use std::ffi::OsString;
use std::io::{Cursor, Write};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use super::*;
use crate::rsync::consts::{
	CF_INC_RECURSE, CF_VARINT_FLIST_FLAGS, FLAG_IMPLIED_DIR, MIN_FILECNT_LOOKAHEAD,
};
use crate::rsync::filter::FilterConfig;
use crate::rsync::mux::{IoCounters, MuxReader, ReadConfig, WriteConfig};
use crate::rsync::options::Options;
use crate::rsync::wire::Proto;

#[derive(Clone, Default)]
struct Sink(Arc<Mutex<Vec<u8>>>);

impl Write for Sink {
	fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
		self.0.lock().unwrap().extend_from_slice(buf);
		Ok(buf.len())
	}

	fn flush(&mut self) -> io::Result<()> {
		Ok(())
	}
}

fn proto(version: u32, inc: bool) -> Proto {
	let mut compat = 0;
	if version >= 30 {
		compat |= CF_SAFE_FLIST | CF_VARINT_FLIST_FLAGS;
		if inc {
			compat |= CF_INC_RECURSE;
		}
	}
	Proto { version, compat }
}

fn base_opts() -> Options {
	let mut o = Options::default();
	o.recurse = 2;
	o.xfer_dirs = 1;
	o.relative_paths = 0;
	o.implied_dirs = true;
	o.preserve_links = true;
	o.preserve_perms = true;
	o.preserve_mtimes = true;
	o
}

fn ctx_for(opts: Options, p: Proto, inc: bool, am_sender: bool, cwd: &Path) -> Ctx {
	let mut o = opts;
	o.am_sender = am_sender;
	let mut ctx = Ctx::for_tests(o);
	ctx.proto = p;
	ctx.inc_recurse = inc;
	ctx.flist_opts.inc_recurse = inc;
	ctx.acl_opts.inc_recurse = inc;
	ctx.am_sender = am_sender;
	ctx.cwd = cwd.to_path_buf();
	ctx
}

fn write_file(path: &Path, data: &[u8]) {
	std::fs::write(path, data).unwrap();
}

/// The fixture the reference outputs below were captured on.
fn fixture() -> tempfile::TempDir {
	let tmp = tempfile::tempdir().unwrap();
	let src = tmp.path().join("src");
	std::fs::create_dir_all(src.join("a/b")).unwrap();
	std::fs::create_dir_all(src.join("c")).unwrap();
	write_file(&src.join("f1"), b"1\n");
	write_file(&src.join("a/f2"), b"2\n");
	write_file(&src.join("a/b/f3"), b"3\n");
	write_file(&src.join("c/f4"), b"4\n");
	#[cfg(unix)]
	std::os::unix::fs::symlink("f1", src.join("l1")).unwrap();
	tmp
}

/// Runs a whole sender scan; returns the wire bytes and the sender's registry.
fn scan(ctx: &Ctx, sources: &[&str], files_from: Option<&[u8]>) -> (Vec<u8>, Arc<Flists>) {
	let (bytes, flists, _) = scan_with(ctx, sources, files_from, Filters::new(FilterConfig::default()));
	(bytes, flists)
}

/// [`scan`] with sender filters, also returning the scanner (for transfer-time lookups).
/// The writer counts into `ctx.counters`, as the session wires it.
fn scan_with(
	ctx: &Ctx,
	sources: &[&str],
	files_from: Option<&[u8]>,
	filters: Filters,
) -> (Vec<u8>, Arc<Flists>, Scanner) {
	let sink = Sink::default();
	let out = MuxWriter::new(Box::new(sink.clone()), ctx.counters.clone(), WriteConfig::default());
	let srcs: Vec<OsString> = sources.iter().map(OsString::from).collect();
	let ff = files_from.map(|b| Box::new(Cursor::new(b.to_vec())) as Box<dyn Read + Send>);
	let mut scanner = Scanner::new(ctx, &srcs, filters, ff).unwrap();
	let flists = Flists::new();
	scanner.send_initial(&out, &flists).unwrap();
	while !flists.is_eof() {
		scanner.send_extra_at_least(&out, &flists, MIN_FILECNT_LOOKAHEAD).unwrap();
	}
	let mut w = out.clone();
	w.flush().unwrap();
	let bytes = sink.0.lock().unwrap().clone();
	(bytes, flists, scanner)
}

