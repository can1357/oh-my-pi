//! Opening the receiving side's trees: get_local_name (destination directory vs single
//! file, `--mkpath`, "created directory"), check_alt_basis_dirs, and do_recv's
//! `--backup-dir` / `--temp-dir` checks.

use std::{
	ffi::OsStr,
	path::{Path, PathBuf},
};

use pi_vfs::DirOptions;

use super::DestTrees;
use crate::rsync::{
	consts::FLAG_DIR_CREATED,
	exit::{RERR_FILEIO, RERR_FILESELECT, RERR_SYNTAX, RsyncError},
	flists::Flists,
	log::{Debug as DebugFlag, Info, LogCode, strerror},
	paths::{self, bytes_os_lossy, is_separator},
	session::Ctx,
	tree::{Tree, TreeOpts},
};

/// Upstream full_fname for an operator path: quoted, relative names prefixed with the
/// current directory.
fn full_path(ctx: &Ctx, raw: &[u8]) -> Vec<u8> {
	let resolved = ctx.paths.resolve(bytes_os_lossy(raw));
	let mut out = b"\"".to_vec();
	out.extend_from_slice(&paths::path_bytes(&resolved));
	out.push(b'"');
	out
}

/// The destination is an explicit transfer root: `--confine-root` does not bound it.
fn root_opts(ctx: &Ctx) -> TreeOpts {
	TreeOpts { insecure_links: ctx.opts.insecure_links, operator_named: true, confine: None }
}

/// Paths named by options (`--compare-dest`/`--copy-dest`/`--link-dest`,
/// `--backup-dir`, `--temp-dir`, an absolute `--partial-dir`) must resolve inside
/// `--confine-root`.
pub(super) fn option_opts(ctx: &Ctx) -> TreeOpts {
	TreeOpts {
		insecure_links: ctx.opts.insecure_links,
		operator_named: true,
		confine: ctx.opts.confine_root.as_ref().map(PathBuf::from),
	}
}

/// make_path for an operator path: creates the missing directories of `path` (its
/// parent only with `drop_name`) and counts them; nothing is created under
/// `--dry-run` (upstream's do_mkdir is a no-op there) but the count is the same.
///
/// Like upstream, `drop_name` cuts at the last separator of the operand as given, so
/// `dst/new/deeper/` creates `deeper` too (only the empty name after the slash is
/// dropped).
fn make_dirs(ctx: &Ctx, raw: &[u8], drop_name: bool) -> std::io::Result<usize> {
	let mut bytes = raw;
	while bytes.len() >= 2 && bytes[0] == b'.' && is_separator(bytes[1]) {
		bytes = &bytes[2..];
	}
	if drop_name {
		match bytes.iter().rposition(|&b| is_separator(b)) {
			None | Some(0) => return Ok(0),
			Some(end) => bytes = &bytes[..end],
		}
	}
	let ends: Vec<usize> = (1..=bytes.len())
		.filter(|&i| i == bytes.len() || (is_separator(bytes[i]) && !is_separator(bytes[i - 1])))
		.collect();
	let mut created = 0;
	let mut missing = Vec::new();
	for &end in ends.iter().rev() {
		let path = ctx.paths.resolve(bytes_os_lossy(&bytes[..end]));
		match ctx.fs.metadata(&path) {
			Ok(meta) if meta.is_dir() => break,
			Ok(_) => {
				if missing.is_empty() {
					return Err(std::io::Error::from(std::io::ErrorKind::AlreadyExists));
				}
				return Err(std::io::Error::from(std::io::ErrorKind::NotADirectory));
			},
			Err(_) => missing.push(path),
		}
	}
	for path in missing.into_iter().rev() {
		if !ctx.opts.dry_run {
			ctx.fs.create_dir_with(&path, &DirOptions::new().mode(0o777))?;
		}
		created += 1;
	}
	Ok(created)
}

