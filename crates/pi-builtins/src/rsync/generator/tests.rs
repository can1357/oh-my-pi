//! Generator behavior on temp-dir trees with a scripted receiver side: the requests
//! written for the sender are parsed back and compared with reference rsync 3.5.1
//! captures (itemize strings from `rsync -aii`, sum headers from a `-e` tee, and
//! `--list-only` lines).

use std::{
	io::{self, Write},
	path::Path,
	sync::{Arc, Mutex},
};

use super::{DestTrees, SibIn, SibOut, Sibling, basis, listing, run, sib_pipe};
#[cfg(unix)]
use crate::rsync::{
	consts::LINK_DEST,
	log::{ItemizeCtx, itemize},
};
use crate::rsync::{
	acl::{AclOpts, AclReceiver},
	checksum::{CsumType, SumHead},
	consts::{
		ITEM_BASIS_TYPE_FOLLOWS, ITEM_TRANSFER, ITEM_XNAME_FOLLOWS, MAXPATHLEN, NDX_DEL_STATS,
		NDX_DONE,
	},
	exit::RERR_PROTOCOL,
	filter::{FilterConfig, Filters},
	flist::{FileEntry, FileList},
	flists::Flists,
	log::{LogConfig, Logger, OutLevels, Role},
	meta::MetaOpts,
	mux::{IoCounters, MuxWriter, WriteConfig},
	options::Options,
	session::Ctx,
	tree::{Tree, TreeOpts},
	wire::{NdxCodec, Proto, ReadExt},
	xattr::XattrReceiver,
};

/// 2020/01/02 02:04:05 UTC, the fixture time of the reference captures.
const T: i64 = 1_577_930_645;

#[derive(Clone, Default)]
struct Buf(Arc<Mutex<Vec<u8>>>, Arc<std::sync::atomic::AtomicUsize>);

impl Write for Buf {
	fn write(&mut self, data: &[u8]) -> io::Result<usize> {
		self.0.lock().unwrap().extend_from_slice(data);
		self.1.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
		Ok(data.len())
	}

	fn flush(&mut self) -> io::Result<()> {
		Ok(())
	}
}

impl Buf {
	fn bytes(&self) -> Vec<u8> {
		self.0.lock().unwrap().clone()
	}

	/// How many separate chunks reached the underlying stream (one per flush).
	fn writes(&self) -> usize {
		self.1.load(std::sync::atomic::Ordering::Relaxed)
	}
}

fn proto() -> Proto {
	Proto { version: 31, compat: 0 }
}

fn base_opts() -> Options {
	let mut opts = Options::default();
	opts.recurse = 2;
	opts.preserve_mtimes = true;
	opts.preserve_links = true;
	opts.whole_file = 0;
	opts.do_xfers = true;
	opts
}

fn make_ctx(opts: Options, cwd: &Path, log: &Buf) -> Ctx {
	let levels = OutLevels::from_verbose(opts.verbose as u8);
	let meta = MetaOpts {
		perms: opts.preserve_perms,
		times: opts.preserve_mtimes,
		dry_run: opts.dry_run,
		..MetaOpts::default()
	};
	let cfg = LogConfig { levels, human_readable: 1, ..LogConfig::default() };
	let mut ctx = Ctx::for_tests(opts);
	ctx.proto = proto();
	ctx.inc_recurse = false;
	ctx.local_server = false;
	ctx.am_server = false;
	ctx.xfer_sum = CsumType::Md5;
	ctx.file_sum = CsumType::Md5;
	ctx.seed = 0;
	ctx.umask = 0o022;
	ctx.meta = meta;
	ctx.flist_opts.checksum_len = 16;
	ctx.cwd = cwd.to_path_buf();
	ctx.paths = crate::host::ShellPaths::with_cwd(cwd);
	ctx.logger = Logger::local(Box::new(log.clone()), Box::new(log.clone()), cfg).with_role(Role::Generator);
	ctx
}

fn entry(name: &str, mode: u32, size: u64, mtime: i64) -> FileEntry {
	let (dir, base) = match name.rfind('/') {
		Some(pos) => (&name[..pos], &name[pos + 1..]),
		None => ("", name),
	};
	FileEntry {
		dirname: Arc::from(dir.as_bytes()),
		basename: base.as_bytes().into(),
		mode,
		size,
		mtime,
		..FileEntry::default()
	}
}

fn publish(entries: Vec<FileEntry>, log: &Logger) -> Arc<Flists> {
	let mut list = FileList { entries, ndx_start: 0, parent_ndx: -1 };
	list.sort_and_clean(proto(), false, log);
	let flists = Flists::new();
	flists.push(list);
	flists.set_eof();
	flists
}

fn open_tree(path: &Path) -> Tree {
	Tree::open(&pi_vfs::BlockingFs::native(), path, &TreeOpts::default()).unwrap()
}

fn trees_for(dest: &Path) -> DestTrees {
	DestTrees {
		dest: open_tree(dest),
		single_file: None,
		partial_dir: None,
		temp_dir: None,
		backup_dir: None,
		alt_dirs: Vec::new(),
		dry_missing: false,
		dest_dev: None,
	}
}

/// A receiver pipe that has already delivered the four phase ends a run needs. Keep the
/// sending half alive while the generator runs.
fn finished_pipe(ctx: &Ctx, flists: &Flists) -> (Arc<SibOut>, SibIn) {
	let (out, sib_in) = sib_pipe(flists, ctx.inc_recurse);
	for _ in 0..4 {
		out.data(Sibling::Done);
	}
	out.flush_all();
	(out, sib_in)
}

/// Runs the generator with a receiver that finishes every phase at once; returns the
/// bytes it wrote for the sender.
fn generate(ctx: &Ctx, trees: &DestTrees, flists: &Flists) -> Vec<u8> {
	let (_out, sib_in) = finished_pipe(ctx, flists);
	let xattrs = Arc::new(Mutex::new(XattrReceiver::new(1 << 30)));
	generate_with(ctx, trees, flists, xattrs, &sib_in, false).0
}