/// A canonical temporary directory (confinement compares physical paths; macOS's
/// temp dir lives behind the `/var` symlink). Resolved like `realpath`, not
/// `std::fs::canonicalize`, which spells Windows paths `\\?\…` where `/` is no
/// separator.
fn canonical_tmp() -> (tempfile::TempDir, PathBuf) {
	let tmp = tempfile::tempdir().unwrap();
	let root = pi_vfs::BlockingFs::native()
		.canonicalize_with(tmp.path(), &pi_vfs::CanonicalizeOptions::default())
		.unwrap();
	(tmp, root)
}

fn flist_size(ctx: &Ctx) -> i64 {
	lock(&ctx.stats).flist_size
}

/// Decodes everything a scan wrote; returns the registry and the announced dir indices.
fn receive(ctx: &Ctx, bytes: Vec<u8>) -> (Arc<Flists>, Vec<i32>) {
	let mut input = MuxReader::new(
		Box::new(Cursor::new(bytes)),
		IoCounters::default(),
		Arc::new(AtomicBool::new(false)),
		ReadConfig::default(),
	);
	let mut fr = FlistReceiver::new(ctx, None);
	let flists = Flists::new();
	fr.recv_initial(&mut input, &flists).unwrap();
	let mut announced = Vec::new();
	if ctx.inc_recurse {
		loop {
			let ndx = fr.ndx_codec().read(&mut input).unwrap();
			if ndx == NDX_FLIST_EOF {
				flists.set_eof();
				break;
			}
			let dir = NDX_FLIST_OFFSET - ndx;
			announced.push(dir);
			fr.recv_extra(&mut input, &flists, dir).unwrap();
		}
	}
	(flists, announced)
}

/// (name, mode, dir flags) of every active entry, in registry order.
fn entries(fl: &Flists) -> Vec<(String, u32, u32)> {
	let mut out = Vec::new();
	for seg in 0..fl.len() {
		fl.with_segment(seg, |l| {
			for e in l.entries.iter().filter(|e| e.is_active()) {
				let dir_flags = if e.is_dir() { e.flags & (FLAG_TOP_DIR | FLAG_CONTENT_DIR | FLAG_IMPLIED_DIR) } else { 0 };
				out.push((String::from_utf8_lossy_owned(e.name()), e.mode, dir_flags));
			}
		});
	}
	out
}

fn names(fl: &Flists) -> Vec<String> {
	let mut v: Vec<String> = entries(fl).into_iter().map(|(n, _, _)| n).collect();
	v.sort();
	v
}

#[test]
fn round_trip_across_protocols_and_inc_recursion() {
	let tmp = fixture();
	std::fs::create_dir_all(tmp.path().join("src/a/b/d")).unwrap();
	let src = format!("{}/src/", tmp.path().display());
	for (version, inc) in [(29, false), (31, false), (31, true), (33, false), (33, true)] {
		let p = proto(version, inc);
		let sctx = ctx_for(base_opts(), p, inc, true, tmp.path());
		let (bytes, sent) = scan(&sctx, &[src.as_str()], None);
		let rctx = ctx_for(base_opts(), p, inc, false, tmp.path());
		let (got, _) = receive(&rctx, bytes);
		let mut a = entries(&sent);
		let mut b = entries(&got);
		a.sort();
		b.sort();
		assert_eq!(a, b, "protocol {version} inc={inc}");
		assert!(got.is_eof());
		let want: Vec<&str> = if cfg!(unix) {
			vec![".", "a", "a/b", "a/b/d", "a/b/f3", "a/f2", "c", "c/f4", "f1", "l1"]
		} else {
			vec![".", "a", "a/b", "a/b/d", "a/b/f3", "a/f2", "c", "c/f4", "f1"]
		};
		assert_eq!(names(&got), want, "protocol {version} inc={inc}");
		// The top dir is a content top dir; sub-dirs are content dirs.
		let dot = b.iter().find(|(n, _, _)| n == ".").unwrap();
		assert_eq!(dot.2, FLAG_TOP_DIR | FLAG_CONTENT_DIR);
		let sub = b.iter().find(|(n, _, _)| n == "a/b").unwrap();
		assert_eq!(sub.2, FLAG_CONTENT_DIR);
	}
}

