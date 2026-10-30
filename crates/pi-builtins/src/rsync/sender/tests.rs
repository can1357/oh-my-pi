//! Sender runs against generator streams captured from rsync 3.5.1
//! (`rsync -e <tee> --checksum-seed=1234 host:src/ dst/` pulls, protocol 33,
//! compat 0x1fe). `*.gen` is the generator's data stream after the filter list
//! through its third NDX_DONE; `*.out` is the reference sender's data stream from
//! its first request echo through its final NDX_DONE.

use std::collections::HashMap;
use std::io::{self, Cursor, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicBool;
use std::sync::{Arc, Mutex};

use super::*;
use crate::rsync::checksum::CsumType;
use crate::rsync::flist::FileList;
use crate::rsync::log::Role;
use crate::rsync::mux::{IoCounters, WriteConfig};
use crate::rsync::options::Options;
use crate::rsync::token::Compress;
use crate::rsync::wire::Proto;

const COMPAT: u32 = 0x1fe;

/// The capture script's generator: a 64-bit LCG emitting the top byte.
fn rand(seed: u64, n: usize) -> Vec<u8> {
	let mut x = seed;
	(0..n)
		.map(|_| {
			x = x.wrapping_mul(6364136223846793005).wrapping_add(1442695040888963407);
			(x >> 56) as u8
		})
		.collect()
}

fn proto() -> Proto {
	Proto::new(33, COMPAT)
}

#[derive(Clone, Default)]
struct Shared(Arc<Mutex<Vec<u8>>>);

impl Write for Shared {
	fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
		self.0.lock().unwrap().extend_from_slice(buf);
		Ok(buf.len())
	}

	fn flush(&mut self) -> io::Result<()> {
		Ok(())
	}
}

/// A source tree in a temp dir with the file list's names.
struct Fake {
	dir: PathBuf,
	names: Vec<&'static str>,
	codec: NdxCodec,
	xattrs: XattrSender,
	removed: Vec<(i32, Option<(u64, u64)>)>,
	/// F_PATHNAME per entry index.
	prefixes: HashMap<i32, Vec<u8>>,
	/// What `reread_xattrs` returns, and the indices it was asked for.
	xset: XattrSet,
	rereads: Mutex<Vec<i32>>,
	/// Segments published one per lookahead call (`at_least < 0`); EOF after the last.
	pending: Vec<FileList>,
	at_least_calls: Vec<i32>,
}

impl Fake {
	fn new(dir: &Path, names: Vec<&'static str>) -> Self {
		Self {
			dir: dir.to_path_buf(),
			names,
			codec: NdxCodec::new(proto()),
			xattrs: XattrSender::new(),
			removed: Vec::new(),
			prefixes: HashMap::new(),
			xset: XattrSet::default(),
			rereads: Mutex::new(Vec::new()),
			pending: Vec::new(),
			at_least_calls: Vec::new(),
		}
	}
}

impl Source for Fake {
	fn send_extra_at_least(&mut self, _out: &MuxWriter, flists: &Flists, at_least: i32) -> Result<(), RsyncError> {
		self.at_least_calls.push(at_least);
		if at_least < 0 && !flists.is_eof() {
			if self.pending.is_empty() {
				flists.set_eof();
			} else {
				flists.push(self.pending.remove(0));
			}
		}
		Ok(())
	}

	fn set_old_total(&mut self, _n: usize) {}

	fn ndx_codec(&mut self) -> &mut NdxCodec {
		&mut self.codec
	}

	fn open_file(&self, ndx: i32, _flists: &Flists) -> io::Result<(pi_vfs::File, pi_vfs::Metadata)> {
		let file = std::fs::File::open(self.dir.join(self.names[ndx as usize]))?;
		let meta = file.metadata()?;
		Ok((pi_vfs::File::from(file), pi_vfs::Metadata::from(meta)))
	}

	fn remove_source(&mut self, ndx: i32, _flists: &Flists, dest: Option<(u64, u64)>) -> Result<(), RsyncError> {
		self.removed.push((ndx, dest));
		Ok(())
	}

	fn xattrs(&mut self) -> &mut XattrSender {
		&mut self.xattrs
	}

	fn full_fname(&self, ndx: i32, _flists: &Flists) -> Vec<u8> {
		format!("\"{}\"", self.dir.join(self.names[ndx as usize]).display()).into_bytes()
	}