/// [`generate`] with the receiver pipe, xattr cache, and multiplexing chosen by the
/// caller; also returns how many chunks the generator itself flushed to the stream.
fn generate_with(
	ctx: &Ctx,
	trees: &DestTrees,
	flists: &Flists,
	xattrs: Arc<Mutex<XattrReceiver>>,
	rx: &SibIn,
	multiplex: bool,
) -> (Vec<u8>, usize) {
	let wire = Buf::default();
	let out = MuxWriter::new(Box::new(wire.clone()), IoCounters::default(), WriteConfig::default());
	if multiplex {
		out.start_multiplex().unwrap();
	}
	let acls = Arc::new(Mutex::new(AclReceiver::new(AclOpts::default(), 1 << 30)));
	let filters = Filters::new(FilterConfig::default());
	run(ctx, trees, flists, xattrs, acls, filters, &out, rx).unwrap();
	let writes = wire.writes();
	let mut out = out;
	out.flush().unwrap();
	(wire.bytes(), writes)
}

/// Splits a multiplexed stream into (message code, payload) frames.
fn frames(bytes: &[u8]) -> Vec<(u8, Vec<u8>)> {
	let mut out = Vec::new();
	let mut r = bytes;
	while let Some((&header, rest)) = r.split_first_chunk::<4>() {
		let header = u32::from_le_bytes(header);
		let len = (header & 0xFF_FFFF) as usize;
		let code = ((header >> 24) as u8).wrapping_sub(crate::rsync::consts::MPLEX_BASE);
		out.push((code, rest[..len].to_vec()));
		r = &rest[len..];
	}
	out
}

#[derive(Debug)]
struct Req {
	ndx: i32,
	iflags: u32,
	basis: Option<u8>,
	head: Option<SumHead>,
}

/// Parses the generator → sender stream (ndx, iflags, basis type, xname, sums).
fn parse(bytes: &[u8]) -> (Vec<Req>, usize) {
	parse_with(bytes, true)
}

/// [`parse`]; `with_sums` false for `--dry-run` streams (no sum headers follow).
fn parse_with(bytes: &[u8], with_sums: bool) -> (Vec<Req>, usize) {
	let mut r = bytes;
	let mut codec = NdxCodec::new(proto());
	let mut reqs = Vec::new();
	let mut dones = 0;
	while !r.is_empty() {
		let ndx = codec.read(&mut r).unwrap();
		if ndx == NDX_DONE {
			dones += 1;
			continue;
		}
		if ndx == NDX_DEL_STATS {
			for _ in 0..5 {
				r.read_varint().unwrap();
			}
			continue;
		}
		let iflags = u32::from(r.read_shortint().unwrap());
		let basis = (iflags & ITEM_BASIS_TYPE_FOLLOWS != 0).then(|| r.read_u8().unwrap());
		if iflags & ITEM_XNAME_FOLLOWS != 0 {
			r.read_vstring(MAXPATHLEN, RERR_PROTOCOL, ("rsync.c", 410)).unwrap();
		}
		let head = (with_sums && iflags & ITEM_TRANSFER != 0).then(|| {
			let head = SumHead::read(&mut r, proto(), 16).unwrap();
			let skip = head.count as usize * (4 + head.s2length as usize);
			r = &r[skip..];
			head
		});
		reqs.push(Req { ndx, iflags, basis, head });
	}
	(reqs, dones)
}

fn set_mtime(path: &Path, secs: i64) {
	let t = crate::rsync::time::system_time(secs, 0).unwrap();
	std::fs::set_times_nofollow(path, std::fs::FileTimes::new().set_accessed(t).set_modified(t))
		.unwrap();
}

fn write_file(path: &Path, data: &[u8], secs: i64) {
	std::fs::write(path, data).unwrap();
	set_mtime(path, secs);
}

fn transferred(ctx: &Ctx, flists: &Flists, reqs: &[Req]) -> Vec<String> {
	let _ = ctx;
	reqs.iter()
		.filter(|r| r.iflags & ITEM_TRANSFER != 0)
		.map(|r| String::from_utf8(flists.entry(r.ndx).unwrap().name()).unwrap())
		.collect()
}