#[test]
fn operand_rules_match_reference_name_lists() {
	// Captured with `rsync -n -r [-R|-d] --out-format=%n` (plus the "." the sender
	// lists for a trailing-slash operand, which %n does not print).
	let tmp = fixture();
	let root = tmp.path();
	let run = |o: Options, version: u32, srcs: &[&str]| {
		let ctx = ctx_for(o, proto(version, false), false, true, root);
		let (_, fl) = scan(&ctx, srcs, None);
		fl
	};
	let link: &[&str] = if cfg!(unix) { &["l1"] } else { &[] };

	let fl = run(base_opts(), 33, &["src/"]);
	let mut want = vec![".", "a", "a/b", "a/b/f3", "a/f2", "c", "c/f4", "f1"];
	want.extend(link);
	want.sort();
	assert_eq!(names(&fl), want);

	let fl = run(base_opts(), 33, &["src"]);
	let mut want = vec!["src", "src/a", "src/a/b", "src/a/b/f3", "src/a/f2", "src/c", "src/c/f4", "src/f1"];
	if cfg!(unix) {
		want.push("src/l1");
	}
	want.sort();
	assert_eq!(names(&fl), want);

	let mut rel = base_opts();
	rel.relative_paths = 1;
	let fl = run(rel.clone(), 33, &["src/a/b"]);
	assert_eq!(names(&fl), ["src", "src/a", "src/a/b", "src/a/b/f3"]);
	let implied: Vec<_> = entries(&fl).into_iter().filter(|(_, _, f)| f & FLAG_IMPLIED_DIR != 0).map(|(n, _, _)| n).collect();
	assert_eq!(implied, ["src", "src/a"]);

	let fl = run(rel.clone(), 33, &["src/./a/b"]);
	assert_eq!(names(&fl), ["a", "a/b", "a/b/f3"]);

	let mut no_implied = rel.clone();
	no_implied.implied_dirs = false;
	let fl = run(no_implied, 29, &["src/a/b/f3"]);
	assert_eq!(names(&fl), ["src/a/b/f3"]);

	let mut dirs_only = base_opts();
	dirs_only.recurse = 0;
	let fl = run(dirs_only, 33, &["src/"]);
	let mut want = vec![".", "a", "c", "f1"];
	want.extend(link);
	want.sort();
	assert_eq!(names(&fl), want);

	let fl = run(base_opts(), 33, &["src/a", "src/c/"]);
	assert_eq!(names(&fl), [".", "a", "a/b", "a/b/f3", "a/f2", "f4"]);
}

#[test]
fn relative_dot_dot_is_refused() {
	let tmp = fixture();
	let mut rel = base_opts();
	rel.relative_paths = 1;
	let ctx = ctx_for(rel, proto(33, false), false, true, tmp.path());
	let sink = Sink::default();
	let out = MuxWriter::new(Box::new(sink), IoCounters::default(), WriteConfig::default());
	let mut scanner = Scanner::new(&ctx, &[OsString::from("src/../src/f1")], Filters::new(FilterConfig::default()), None).unwrap();
	let err = scanner.send_initial(&out, &Flists::new()).unwrap_err();
	assert_eq!(err.code, RERR_SYNTAX);
	assert_eq!(err.message.as_deref(), Some("found \"..\" dir in relative path: src/../src/f1"));
}

