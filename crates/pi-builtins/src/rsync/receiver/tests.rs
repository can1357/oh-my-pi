use std::{
	io::{self, Cursor, Write},
	path::Path,
	sync::{Arc, Mutex},
	time::UNIX_EPOCH,
};

use super::*;
use crate::rsync::{
	checksum::{CsumType, Strong, SumHead},
	flist::{FileList, FlistDecoder, FlistOpts},
	ids::IdLists,
	log::{LogConfig, OutLevels, Role},
	meta::MetaOpts,
	mux::{ReadConfig, WriteConfig},
	options::Options,
	token::{Compress, TokenEncoder},
	wire::{NdxCodec, Proto, ReadExt, WriteExt},
};

const P33: Proto = Proto { version: 33, compat: 0 };
const SEED: i32 = 0x1234_5678;

/// A write sink tests can read back.
#[derive(Clone, Default)]
struct Capture(Arc<Mutex<Vec<u8>>>);

impl Write for Capture {
	fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
		lock(&self.0).extend_from_slice(buf);
		Ok(buf.len())
	}

	fn flush(&mut self) -> io::Result<()> {
		Ok(())
	}
}

impl Capture {
	fn text(&self) -> String {
		String::from_utf8_lossy(&lock(&self.0)).into_owned()
	}
}

struct Fixture {
	ctx: Ctx,
	out: Capture,
	err: Capture,
	dir: tempfile::TempDir,
}

impl Fixture {
	fn new(opts: Options, proto: Proto, seed: i32) -> Self {
		let dir = tempfile::tempdir().unwrap();
		let mut ctx = Ctx::for_tests(opts.clone());
		ctx.proto = proto;
		ctx.xfer_sum = CsumType::Md5;
		ctx.file_sum = CsumType::Md5;
		ctx.seed = seed;
		ctx.compress = Compress::None;
		ctx.inc_recurse = false;
		ctx.am_server = false;
		ctx.local_server = false;
		ctx.progress = None;
		ctx.umask = 0o022;
		ctx.meta = MetaOpts {
			perms: opts.preserve_perms,
			times: opts.preserve_mtimes,
			..MetaOpts::default()
		};
		let out = Capture::default();
		let err = Capture::default();
		let cfg = LogConfig { levels: OutLevels::from_verbose(1), ..LogConfig::default() };
		ctx.logger = Logger::local(Box::new(out.clone()), Box::new(err.clone()), cfg).with_role(Role::Receiver);
		Self { ctx, out, err, dir }
	}

	fn path(&self, name: &str) -> std::path::PathBuf {
		self.dir.path().join(name)
	}

	fn trees(&self) -> DestTrees {
		DestTrees {
			dest: Tree::open(&self.ctx.fs, self.dir.path(), &TreeOpts::default()).unwrap(),
			single_file: None,
			partial_dir: self.ctx.opts.partial_dir.as_ref().map(|d| crate::host::os_bytes_lossy(d).into_owned()),
			temp_dir: None,
			backup_dir: None,
			alt_dirs: Vec::new(),
			dry_missing: false,
			dest_dev: None,
		}
	}

	fn messages(&self) -> String {
		self.ctx.logger.flush();
		format!("{}{}", self.out.text(), self.err.text())
	}

	/// Runs the receiver over `stream`; returns its result and the sibling messages.
	fn run(&self, trees: &DestTrees, flists: &Flists, stream: Vec<u8>) -> (Result<(), RsyncError>, Vec<Sibling>) {
		let mut fr = FlistReceiver::new(&self.ctx, None);
		let mut input = MuxReader::new(
			Box::new(Cursor::new(stream)),
			self.ctx.counters.clone(),
			self.ctx.cancel.clone(),
			ReadConfig::default(),
		);
		let out = MuxWriter::new(Box::new(io::sink()), self.ctx.counters.clone(), WriteConfig::default());
		let (sib_out, sib_in) = crate::rsync::generator::sib_pipe(flists, self.ctx.inc_recurse);
		let result = run(&self.ctx, trees, flists, &mut fr, &mut input, &out, &sib_out);
		sib_out.flush_all();
		let items = sib_in.drain().into_iter().filter(|s| !matches!(s, Sibling::List | Sibling::ListEof));
		(result, items.collect())
	}
}

fn opts() -> Options {
	let mut o = Options::default();
	o.do_xfers = true;
	o.preserve_mtimes = true;
	o.preserve_perms = true;
	o.whole_file = 0;
	o
}

fn entry(name: &str, size: usize, mode: u32, mtime: i64) -> FileEntry {
	FileEntry {
		dirname: Arc::from(&b""[..]),
		basename: name.as_bytes().to_vec().into_boxed_slice(),
		mode,
		size: size as u64,
		mtime,
		..FileEntry::default()
	}
}

fn flists_of(entries: Vec<FileEntry>) -> Arc<Flists> {
	let flists = Flists::new();
	flists.push(FileList { entries, ndx_start: 0, parent_ndx: -1 });
	flists.set_eof();
	flists
}

fn md5(seed: i32, parts: &[&[u8]]) -> Vec<u8> {
	let mut digest = Strong { kind: CsumType::Md5, seed, proto: P33 }.file();
	for part in parts {
		digest.update(part);
	}
	digest.finish()
}