impl DestTrees {
	/// get_local_name + --mkpath + "created directory" output, after the initial list arrived.
	pub(crate) fn open(ctx: &Ctx, dest: Option<&OsStr>, flists: &Flists) -> Result<Self, RsyncError> {
		let log = &ctx.logger;
		let opts = &ctx.opts;
		let file_total = flists.segment_len(0).unwrap_or(0);
		let first = (0..file_total as i32)
			.map(|i| flists.segment_start(0).unwrap_or(0) + i)
			.find(|&ndx| flists.entry(ndx).is_some_and(|e| e.is_active()));

		if log.levels().debug(DebugFlag::Recv) >= 1 {
			let shown = dest.map_or_else(|| b"<NULL>".to_vec(), |d| crate::host::os_bytes_lossy(d).into_owned());
			let mut text = format!("get_local_name count={file_total} ").into_bytes();
			text.extend_from_slice(&shown);
			text.push(b'\n');
			log.rprintf(LogCode::Info, &text);
		}

		let cwd_tree = || -> Result<Tree, RsyncError> {
			Tree::open(&ctx.fs, &ctx.cwd, &root_opts(ctx)).map_err(|err| {
				log.rsyserr(LogCode::Error, &err, &[b"change_dir#3 ", full_path(ctx, b".").as_slice()].concat());
				RsyncError::bare(RERR_FILESELECT).at("main.c", 868)
			})
		};

		let Some(dest) = dest.filter(|_| opts.list_only == 0) else {
			let mut trees = Self::bare(cwd_tree()?);
			trees.finish_open(ctx, &ctx.cwd)?;
			return Ok(trees);
		};
		let mut raw = crate::host::os_bytes_lossy(dest).into_owned();
		if raw.is_empty() {
			if opts.old_style_args > 0 || ctx.am_server {
				raw = b".".to_vec();
			} else {
				return Err(RsyncError::new(
					RERR_SYNTAX,
					"Empty destination arg specified (use \".\" or see --old-args).",
				)
				.at("main.c", 698));
			}
		}
		let mut statret = ctx.fs.metadata(ctx.paths.resolve(bytes_os_lossy(&raw)));
		let cp = raw.iter().rposition(|&b| is_separator(b));
		let trailing_slash = cp.is_some_and(|c| c + 1 == raw.len());
		let say_created = log.levels().info(Info::Name) >= 1 || opts.stdout_format_has_i != 0;

		if opts.mkpath_dest_arg && statret.is_err() && (cp.is_some() || file_total > 1) {
			let drop_name = !(file_total > 1 && !trailing_slash);
			match make_dirs(ctx, &raw, drop_name) {
				Err(err) => {
					log.rsyserr(LogCode::Error, &err, &[b"mkdir ", full_path(ctx, &raw).as_slice(), b" failed"].concat());
					return Err(RsyncError::bare(RERR_FILEIO).at("main.c", 821));
				},
				Ok(0) => {},
				Ok(n) => {
					if say_created {
						let shown = match cp {
							Some(c) if file_total == 1 || trailing_slash => &raw[..c],
							_ => &raw[..],
						};
						let mut text =
							format!("created {n} director{} for ", if n == 1 { "y" } else { "ies" }).into_bytes();
						text.extend_from_slice(shown);
						text.push(b'\n');
						log.rprintf(LogCode::Info, &text);
					}
					statret = ctx.fs.metadata(ctx.paths.resolve(bytes_os_lossy(&raw)));
				},
			}
		}

		match &statret {
			Ok(meta) if meta.is_dir() => {
				let path = ctx.paths.resolve(bytes_os_lossy(&raw));
				let tree = Tree::open(&ctx.fs, &path, &root_opts(ctx)).map_err(|err| {
					log.rsyserr(LogCode::Error, &err, &[b"change_dir#1 ", full_path(ctx, &raw).as_slice(), b" failed"].concat());
					RsyncError::bare(RERR_FILESELECT).at("main.c", 781)
				})?;
				let mut trees = Self::bare(tree);
				trees.dest_dev = meta.dev();
				trees.finish_open(ctx, &path)?;
				return Ok(trees);
			},
			Ok(_) => {
				if file_total > 1 {
					return Err(RsyncError::new(
						RERR_FILESELECT,
						"ERROR: destination must be a directory when copying more than 1 file",
					)
					.at("main.c", 790));
				}
				if file_total == 1 && first.and_then(|n| flists.entry(n)).is_some_and(|e| e.is_dir()) {
					return Err(RsyncError::new(RERR_FILESELECT, "ERROR: cannot overwrite non-directory with a directory")
						.at("main.c", 796));
				}
			},
			Err(err) if err.kind() != std::io::ErrorKind::NotFound => {
				log.rsyserr(
					LogCode::Error,
					err,
					&[b"ERROR: cannot stat destination ", full_path(ctx, &raw).as_slice()].concat(),
				);
				return Err(RsyncError::bare(RERR_FILESELECT).at("main.c", 802));
			},
			Err(_) => {},
		}

		if file_total > 1 || trailing_slash {
			if trailing_slash && raw.len() > 1 {
				raw.truncate(raw.len() - 1);
			}
			if statret.is_ok() {
				return Err(RsyncError::new(RERR_SYNTAX, "ERROR: destination path is not a directory").at("main.c", 814));
			}
			let path = ctx.paths.resolve(bytes_os_lossy(&raw));
			if !opts.dry_run
				&& let Err(err) = ctx.fs.create_dir_with(&path, &DirOptions::new().mode(0o777))
			{
				log.rsyserr(LogCode::Error, &err, &[b"mkdir ", full_path(ctx, &raw).as_slice(), b" failed"].concat());
				return Err(RsyncError::bare(RERR_FILEIO).at("main.c", 821));
			}
			if let Some(ndx) = first
				&& flists.entry(ndx).is_some_and(|e| &*e.basename == b".")
			{
				flists.update(ndx, |e| e.flags |= FLAG_DIR_CREATED);
			}
			if say_created {
				let mut text = b"created directory ".to_vec();
				text.extend_from_slice(&raw);
				text.push(b'\n');
				log.rprintf(LogCode::Info, &text);
			}
			if opts.dry_run {
				// The destination does not really exist (upstream dry_run++).
				let mut trees = Self::bare(cwd_tree()?);
				trees.dry_missing = true;
				trees.finish_open(ctx, &path)?;
				return Ok(trees);
			}
			let tree = Tree::open(&ctx.fs, &path, &root_opts(ctx)).map_err(|err| {
				log.rsyserr(LogCode::Error, &err, &[b"change_dir#2 ", full_path(ctx, &raw).as_slice(), b" failed"].concat());
				RsyncError::bare(RERR_FILESELECT).at("main.c", 839)
			})?;
			let mut trees = Self::bare(tree);
			trees.dest_dev = ctx.fs.metadata(&path).ok().and_then(|m| m.dev());
			trees.finish_open(ctx, &path)?;
			return Ok(trees);
		}

		// A single file, possibly replacing an existing non-directory.
		let Some(cp) = cp else {
			let mut trees = Self::bare(cwd_tree()?);
			trees.single_file = Some(raw);
			trees.finish_open(ctx, &ctx.cwd)?;
			return Ok(trees);
		};
		let parent_raw: Vec<u8> = if cp == 0 { b"/".to_vec() } else { raw[..cp].to_vec() };
		let leaf = raw[cp + 1..].to_vec();
		let parent = ctx.paths.resolve(bytes_os_lossy(&parent_raw));
		if opts.dry_run && opts.mkpath_dest_arg && ctx.fs.metadata(&parent).is_err() {
			let mut trees = Self::bare(cwd_tree()?);
			trees.single_file = Some(leaf);
			trees.dry_missing = true;
			trees.finish_open(ctx, &parent)?;
			return Ok(trees);
		}
		let tree = Tree::open(&ctx.fs, &parent, &root_opts(ctx)).map_err(|err| {
			log.rsyserr(LogCode::Error, &err, &[b"change_dir#3 ", full_path(ctx, &parent_raw).as_slice(), b" failed"].concat());
			RsyncError::bare(RERR_FILESELECT).at("main.c", 868)
		})?;
		let mut trees = Self::bare(tree);
		trees.single_file = Some(leaf);
		trees.finish_open(ctx, &parent)?;
		Ok(trees)
	}