#[test]
fn files_from_lines() {
	let ctx = ctx_for(base_opts(), proto(33, false), false, true, &std::env::temp_dir());
	let lines = |data: &[u8], nulls: bool, comments: bool| {
		let mut r = Cursor::new(data.to_vec());
		let mut out = Vec::new();
		loop {
			let l = read_line(&mut r, nulls, comments, &ctx).unwrap();
			if l.is_empty() {
				break;
			}
			out.push(String::from_utf8(l).unwrap());
		}
		out
	};
	// Local file: CR/LF both end lines, blank lines and comments are skipped.
	assert_eq!(lines(b"a\r\n\r\nb\n#c\n;d\n\ne", false, true), ["a", "b", "e"]);
	// Local file with -0: NUL-terminated, comments still skipped.
	assert_eq!(lines(b"a\0\0#x\0b c\0", true, true), ["a", "b c"]);
	// Remote stream: NUL-terminated, an empty name ends the list.
	assert_eq!(lines(b"a\0b\0\0c\0", true, false), ["a", "b"]);
	// A remote list with a newline in a name keeps it.
	assert_eq!(lines(b"x\ny\0", true, false), ["x\ny"]);
}

#[test]
fn files_from_sends_implied_parents_without_recursion() {
	let tmp = fixture();
	let mut o = base_opts();
	o.relative_paths = 1;
	o.recurse = 0;
	let ctx = ctx_for(o, proto(33, false), false, true, tmp.path());
	let dir = format!("{}/src", tmp.path().display());
	let (_, fl) = scan(&ctx, &[dir.as_str()], Some(b"f1\na/b/f3\n\n#skip\nc\n"));
	assert_eq!(names(&fl), ["a", "a/b", "a/b/f3", "c", "f1"]);
}

#[test]
fn missing_args_policies() {
	let tmp = fixture();
	let mut o = base_opts();
	o.missing_args = 2;
	let ctx = ctx_for(o, proto(33, false), false, true, tmp.path());
	let (_, fl) = scan(&ctx, &["src/f1", "src/nope"], None);
	let e = entries(&fl);
	assert_eq!(e.iter().map(|(n, _, _)| n.as_str()).collect::<Vec<_>>(), ["f1", "nope"]);
	assert_eq!(e[1].1, 0, "a missing arg is sent with mode 0");

	let mut o = base_opts();
	o.missing_args = 1;
	let ctx = ctx_for(o, proto(33, false), false, true, tmp.path());
	let (_, fl) = scan(&ctx, &["src/f1", "src/nope"], None);
	assert_eq!(names(&fl), ["f1"]);
	assert_eq!(ctx.io_error.load(Ordering::Relaxed), 0);
}

#[test]
fn inc_recursion_segment_order_matches_reference() {
	// Reference (`rsync -n -r --debug=FLIST3 src/ dst/`): segments start at 1, 7, 11,
	// 14, 15, 16, 19 for dirs a, a/b, a/b/d, a/e, c, c/g announced as dir_ndx
	// 1, 3, 5, 4, 2, 6.
	let tmp = fixture();
	for d in ["src/a/b/d", "src/a/e", "src/c/g"] {
		std::fs::create_dir_all(tmp.path().join(d)).unwrap();
	}
	let p = proto(33, true);
	let sctx = ctx_for(base_opts(), p, true, true, tmp.path());
	let (bytes, sent) = scan(&sctx, &["src/"], None);
	let rctx = ctx_for(base_opts(), p, true, false, tmp.path());
	let (got, announced) = receive(&rctx, bytes);
	assert_eq!(announced, [1, 3, 5, 4, 2, 6]);
	for fl in [&sent, &got] {
		let starts: Vec<i32> = (0..fl.len()).map(|s| fl.segment_start(s).unwrap()).collect();
		if cfg!(unix) {
			assert_eq!(starts, [1, 7, 11, 14, 15, 16, 19]);
		}
		let parents: Vec<String> = (1..fl.len())
			.map(|s| {
				let ndx = fl.segment_parent(s).unwrap();
				String::from_utf8(fl.entry(ndx).unwrap().name()).unwrap()
			})
			.collect();
		assert_eq!(parents, ["a", "a/b", "a/b/d", "a/e", "c", "c/g"]);
		// The first list's parent is its "." entry; gap indices resolve to parents.
		assert_eq!(fl.segment_parent(0), Some(1));
		assert_eq!(fl.entry(starts[1] - 1).unwrap().name(), b"a");
	}
	let dir_names: Vec<String> = (0..got.dir_count())
		.map(|i| String::from_utf8(got.dir_entry(i).unwrap().name()).unwrap())
		.collect();
	assert_eq!(dir_names, [".", "a", "c", "a/b", "a/e", "a/b/d", "c/g"]);
}