#[cfg(unix)]
#[test]
fn itemize_matches_reference_aii() {
	use std::os::unix::fs::PermissionsExt;
	let tmp = tempfile::tempdir().unwrap();
	let dest = tmp.path();
	std::fs::set_permissions(dest, std::fs::Permissions::from_mode(0o755)).unwrap();
	write_file(&dest.join("same.txt"), b"abc", T);
	write_file(&dest.join("grow.txt"), b"abc", T);
	write_file(&dest.join("touch.txt"), b"xyz", T + 63_000_000);
	write_file(&dest.join("perm.txt"), b"p", T);
	for name in ["same.txt", "grow.txt", "touch.txt", "perm.txt"] {
		std::fs::set_permissions(dest.join(name), std::fs::Permissions::from_mode(0o644)).unwrap();
	}
	set_mtime(dest, T + 5);

	let mut opts = base_opts();
	opts.preserve_perms = true;
	opts.stdout_format_has_i = 3;
	opts.itemize_changes = 2;
	let log = Buf::default();
	let ctx = make_ctx(opts, dest, &log);
	let mut link = entry("link", 0o120755, 7, T);
	link.link = Some(b"new.txt"[..].into());
	let flists = publish(
		vec![
			entry(".", 0o040755, 288, T),
			entry("grow.txt", 0o100644, 6, T),
			link,
			entry("new.txt", 0o100644, 5, T),
			entry("perm.txt", 0o100600, 1, T),
			entry("same.txt", 0o100644, 3, T),
			entry("touch.txt", 0o100644, 3, T),
			entry("sub", 0o040755, 96, T),
			entry("sub/inner", 0o100644, 1, T),
		],
		&ctx.logger,
	);
	let trees = trees_for(dest);
	let (reqs, dones) = parse(&generate(&ctx, &trees, &flists));
	assert_eq!(dones, 4, "phase NDX_DONEs for protocol 31");

	let ictx = ItemizeCtx { local_server: true, preserve_mtimes: true, receiver_symlink_times: true };
	let lines: Vec<String> = reqs
		.iter()
		.map(|r| {
			let e = flists.entry(r.ndx).unwrap();
			let mut name = String::from_utf8(e.name()).unwrap();
			if e.is_dir() {
				name.push('/');
			}
			if let Some(link) = &e.link {
				name.push_str(" -> ");
				name.push_str(std::str::from_utf8(link).unwrap());
			}
			let flags = itemize(r.iflags, e.mode, "recv", ictx);
			format!("{} {name}", String::from_utf8_lossy(&flags))
		})
		.collect();
	// rsync -aii src/ dst/ (3.5.1), same fixture.
	let expected = [
		".d..t...... ./",
		">f.s....... grow.txt",
		"cL+++++++++ link -> new.txt",
		">f+++++++++ new.txt",
		".f...p..... perm.txt",
		".f          same.txt",
		">f..t...... touch.txt",
		"cd+++++++++ sub/",
		">f+++++++++ sub/inner",
	];
	assert_eq!(lines, expected);
	// The local changes happened: directory, symlink, permissions.
	assert!(dest.join("sub").is_dir());
	assert_eq!(std::fs::read_link(dest.join("link")).unwrap(), Path::new("new.txt"));
	let perm = std::fs::metadata(dest.join("perm.txt")).unwrap().permissions().mode();
	assert_eq!(perm & 0o777, 0o600);
}

#[test]
fn sum_header_bytes_match_reference() {
	let tmp = tempfile::tempdir().unwrap();
	let dest = tmp.path();
	write_file(&dest.join("f"), &vec![7u8; 70_000], T - 100);
	let log = Buf::default();
	let ctx = make_ctx(base_opts(), dest, &log);
	let flists = publish(vec![entry("f", 0o100644, 100_000, T)], &ctx.logger);
	let bytes = generate(&ctx, &trees_for(dest), &flists);
	// ndx 0, iflags 0x800c (transfer, size, time), then the header the reference sends for
	// a 70000-byte basis: count 100, blength 700, s2length 2, remainder 0.
	let expected: &[u8] = &[
		0x01, 0x0c, 0x80, 0x64, 0x00, 0x00, 0x00, 0xbc, 0x02, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x00, 0x00,
		0x00, 0x00,
	];
	assert_eq!(&bytes[..expected.len()], expected);
	let (reqs, _) = parse(&bytes);
	assert_eq!(reqs.len(), 1);

	// A 4000003-byte basis: count 2001, blength 2000, s2length 2, remainder 3.
	write_file(&dest.join("f"), &vec![1u8; 4_000_003], T - 100);
	let flists = publish(vec![entry("f", 0o100644, 5_000_000, T)], &ctx.logger);
	let bytes = generate(&ctx, &trees_for(dest), &flists);
	let head: &[u8] =
		&[0xd1, 0x07, 0x00, 0x00, 0xd0, 0x07, 0x00, 0x00, 0x02, 0x00, 0x00, 0x00, 0x03, 0x00, 0x00, 0x00];
	assert_eq!(&bytes[3..3 + head.len()], head);
}

#[test]
fn whole_file_sends_an_empty_header() {
	let tmp = tempfile::tempdir().unwrap();
	let dest = tmp.path();
	write_file(&dest.join("f"), b"old contents", T - 100);
	let mut opts = base_opts();
	opts.whole_file = 1;
	let log = Buf::default();
	let ctx = make_ctx(opts, dest, &log);
	let flists = publish(vec![entry("f", 0o100644, 20, T)], &ctx.logger);
	let (reqs, _) = parse(&generate(&ctx, &trees_for(dest), &flists));
	assert_eq!(reqs.len(), 1);
	// The destination file itself is the basis: no basis-type byte follows.
	assert_eq!(reqs[0].basis, None);
	assert_eq!(reqs[0].head, Some(SumHead::default()));
}

/// The names requested from the sender for a fixture of six files, after `tweak`.
fn quick_check_run(tweak: impl FnOnce(&mut Options), sums: bool) -> Vec<String> {
	let tmp = tempfile::tempdir().unwrap();
	let dest = tmp.path();
	write_file(&dest.join("same"), b"aaaa", T);
	write_file(&dest.join("size"), b"aaa", T);
	write_file(&dest.join("time"), b"aaaa", T - 50);
	write_file(&dest.join("content"), b"zzzz", T);
	write_file(&dest.join("newer"), b"aaaa", T + 50);
	let mut opts = base_opts();
	tweak(&mut opts);
	let log = Buf::default();
	let ctx = make_ctx(opts, dest, &log);
	let digest = |data: &[u8]| -> Box<[u8]> {
		crate::rsync::checksum::file_checksum(CsumType::Md5, 0, proto(), &mut &data[..]).unwrap().into()
	};
	let mut entries = vec![
		entry("same", 0o100644, 4, T),
		entry("size", 0o100644, 4, T),
		entry("time", 0o100644, 4, T),
		entry("content", 0o100644, 4, T),
		entry("newer", 0o100644, 4, T),
		entry("missing", 0o100644, 4, T),
	];
	if sums {
		for e in &mut entries {
			e.sum = Some(digest(b"aaaa"));
		}
	}
	let flists = publish(entries, &ctx.logger);
	let (reqs, _) = parse(&generate(&ctx, &trees_for(dest), &flists));
	let mut names = transferred(&ctx, &flists, &reqs);
	names.sort();
	names
}