	fn reread_xattrs(&self, ndx: i32, _flists: &Flists) -> io::Result<XattrSet> {
		self.rereads.lock().unwrap().push(ndx);
		Ok(self.xset.clone())
	}

	fn pathname(&self, ndx: i32, _flists: &Flists) -> Option<Vec<u8>> {
		self.prefixes.get(&ndx).cloned()
	}
}

impl Input for Cursor<Vec<u8>> {
	fn data_ready(&mut self) -> io::Result<bool> {
		Ok(self.position() < self.get_ref().len() as u64)
	}
}

fn entry(name: &str, mode: u32, size: u64) -> FileEntry {
	FileEntry {
		dirname: Arc::from(&b""[..]),
		basename: name.as_bytes().into(),
		mode,
		size,
		..FileEntry::default()
	}
}

struct Setup {
	_tmp: tempfile::TempDir,
	ctx: Ctx,
	flists: Arc<Flists>,
	src: Fake,
}

fn setup(files: &[(&'static str, Vec<u8>)], with_dot: bool, opts: Options, xfer: CsumType, compress: Compress) -> Setup {
	let tmp = tempfile::tempdir().unwrap();
	let mut entries = Vec::new();
	let mut names = Vec::new();
	if with_dot {
		entries.push(entry(".", 0o040755, 0));
		names.push(".");
	}
	for (name, data) in files {
		std::fs::write(tmp.path().join(name), data).unwrap();
		entries.push(entry(name, 0o100644, data.len() as u64));
		names.push(*name);
	}
	let flists = Flists::new();
	flists.push(FileList { entries, ndx_start: 0, parent_ndx: -1 });
	flists.set_eof();
	let mut ctx = Ctx::for_tests(opts).with_role(Role::Sender);
	ctx.proto = proto();
	ctx.xfer_sum = xfer;
	ctx.seed = 1234;
	ctx.compress = compress;
	ctx.compress_level = None;
	ctx.am_server = true;
	ctx.am_sender = true;
	ctx.inc_recurse = false;
	let src = Fake::new(tmp.path(), names);
	Setup { _tmp: tmp, ctx, flists, src }
}

fn sender_opts() -> Options {
	let mut opts = Options::default();
	opts.am_server = true;
	opts.am_sender = true;
	opts
}

/// Runs the sender over `requests` and returns everything it wrote.
fn run_capture(s: &mut Setup, requests: &[u8], peer: &flume::Receiver<Msg>) -> Result<Vec<u8>, RsyncError> {
	let sink = Shared::default();
	let out = MuxWriter::new(Box::new(sink.clone()), IoCounters::default(), WriteConfig::default());
	let mut input = Cursor::new(requests.to_vec());
	run_with(&s.ctx, &mut s.src, &s.flists, &mut input, &out, peer)?;
	let mut flush = out.clone();
	flush.flush().unwrap();
	assert_eq!(input.position() as usize, requests.len(), "whole generator stream consumed");
	Ok(sink.0.lock().unwrap().clone())
}

fn dir_files() -> Vec<(&'static str, Vec<u8>)> {
	let basis = rand(1, 10000);
	let a = [&basis[..5000], &rand(4, 123)[..], &basis[5000..]].concat();
	vec![("a", a), ("b", rand(2, 5000)), ("c", rand(3, 3000))]
}

fn hexdiff(got: &[u8], want: &[u8]) -> String {
	let at = got.iter().zip(want).position(|(a, b)| a != b).unwrap_or(got.len().min(want.len()));
	format!("first difference at byte {at} (got {} bytes, want {})", got.len(), want.len())
}

#[test]
fn delta_run_is_byte_identical() {
	let mut s = setup(&dir_files(), true, sender_opts(), CsumType::Xxh128, Compress::None);
	let (_tx, rx) = flume::unbounded();
	let got = run_capture(&mut s, include_bytes!("testdata/dir_plain.gen"), &rx).unwrap();
	let want = include_bytes!("testdata/dir_plain.out");
	assert!(got == want, "{}", hexdiff(&got, want));
	let stats = s.ctx.stats.lock().unwrap();
	assert_eq!(stats.xferred_files, 3);
	assert_eq!(stats.total_transferred_size, 10123 + 5000 + 3000);
	// a: 123 inserted + the 700-byte block it broke; b: all matched; c: all literal.
	assert_eq!(stats.literal_data, 823 + 3000);
	assert_eq!(stats.matched_data, 10123 - 823 + 5000);
	drop(stats);
	for ndx in 1..=3 {
		let e = s.flists.entry(ndx).unwrap();
		assert_ne!(e.flags & FLAG_FILE_SENT, 0, "ndx {ndx} marked sent");
	}
}

#[test]
fn compressed_run_is_byte_identical() {
	let mut s = setup(&dir_files(), true, sender_opts(), CsumType::Xxh128, Compress::Zstd);
	let (_tx, rx) = flume::unbounded();
	let got = run_capture(&mut s, include_bytes!("testdata/dir_plain.gen"), &rx).unwrap();
	let want = include_bytes!("testdata/dir_zstd.out");
	assert!(got == want, "{}", hexdiff(&got, want));
}

#[test]
fn append_verify_run_is_byte_identical() {
	let basis = rand(5, 9000);
	let target = [&basis[..], &rand(6, 40000)[..]].concat();
	let mut opts = sender_opts();
	opts.append_mode = 2;
	opts.inplace = true;
	let mut s = setup(&[("f", target)], false, opts, CsumType::Md5, Compress::None);
	let (_tx, rx) = flume::unbounded();
	let got = run_capture(&mut s, include_bytes!("testdata/append_verify_md5.gen"), &rx).unwrap();
	let want = include_bytes!("testdata/append_verify_md5.out");
	assert!(got == want, "{}", hexdiff(&got, want));
	assert_eq!(s.ctx.stats.lock().unwrap().literal_data, 40000);
}

#[test]
fn remove_source_files_on_success() {
	let mut opts = sender_opts();
	opts.remove_source_files = 1;
	let mut s = setup(&dir_files(), true, opts, CsumType::Xxh128, Compress::None);
	let (tx, rx) = flume::unbounded();
	// The receiver's MSG_SUCCESS payloads as the reference client forwarded them.
	for ndx in 1i32..=3 {
		tx.send(Msg { code: MSG_SUCCESS, payload: ndx.to_le_bytes().to_vec() }).unwrap();
	}
	let got = run_capture(&mut s, include_bytes!("testdata/dir_plain.gen"), &rx).unwrap();
	assert_eq!(&got[..], &include_bytes!("testdata/dir_plain.out")[..]);
	assert_eq!(s.src.removed, vec![(1, None), (2, None), (3, None)]);
}

#[test]
fn malformed_success_message_is_a_stream_error() {
	let mut opts = sender_opts();
	opts.remove_source_files = 1;
	let mut s = setup(&dir_files(), true, opts, CsumType::Xxh128, Compress::None);
	let (tx, rx) = flume::unbounded();
	tx.send(Msg { code: MSG_SUCCESS, payload: vec![1, 0] }).unwrap();
	let err = run_capture(&mut s, include_bytes!("testdata/dir_plain.gen"), &rx).unwrap_err();
	assert_eq!(err.code, exit::RERR_STREAMIO);
	assert_eq!(err.message.as_deref(), Some("invalid multi-message 100:2 [sender]"));
}

/// Builds a generator stream: `ndx` + iflags (+ sum head) per request, then NDX_DONEs.
fn gen_stream(reqs: &[(i32, u16, Option<[i32; 4]>)], dones: usize) -> Vec<u8> {
	let mut codec = NdxCodec::new(proto());
	let mut w = Vec::new();
	for &(ndx, iflags, head) in reqs {
		codec.write(&mut w, ndx).unwrap();
		w.write_shortint(iflags).unwrap();
		if let Some(head) = head {
			for v in head {
				w.write_int(v).unwrap();
			}
		}
	}
	for _ in 0..dones {
		codec.write(&mut w, NDX_DONE).unwrap();
	}
	w
}

#[test]
fn vanished_file_sends_no_send_and_counts_io_error() {
	let mut s = setup(&[("f", rand(9, 100))], false, sender_opts(), CsumType::Xxh128, Compress::None);
	std::fs::remove_file(s.src.dir.join("f")).unwrap();
	let requests = gen_stream(&[(0, ITEM_TRANSFER as u16, Some([0, 0, 0, 0]))], 3);
	let sink = Shared::default();
	let out = MuxWriter::new(Box::new(sink.clone()), IoCounters::default(), WriteConfig::default());
	out.start_multiplex().unwrap();
	let (_tx, rx) = flume::unbounded();
	run_with(&s.ctx, &mut s.src, &s.flists, &mut Cursor::new(requests), &out, &rx).unwrap();
	let mut flush = out.clone();
	flush.flush().unwrap();
	assert_eq!(s.ctx.io_error.load(Ordering::Relaxed) & IOERR_VANISHED, IOERR_VANISHED);
	// Frames: MSG_NO_SEND(0), then DONE x3 and MSG_IO_ERROR before the final DONE.
	let bytes = sink.0.lock().unwrap().clone();
	let mut frames = Vec::new();
	let mut r = &bytes[..];
	while let Some((&h, rest)) = r.split_first_chunk::<4>() {
		let h = u32::from_le_bytes(h);
		let (code, len) = ((h >> 24) as u8 - crate::rsync::consts::MPLEX_BASE, (h & 0xffffff) as usize);
		frames.push((code, rest[..len].to_vec()));
		r = &rest[len..];
	}
	let data: Vec<u8> = frames.iter().filter(|f| f.0 == 0).flat_map(|f| f.1.clone()).collect();
	assert_eq!(data, vec![0, 0, 0], "only the phase echoes and the final NDX_DONE");
	assert!(frames.iter().any(|f| f.0 == MSG_NO_SEND && f.1 == 0i32.to_le_bytes()));
	assert!(frames.iter().any(|f| f.0 == MSG_IO_ERROR && f.1 == IOERR_VANISHED.to_le_bytes()));
}

#[test]
fn transfer_request_for_directory_is_refused() {
	let mut s = setup(&[("f", rand(9, 100))], true, sender_opts(), CsumType::Xxh128, Compress::None);
	let requests = gen_stream(&[(0, ITEM_TRANSFER as u16, None)], 0);
	let (_tx, rx) = flume::unbounded();
	let err = run_capture(&mut s, &requests, &rx).unwrap_err();
	assert_eq!(err.code, exit::RERR_PROTOCOL);
	assert_eq!(err.message.as_deref(), Some("received request to transfer non-regular file: 0 [sender]"));
}

#[test]
fn out_of_range_index_is_refused() {
	let mut s = setup(&[("f", rand(9, 100))], false, sender_opts(), CsumType::Xxh128, Compress::None);
	let requests = gen_stream(&[(5, 0, None)], 0);
	let (_tx, rx) = flume::unbounded();
	let err = run_capture(&mut s, &requests, &rx).unwrap_err();
	assert_eq!(err.code, exit::RERR_PROTOCOL);
	assert_eq!(err.message.as_deref(), Some("File-list index 5 not in -1 - 0 (read_ndx_and_attrs) [sender]"));
}

#[test]
fn dry_run_echoes_without_sums() {
	let mut opts = sender_opts();
	opts.dry_run = true;
	opts.do_xfers = false;
	let mut s = setup(&[("f", rand(9, 100))], false, opts, CsumType::Xxh128, Compress::None);
	let requests = gen_stream(&[(0, (ITEM_TRANSFER | ITEM_IS_NEW) as u16, None)], 3);
	let (_tx, rx) = flume::unbounded();
	let got = run_capture(&mut s, &requests, &rx).unwrap();
	// ndx 0 (delta 1), iflags, then DONE x3.
	let iflags = ((ITEM_TRANSFER | ITEM_IS_NEW) as u16).to_le_bytes();
	assert_eq!(got, vec![1, iflags[0], iflags[1], 0, 0, 0]);
	let stats = s.ctx.stats.lock().unwrap();
	assert_eq!((stats.xferred_files, stats.created_files, stats.literal_data), (1, 1, 0));
}

#[test]
fn cancellation_stops_the_loop() {
	let mut s = setup(&[("f", rand(9, 100))], false, sender_opts(), CsumType::Xxh128, Compress::None);
	s.ctx.cancel = Arc::new(AtomicBool::new(true));
	let (_tx, rx) = flume::unbounded();
	let err = run_capture(&mut s, &gen_stream(&[], 3), &rx).unwrap_err();
	assert_eq!(err.code, exit::RERR_SIGNAL);
}

/// Two inc-recursion segments: list 1 = [".", "a" (file), "sub" (dir)] at 1..=3 and
/// list 2 = ["sub/x"] at 5 (gap index 4 = "sub").
fn setup_inc(opts: Options) -> Setup {
	let tmp = tempfile::tempdir().unwrap();
	let flists = Flists::new();
	let mut sub = entry("sub", 0o040755, 0);
	sub.xattr = Some(0);
	flists.push(FileList {
		entries: vec![entry(".", 0o040755, 0), entry("a", 0o100644, 1), sub],
		ndx_start: 1,
		parent_ndx: -1,
	});
	let mut x = entry("x", 0o100644, 1);
	x.dirname = Arc::from(&b"sub"[..]);
	flists.push(FileList { entries: vec![x], ndx_start: 5, parent_ndx: 3 });
	flists.set_eof();
	let mut ctx = Ctx::for_tests(opts).with_role(Role::Sender);
	ctx.proto = proto();
	ctx.am_server = true;
	ctx.am_sender = true;
	ctx.inc_recurse = true;
	let src = Fake::new(tmp.path(), Vec::new());
	Setup { _tmp: tmp, ctx, flists, src }
}

/// A client-side logger whose --out-format lines land in the returned buffer.
fn capture_logger(s: &mut Setup, format: &[u8]) -> Shared {
	let buf = Shared::default();
	let cfg = crate::rsync::log::LogConfig {
		out_format: Some(format.to_vec()),
		local_server: true,
		..Default::default()
	};
	s.ctx.logger = crate::rsync::log::Logger::local(Box::new(buf.clone()), Box::new(io::sink()), cfg)
		.with_role(Role::Sender);
	s.ctx.am_server = false;
	buf
}

/// Delivers `data`, handing `msg` to the peer channel just before byte `at` becomes
/// readable — the mux pump's order (messages dispatched before later data).
struct Staged {
	data: Cursor<Vec<u8>>,
	at: u64,
	msg: Option<(flume::Sender<Msg>, Msg)>,
}

impl Read for Staged {
	fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
		if self.data.position() >= self.at
			&& let Some((tx, msg)) = self.msg.take()
		{
			tx.send(msg).unwrap();
		}
		let limit = if self.msg.is_some() { (self.at - self.data.position()) as usize } else { buf.len() };
		let n = buf.len().min(limit);
		self.data.read(&mut buf[..n])
	}
}

impl Input for Staged {
	fn data_ready(&mut self) -> io::Result<bool> {
		Ok(true)
	}
}

/// B5 / S: a MSG_SUCCESS that precedes the NDX_DONE retiring its segment must be
/// applied before the segment is freed (upstream handles it inline while reading).
#[test]
fn success_before_segment_done_is_applied_first() {
	let mut opts = sender_opts();
	opts.remove_source_files = 1;
	let mut s = setup_inc(opts);
	let (tx, rx) = flume::unbounded();
	let mut input = Staged {
		data: Cursor::new(gen_stream(&[], 4)),
		at: 0,
		msg: Some((tx, Msg { code: MSG_SUCCESS, payload: 2i32.to_le_bytes().to_vec() })),
	};
	let out = MuxWriter::new(Box::new(Shared::default()), IoCounters::default(), WriteConfig::default());
	run_with(&s.ctx, &mut s.src, &s.flists, &mut input, &out, &rx).unwrap();
	assert_eq!(s.src.removed, vec![(2, None)]);
	assert!(s.flists.is_released(0) && s.flists.is_released(1));
}

/// P + B12: a directory itemized at a segment's gap index is the segment's parent:
/// `%f` uses the parent's F_PATHNAME and its xattrs are re-read by the parent's index.
#[test]
fn gap_index_resolves_to_parent_dir_for_pathname_and_xattrs() {
	let mut opts = sender_opts();
	opts.preserve_xattrs = 1;
	let mut s = setup_inc(opts);
	let value = b"need to test directory xattrs too, long".to_vec();
	let set = XattrSet { items: vec![(b"dir1".to_vec(), value.clone())], ..Default::default() };
	s.src.xattrs.send_indexed(&mut Vec::new(), &set, proto()).unwrap();
	s.src.xset = set;
	s.src.prefixes.insert(3, b"src".to_vec());
	let log = capture_logger(&mut s, b"%f");

	// Request: gap ndx 4 (dir "sub"), xattr change, then the xattr value request (#1).
	let iflags = (ITEM_REPORT_XATTR | crate::rsync::consts::ITEM_REPORT_TIME) as u16;
	let mut codec = NdxCodec::new(proto());
	let mut requests = Vec::new();
	codec.write(&mut requests, 4).unwrap();
	requests.write_shortint(iflags).unwrap();
	requests.write_varint(1).unwrap();
	requests.write_varint(0).unwrap();
	for _ in 0..4 {
		codec.write(&mut requests, NDX_DONE).unwrap();
	}
	let (_tx, rx) = flume::unbounded();
	let got = run_capture(&mut s, &requests, &rx).unwrap();
	assert_eq!(*s.src.rereads.lock().unwrap(), vec![3]);
	assert!(got.windows(value.len()).any(|w| w == value), "requested xattr value echoed");
	assert_eq!(String::from_utf8_lossy(&log.0.lock().unwrap()), "src/sub\n");
}

/// F: a fuzzy basis travels as ITEM_XNAME_FOLLOWS, but transfer-time log lines never
/// show it (`>f+++++++++ big.bin`, not `... => big-1.bin`).
#[test]
fn fuzzy_xname_not_shown_on_transfer_line() {
	let mut s = setup(&[("f", rand(9, 100))], false, sender_opts(), CsumType::Xxh128, Compress::None);
	let log = capture_logger(&mut s, b"%i %n%L");
	let iflags = (ITEM_TRANSFER | ITEM_IS_NEW | ITEM_BASIS_TYPE_FOLLOWS | ITEM_XNAME_FOLLOWS) as u16;
	let mut codec = NdxCodec::new(proto());
	let mut requests = Vec::new();
	codec.write(&mut requests, 0).unwrap();
	requests.write_shortint(iflags).unwrap();
	requests.write_u8(FNAMECMP_FUZZY).unwrap();
	requests.write_vstring(b"f-1").unwrap();
	for v in [0i32; 4] {
		requests.write_int(v).unwrap();
	}
	for _ in 0..3 {
		codec.write(&mut requests, NDX_DONE).unwrap();
	}
	let (_tx, rx) = flume::unbounded();
	run_capture(&mut s, &requests, &rx).unwrap();
	let text = String::from_utf8_lossy(&log.0.lock().unwrap()).into_owned();
	assert!(text.ends_with("f+++++++++ f\n"), "{text:?}");
	assert!(!text.contains("=>"), "{text:?}");
}

/// Never ready: the generator has nothing to say until it sees more of the list.
struct Idle(Cursor<Vec<u8>>);

impl Read for Idle {
	fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
		self.0.read(buf)
	}
}