#[test]
fn receiver_rejects_bad_dir_indices() {
	let tmp = fixture();
	let p = proto(33, true);
	let sctx = ctx_for(base_opts(), p, true, true, tmp.path());
	let (bytes, _) = scan(&sctx, &["src/"], None);
	let rctx = ctx_for(base_opts(), p, true, false, tmp.path());
	let mut input = MuxReader::new(
		Box::new(Cursor::new(bytes)),
		IoCounters::default(),
		Arc::new(AtomicBool::new(false)),
		ReadConfig::default(),
	);
	let mut fr = FlistReceiver::new(&rctx, None);
	let flists = Flists::new();
	fr.recv_initial(&mut input, &flists).unwrap();
	let count = flists.dir_count() as i32;
	let err = fr.recv_extra(&mut input, &flists, count).unwrap_err();
	assert_eq!(err.code, RERR_PROTOCOL);
	let who = rctx.logger.role().name();
	let want = format!(
		"Invalid dir index: {} (-101 - {}) [{who}]",
		NDX_FLIST_OFFSET - count,
		NDX_FLIST_OFFSET - count + 1
	);
	assert_eq!(err.message.as_deref(), Some(want.as_str()));
	// The sender announces dir 1 first; receiving it twice is refused.
	let ndx = fr.ndx_codec().read(&mut input).unwrap();
	assert_eq!(NDX_FLIST_OFFSET - ndx, 1);
	fr.recv_extra(&mut input, &flists, 1).unwrap();
	let err = fr.recv_extra(&mut input, &flists, 1).unwrap_err();
	assert_eq!(err.message.as_deref(), Some("rsync: refusing malicious duplicate flist for dir 1"));
}

#[test]
fn receiver_flags_paths_outside_the_announced_dir() {
	// A segment for dir "a" whose entry lives under "c" aborts the transfer.
	let tmp = fixture();
	let p = proto(33, true);
	let rctx = ctx_for(base_opts(), p, true, false, tmp.path());
	let flists = Flists::new();
	let dir = FileEntry { basename: b"a".to_vec().into(), mode: 0o040755, ..FileEntry::default() };
	flists.push(FileList { entries: vec![dir], ndx_start: 1, parent_ndx: -1 });
	let mut enc = FlistEncoder::new(p, rctx.flist_opts.clone());
	let mut ids = IdLists::new(p, &rctx.flist_opts);
	let mut wire = Vec::new();
	enc.start_list(3);
	let bad = FileEntry {
		dirname: Arc::from(&b"c"[..]),
		basename: b"x".to_vec().into(),
		mode: 0o100644,
		..FileEntry::default()
	};
	enc.send_entry(&mut wire, &bad, 3, &mut ids).unwrap();
	enc.send_end(&mut wire, 0).unwrap();
	let mut input = MuxReader::new(
		Box::new(Cursor::new(wire)),
		IoCounters::default(),
		Arc::new(AtomicBool::new(false)),
		ReadConfig::default(),
	);
	let mut fr = FlistReceiver::new(&rctx, None);
	let err = fr.recv_extra(&mut input, &flists, 0).unwrap_err();
	assert_eq!(err.code, RERR_UNSUPPORTED);
	assert_eq!(err.message.as_deref(), Some("ABORTING due to invalid path from sender: c/x"));
}