#[test]
fn quick_check_decisions() {
	let v = |names: &[&str]| names.iter().map(|s| (*s).to_owned()).collect::<Vec<_>>();
	// Size + mtime.
	assert_eq!(quick_check_run(|_| {}, false), v(&["missing", "newer", "size", "time"]));
	// --size-only ignores the mtime.
	assert_eq!(quick_check_run(|o| o.size_only = true, false), v(&["missing", "size"]));
	// -I transfers everything.
	assert_eq!(
		quick_check_run(|o| o.ignore_times = true, false),
		v(&["content", "missing", "newer", "same", "size", "time"])
	);
	// -c compares whole-file checksums instead of mtimes.
	assert_eq!(quick_check_run(|o| o.always_checksum = true, true), v(&["content", "missing", "size"]));
	// -u skips files that are newer on the receiver.
	assert_eq!(quick_check_run(|o| o.update_only = true, false), v(&["missing", "size", "time"]));
	// --existing never creates.
	assert_eq!(quick_check_run(|o| o.ignore_non_existing = true, false), v(&["newer", "size", "time"]));
	// --ignore-existing only creates.
	assert_eq!(quick_check_run(|o| o.ignore_existing = true, false), v(&["missing"]));
	// --max-size / --min-size.
	assert_eq!(quick_check_run(|o| o.max_size = 3, false), Vec::<String>::new());
	assert_eq!(quick_check_run(|o| o.min_size = 5, false), Vec::<String>::new());
}

#[test]
fn skip_messages_at_info_skip() {
	let tmp = tempfile::tempdir().unwrap();
	let dest = tmp.path();
	write_file(&dest.join("there"), b"aaaa", T);
	let mut opts = base_opts();
	opts.ignore_non_existing = true;
	let log = Buf::default();
	let mut ctx = make_ctx(opts, dest, &log);
	let mut levels = OutLevels::default();
	levels.apply_info("skip1").unwrap();
	let cfg = LogConfig { levels, human_readable: 1, ..LogConfig::default() };
	ctx.logger = Logger::local(Box::new(log.clone()), Box::new(log.clone()), cfg).with_role(Role::Generator);
	let flists = publish(vec![entry("absent", 0o100644, 1, T), entry("there", 0o100644, 4, T)], &ctx.logger);
	generate(&ctx, &trees_for(dest), &flists);
	ctx.logger.flush();
	assert_eq!(String::from_utf8(log.bytes()).unwrap(), "not creating new file \"absent\"\n");
}

#[cfg(unix)]
#[test]
fn link_dest_hard_links_unchanged_files() {
	use std::os::unix::fs::MetadataExt;
	let tmp = tempfile::tempdir().unwrap();
	let alt = tmp.path().join("alt");
	let dest = tmp.path().join("dest");
	std::fs::create_dir_all(&alt).unwrap();
	std::fs::create_dir_all(&dest).unwrap();
	write_file(&alt.join("f"), b"same data", T);
	write_file(&alt.join("g"), b"old", T);
	let mut opts = base_opts();
	opts.alt_dest_type = LINK_DEST;
	let log = Buf::default();
	let ctx = make_ctx(opts, &dest, &log);
	let flists = publish(vec![entry("f", 0o100644, 9, T), entry("g", 0o100644, 10, T)], &ctx.logger);
	let mut trees = trees_for(&dest);
	trees.alt_dirs.push(open_tree(&alt));
	let (reqs, _) = parse(&generate(&ctx, &trees, &flists));

	// f is linked, not requested.
	assert_eq!(
		std::fs::metadata(alt.join("f")).unwrap().ino(),
		std::fs::metadata(dest.join("f")).unwrap().ino()
	);
	// g is requested with the link-dest copy as its basis (basis type 0, sums sent).
	assert_eq!(reqs.len(), 1);
	assert_eq!(flists.entry(reqs[0].ndx).unwrap().name(), b"g");
	assert_eq!(reqs[0].basis, Some(0));
	assert_eq!(reqs[0].head.map(|h| h.count), Some(1));
	assert!(!dest.join("g").exists());
}

#[test]
fn dry_run_creates_nothing() {
	let tmp = tempfile::tempdir().unwrap();
	let dest = tmp.path();
	let mut opts = base_opts();
	opts.dry_run = true;
	opts.do_xfers = false;
	let log = Buf::default();
	let ctx = make_ctx(opts, dest, &log);
	let flists = publish(
		vec![entry("d", 0o040755, 0, T), entry("d/f", 0o100644, 3, T), entry("g", 0o100644, 3, T)],
		&ctx.logger,
	);
	let (reqs, _) = parse_with(&generate(&ctx, &trees_for(dest), &flists), false);
	assert!(!dest.join("d").exists());
	let mut names: Vec<Vec<u8>> = reqs.iter().map(|r| flists.entry(r.ndx).unwrap().name()).collect();
	names.sort();
	assert_eq!(names, [b"d".to_vec(), b"d/f".to_vec(), b"g".to_vec()]);
	// No sums under --dry-run.
	assert!(reqs.iter().all(|r| r.head.is_none()));
}