	fn bare(dest: Tree) -> Self {
		Self {
			dest,
			single_file: None,
			partial_dir: None,
			temp_dir: None,
			backup_dir: None,
			alt_dirs: Vec::new(),
			dry_missing: false,
			dest_dev: None,
		}
	}

	/// check_alt_basis_dirs and do_recv's backup-dir/temp-dir checks, relative to the
	/// destination directory `curr_dir`.
	fn finish_open(&mut self, ctx: &Ctx, curr_dir: &Path) -> Result<(), RsyncError> {
		let log = &ctx.logger;
		let opts = &ctx.opts;
		self.partial_dir = opts.partial_dir.as_ref().map(|p| crate::host::os_bytes_lossy(p).into_owned());

		let alt_opt = crate::rsync::options::alt_dest_opt(opts.alt_dest_type);
		for bdir in &opts.basis_dirs {
			let mut raw = crate::host::os_bytes_lossy(bdir).into_owned();
			if raw.len() > 1 {
				raw.pop_if(|b| is_separator(*b));
			}
			let given = bytes_os_lossy(&raw);
			let given = Path::new(&given);
			let resolved = if given.is_absolute() || raw.first().is_some_and(|&b| is_separator(b)) {
				ctx.paths.resolve(&given)
			} else if self.dry_missing && raw.starts_with(b"../") {
				// Strip one "../" for the directory a dry run could not create.
				let base = curr_dir.parent().unwrap_or(curr_dir);
				base.join(bytes_os_lossy(&raw[3..]))
			} else {
				curr_dir.join(&given)
			};
			let shown = paths::path_bytes(&resolved).into_owned();
			match ctx.fs.metadata(&resolved) {
				Err(_) => {
					let mut text = format!("{alt_opt} arg does not exist: ").into_bytes();
					text.extend_from_slice(&shown);
					text.push(b'\n');
					log.rprintf(LogCode::Warning, &text);
				},
				Ok(meta) if !meta.is_dir() => {
					let mut text = format!("{alt_opt} arg is not a dir: ").into_bytes();
					text.extend_from_slice(&shown);
					text.push(b'\n');
					log.rprintf(LogCode::Warning, &text);
				},
				Ok(_) => {
					if let Ok(tree) = Tree::open(&ctx.fs, &resolved, &option_opts(ctx)) {
						self.alt_dirs.push(tree);
					}
				},
			}
		}

		if let Some(bdir) = &opts.backup_dir {
			let mut raw = crate::host::os_bytes_lossy(bdir).into_owned();
			if raw.len() > 1 {
				raw.pop_if(|b| is_separator(*b));
			}
			let given = bytes_os_lossy(&raw);
			let given = Path::new(&given);
			let resolved = if given.is_absolute() { ctx.paths.resolve(&given) } else { curr_dir.join(&given) };
			match ctx.fs.metadata(&resolved) {
				Ok(meta) if meta.is_dir() => {
					if log.levels().info(Info::Backup) >= 1 {
						log.rprintf(LogCode::Info, &[b"backup_dir is ", raw.as_slice(), b"\n"].concat());
					}
					self.backup_dir = Tree::open(&ctx.fs, &resolved, &option_opts(ctx)).ok();
				},
				Ok(_) => {
					let message = format!("The backup-dir is not a directory: {}", String::from_utf8_lossy(&raw));
					return Err(RsyncError::new(RERR_SYNTAX, message).at("main.c", 1045));
				},
				Err(err) if err.kind() != std::io::ErrorKind::NotFound => {
					let message = format!("Failed to stat {}: {}", String::from_utf8_lossy(&raw), strerror(&err));
					return Err(RsyncError::new(RERR_FILEIO, message).at("main.c", 1049));
				},
				Err(_) => {
					if log.levels().info(Info::Backup) >= 1 {
						log.rprintf(LogCode::Info, &[b"(new) backup_dir is ", raw.as_slice(), b"\n"].concat());
					}
				},
			}
		}

		if let Some(tdir) = &opts.tmpdir {
			let raw = crate::host::os_bytes_lossy(tdir).into_owned();
			let given = bytes_os_lossy(&raw);
			let given = Path::new(&given);
			let resolved = if given.is_absolute() { ctx.paths.resolve(&given) } else { curr_dir.join(&given) };
			match ctx.fs.metadata(&resolved) {
				Ok(meta) if meta.is_dir() => {
					self.temp_dir = Some(Tree::open(&ctx.fs, &resolved, &option_opts(ctx)).map_err(|err| {
						let message =
							format!("Failed to stat temp-dir {}: {}", String::from_utf8_lossy(&raw), strerror(&err));
						RsyncError::new(RERR_FILEIO, message).at("main.c", 1072)
					})?);
				},
				Ok(_) => {
					let message = format!("The temp-dir is not a directory: {}", String::from_utf8_lossy(&raw));
					return Err(RsyncError::new(RERR_SYNTAX, message).at("main.c", 1065));
				},
				Err(err) if err.kind() == std::io::ErrorKind::NotFound => {
					let message = format!("The temp-dir does not exist: {}", String::from_utf8_lossy(&raw));
					return Err(RsyncError::new(RERR_SYNTAX, message).at("main.c", 1069));
				},
				Err(err) => {
					let message = format!("Failed to stat temp-dir {}: {}", String::from_utf8_lossy(&raw), strerror(&err));
					return Err(RsyncError::new(RERR_FILEIO, message).at("main.c", 1072));
				},
			}
		}
		Ok(())
	}
}