#[test]
fn sort_with_order_records_transmission_positions() {
	let mk = |n: &str| FileEntry { basename: n.as_bytes().into(), mode: 0o100644, ..FileEntry::default() };
	let (sorted, order) = sort_with_order(vec![(mk("c"), ()), (mk("a"), ()), (mk("b"), ())], proto(33, false));
	let names: Vec<&[u8]> = sorted.iter().map(|(e, ())| &*e.basename).collect();
	assert_eq!(names, [b"a" as &[u8], b"b", b"c"]);
	assert_eq!(order, [2, 0, 1]);
}

#[cfg(unix)]
#[test]
fn iconv_names_round_trip() {
	let tmp = tempfile::tempdir().unwrap();
	let src = tmp.path().join("src");
	std::fs::create_dir(&src).unwrap();
	write_file(&src.join("plain"), b"x");
	let p = proto(31, false);
	let mut o = base_opts();
	o.need_unsorted_flist = true;
	let mut sctx = ctx_for(o.clone(), p, false, true, tmp.path());
	// Local names are UTF-8 on both sides here; the wire spelling is UTF-8 too.
	sctx.iconv = Some(Arc::new(crate::rsync::iconv::Iconv::with_locale(b"UTF-8", false, None).unwrap()));
	let operand = format!("{}/", src.display());
	let (bytes, sent) = scan(&sctx, &[operand.as_str()], None);
	let mut rctx = ctx_for(o, p, false, false, tmp.path());
	rctx.iconv = Some(Arc::new(crate::rsync::iconv::Iconv::with_locale(b"UTF-8", true, None).unwrap()));
	let (got, _) = receive(&rctx, bytes);
	assert_eq!(names(&sent), names(&got));
	// Both sides agree on the index the peer uses for every name.
	let wire_of = |fl: &Flists| -> Vec<(Vec<u8>, i32)> {
		let len = fl.segment_len(0).unwrap() as i32;
		let mut v: Vec<_> = (0..len).map(|i| (fl.entry(i).unwrap().name(), fl.to_wire(i))).collect();
		v.sort();
		v
	};
	assert_eq!(wire_of(&sent), wire_of(&got));
}

#[test]
fn sender_flist_size_counts_only_bytes_written_out() {
	// R2. Reference (`rsync -a --stats src/ dst/`): "File list size: 0". The list sits in
	// the output buffer while it is built, so nothing reaches the fd before it is done.
	let tmp = fixture();
	for inc in [false, true] {
		let ctx = ctx_for(base_opts(), proto(33, inc), inc, true, tmp.path());
		let (bytes, _) = scan(&ctx, &["src/"], None);
		assert!(!bytes.is_empty());
		assert_eq!(flist_size(&ctx), 0, "inc={inc}");
	}
}

#[test]
fn receiver_flist_size_counts_whole_frames() {
	// R3. Reference pull: the sender's lists (initial, sub-lists, NDX_FLIST_EOF) arrive as
	// one MSG_DATA frame; the initial recv_file_list reads it whole, header included
	// (927 = 4 + 923), and the later lists add nothing.
	let tmp = fixture();
	let p = proto(33, true);
	let sctx = ctx_for(base_opts(), p, true, true, tmp.path());
	let (payload, _) = scan(&sctx, &["src/"], None);
	let header = ((u32::from(crate::rsync::consts::MPLEX_BASE + crate::rsync::consts::MSG_DATA)) << 24)
		| payload.len() as u32;
	let mut stream = header.to_le_bytes().to_vec();
	stream.extend_from_slice(&payload);
	let rctx = ctx_for(base_opts(), p, true, false, tmp.path());
	let mut input = MuxReader::new(
		Box::new(Cursor::new(stream)),
		IoCounters::default(),
		Arc::new(AtomicBool::new(false)),
		ReadConfig::default(),
	);
	input.start_multiplex(Box::new(|_| Ok(()))).unwrap();
	let mut fr = FlistReceiver::new(&rctx, None);
	let flists = Flists::new();
	fr.recv_initial(&mut input, &flists).unwrap();
	let whole = 4 + payload.len() as i64;
	assert_eq!(flist_size(&rctx), whole);
	loop {
		let ndx = fr.ndx_codec().read(&mut input).unwrap();
		if ndx == NDX_FLIST_EOF {
			break;
		}
		fr.recv_extra(&mut input, &flists, NDX_FLIST_OFFSET - ndx).unwrap();
	}
	assert_eq!(flist_size(&rctx), whole);

	// Raw (unmultiplexed) input counts the bytes the list consumed.
	let p = proto(29, false);
	let sctx = ctx_for(base_opts(), p, false, true, tmp.path());
	let (bytes, _) = scan(&sctx, &["src/"], None);
	let rctx = ctx_for(base_opts(), p, false, false, tmp.path());
	let len = bytes.len() as i64;
	receive(&rctx, bytes);
	assert_eq!(flist_size(&rctx), len);
}