#[test]
fn list_only_lines_match_reference() {
	let tz = jiff::tz::TimeZone::UTC;
	let dir = entry(".", 0o040755, 320, T);
	let big = entry("big", 0o100644, 1_234_567, T);
	let mut link = entry("link", 0o120755, 7, T);
	link.link = Some(b"new.txt"[..].into());
	let line = |e: &FileEntry, human: u8| {
		String::from_utf8(listing::list_line(e, human, &tz, false, false, true, false)).unwrap()
	};
	// TZ=UTC rsync -a [--no-h|-h] --list-only src/ (3.5.1).
	assert_eq!(line(&dir, 0), "drwxr-xr-x         320 2020/01/02 02:04:05 .\n");
	assert_eq!(line(&big, 0), "-rw-r--r--     1234567 2020/01/02 02:04:05 big\n");
	assert_eq!(line(&dir, 1), "drwxr-xr-x            320 2020/01/02 02:04:05 .\n");
	assert_eq!(line(&big, 1), "-rw-r--r--      1,234,567 2020/01/02 02:04:05 big\n");
	assert_eq!(line(&big, 2), "-rw-r--r--          1.23M 2020/01/02 02:04:05 big\n");
	assert_eq!(line(&link, 1), "lrwxr-xr-x              7 2020/01/02 02:04:05 link -> new.txt\n");
}

#[test]
fn list_only_run_prints_entries_and_requests_nothing() {
	let tmp = tempfile::tempdir().unwrap();
	let mut opts = base_opts();
	opts.list_only = 2;
	let log = Buf::default();
	let mut ctx = make_ctx(opts, tmp.path(), &log);
	let cfg = LogConfig {
		levels: OutLevels::from_verbose(0),
		human_readable: 1,
		time_zone: Some(jiff::tz::TimeZone::UTC),
		..LogConfig::default()
	};
	ctx.logger = Logger::local(Box::new(log.clone()), Box::new(log.clone()), cfg).with_role(Role::Generator);
	let flists = publish(vec![entry(".", 0o040755, 320, T), entry("a", 0o100644, 3, T)], &ctx.logger);
	let (reqs, _) = parse(&generate(&ctx, &trees_for(tmp.path()), &flists));
	assert!(reqs.is_empty());
	ctx.logger.flush();
	assert_eq!(
		String::from_utf8(log.bytes()).unwrap(),
		"drwxr-xr-x            320 2020/01/02 02:04:05 .\n-rw-r--r--              3 2020/01/02 02:04:05 a\n"
	);
	assert!(!tmp.path().join("a").exists());
}

#[test]
fn dest_open_creates_directory_for_many_files() {
	let tmp = tempfile::tempdir().unwrap();
	let mut opts = base_opts();
	opts.verbose = 1;
	let log = Buf::default();
	let ctx = make_ctx(opts, tmp.path(), &log);
	let flists = publish(vec![entry("a", 0o100644, 1, T), entry("b", 0o100644, 1, T)], &ctx.logger);
	let trees = DestTrees::open(&ctx, Some(std::ffi::OsStr::new("newdir")), &flists).unwrap();
	ctx.logger.flush();
	assert!(tmp.path().join("newdir").is_dir());
	assert!(trees.single_file.is_none());
	assert_eq!(String::from_utf8(log.bytes()).unwrap(), "created directory newdir\n");

	// A non-directory destination with several files is an error (exit 3).
	write_file(&tmp.path().join("plain"), b"x", T);
	let err = DestTrees::open(&ctx, Some(std::ffi::OsStr::new("plain")), &flists).err().unwrap();
	assert_eq!(err.code, crate::rsync::exit::RERR_FILESELECT);
	assert_eq!(
		err.message.as_deref(),
		Some("ERROR: destination must be a directory when copying more than 1 file")
	);

	// One file to a new name: single-file mode in the parent.
	let one = publish(vec![entry("a", 0o100644, 1, T)], &ctx.logger);
	let trees = DestTrees::open(&ctx, Some(std::ffi::OsStr::new("newdir/renamed")), &one).unwrap();
	assert_eq!(trees.single_file.as_deref(), Some(&b"renamed"[..]));
}

#[test]
fn fuzzy_helpers() {
	let suffix = |name: &str| {
		let (at, len) = basis::find_filename_suffix(name.as_bytes());
		name[at..at + len].to_owned()
	};
	assert_eq!(suffix("foo.tar.gz"), ".gz");
	assert_eq!(suffix("foo.txt.bak"), ".txt");
	assert_eq!(suffix(".bashrc"), "");
	assert_eq!(suffix("notes.txt~"), ".txt");
	assert_eq!(suffix("a.1.2"), ".1");
	assert_eq!(basis::fuzzy_distance(b"abc", b"abc", u32::MAX), 0);
	// One substitution costs a unit plus the byte distance.
	assert_eq!(basis::fuzzy_distance(b"abc", b"abd", u32::MAX), (1 << 16) + 1);
	// Length difference beyond the limit short-circuits.
	assert_eq!(basis::fuzzy_distance(b"a", b"abcdef", 1 << 16), 0xFFFF * (1 << 16) + 1);
}

/// An incremental-recursion fixture: list 0 holds "." and "sub", list 1 the contents of
/// "sub" (global indices: 1..=2, gap 3, then 4).
fn inc_lists(log: &Logger) -> (Arc<Flists>, FileList) {
	let flists = Flists::new();
	let mut first = FileList {
		entries: vec![entry(".", 0o040755, 0, T), entry("sub", 0o040755, 0, T)],
		ndx_start: 1,
		parent_ndx: 1,
	};
	first.sort_and_clean(proto(), false, log);
	flists.push(first);
	let second = FileList { entries: vec![entry("sub/f", 0o100644, 3, T)], ndx_start: 4, parent_ndx: 2 };
	(flists, second)
}