enum Tok<'a> {
	Lit(&'a [u8]),
	/// Block index and its data (for compressor history).
	Block(u32, &'a [u8]),
}

/// A sender → receiver stream as rsync 3.5.1 frames it (after the file list).
struct Stream {
	buf: Vec<u8>,
	ndx: NdxCodec,
	enc: TokenEncoder,
}

impl Stream {
	fn new(compress: Compress) -> Self {
		let mut enc = TokenEncoder::new(compress, None);
		enc.set_protocol(33);
		Self { buf: Vec::new(), ndx: NdxCodec::new(P33), enc }
	}

	fn file(&mut self, ndx: i32, iflags: u32, head: SumHead, toks: &[Tok<'_>], sum: &[u8]) -> &mut Self {
		self.ndx.write(&mut self.buf, ndx).unwrap();
		self.buf.write_shortint(iflags as u16).unwrap();
		head.write(&mut self.buf, P33).unwrap();
		for tok in toks {
			match tok {
				Tok::Lit(data) => self.enc.send(&mut self.buf, data, None, &[]).unwrap(),
				Tok::Block(n, data) => self.enc.send(&mut self.buf, &[], Some(*n), data).unwrap(),
			}
		}
		self.enc.end_file(&mut self.buf).unwrap();
		self.buf.extend_from_slice(sum);
		self
	}

	fn done(&mut self) -> &mut Self {
		self.ndx.write(&mut self.buf, NDX_DONE).unwrap();
		self
	}

	fn take(&mut self) -> Vec<u8> {
		std::mem::take(&mut self.buf)
	}
}

fn mtime_of(path: &Path) -> i64 {
	std::fs::metadata(path).unwrap().modified().unwrap().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64
}

#[cfg(unix)]
fn mode_of(path: &Path) -> u32 {
	use std::os::unix::fs::PermissionsExt;
	std::fs::metadata(path).unwrap().permissions().mode() & 0o7777
}

fn dir_names(dir: &Path) -> Vec<String> {
	let mut names: Vec<String> =
		std::fs::read_dir(dir).unwrap().map(|e| e.unwrap().file_name().to_string_lossy().into_owned()).collect();
	names.sort();
	names
}

/// `rsync -t -p --no-W -B 700 --only-write-batch=B src/a src/b dst/` from the
/// reference 3.5.1, with `dst/b` holding [`capture_basis`]: the stream flags,
/// protocol, compat flags, checksum seed, file list, and the sender's data.
const CAPTURED_BATCH: &str = concat!(
	"000000002100000081fea03cb76a180161000c005e954f0da0810000809801620070178481000000000100a000000000",
	"0000000000000000000000000c00000068656c6c6f20776f726c640a000000006f5902ac237024bdd0c176cb93063dc4",
	"011c8009000000bc0200000200000094010000fffffffffefffffffdffffff2200000036646b727935636a717935636a",
	"717834626970773361686f763239676e753138666dfbfffffffafffffff9fffffff8ffffff3d000000646b727935636a",
	"717834626970773361686f763239676e753239676e753138666d743037656c737a36646b727935636a71783462697077",
	"3361686f7632ffffffff310100007733616970773361686f763239676e753138666d743037656c737a36646b72793563",
	"6a7178346269717834626970773361686f763239676e753138666d743037656c737a36646b727935636a717935636a71",
	"7834626970773361686f763239676e753138666d743037656c737a36646b727936646b727935636a7178346269707733",
	"61686f763239676e753138666d743037656c737a36656c737a36646b727935636a717834626970773361686f76323967",
	"6e753138666d743037656d743037656c737a36646b727935636a717834626970773361686f763239676e753138666d75",
	"3138666d743037656c737a36646b727935636a717834626970773361686f763239676e753239676e753138666d743037",
	"656c737a36646b727935636a717834626970773361686f763261686f76323900000000f0a72fb5fd74031a12187ac490",
	"4bb54a000000006c00003400007c1700010000000000",
);

fn unhex(text: &str) -> Vec<u8> {
	(0..text.len()).step_by(2).map(|i| u8::from_str_radix(&text[i..i + 2], 16).unwrap()).collect()
}

/// The captured source file `b`.
fn capture_source() -> Vec<u8> {
	let alpha = b"abcdefghijklmnopqrstuvwxyz0123456789";
	(0..6000usize).map(|i| alpha[(i * 7 + i / 37) % 36]).collect()
}

/// The destination's old `b` the capture's deltas refer to.
fn capture_basis() -> Vec<u8> {
	let mut basis = capture_source();
	basis[2500..2520].fill(b'#');
	basis.extend_from_slice(b"tail");
	basis
}

#[test]
fn captured_sender_stream_rebuilds_files() {
	let bytes = unhex(CAPTURED_BATCH);
	let mut cur = Cursor::new(bytes);
	assert_eq!(cur.read_int().unwrap(), 0);
	assert_eq!(cur.read_int().unwrap(), 33);
	let compat = cur.read_varint().unwrap() as u32;
	let seed = cur.read_int().unwrap();
	let proto = Proto { version: 33, compat };

	let fx = Fixture::new(opts(), proto, seed);
	let fopts = FlistOpts::default();
	let mut ids = IdLists::new(proto, &fopts);
	let mut dec = FlistDecoder::new(proto, fopts);
	let mut entries = Vec::new();
	while let Some(e) = dec.recv_entry(&mut cur, &mut ids).unwrap() {
		entries.push(e);
	}
	let mut list = FileList { entries, ndx_start: 0, parent_ndx: -1 };
	list.sort_and_clean(proto, false, &fx.ctx.logger);
	let wanted: Vec<FileEntry> = list.entries.clone();
	let flists = Flists::new();
	flists.push(list);
	flists.set_eof();

	std::fs::write(fx.path("b"), capture_basis()).unwrap();
	let rest = cur.get_ref()[cur.position() as usize..].to_vec();
	let trees = fx.trees();
	let (result, sib) = fx.run(&trees, &flists, rest);
	result.unwrap();

	assert_eq!(std::fs::read(fx.path("a")).unwrap(), b"hello world\n");
	assert_eq!(std::fs::read(fx.path("b")).unwrap(), capture_source());
	assert_eq!(dir_names(fx.dir.path()), ["a", "b"]);
	for e in &wanted {
		let path = fx.path(&String::from_utf8_lossy(&e.basename));
		assert_eq!(mtime_of(&path), e.mtime);
		#[cfg(unix)]
		assert_eq!(mode_of(&path), e.mode & 0o7777);
	}
	#[cfg(unix)]
	{
		assert_eq!(mode_of(&fx.path("a")), 0o640);
		assert_eq!(mode_of(&fx.path("b")), 0o604);
	}
	assert_eq!(sib, [Sibling::Done, Sibling::Done]);
	let stats = lock(&fx.ctx.stats);
	assert_eq!(stats.xferred_files, 2);
	assert_eq!(stats.literal_data + stats.matched_data, 6012);
	assert!(stats.matched_data > 0, "the delta reused basis blocks");
	assert_eq!(stats.created_files, 1);
}

#[test]
fn verification_failure_asks_for_a_redo_then_succeeds() {
	let fx = Fixture::new(opts(), P33, SEED);
	let flists = flists_of(vec![entry("f", 4, 0o100_644, 1_600_000_000)]);
	let trees = fx.trees();
	let good = md5(SEED, &[b"data"]);
	let mut bad = good.clone();
	bad[0] ^= 0xff;
	let mut s = Stream::new(Compress::None);
	s.file(0, ITEM_TRANSFER | ITEM_IS_NEW, SumHead::default(), &[Tok::Lit(b"data")], &bad);
	s.done();
	s.file(0, ITEM_TRANSFER, SumHead::default(), &[Tok::Lit(b"data")], &good);
	s.done().done();
	let (result, sib) = fx.run(&trees, &flists, s.take());
	result.unwrap();
	assert!(
		fx.messages().contains("WARNING: f failed verification -- update discarded (will try again).\n"),
		"{}",
		fx.messages()
	);
	assert_eq!(sib, [Sibling::Redo(0), Sibling::Done, Sibling::Done]);
	assert_eq!(std::fs::read(fx.path("f")).unwrap(), b"data");
	assert_eq!(mtime_of(&fx.path("f")), 1_600_000_000);
	assert_eq!(dir_names(fx.dir.path()), ["f"]);
	assert_eq!(lock(&fx.ctx.stats).created_files, 1);
}

#[test]
fn verification_failure_in_the_redo_pass_is_an_error() {
	let fx = Fixture::new(opts(), P33, SEED);
	let flists = flists_of(vec![entry("f", 4, 0o100_644, 1_600_000_000)]);
	let trees = fx.trees();
	let bad = vec![0u8; 16];
	let mut s = Stream::new(Compress::None);
	s.file(0, ITEM_TRANSFER, SumHead::default(), &[Tok::Lit(b"data")], &bad);
	s.done();
	s.file(0, ITEM_TRANSFER, SumHead::default(), &[Tok::Lit(b"data")], &bad);
	s.done().done();
	let (result, sib) = fx.run(&trees, &flists, s.take());
	result.unwrap();
	let messages = fx.messages();
	assert!(messages.contains("ERROR: f failed verification -- update discarded.\n"), "{messages}");
	assert_eq!(sib, [Sibling::Redo(0), Sibling::Done, Sibling::Done]);
	assert!(!fx.path("f").exists());
	assert!(fx.ctx.logger.got_xfer_error());
	assert!(dir_names(fx.dir.path()).is_empty());
}

#[test]
fn delta_against_the_basis_with_zlib_history() {
	let mut fx = Fixture::new(opts(), P33, SEED);
	fx.ctx.compress = Compress::Zlib;
	let basis: Vec<u8> = (0..300u32).map(|i| (i * 31 % 251) as u8).collect();
	std::fs::write(fx.path("f"), &basis).unwrap();
	let result_data = [&basis[100..200], b"new!", &basis[0..100], &basis[200..300]].concat();
	let flists = flists_of(vec![entry("f", result_data.len(), 0o100_600, 1_500_000_000)]);
	let trees = fx.trees();
	let head = SumHead { count: 3, blength: 100, s2length: 2, remainder: 0 };
	let mut s = Stream::new(Compress::Zlib);
	s.file(
		0,
		ITEM_TRANSFER,
		head,
		&[Tok::Block(1, &basis[100..200]), Tok::Lit(b"new!"), Tok::Block(0, &basis[..100]), Tok::Block(2, &basis[200..])],
		&md5(SEED, &[&result_data]),
	);
	s.done().done().done();
	let (result, _) = fx.run(&trees, &flists, s.take());
	result.unwrap();
	assert_eq!(std::fs::read(fx.path("f")).unwrap(), result_data);
	let stats = lock(&fx.ctx.stats);
	assert_eq!((stats.literal_data, stats.matched_data), (4, 300));
}

#[test]
fn invalid_block_index_is_a_protocol_error() {
	let fx = Fixture::new(opts(), P33, SEED);
	std::fs::write(fx.path("f"), b"0123456789").unwrap();
	let flists = flists_of(vec![entry("f", 10, 0o100_644, 0)]);
	let trees = fx.trees();
	let head = SumHead { count: 1, blength: 10, s2length: 2, remainder: 0 };
	let mut s = Stream::new(Compress::None);
	s.file(0, ITEM_TRANSFER, head, &[Tok::Block(5, b"")], &[0; 16]);
	let (result, _) = fx.run(&trees, &flists, s.take());
	let err = result.unwrap_err();
	assert_eq!(err.code, RERR_PROTOCOL);
	assert_eq!(err.message.as_deref(), Some("Invalid block index 5 (count=1) [receiver]"));
	assert_eq!(err.site, Some(("receiver.c", 589)));
	// The temp file is gone, the basis untouched.
	assert_eq!(dir_names(fx.dir.path()), ["f"]);
	assert_eq!(std::fs::read(fx.path("f")).unwrap(), b"0123456789");
}

#[test]
fn gap_index_of_an_empty_inc_recursion_segment_names_its_directory() {
	// `rsync -r foo f1 dest/` with an empty foo: the initial list holds ".", "f1",
	// "foo" (indices 1..=3), foo's own segment is empty and starts at 5, and the
	// generator itemizes foo through that segment's gap index 4.
	let mut fx = Fixture::new(opts(), P33, SEED);
	fx.ctx.inc_recurse = true;
	let flists = Flists::new();
	flists.push(FileList {
		entries: vec![
			entry(".", 0, 0o040_755, 1_400_000_000),
			entry("f1", 2, 0o100_644, 1_400_000_000),
			entry("foo", 0, 0o040_755, 1_400_000_000),
		],
		ndx_start: 1,
		parent_ndx: -1,
	});
	flists.push(FileList { entries: Vec::new(), ndx_start: 5, parent_ndx: 3 });
	flists.set_eof();
	let trees = fx.trees();
	let mut s = Stream::new(Compress::None);
	s.ndx.write(&mut s.buf, 4).unwrap();
	s.buf.write_shortint(0).unwrap();
	// One NDX_DONE per segment ends phase 0, then the redo and final phases.
	s.done().done().done().done();
	let (result, sib) = fx.run(&trees, &flists, s.take());
	result.unwrap();
	assert_eq!(sib, [Sibling::Done, Sibling::Done]);
	assert!(flists.is_released(0) && flists.is_released(1));
}

#[test]
fn transfer_request_for_a_non_regular_file_is_refused() {
	let fx = Fixture::new(opts(), P33, SEED);
	let flists = flists_of(vec![entry("d", 0, 0o040_755, 0)]);
	let trees = fx.trees();
	let mut s = Stream::new(Compress::None);
	s.file(0, ITEM_TRANSFER, SumHead::default(), &[], &[0; 16]);
	let (result, _) = fx.run(&trees, &flists, s.take());
	let err = result.unwrap_err();
	assert_eq!(err.message.as_deref(), Some("received request to transfer non-regular file: 0 [receiver]"));
	assert_eq!(err.site, Some(("rsync.c", 442)));
}

#[test]
fn inplace_updates_the_file_itself_and_truncates() {
	let mut o = opts();
	o.inplace = true;
	let fx = Fixture::new(o, P33, SEED);
	std::fs::write(fx.path("f"), b"AAAABBBBCCCCDDDD").unwrap();
	#[cfg(unix)]
	let ino = {
		use std::os::unix::fs::MetadataExt;
		std::fs::metadata(fx.path("f")).unwrap().ino()
	};
	let flists = flists_of(vec![entry("f", 13, 0o100_644, 1_400_000_000)]);
	let trees = fx.trees();
	let head = SumHead { count: 4, blength: 4, s2length: 2, remainder: 0 };
	let mut s = Stream::new(Compress::None);
	let want = b"AAAAXXXXCCCCZ";
	s.file(
		0,
		ITEM_TRANSFER,
		head,
		&[Tok::Block(0, b"AAAA"), Tok::Lit(b"XXXX"), Tok::Block(2, b"CCCC"), Tok::Lit(b"Z")],
		&md5(SEED, &[want]),
	);
	s.done().done().done();
	let (result, _) = fx.run(&trees, &flists, s.take());
	result.unwrap();
	assert_eq!(std::fs::read(fx.path("f")).unwrap(), want);
	assert_eq!(mtime_of(&fx.path("f")), 1_400_000_000);
	#[cfg(unix)]
	{
		use std::os::unix::fs::MetadataExt;
		assert_eq!(std::fs::metadata(fx.path("f")).unwrap().ino(), ino);
	}
	assert_eq!(dir_names(fx.dir.path()), ["f"]);
}

/// B14 (receiver half): an in-place update counts only the 4 KiB blocks it wrote;
/// blocks matched at their own offset are skipped, not rewritten. The reference's
/// `--inplace -I --no-whole-file` run over a 64 KiB file with its first 3 bytes
/// changed reports "Number of 4 KiB logical blocks touched: 1".
#[test]
fn inplace_counts_only_touched_logical_blocks() {
	let mut o = opts();
	o.inplace = true;
	let fx = Fixture::new(o, P33, SEED);
	let basis: Vec<u8> = (0..65_536u32).map(|i| (i.wrapping_mul(2_654_435_761) >> 13) as u8).collect();
	std::fs::write(fx.path("f"), &basis).unwrap();
	let mut want = basis.clone();
	want[..3].copy_from_slice(b"xyz");
	let flists = flists_of(vec![entry("f", want.len(), 0o100_644, 1_400_000_000)]);
	let trees = fx.trees();
	let head = SumHead { count: 64, blength: 1024, s2length: 2, remainder: 0 };
	let mut toks = vec![Tok::Lit(&want[..1024])];
	for n in 1..64u32 {
		let at = n as usize * 1024;
		toks.push(Tok::Block(n, &basis[at..at + 1024]));
	}
	let mut s = Stream::new(Compress::None);
	s.file(0, ITEM_TRANSFER, head, &toks, &md5(SEED, &[&want]));
	s.done().done().done();
	let (result, _) = fx.run(&trees, &flists, s.take());
	result.unwrap();
	assert_eq!(std::fs::read(fx.path("f")).unwrap(), want);
	let stats = lock(&fx.ctx.stats);
	assert_eq!(stats.touched_blocks_4k, 1);
	assert_eq!((stats.literal_data, stats.matched_data), (1024, 63 * 1024));
}

#[test]
fn append_adds_only_the_new_tail() {
	for (mode, sum_parts) in [(1u32, vec![&b"world"[..]]), (2, vec![&b"hello "[..], &b"world"[..]])] {
		let mut o = opts();
		o.inplace = true;
		o.append_mode = mode;
		let fx = Fixture::new(o, P33, SEED);
		std::fs::write(fx.path("f"), b"hello ").unwrap();
		let flists = flists_of(vec![entry("f", 11, 0o100_644, 1_400_000_000)]);
		let trees = fx.trees();
		let head = SumHead { count: 1, blength: 6, s2length: 2, remainder: 0 };
		let mut s = Stream::new(Compress::None);
		s.file(0, ITEM_TRANSFER, head, &[Tok::Lit(b"world")], &md5(SEED, &sum_parts));
		s.done().done().done();
		let (result, sib) = fx.run(&trees, &flists, s.take());
		result.unwrap();
		assert_eq!(std::fs::read(fx.path("f")).unwrap(), b"hello world", "append mode {mode}");
		assert!(!sib.contains(&Sibling::Redo(0)), "append mode {mode}: {}", fx.messages());
	}
}

#[test]
fn partial_keeps_received_data_when_the_stream_breaks() {
	let mut o = opts();
	o.keep_partial = true;
	let fx = Fixture::new(o, P33, SEED);
	let flists = flists_of(vec![entry("f", 100, 0o100_644, 1_400_000_000)]);
	let trees = fx.trees();
	let mut s = Stream::new(Compress::None);
	s.file(0, ITEM_TRANSFER, SumHead::default(), &[Tok::Lit(b"first part")], &[0; 16]);
	let mut stream = s.take();
	// Cut the stream right after the literal (before the end token).
	let cut = stream.windows(10).position(|w| w == b"first part").unwrap() + 10;
	stream.truncate(cut);
	let (result, _) = fx.run(&trees, &flists, stream);
	assert!(result.is_err());
	assert_eq!(std::fs::read(fx.path("f")).unwrap(), b"first part");
	// Without --partial-dir the kept file gets an ancient time.
	assert_eq!(mtime_of(&fx.path("f")), 0);
	assert_eq!(dir_names(fx.dir.path()), ["f"]);
}

#[test]
fn without_partial_a_broken_transfer_leaves_nothing() {
	let fx = Fixture::new(opts(), P33, SEED);
	let flists = flists_of(vec![entry("f", 100, 0o100_644, 1_400_000_000)]);
	let trees = fx.trees();
	let mut s = Stream::new(Compress::None);
	s.file(0, ITEM_TRANSFER, SumHead::default(), &[Tok::Lit(b"first part")], &[0; 16]);
	let mut stream = s.take();
	let cut = stream.windows(10).position(|w| w == b"first part").unwrap() + 10;
	stream.truncate(cut);
	let (result, _) = fx.run(&trees, &flists, stream);
	assert!(result.is_err());
	assert!(dir_names(fx.dir.path()).is_empty());
}

#[test]
fn partial_dir_receives_the_partial_file() {
	let mut o = opts();
	o.keep_partial = true;
	o.partial_dir = Some(".part".into());
	let fx = Fixture::new(o, P33, SEED);
	let flists = flists_of(vec![entry("f", 100, 0o100_644, 1_400_000_000)]);
	let trees = fx.trees();
	let mut s = Stream::new(Compress::None);
	s.file(0, ITEM_TRANSFER, SumHead::default(), &[Tok::Lit(b"first part")], &[0; 16]);
	let mut stream = s.take();
	let cut = stream.windows(10).position(|w| w == b"first part").unwrap() + 10;
	stream.truncate(cut);
	let (result, _) = fx.run(&trees, &flists, stream);
	assert!(result.is_err());
	assert_eq!(std::fs::read(fx.path(".part/f")).unwrap(), b"first part");
	assert!(!fx.path("f").exists());
}

#[test]
fn partial_dir_basis_is_consumed_and_removed() {
	let mut o = opts();
	o.keep_partial = true;
	o.partial_dir = Some(".part".into());
	let fx = Fixture::new(o, P33, SEED);
	std::fs::create_dir(fx.path(".part")).unwrap();
	std::fs::write(fx.path(".part/f"), b"0123456789").unwrap();
	let flists = flists_of(vec![entry("f", 15, 0o100_644, 1_400_000_000)]);
	let trees = fx.trees();
	let head = SumHead { count: 1, blength: 10, s2length: 2, remainder: 0 };
	let want = b"0123456789abcde";
	let mut s = Stream::new(Compress::None);
	s.ndx.write(&mut s.buf, 0).unwrap();
	s.buf.write_shortint((ITEM_TRANSFER | ITEM_BASIS_TYPE_FOLLOWS) as u16).unwrap();
	s.buf.push(FNAMECMP_PARTIAL_DIR);
	head.write(&mut s.buf, P33).unwrap();
	s.enc.send(&mut s.buf, &[], Some(0), b"0123456789").unwrap();
	s.enc.send(&mut s.buf, b"abcde", None, &[]).unwrap();
	s.enc.end_file(&mut s.buf).unwrap();
	s.buf.extend_from_slice(&md5(SEED, &[want]));
	s.done().done().done();
	let (result, _) = fx.run(&trees, &flists, s.take());
	result.unwrap();
	assert_eq!(std::fs::read(fx.path("f")).unwrap(), want);
	assert_eq!(dir_names(fx.dir.path()), ["f"]);
}

/// Test-only interposition points of the receiver (like the upstream suite's dyld hooks).
pub(crate) mod hooks {
	use std::{cell::RefCell, io};

	use pi_vfs::File;

	thread_local! {
		static AFTER_INPLACE_OPEN: RefCell<Option<Box<dyn FnOnce()>>> = RefCell::new(None);
	}

	/// Makes the next in-place output open fail with EACCES after running `f`.
	#[cfg(unix)]
	pub(crate) fn fail_next_inplace_open(f: impl FnOnce() + 'static) {
		AFTER_INPLACE_OPEN.with(|hook| *hook.borrow_mut() = Some(Box::new(f)));
	}

	/// Called by `open_inplace` with the first open's result.
	pub(crate) fn after_inplace_open(result: io::Result<File>) -> io::Result<File> {
		match AFTER_INPLACE_OPEN.with(|hook| hook.borrow_mut().take()) {
			Some(f) => {
				drop(result);
				f();
				Err(super::super::eacces())
			}
			None => result,
		}
	}
}

/// Upstream partial-protected-regular-retry-policy: the in-place partial-dir open
/// fails with EACCES, then `pdir` is swapped for a symlink. Every retry resolves
/// the partial dir by path again, so the symlink is refused (here it leads out of
/// `--confine-root`; ELOOP) instead of the retry reusing the old directory and
/// reporting "Permission denied". Nothing outside is written.
#[cfg(unix)]
#[test]
fn inplace_partial_retry_resolves_the_partial_dir_again() {
	let outside = tempfile::tempdir().unwrap();
	std::fs::create_dir(outside.path().join("secret")).unwrap();
	std::fs::write(outside.path().join("secret/f"), b"OTHER-SECRET!!!").unwrap();
	let mut o = opts();
	o.keep_partial = true;
	o.partial_dir = Some("pdir".into());
	let proto = Proto { version: 33, compat: CF_INPLACE_PARTIAL_DIR };
	let dir = tempfile::tempdir().unwrap();
	o.confine_root = Some(std::fs::canonicalize(dir.path()).unwrap().into_os_string());
	let mut fx = Fixture::new(o, proto, SEED);
	fx.dir = dir;
	std::fs::create_dir(fx.path("pdir")).unwrap();
	std::fs::write(fx.path("pdir/f"), b"0123456789").unwrap();
	let (pdir, held, secret) = (fx.path("pdir"), fx.path(".pdir-held"), outside.path().join("secret"));
	hooks::fail_next_inplace_open(move || {
		std::fs::rename(&pdir, &held).unwrap();
		std::os::unix::fs::symlink(&secret, &pdir).unwrap();
	});
	let flists = flists_of(vec![entry("f", 15, 0o100_644, 1_400_000_000)]);
	let trees = fx.trees();
	let (result, _) = fx.run(&trees, &flists, partial_basis_stream(proto));
	result.unwrap();
	let messages = fx.messages();
	let shown = format!("open \"{}\" failed: Too many levels of symbolic links", fx.path("pdir/f").display());
	assert!(messages.contains(&shown), "{messages}");
	assert!(!messages.contains("Permission denied"), "{messages}");
	assert!(fx.ctx.logger.got_xfer_error());
	assert_eq!(std::fs::read(outside.path().join("secret/f")).unwrap(), b"OTHER-SECRET!!!");
	assert_eq!(std::fs::read(fx.path(".pdir-held/f")).unwrap(), b"0123456789");
	assert!(!fx.path("f").exists());
}

/// The same race with the real ownership rule (root only): the swapped-in
/// symlink belongs to another user, so the retry prints upstream's notice.
#[cfg(unix)]
#[test]
fn inplace_partial_retry_refuses_a_foreign_symlink_swapped_in() {
	// SAFETY: geteuid has no preconditions.
	if unsafe { libc::geteuid() } != 0 {
		return;
	}
	let mut o = opts();
	o.keep_partial = true;
	o.partial_dir = Some("pdir".into());
	let proto = Proto { version: 33, compat: CF_INPLACE_PARTIAL_DIR };
	let fx = Fixture::new(o, proto, SEED);
	std::fs::create_dir(fx.path("pdir")).unwrap();
	std::fs::write(fx.path("pdir/f"), b"0123456789").unwrap();
	std::fs::create_dir(fx.path("secret")).unwrap();
	std::fs::write(fx.path("secret/f"), b"OTHER-SECRET!!!").unwrap();
	let (pdir, held) = (fx.path("pdir"), fx.path(".pdir-held"));
	hooks::fail_next_inplace_open(move || {
		std::fs::rename(&pdir, &held).unwrap();
		std::os::unix::fs::symlink("secret", &pdir).unwrap();
		std::os::unix::fs::lchown(&pdir, Some(65534), Some(65534)).unwrap();
	});
	let flists = flists_of(vec![entry("f", 15, 0o100_644, 1_400_000_000)]);
	let trees = fx.trees();
	let (result, _) = fx.run(&trees, &flists, partial_basis_stream(proto));
	result.unwrap();
	let messages = fx.messages();
	assert!(messages.contains(crate::rsync::paths::UNTRUSTED_SYMLINK_NOTICE), "{messages}");
	let shown = format!("open \"{}\" failed: Too many levels of symbolic links", fx.path("pdir/f").display());
	assert!(messages.contains(&shown), "{messages}");
	assert_eq!(std::fs::read(fx.path("secret/f")).unwrap(), b"OTHER-SECRET!!!");
	assert!(!fx.path("f").exists());
}

/// A one-file stream whose basis is the partial-dir file (10 bytes of block 0 + "abcde").
#[cfg(unix)]
fn partial_basis_stream(proto: Proto) -> Vec<u8> {
	let head = SumHead { count: 1, blength: 10, s2length: 2, remainder: 0 };
	let mut s = Stream::new(Compress::None);
	s.ndx.write(&mut s.buf, 0).unwrap();
	s.buf.write_shortint((ITEM_TRANSFER | ITEM_BASIS_TYPE_FOLLOWS) as u16).unwrap();
	s.buf.push(FNAMECMP_PARTIAL_DIR);
	head.write(&mut s.buf, proto).unwrap();
	s.enc.send(&mut s.buf, &[], Some(0), b"0123456789").unwrap();
	s.enc.send(&mut s.buf, b"abcde", None, &[]).unwrap();
	s.enc.end_file(&mut s.buf).unwrap();
	s.buf.extend_from_slice(&md5(SEED, &[b"0123456789abcde"]));
	s.done().done().done();
	s.take()
}

/// B17: the in-place partial-dir output resolves through the trusted-owner walk.
/// Here `pdir` is an in-tree symlink to `secret` that the walk must refuse (it
/// leads outside `--confine-root`), so the partial file behind it is neither
/// rewritten nor consumed and the file fails (upstream: `open … failed: Too many
/// levels of symbolic links`, exit 23).
#[cfg(unix)]
#[test]
fn inplace_partial_dir_output_is_not_followed_through_a_refused_symlink() {
	let dir = tempfile::tempdir().unwrap();
	let mut o = opts();
	o.keep_partial = true;
	o.partial_dir = Some("pdir".into());
	// Canonical, so a symlinked temp root (macOS /var) is not what gets refused.
	o.confine_root = Some(std::fs::canonicalize(dir.path()).unwrap().join("allowed").into_os_string());
	let proto = Proto { version: 33, compat: CF_INPLACE_PARTIAL_DIR };
	let mut fx = Fixture::new(o, proto, SEED);
	fx.dir = dir;
	std::fs::create_dir_all(fx.path("allowed")).unwrap();
	std::fs::create_dir(fx.path("secret")).unwrap();
	std::fs::write(fx.path("secret/f"), b"0123456789").unwrap();
	std::os::unix::fs::symlink("secret", fx.path("pdir")).unwrap();
	let flists = flists_of(vec![entry("f", 15, 0o100_644, 1_400_000_000)]);
	let trees = fx.trees();
	let (result, _) = fx.run(&trees, &flists, partial_basis_stream(proto));
	result.unwrap();
	let messages = fx.messages();
	let shown = format!("open \"{}\" failed: ", fx.path("pdir/f").display());
	assert!(messages.contains(&shown), "{messages}");
	assert!(fx.ctx.logger.got_xfer_error());
	assert_eq!(std::fs::read(fx.path("secret/f")).unwrap(), b"0123456789");
	assert!(!fx.path("f").exists());
}

/// B17 with the real ownership rule: a `pdir` symlink owned by another user is
/// refused even though it stays inside the tree (needs root to chown it).
#[cfg(unix)]
#[test]
fn inplace_partial_dir_refuses_a_foreign_owned_symlink() {
	// SAFETY: geteuid has no preconditions.
	if unsafe { libc::geteuid() } != 0 {
		return;
	}
	let mut o = opts();
	o.keep_partial = true;
	o.partial_dir = Some("pdir".into());
	let proto = Proto { version: 33, compat: CF_INPLACE_PARTIAL_DIR };
	let fx = Fixture::new(o, proto, SEED);
	std::fs::create_dir(fx.path("secret")).unwrap();
	std::fs::write(fx.path("secret/f"), b"0123456789").unwrap();
	std::os::unix::fs::symlink("secret", fx.path("pdir")).unwrap();
	std::os::unix::fs::lchown(fx.path("pdir"), Some(65534), Some(65534)).unwrap();
	let flists = flists_of(vec![entry("f", 15, 0o100_644, 1_400_000_000)]);
	let trees = fx.trees();
	let (result, _) = fx.run(&trees, &flists, partial_basis_stream(proto));
	result.unwrap();
	let messages = fx.messages();
	assert!(messages.contains(crate::rsync::paths::UNTRUSTED_SYMLINK_NOTICE), "{messages}");
	assert_eq!(std::fs::read(fx.path("secret/f")).unwrap(), b"0123456789");
	assert!(!fx.path("f").exists());
}

/// T: a `--temp-dir` that climbs out with ".." is refused per file, as upstream's
/// secure_mkstemp does (`mkstemp "<dest>/../tmpd/f.XXXXXX" failed: Invalid
/// argument (22)`, exit 23), and nothing is written.
#[test]
fn temp_dir_climbing_with_dot_dot_is_refused() {
	let mut o = opts();
	o.tmpdir = Some("../tmpd".into());
	let mut fx = Fixture::new(o, P33, SEED);
	let outer = tempfile::tempdir().unwrap();
	std::fs::create_dir(outer.path().join("dst")).unwrap();
	std::fs::create_dir(outer.path().join("tmpd")).unwrap();
	fx.dir = outer;
	let flists = flists_of(vec![entry("f", 5, 0o100_644, 1_400_000_000)]);
	let mut trees = fx.trees();
	trees.dest = Tree::open(&fx.ctx.fs, &fx.path("dst"), &TreeOpts::default()).unwrap();
	trees.temp_dir = Some(Tree::open(&fx.ctx.fs, &fx.path("tmpd"), &TreeOpts::default()).unwrap());
	let mut s = Stream::new(Compress::None);
	s.file(0, ITEM_TRANSFER | ITEM_IS_NEW, SumHead::default(), &[Tok::Lit(b"12345")], &md5(SEED, &[b"12345"]));
	s.done().done().done();
	let (result, _) = fx.run(&trees, &flists, s.take());
	result.unwrap();
	let messages = fx.messages();
	let want = format!("mkstemp \"{}\" failed: ", fx.path("dst").join("../tmpd/f.XXXXXX").display());
	assert!(messages.contains(&want), "{messages}");
	#[cfg(unix)]
	assert!(messages.contains("failed: Invalid argument (22)\n"), "{messages}");
	assert!(fx.ctx.logger.got_xfer_error());
	assert!(dir_names(&fx.path("dst")).is_empty());
	assert!(dir_names(&fx.path("tmpd")).is_empty());
}

#[test]
fn delay_updates_moves_files_into_place_at_the_end() {
	let mut o = opts();
	o.delay_updates = true;
	o.keep_partial = true;
	o.partial_dir = Some(".~tmp~".into());
	o.partial_dir_is_tmp = true;
	let fx = Fixture::new(o, P33, SEED);
	std::fs::write(fx.path("a"), b"old").unwrap();
	let flists = flists_of(vec![entry("a", 3, 0o100_644, 1_400_000_000), entry("b", 3, 0o100_644, 1_400_000_000)]);
	let trees = fx.trees();
	let mut s = Stream::new(Compress::None);
	s.file(0, ITEM_TRANSFER, SumHead::default(), &[Tok::Lit(b"new")], &md5(SEED, &[b"new"]));
	s.file(1, ITEM_TRANSFER | ITEM_IS_NEW, SumHead::default(), &[Tok::Lit(b"bbb")], &md5(SEED, &[b"bbb"]));
	// Phase 0 ends; the files still wait in .~tmp~.
	s.done();
	let (result, _) = fx.run(&trees, &flists, s.take());
	assert!(result.is_err(), "the stream ended before the last phase");
	assert_eq!(std::fs::read(fx.path("a")).unwrap(), b"old");
	assert_eq!(std::fs::read(fx.path(".~tmp~/a")).unwrap(), b"new");
	assert_eq!(std::fs::read(fx.path(".~tmp~/b")).unwrap(), b"bbb");

	// A full run moves them at the start of phase 2 and removes the partial dir.
	std::fs::remove_dir_all(fx.path(".~tmp~")).unwrap();
	let mut s = Stream::new(Compress::None);
	s.file(0, ITEM_TRANSFER, SumHead::default(), &[Tok::Lit(b"new")], &md5(SEED, &[b"new"]));
	s.file(1, ITEM_TRANSFER | ITEM_IS_NEW, SumHead::default(), &[Tok::Lit(b"bbb")], &md5(SEED, &[b"bbb"]));
	s.done().done().done();
	let (result, _) = fx.run(&trees, &flists, s.take());
	result.unwrap();
	assert_eq!(std::fs::read(fx.path("a")).unwrap(), b"new");
	assert_eq!(std::fs::read(fx.path("b")).unwrap(), b"bbb");
	assert_eq!(mtime_of(&fx.path("b")), 1_400_000_000);
	assert_eq!(dir_names(fx.dir.path()), ["a", "b"]);
}

#[test]
fn temp_dir_holds_the_file_until_it_is_renamed() {
	let mut o = opts();
	let tmp = tempfile::tempdir().unwrap();
	o.tmpdir = Some(tmp.path().as_os_str().to_owned());
	let fx = Fixture::new(o, P33, SEED);
	let flists = flists_of(vec![entry("f", 5, 0o100_640, 1_400_000_000)]);
	let mut trees = fx.trees();
	trees.temp_dir = Some(Tree::open(&fx.ctx.fs, tmp.path(), &TreeOpts::default()).unwrap());
	let mut s = Stream::new(Compress::None);
	s.file(0, ITEM_TRANSFER, SumHead::default(), &[Tok::Lit(b"12345")], &md5(SEED, &[b"12345"]));
	s.done().done().done();
	let (result, _) = fx.run(&trees, &flists, s.take());
	result.unwrap();
	assert_eq!(std::fs::read(fx.path("f")).unwrap(), b"12345");
	#[cfg(unix)]
	assert_eq!(mode_of(&fx.path("f")), 0o640);
	assert!(dir_names(tmp.path()).is_empty());
}

#[test]
fn sparse_output_keeps_holes() {
	let mut o = opts();
	o.sparse_files = true;
	let fx = Fixture::new(o, P33, SEED);
	let mut data = vec![0u8; 2 * 1024 * 1024];
	data[..5].copy_from_slice(b"start");
	let n = data.len();
	data[n - 3..].copy_from_slice(b"end");
	let flists = flists_of(vec![entry("f", data.len(), 0o100_644, 1_400_000_000)]);
	let trees = fx.trees();
	let mut s = Stream::new(Compress::None);
	s.file(0, ITEM_TRANSFER, SumHead::default(), &[Tok::Lit(&data)], &md5(SEED, &[&data]));
	s.done().done().done();
	let (result, _) = fx.run(&trees, &flists, s.take());
	result.unwrap();
	assert_eq!(std::fs::read(fx.path("f")).unwrap(), data);
	#[cfg(unix)]
	if super::data::fs_makes_holes(fx.dir.path()) {
		use std::os::unix::fs::MetadataExt;
		let meta = std::fs::metadata(fx.path("f")).unwrap();
		assert!(meta.blocks() * 512 < 512 * 1024, "allocated {} blocks", meta.blocks());
	}
	assert_eq!(lock(&fx.ctx.stats).touched_blocks_4k, 2);
}

#[test]
fn fuzzy_basis_without_fuzzy_is_refused() {
	let fx = Fixture::new(opts(), P33, SEED);
	let flists = flists_of(vec![entry("f", 1, 0o100_644, 0)]);
	let trees = fx.trees();
	let mut s = Stream::new(Compress::None);
	s.ndx.write(&mut s.buf, 0).unwrap();
	s.buf.write_shortint((ITEM_TRANSFER | ITEM_BASIS_TYPE_FOLLOWS | ITEM_XNAME_FOLLOWS) as u16).unwrap();
	s.buf.push(FNAMECMP_FUZZY);
	s.buf.write_vstring(b"../../etc/passwd").unwrap();
	let (result, _) = fx.run(&trees, &flists, s.take());
	let err = result.unwrap_err();
	assert_eq!((err.code, err.site), (RERR_PROTOCOL, Some(("receiver.c", 1028))));
	// The peer-supplied name was sanitized before it was shown.
	assert!(fx.messages().contains("rsync: refusing malicious fuzzy operation for etc/passwd\n"), "{}", fx.messages());
}

#[test]
fn unknown_basis_dir_index_is_refused() {
	let fx = Fixture::new(opts(), P33, SEED);
	let flists = flists_of(vec![entry("f", 1, 0o100_644, 0)]);
	let trees = fx.trees();
	let mut s = Stream::new(Compress::None);
	s.ndx.write(&mut s.buf, 0).unwrap();
	s.buf.write_shortint((ITEM_TRANSFER | ITEM_BASIS_TYPE_FOLLOWS) as u16).unwrap();
	s.buf.push(3);
	let (result, _) = fx.run(&trees, &flists, s.take());
	let err = result.unwrap_err();
	assert_eq!(err.message.as_deref(), Some("invalid basis_dir index: 3."));
	assert_eq!(err.site, Some(("receiver.c", 1049)));
}

#[test]
fn out_of_range_index_is_reported_with_the_list_bounds() {
	let fx = Fixture::new(opts(), P33, SEED);
	let flists = flists_of(vec![entry("f", 1, 0o100_644, 0)]);
	let trees = fx.trees();
	let mut s = Stream::new(Compress::None);
	s.ndx.write(&mut s.buf, 7).unwrap();
	s.buf.write_shortint(0).unwrap();
	let (result, _) = fx.run(&trees, &flists, s.take());
	let err = result.unwrap_err();
	assert_eq!(err.message.as_deref(), Some("File-list index 7 not in -1 - 0 (read_ndx_and_attrs) [receiver]"));
}

#[test]
fn dry_run_logs_without_reading_data() {
	let mut o = opts();
	o.dry_run = true;
	o.do_xfers = false;
	let fx = Fixture::new(o, P33, SEED);
	let flists = flists_of(vec![entry("f", 4, 0o100_644, 0)]);
	let trees = fx.trees();
	let mut s = Stream::new(Compress::None);
	// A dry-run sender sends no data after the attributes.
	s.ndx.write(&mut s.buf, 0).unwrap();
	s.buf.write_shortint((ITEM_TRANSFER | ITEM_IS_NEW) as u16).unwrap();
	s.done().done().done();
	let (result, sib) = fx.run(&trees, &flists, s.take());
	result.unwrap();
	assert!(!fx.path("f").exists());
	assert_eq!(sib, [Sibling::Done, Sibling::Done]);
	assert_eq!(lock(&fx.ctx.stats).xferred_files, 1);
}

#[test]
fn del_stats_are_read_between_requests() {
	let fx = Fixture::new(opts(), P33, SEED);
	let flists = flists_of(vec![entry("f", 0, 0o100_644, 0)]);
	let trees = fx.trees();
	let mut s = Stream::new(Compress::None);
	s.ndx.write(&mut s.buf, NDX_DEL_STATS).unwrap();
	for v in [3, 1, 1, 0, 0] {
		s.buf.write_varint(v).unwrap();
	}
	s.done().done().done();
	let (result, _) = fx.run(&trees, &flists, s.take());
	result.unwrap();
	let stats = lock(&fx.ctx.stats);
	assert_eq!((stats.deleted_files, stats.deleted_dirs, stats.deleted_symlinks), (5, 1, 1));
}

#[test]
fn directory_in_the_way_is_reported_and_skipped() {
	let fx = Fixture::new(opts(), P33, SEED);
	std::fs::create_dir(fx.path("f")).unwrap();
	let flists = flists_of(vec![entry("f", 4, 0o100_644, 0)]);
	let trees = fx.trees();
	let mut s = Stream::new(Compress::None);
	s.file(0, ITEM_TRANSFER, SumHead::default(), &[Tok::Lit(b"data")], &md5(SEED, &[b"data"]));
	s.done().done().done();
	let (result, _) = fx.run(&trees, &flists, s.take());
	result.unwrap();
	let messages = fx.messages();
	assert!(messages.contains("recv_files: \"") && messages.contains("f\" is a directory\n"), "{messages}");
	assert!(fx.path("f").is_dir());
}