#[cfg(unix)]
#[test]
fn files_from_symlink_refused_by_confine_root_is_a_stat_error() {
	// B6. Reference: `rsync -r --confine-root=ROOT --files-from=ROOT/ff ROOT/ ROOT/dest/`
	// with `outside-link/` → `[sender] link_stat "ROOT/outside-link" failed: Too many
	// levels of symbolic links (62)`, code 23; not "skipping non-regular file".
	let (_tmp, base) = canonical_tmp();
	let root = base.join("root");
	std::fs::create_dir_all(root.join("dest")).unwrap();
	std::fs::create_dir_all(base.join("outside")).unwrap();
	write_file(&base.join("outside/marker"), b"o\n");
	std::os::unix::fs::symlink(base.join("outside"), root.join("outside-link")).unwrap();
	let mut o = base_opts();
	o.relative_paths = 1;
	o.confine_root = Some(root.clone().into_os_string());
	let ctx = ctx_for(o, proto(33, false), false, true, &base);
	let root_s = root.to_str().unwrap().to_owned();
	let (_, fl, _) =
		scan_with(&ctx, &[root_s.as_str()], Some(b"outside-link/\n"), Filters::new(FilterConfig::default()));
	assert!(names(&fl).is_empty(), "{:?}", names(&fl));
	assert_ne!(ctx.io_error.load(Ordering::Relaxed) & IOERR_GENERAL, 0);
}

#[test]
fn confine_root_does_not_bound_transfer_roots() {
	// B7. Reference: `rsync -r --confine-root=X/root X/other/ d/` transfers normally:
	// --confine-root bounds operator/peer-supplied paths, not the operands.
	let (_tmp, base) = canonical_tmp();
	std::fs::create_dir_all(base.join("root")).unwrap();
	std::fs::create_dir_all(base.join("other/sub")).unwrap();
	write_file(&base.join("other/sub/f"), b"x");
	let mut o = base_opts();
	o.confine_root = Some(base.join("root").into_os_string());
	let ctx = ctx_for(o, proto(33, false), false, true, &base);
	let (_, fl) = scan(&ctx, &["other/"], None);
	assert_eq!(names(&fl), [".", "sub", "sub/f"]);
	assert_eq!(ctx.io_error.load(Ordering::Relaxed), 0);
}