/// B4/O2: a file-list segment the receiver forwards while the generator waits wakes it
/// at once (no lost wake-up, no polling): the generator then finishes the new segment.
#[test]
fn generator_wakes_when_a_segment_arrives_while_it_waits() {
	let tmp = tempfile::tempdir().unwrap();
	let mut opts = base_opts();
	opts.dry_run = true;
	opts.do_xfers = false;
	let log = Buf::default();
	let mut ctx = make_ctx(opts, tmp.path(), &log);
	ctx.inc_recurse = true;
	let (flists, second) = inc_lists(&ctx.logger);
	let (sib_out, sib_in) = sib_pipe(&flists, true);
	let publisher = {
		let flists = Arc::clone(&flists);
		std::thread::spawn(move || {
			std::thread::sleep(std::time::Duration::from_millis(50));
			flists.push(second);
			flists.set_eof();
			sib_out.data(Sibling::List);
			sib_out.data(Sibling::ListEof);
			for _ in 0..4 {
				sib_out.data(Sibling::Done);
			}
			sib_out.flush_all();
			sib_out
		})
	};
	let started = std::time::Instant::now();
	let xattrs = Arc::new(Mutex::new(XattrReceiver::new(1 << 30)));
	let (bytes, _) = generate_with(&ctx, &trees_for(tmp.path()), &flists, xattrs, &sib_in, false);
	drop(publisher.join().unwrap());
	assert!(started.elapsed() < std::time::Duration::from_secs(5));
	let (reqs, dones) = parse_with(&bytes, false);
	assert!(reqs.iter().any(|r| r.ndx == 4), "the late segment's file was requested");
	// One NDX_DONE per list plus the three protocol-31 phase markers.
	assert_eq!(dones, 2 + 3);
}

/// G2 (upstream perform_io model): the generator writes its buffered output once per
/// refill of its pipe input and never while pipe input it already read is waiting.
/// Here the receiver delivered the second list, the list end, and every phase end in
/// one batch before the generator started: the refill at the end of the first list
/// writes that list's requests (a reference capture's `D:303`), everything after it is
/// handled from the inbox without I/O, and the rest leaves in the final flush.
#[test]
fn generator_flushes_once_per_refill() {
	let tmp = tempfile::tempdir().unwrap();
	let mut opts = base_opts();
	opts.dry_run = true;
	opts.do_xfers = false;
	let log = Buf::default();
	let mut ctx = make_ctx(opts, tmp.path(), &log);
	ctx.inc_recurse = true;
	let (flists, second) = inc_lists(&ctx.logger);
	let (_out, sib_in) = {
		let (out, sib_in) = sib_pipe(&flists, true);
		flists.push(second);
		flists.set_eof();
		out.data(Sibling::List);
		out.data(Sibling::ListEof);
		for _ in 0..4 {
			out.data(Sibling::Done);
		}
		out.flush_all();
		(out, sib_in)
	};
	let xattrs = Arc::new(Mutex::new(XattrReceiver::new(1 << 30)));
	let (bytes, writes) = generate_with(&ctx, &trees_for(tmp.path()), &flists, xattrs, &sib_in, false);
	assert_eq!(writes, 2);
	let (reqs, dones) = parse_with(&bytes, false);
	assert!(reqs.iter().any(|r| r.ndx == 4), "the forwarded list's file was requested");
	assert_eq!(dones, 2 + 3);
}

/// G2: a list the receiver has published but not yet forwarded stays invisible to the
/// generator (upstream's generator learns of lists only by reading its pipe).
#[test]
fn generator_ignores_lists_not_forwarded_yet() {
	let tmp = tempfile::tempdir().unwrap();
	let mut opts = base_opts();
	opts.dry_run = true;
	opts.do_xfers = false;
	let log = Buf::default();
	let mut ctx = make_ctx(opts, tmp.path(), &log);
	ctx.inc_recurse = true;
	let (flists, second) = inc_lists(&ctx.logger);
	let (sib_out, sib_in) = sib_pipe(&flists, true);
	// Published in the registry, but only the list end and phase ends are forwarded.
	flists.push(second);
	flists.set_eof();
	sib_out.data(Sibling::ListEof);
	for _ in 0..4 {
		sib_out.data(Sibling::Done);
	}
	sib_out.flush_all();
	let xattrs = Arc::new(Mutex::new(XattrReceiver::new(1 << 30)));
	let (bytes, _) = generate_with(&ctx, &trees_for(tmp.path()), &flists, xattrs, &sib_in, false);
	let (reqs, _) = parse_with(&bytes, false);
	assert!(reqs.iter().all(|r| r.ndx != 4), "an unforwarded list is never generated");
}

/// G3: the receiver's pipe output leaves only at its refills and flushes, messages
/// before data; when input is already waiting, a refill that wrote messages keeps the
/// data back (upstream perform_io).
#[test]
fn receiver_pipe_batches_like_perform_io() {
	let flists = Flists::new();
	let (out, sib_in) = sib_pipe(&flists, true);
	out.data(Sibling::List);
	out.msg(Sibling::Success(3));
	out.msg(Sibling::Success(4));
	assert!(sib_in.drain().is_empty(), "nothing leaves before a refill");
	out.refill(true);
	assert_eq!(sib_in.drain(), [Sibling::Success(3), Sibling::Success(4)]);
	out.data(Sibling::Done);
	out.refill(true);
	assert_eq!(sib_in.drain(), [Sibling::List, Sibling::Done]);
	out.msg(Sibling::Redo(5));
	out.data(Sibling::ListEof);
	out.refill(false);
	assert_eq!(sib_in.drain(), [Sibling::Redo(5), Sibling::ListEof]);
}

/// M: `--mkpath src/ dst/new/deeper/` creates all three components and, since the
/// destination then exists, prints no "created directory" line (reference 3.5.1:
/// `created 3 directories for dst/new/deeper`).
#[test]
fn mkpath_with_trailing_slash_creates_every_component() {
	let tmp = tempfile::tempdir().unwrap();
	let mut opts = base_opts();
	opts.verbose = 1;
	opts.mkpath_dest_arg = true;
	let log = Buf::default();
	let ctx = make_ctx(opts, tmp.path(), &log);
	let flists = publish(vec![entry(".", 0o040755, 0, T), entry("a", 0o100644, 1, T)], &ctx.logger);
	let trees = DestTrees::open(&ctx, Some(std::ffi::OsStr::new("dst/new/deeper/")), &flists).unwrap();
	ctx.logger.flush();
	assert!(tmp.path().join("dst/new/deeper").is_dir());
	assert!(trees.single_file.is_none());
	assert_eq!(String::from_utf8(log.bytes()).unwrap(), "created 3 directories for dst/new/deeper\n");
	let dot = flists.entry(0).unwrap();
	assert_eq!(dot.flags & crate::rsync::consts::FLAG_DIR_CREATED, 0);
}