impl Input for Idle {
	fn data_ready(&mut self) -> io::Result<bool> {
		Ok(false)
	}
}

/// B3: while no request is pending the sender keeps sending one more segment at a
/// time (io.c's zero-timeout poll) until the list is complete, so a generator with
/// nothing to request in the queued segments is never starved.
#[test]
fn idle_lookahead_sends_segments_until_eof() {
	let mut s = setup_inc(sender_opts());
	// Re-open the list: two more segments wait to be sent.
	let flists = Flists::new();
	flists.push(FileList { entries: vec![entry(".", 0o040755, 0), entry("sub", 0o040755, 0)], ndx_start: 1, parent_ndx: -1 });
	s.flists = flists;
	let mut x = entry("x", 0o100644, 0);
	x.dirname = Arc::from(&b"sub"[..]);
	let mut deep = entry("deep", 0o040755, 0);
	deep.dirname = Arc::from(&b"sub"[..]);
	s.src.pending = vec![
		FileList { entries: vec![deep, x], ndx_start: 4, parent_ndx: 2 },
		FileList { entries: vec![entry("y", 0o100644, 0)], ndx_start: 7, parent_ndx: 4 },
	];
	// One NDX_DONE per segment, then the two remaining phases.
	let mut input = Idle(Cursor::new(gen_stream(&[], 5)));
	let out = MuxWriter::new(Box::new(Shared::default()), IoCounters::default(), WriteConfig::default());
	let (_tx, rx) = flume::unbounded();
	run_with(&s.ctx, &mut s.src, &s.flists, &mut input, &out, &rx).unwrap();
	assert!(s.flists.is_eof());
	assert_eq!(s.flists.len(), 3);
	assert_eq!(s.src.at_least_calls.iter().filter(|&&n| n < 0).count(), 3, "{:?}", s.src.at_least_calls);
}