#[test]
fn dir_merge_files_outside_confine_root_are_not_read() {
	// B8. Reference: `--filter=':- ../outside-secret'` with --confine-root=X/root lists
	// `secretword` (the merge file outside the root is not read); without the option the
	// merge file excludes it.
	let (_tmp, base) = canonical_tmp();
	let root = base.join("root");
	std::fs::create_dir_all(root.join("sub")).unwrap();
	write_file(&base.join("outside-secret"), b"secretword\n");
	write_file(&root.join("secretword"), b"X\n");
	write_file(&root.join("keep"), b"X\n");
	let filters = || {
		let mut f = Filters::new(FilterConfig::default());
		f.add(crate::rsync::filter::RuleArg::Filter(b":- ../outside-secret"), &|_| Ok(Vec::new()))
			.unwrap();
		f
	};
	let ctx = ctx_for(base_opts(), proto(33, false), false, true, &base);
	let (_, fl, _) = scan_with(&ctx, &["root/"], None, filters());
	assert_eq!(names(&fl), [".", "keep", "sub"]);

	let mut o = base_opts();
	o.confine_root = Some(root.clone().into_os_string());
	let ctx = ctx_for(o, proto(33, false), false, true, &base);
	let (_, fl, _) = scan_with(&ctx, &["root/"], None, filters());
	assert_eq!(names(&fl), [".", "keep", "secretword", "sub"]);
}

#[cfg(unix)]
#[test]
fn fake_super_stat_xattr_is_folded_into_entries() {
	// B10. Reference: `rsync --fake-super -rlptgoD --specials --list-only z/` on a file
	// carrying rsync.%stat "20644 1,3 0:0" lists `crw-r--r-- … achar`.
	let tmp = tempfile::tempdir().unwrap();
	let z = tmp.path().join("z");
	std::fs::create_dir(&z).unwrap();
	write_file(&z.join("achar"), b"");
	use std::os::unix::ffi::OsStrExt;
	let tree = Tree::open(&pi_vfs::BlockingFs::native(), &z, &TreeOpts::default()).unwrap();
	let name = crate::rsync::xattr::rsync_internal_name(b"stat");
	let name = std::ffi::OsStr::from_bytes(&name);
	if tree.set_xattr(Path::new("achar"), name, b"20644 1,3 0:0", false).is_err() {
		return; // no user xattrs on this filesystem
	}
	let mut o = base_opts();
	o.am_root = -1;
	o.preserve_devices = true;
	o.preserve_specials = true;
	let ctx = ctx_for(o, proto(33, false), false, true, tmp.path());
	assert!(ctx.meta.fake_super);
	let (_, fl) = scan(&ctx, &["z/"], None);
	let e = (0..fl.segment_len(0).unwrap() as i32)
		.filter_map(|i| fl.entry(i))
		.find(|e| &*e.basename == b"achar")
		.unwrap();
	assert_eq!(e.mode, 0o20644);
	assert_eq!(e.rdev, Some((1, 3)));
	assert_eq!(e.size, 0);
}

#[test]
fn transfer_lookups_accept_a_segments_gap_index() {
	// P / B12. The generator itemizes a sub-list's directory at the gap index
	// (`ndx_start - 1`); upstream resolves it to dir_flist[parent_ndx], whose F_PATHNAME
	// is the operand's dir (`%f` prints `src/a` in the reference).
	let tmp = fixture();
	let ctx = ctx_for(base_opts(), proto(33, true), true, true, tmp.path());
	let (_, fl, scanner) = scan_with(&ctx, &["src/"], None, Filters::new(FilterConfig::default()));
	let gap = fl.segment_start(1).unwrap() - 1;
	assert_eq!(fl.entry(gap).unwrap().name(), b"a");
	assert_eq!(scanner.pathname(gap, &fl).as_deref(), Some(&b"src"[..]));
	let ff = scanner.full_fname(gap, &fl);
	assert!(ff.ends_with(b"/src/a\""), "{}", String::from_utf8_lossy(&ff));
	#[cfg(unix)]
	{
		let tree = Tree::open(&pi_vfs::BlockingFs::native(), &tmp.path().join("src"), &TreeOpts::default()).unwrap();
		let name = if cfg!(target_os = "linux") { "user.dir1" } else { "dir1" };
		if tree.set_xattr(Path::new("a"), std::ffi::OsStr::new(name), b"directory xattr", false).is_ok() {
			let set = scanner.reread_xattrs(gap, &fl).unwrap();
			assert!(set.items.iter().any(|(_, v)| v == b"directory xattr"), "{set:?}");
		}
	}
}