/// B7: `--confine-root` bounds option-named paths, not the destination transfer root.
#[cfg(unix)]
#[test]
fn confine_root_does_not_bound_the_destination() {
	let tmp = tempfile::tempdir().unwrap();
	let root = tmp.path().join("root");
	std::fs::create_dir_all(&root).unwrap();
	std::fs::create_dir_all(tmp.path().join("d")).unwrap();
	let mut opts = base_opts();
	opts.confine_root = Some(root.into_os_string());
	let log = Buf::default();
	let ctx = make_ctx(opts, tmp.path(), &log);
	let flists = publish(vec![entry("keep", 0o100644, 1, T)], &ctx.logger);
	let trees = DestTrees::open(&ctx, Some(std::ffi::OsStr::new("d/")), &flists).unwrap();
	assert_eq!(trees.dest.root(), tmp.path().join("d").as_path());
}

/// B11: under --fake-super a FIFO arrives as an empty regular file whose real type and
/// mode live in the stat xattr (reference: `-rw-r--r--` plus `rsync.%stat` =
/// `10644 0,0 0:0`).
#[cfg(unix)]
#[test]
fn fake_super_creates_placeholder_for_specials() {
	use std::os::unix::fs::FileTypeExt;
	let tmp = tempfile::tempdir().unwrap();
	let dest = tmp.path();
	let mut opts = base_opts();
	opts.am_root = -1;
	opts.preserve_specials = true;
	let log = Buf::default();
	let mut ctx = make_ctx(opts, dest, &log);
	ctx.meta.fake_super = true;
	let flists = publish(vec![entry("p", 0o010644, 0, T)], &ctx.logger);
	generate(&ctx, &trees_for(dest), &flists);
	let meta = std::fs::symlink_metadata(dest.join("p")).unwrap();
	assert!(meta.file_type().is_file() && !meta.file_type().is_fifo());
	let tree = open_tree(dest);
	let probe = Path::new("probe");
	std::fs::write(dest.join(probe), b"").unwrap();
	let xattrs_work = tree.set_xattr(probe, std::ffi::OsStr::new("user.probe"), b"1", false).is_ok();
	if xattrs_work {
		let stat = tree.get_xattr(Path::new("p"), std::ffi::OsStr::new(crate::rsync::meta::XSTAT_ATTR), false);
		assert_eq!(stat.unwrap().as_deref(), Some(&b"10644 0,0 0:0"[..]));
	}
}

/// B13: a new directory whose `--copy-dest` twin is up to date gets that twin's long
/// (abbreviated on the wire) xattr values (reference: `xattr to2/foo` lists dir1).
#[cfg(target_os = "macos")]
#[test]
fn copy_dest_uptodate_dir_keeps_long_xattrs() {
	use crate::rsync::xattr::{XattrOpts, XattrSender, XattrSet};
	let tmp = tempfile::tempdir().unwrap();
	let alt = tmp.path().join("chk");
	let dest = tmp.path().join("to");
	std::fs::create_dir_all(alt.join("foo")).unwrap();
	std::fs::create_dir_all(&dest).unwrap();
	let value = b"need to test directory xattrs too".to_vec();
	let alt_tree = open_tree(&alt);
	alt_tree.set_xattr(Path::new("foo"), std::ffi::OsStr::new("dir1"), &value, false).unwrap();
	set_mtime(&alt.join("foo"), T);

	// The xattr set as the sender transmits it: the long value travels as a digest.
	let set = XattrSet { items: vec![(b"dir1".to_vec(), value.clone())], abbrev: Vec::new() };
	let mut wire = Vec::new();
	XattrSender::with_opts(XattrOpts::default()).send_indexed(&mut wire, &set, proto()).unwrap();
	let mut receiver = XattrReceiver::new(1 << 30);
	let ndx = receiver.recv_named(&mut &wire[..], proto(), b"foo").unwrap();

	let mut opts = base_opts();
	opts.preserve_xattrs = 1;
	opts.alt_dest_type = crate::rsync::consts::COPY_DEST;
	let log = Buf::default();
	let mut ctx = make_ctx(opts, &dest, &log);
	ctx.meta.xattrs = true;
	let mut foo = entry("foo", 0o040755, 0, T);
	foo.xattr = Some(ndx);
	let flists = publish(vec![foo], &ctx.logger);
	let mut trees = trees_for(&dest);
	trees.alt_dirs.push(alt_tree);
	let (_out, sib_in) = finished_pipe(&ctx, &flists);
	generate_with(&ctx, &trees, &flists, Arc::new(Mutex::new(receiver)), &sib_in, false);
	let got = open_tree(&dest).get_xattr(Path::new("foo"), std::ffi::OsStr::new("dir1"), false).unwrap();
	assert_eq!(got, Some(value));
}

/// B15: with --only-write-batch nothing exists on the receiving side yet, so success
/// must never reach the sender as a removal request (upstream send_msg_success).
#[test]
fn only_write_batch_never_requests_source_removal() {
	let tmp = tempfile::tempdir().unwrap();
	let dest = tmp.path();
	write_file(&dest.join("a"), b"same", T);
	let run_with = |write_batch: i32| {
		let mut opts = base_opts();
		opts.remove_source_files = 1;
		opts.write_batch = write_batch;
		let log = Buf::default();
		let ctx = make_ctx(opts, dest, &log);
		let flists = publish(vec![entry("a", 0o100644, 4, T)], &ctx.logger);
		let (_out, sib_in) = finished_pipe(&ctx, &flists);
		let xattrs = Arc::new(Mutex::new(XattrReceiver::new(1 << 30)));
		let (bytes, _) = generate_with(&ctx, &trees_for(dest), &flists, xattrs, &sib_in, true);
		frames(&bytes).iter().filter(|(code, _)| *code == crate::rsync::consts::MSG_SUCCESS).count()
	};
	// The up-to-date file is reported as done for --remove-source-files...
	assert_eq!(run_with(0), 1);
	// ...but not when only writing a batch.
	assert_eq!(run_with(-1), 0);
}

/// B16 (--inplace): a relative --backup-dir reached through the operator's own symlink
/// to outside the destination still gets the backup copy and the file is still
/// requested, but applying the backup's attributes by its dest-relative name fails like
/// upstream (`[generator] stat ".../opd/sub/f0" failed: Too many levels of symbolic
/// links`, exit 23), leaving the copy at its creation mode 0600.
///
/// The reference behaves the same with `--no-W` (the backup is filled block by block
/// while the sums are generated); an "unchanged" run only happens when size and mtime
/// match, which is the plain quick check.
#[cfg(unix)]
#[test]
fn inplace_backup_through_operator_symlink_still_updates() {
	for whole_file in [1, 0] {
		inplace_backup_case(whole_file);
	}
}

#[cfg(unix)]
fn inplace_backup_case(whole_file: i32) {
	use std::os::unix::fs::PermissionsExt;
	let tmp = tempfile::tempdir().unwrap();
	let dest = tmp.path().join("dest");
	let outside = tmp.path().join("outside");
	std::fs::create_dir_all(&dest).unwrap();
	std::fs::create_dir_all(&outside).unwrap();
	write_file(&dest.join("f0"), b"OLD\n", T - 100);
	std::fs::set_permissions(dest.join("f0"), std::fs::Permissions::from_mode(0o644)).unwrap();
	std::os::unix::fs::symlink(&outside, dest.join("opd")).unwrap();

	let mut opts = base_opts();
	opts.inplace = true;
	opts.make_backups = true;
	opts.backup_dir = Some("opd/sub".into());
	opts.whole_file = whole_file;
	let log = Buf::default();
	let ctx = make_ctx(opts, &dest, &log);
	let flists = publish(vec![entry("f0", 0o100644, 19, T)], &ctx.logger);
	let (reqs, _) = parse(&generate(&ctx, &trees_for(&dest), &flists));
	ctx.logger.flush();

	// The update still goes ahead (with --no-W against the 4-byte basis: one block sum).
	assert_eq!(reqs.len(), 1);
	assert!(reqs[0].iflags & ITEM_TRANSFER != 0);
	let blocks = if whole_file == 1 { 0 } else { 1 };
	assert_eq!(reqs[0].head.map(|h| h.count), Some(blocks));
	// The backup escaped through the operator's symlink, mode as created.
	let backup = outside.join("sub/f0");
	assert_eq!(std::fs::read(&backup).unwrap(), b"OLD\n");
	assert_eq!(std::fs::metadata(&backup).unwrap().permissions().mode() & 0o777, 0o600);
	let text = String::from_utf8(log.bytes()).unwrap();
	let want = format!(
		"rsync: [generator] stat \"{}\" failed: Too many levels of symbolic links (",
		dest.join("opd/sub/f0").display()
	);
	assert!(text.contains(&want), "{text}");
	assert!(ctx.logger.got_xfer_error());
}

/// devices-fake: under --fake-super a --link-dest special is stored as a regular
/// placeholder carrying its real type in the stat xattr; the alt-dest lookup must see
/// it through that record and hard-link it (reference `-aii --specials --fake-super
/// --link-dest=…`: `hS          fifo`, same inode) instead of creating a new one.
#[cfg(unix)]
#[test]
fn fake_super_link_dest_links_special_placeholders() {
	use std::os::unix::fs::MetadataExt;
	let tmp = tempfile::tempdir().unwrap();
	let alt = tmp.path().join("ld");
	let dest = tmp.path().join("o1");
	std::fs::create_dir_all(&alt).unwrap();
	std::fs::create_dir_all(&dest).unwrap();
	write_file(&alt.join("fifo"), b"", T);
	let alt_tree = open_tree(&alt);
	let record = alt_tree.set_xattr(
		Path::new("fifo"),
		std::ffi::OsStr::new(crate::rsync::meta::XSTAT_ATTR),
		b"10644 0,0 0:0",
		false,
	);
	if record.is_err() {
		// No xattr support on this temp filesystem: fake-super cannot work here.
		return;
	}

	let mut opts = base_opts();
	opts.am_root = -1;
	opts.preserve_specials = true;
	opts.stdout_format_has_i = 3;
	opts.itemize_changes = 2;
	opts.alt_dest_type = LINK_DEST;
	let log = Buf::default();
	let mut ctx = make_ctx(opts, &dest, &log);
	ctx.meta.fake_super = true;
	let flists = publish(vec![entry("fifo", 0o010644, 0, T)], &ctx.logger);
	let mut trees = trees_for(&dest);
	trees.alt_dirs.push(alt_tree);
	let (reqs, _) = parse(&generate(&ctx, &trees, &flists));

	assert_eq!(
		std::fs::metadata(alt.join("fifo")).unwrap().ino(),
		std::fs::metadata(dest.join("fifo")).unwrap().ino()
	);
	assert_eq!(reqs.len(), 1);
	let e = flists.entry(reqs[0].ndx).unwrap();
	let ictx = ItemizeCtx { local_server: true, preserve_mtimes: true, receiver_symlink_times: true };
	assert_eq!(&itemize(reqs[0].iflags, e.mode, "recv", ictx), b"hS         ");
}
