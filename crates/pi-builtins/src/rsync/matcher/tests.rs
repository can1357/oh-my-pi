//! Matcher tests against token streams captured from rsync 3.5.1
//! (`rsync --server --sender` pulls with `--no-whole-file -I --checksum-seed=1234`,
//! protocol 33, negotiated xxh128; the token lists are the sender's wire ints).

use std::io::{self, Read};

use super::*;
use crate::rsync::checksum::CsumType;
use crate::rsync::options::Options;
use crate::rsync::token::Compress;

/// Compat flags the reference server announced (0x1fe).
const COMPAT: u32 = 0x1fe;
const SEED: i32 = 1234;

enum Seg {
	Rand(u64, usize),
	Zero(usize),
	Basis(usize, usize),
}

struct Case {
	name: &'static str,
	inplace: bool,
	basis: &'static [Seg],
	target: &'static [Seg],
	head: [i32; 4],
	tokens: &'static str,
	digest: &'static str,
}

const CASES: &[Case] = &[
	Case {
		name: "identical",
		inplace: false,
		basis: &[Seg::Rand(1, 10000)],
		target: &[Seg::Basis(0, 10000)],
		head: [15, 700, 2, 200],
		tokens: "B0-14 E",
		digest: "88b2f1c39201b555dbec308aae6a2e9d",
	},
	Case {
		name: "prefix_change",
		inplace: false,
		basis: &[Seg::Rand(1, 10000)],
		target: &[Seg::Rand(2, 300), Seg::Basis(300, 10000)],
		head: [15, 700, 2, 200],
		tokens: "L700 B1-14 E",
		digest: "2f733318be8cf769ab52182b37b14559",
	},
	Case {
		name: "suffix_change",
		inplace: false,
		basis: &[Seg::Rand(1, 10000)],
		target: &[Seg::Basis(0, 9000), Seg::Rand(3, 1500)],
		head: [15, 700, 2, 200],
		tokens: "B0-11 L2100 E",
		digest: "c9162df69a2bd5ac8e37ae70d17414ef",
	},
	Case {
		name: "insert_middle",
		inplace: false,
		basis: &[Seg::Rand(1, 10000)],
		target: &[Seg::Basis(0, 5000), Seg::Rand(4, 123), Seg::Basis(5000, 10000)],
		head: [15, 700, 2, 200],
		tokens: "B0-6 L823 B8-14 E",
		digest: "5ae6f8f078cb24732588e26bd5738d46",
	},
	Case {
		name: "block_reorder",
		inplace: false,
		basis: &[Seg::Rand(1, 10000)],
		target: &[Seg::Basis(9800, 10000), Seg::Basis(7000, 9800), Seg::Basis(0, 700), Seg::Basis(3500, 7000), Seg::Basis(700, 3500)],
		head: [15, 700, 2, 200],
		tokens: "L200 B10-13 B0 B5-9 B1-4 E",
		digest: "08f12ec1c3ca0b93cd915ac515ae3f7e",
	},
	Case {
		name: "all_different",
		inplace: false,
		basis: &[Seg::Rand(1, 10000)],
		target: &[Seg::Rand(5, 8000)],
		head: [15, 700, 2, 200],
		tokens: "L8000 E",
		digest: "1d002dfb5cd1db67843bc189e20705f5",
	},
	Case {
		name: "remainder_mid",
		inplace: false,
		basis: &[Seg::Rand(1, 10000)],
		target: &[Seg::Rand(6, 50), Seg::Basis(9800, 10000), Seg::Basis(0, 9800), Seg::Rand(7, 10)],
		head: [15, 700, 2, 200],
		tokens: "L250 B0-13 L10 E",
		digest: "f4344bd58d6e201db4e77ca3c881eed5",
	},
	Case {
		name: "remainder_end",
		inplace: false,
		basis: &[Seg::Rand(1, 10000)],
		target: &[Seg::Basis(0, 700), Seg::Rand(7, 333), Seg::Basis(9800, 10000)],
		head: [15, 700, 2, 200],
		tokens: "B0 L333 B14 E",
		digest: "91349b930c67b17cf7967d358ac897fa",
	},
	Case {
		name: "zeros",
		inplace: false,
		basis: &[Seg::Zero(7000)],
		target: &[Seg::Zero(7350)],
		head: [10, 700, 2, 0],
		tokens: "B0-9 L350 E",
		digest: "043e790548312c934545ae626d11b53b",
	},
	Case {
		name: "zeros_noise",
		inplace: false,
		basis: &[Seg::Zero(3500), Seg::Rand(8, 700), Seg::Zero(2800)],
		target: &[Seg::Rand(9, 10), Seg::Zero(4200), Seg::Basis(3500, 4200), Seg::Zero(1400)],
		head: [10, 700, 2, 0],
		tokens: "L10 B0-4 B9 B5-7 E",
		digest: "cc9ed29394475088a0cbfb00f11c8275",
	},
	Case {
		name: "big_literal",
		inplace: false,
		basis: &[Seg::Rand(10, 200000)],
		target: &[Seg::Rand(11, 100000), Seg::Basis(100000, 200000)],
		head: [286, 700, 2, 500],
		tokens: "L32768 L32768 L32768 L1796 B143-285 E",
		digest: "4c75fa02a0a6eb65af3cfa9009829e33",
	},
	Case {
		name: "large_windows",
		inplace: false,
		basis: &[Seg::Rand(12, 700000)],
		target: &[Seg::Basis(0, 300000), Seg::Rand(13, 5000), Seg::Basis(310000, 700000), Seg::Rand(14, 777)],
		head: [842, 832, 2, 288],
		tokens: "B0-359 L5816 B373-840 L1065 E",
		digest: "e10723c1c94383063e922eadc0f1cd96",
	},
	Case {
		name: "empty_target",
		inplace: false,
		basis: &[Seg::Rand(1, 10000)],
		target: &[],
		head: [15, 700, 2, 200],
		tokens: "E",
		digest: "7f498d4624c30160d8984701d306aa99",
	},
	Case {
		name: "empty_basis",
		inplace: false,
		basis: &[],
		target: &[Seg::Rand(15, 5000)],
		head: [0, 0, 0, 0],
		tokens: "L5000 E",
		digest: "918476c864bbb25912176ce2709ff759",
	},
	Case {
		name: "short_target",
		inplace: false,
		basis: &[Seg::Rand(1, 10000)],
		target: &[Seg::Basis(0, 500)],
		head: [15, 700, 2, 200],
		tokens: "L500 E",
		digest: "5ddd41d5cd0ca8e68fb0d92169d14d0b",
	},
	Case {
		name: "inplace_reorder",
		inplace: true,
		basis: &[Seg::Rand(1, 10000)],
		target: &[Seg::Basis(9800, 10000), Seg::Basis(7000, 9800), Seg::Basis(0, 700), Seg::Basis(3500, 7000), Seg::Basis(700, 3500)],
		head: [15, 700, 2, 200],
		tokens: "L200 B10-13 L7000 E",
		digest: "08f12ec1c3ca0b93cd915ac515ae3f7e",
	},
	Case {
		name: "inplace_zeros_noise",
		inplace: true,
		basis: &[Seg::Zero(3500), Seg::Rand(8, 700), Seg::Zero(2800)],
		target: &[Seg::Rand(9, 10), Seg::Zero(4200), Seg::Basis(3500, 4200), Seg::Zero(1400)],
		head: [10, 700, 2, 0],
		tokens: "L700 B1-4 B9 L1400 B8 L10 E",
		digest: "cc9ed29394475088a0cbfb00f11c8275",
	},
	Case {
		name: "inplace_zero_shift",
		inplace: true,
		basis: &[Seg::Zero(7000)],
		target: &[Seg::Rand(20, 100), Seg::Zero(7000)],
		head: [10, 700, 2, 0],
		tokens: "L700 B1-9 L100 E",
		digest: "992d59288c480a61fbf949813e4d4bdc",
	},
	Case {
		name: "inplace_insert",
		inplace: true,
		basis: &[Seg::Rand(1, 10000)],
		target: &[Seg::Basis(0, 5000), Seg::Rand(4, 123), Seg::Basis(5000, 10000)],
		head: [15, 700, 2, 200],
		tokens: "B0-6 L5223 E",
		digest: "5ae6f8f078cb24732588e26bd5738d46",
	},
];

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

fn build(spec: &[Seg], basis: &[u8]) -> Vec<u8> {
	let mut out = Vec::new();
	for seg in spec {
		match *seg {
			Seg::Rand(seed, n) => out.extend(rand(seed, n)),
			Seg::Zero(n) => out.resize(out.len() + n, 0),
			Seg::Basis(a, b) => out.extend_from_slice(&basis[a..b]),
		}
	}
	out
}

fn proto() -> Proto {
	Proto::new(33, COMPAT)
}

fn test_ctx() -> Ctx {
	let mut ctx = Ctx::for_tests(Options::default());
	ctx.proto = proto();
	ctx.xfer_sum = CsumType::Xxh128;
	ctx.seed = SEED;
	ctx.compress = Compress::None;
	ctx.am_server = true;
	ctx.am_sender = true;
	ctx
}

/// The generator side: first-pass sums of `basis` exactly as rsync's generator builds them.
fn sums_for(basis: &[u8]) -> Sums {
	let p = proto();
	// The generator sends an all-zero header for an empty basis.
	let head = if basis.is_empty() {
		SumHead::default()
	} else {
		SumHead::for_len(basis.len() as i64, 0, p, CsumType::Xxh128.digest_len())
	};
	let strong = Strong { kind: CsumType::Xxh128, seed: SEED, proto: p };
	let mut sum1 = Vec::new();
	let mut sum2 = Vec::new();
	if head.count > 0 {
		for block in basis.chunks(head.blength as usize) {
			sum1.push(checksum::checksum1(block));
			sum2.extend_from_slice(&strong.block(block)[..head.s2length as usize]);
		}
	}
	Sums::from_parts(head, sum1, sum2)
}

/// Expands "L8 B0-12 E" into wire ints (literal length, -(block+1), 0).
fn expand(tokens: &str) -> Vec<i32> {
	let mut out = Vec::new();
	for word in tokens.split_whitespace() {
		match word.split_at(1) {
			("L", n) => out.push(n.parse().unwrap()),
			("E", _) => out.push(0),
			("B", range) => {
				let (a, b) = match range.split_once('-') {
					Some((a, b)) => (a.parse::<i32>().unwrap(), b.parse::<i32>().unwrap()),
					None => (range.parse().unwrap(), range.parse().unwrap()),
				};
				out.extend((a..=b).map(|i| -(i + 1)));
			},
			_ => panic!("bad token word {word}"),
		}
	}
	out
}

/// Splits an uncompressed token stream into its ints, checking the literal bytes.
fn decode(stream: &[u8], target: &[u8], sums: &Sums) -> Vec<i32> {
	let mut ints = Vec::new();
	let mut pos = 0usize;
	let mut file_pos = 0usize;
	loop {
		let v = i32::from_le_bytes(*stream[pos..].first_chunk().unwrap());
		pos += 4;
		ints.push(v);
		if v > 0 {
			let n = v as usize;
			assert_eq!(&stream[pos..pos + n], &target[file_pos..file_pos + n], "literal bytes");
			pos += n;
			file_pos += n;
		} else if v < 0 {
			file_pos += sums.head.block_len(-v - 1) as usize;
		} else {
			break;
		}
	}
	assert_eq!(pos, stream.len(), "trailing bytes after the end token");
	assert_eq!(file_pos, target.len(), "tokens cover the file");
	ints
}

fn hex(b: &[u8]) -> String {
	b.iter().map(|b| format!("{b:02x}")).collect()
}

/// A reader that hands out at most `step` bytes per call (exercises the window).
struct Trickle<'a> {
	data: &'a [u8],
	step: usize,
}

impl Read for Trickle<'_> {
	fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
		let n = buf.len().min(self.step).min(self.data.len());
		buf[..n].copy_from_slice(&self.data[..n]);
		self.data = &self.data[n..];
		Ok(n)
	}
}

fn run_case(ctx: &Ctx, case: &Case, step: usize) {
	let basis = build(case.basis, &[]);
	let target = build(case.target, &basis);
	let mut sums = sums_for(&basis);
	let h = sums.head;
	assert_eq!([h.count, h.blength, h.s2length, h.remainder], case.head, "{}: sum head", case.name);
	sums.updating_basis = case.inplace;
	let mut enc = TokenEncoder::new(Compress::None, None);
	let mut out = Vec::new();
	let strong = Strong { kind: ctx.xfer_sum, seed: ctx.seed, proto: ctx.proto };
	let mut digest = strong.file();
	let mut src = Trickle { data: &target, step };
	let stats = match_file(ctx, &sums, &mut src, target.len() as u64, &mut enc, &mut out, &mut digest)
		.unwrap_or_else(|e| panic!("{}: {e}", case.name));
	let ints = decode(&out, &target, &sums);
	assert_eq!(ints, expand(case.tokens), "{}: token stream", case.name);
	let literal: u64 = ints.iter().filter(|&&v| v > 0).map(|&v| v as u64).sum();
	let matched: u64 =
		ints.iter().filter(|&&v| v < 0).map(|&v| sums.head.block_len(-v - 1) as u64).sum();
	assert_eq!((stats.literal, stats.matched), (literal, matched), "{}: counts", case.name);
	assert!(stats.read_error.is_none(), "{}", case.name);
	let sum = file_sum_trailer(digest, 16, false);
	assert_eq!(hex(&sum), case.digest, "{}: file checksum", case.name);
}

#[test]
fn token_streams_match_reference() {
	let ctx = test_ctx();
	for case in CASES {
		run_case(&ctx, case, usize::MAX);
	}
}

#[test]
fn token_streams_independent_of_read_sizes() {
	let ctx = test_ctx();
	for case in CASES {
		run_case(&ctx, case, 997);
	}
}

#[test]
fn short_file_reads_as_zeros_and_reports_enodata() {
	let ctx = test_ctx();
	let basis = rand(1, 10000);
	let sums = sums_for(&basis);
	let mut enc = TokenEncoder::new(Compress::None, None);
	let mut out = Vec::new();
	let strong = Strong { kind: ctx.xfer_sum, seed: ctx.seed, proto: ctx.proto };
	let mut digest = strong.file();
	// Claims 10000 bytes but delivers only the first 9000: the tail reads as zeros.
	let mut src: &[u8] = &basis[..9000];
	let stats = match_file(&ctx, &sums, &mut src, 10000, &mut enc, &mut out, &mut digest).unwrap();
	let err = stats.read_error.expect("short read must be reported");
	#[cfg(unix)]
	assert_eq!(err.raw_os_error(), Some(libc::ENODATA));
	#[cfg(not(unix))]
	let _ = err;
	let mut padded = basis[..9000].to_vec();
	padded.resize(10000, 0);
	let ints = decode(&out, &padded, &sums);
	// Blocks 0..=11 match (8400 bytes), then 1600 bytes of literal (600 real + zeros).
	assert_eq!(ints, expand("B0-11 L1600 E"));
	let sum = file_sum_trailer(digest, 16, true);
	assert_eq!(sum, vec![0u8; 16]);
}

#[test]
fn bad_checksum_after_read_error() {
	let ctx = test_ctx();
	let strong = Strong { kind: ctx.xfer_sum, seed: ctx.seed, proto: ctx.proto };
	let good = file_sum_trailer(strong.file(), 16, false);
	assert_ne!(good, vec![0u8; 16]);
	assert_eq!(file_sum_trailer(strong.file(), 16, true), vec![0u8; 16]);
	// CSUM_NONE's digest is a single zero byte: the error form must still differ.
	let none = Strong { kind: CsumType::None, seed: 0, proto: ctx.proto };
	assert_eq!(file_sum_trailer(none.file(), 1, false), vec![0]);
	assert_eq!(file_sum_trailer(none.file(), 1, true), vec![1]);
}

#[test]
fn append_sends_only_the_tail() {
	let ctx = test_ctx();
	let basis = rand(1, 10000);
	let mut target = basis.clone();
	target.extend(rand(2, 40000));
	for mode in [1u32, 2] {
		let mut sums = Sums::from_parts(sums_for(&basis).head, Vec::new(), Vec::new());
		sums.append_mode = mode;
		let mut enc = TokenEncoder::new(Compress::None, None);
		let mut out = Vec::new();
		let strong = Strong { kind: ctx.xfer_sum, seed: ctx.seed, proto: ctx.proto };
		let mut digest = strong.file();
		let mut src: &[u8] = &target;
		let stats =
			match_file(&ctx, &sums, &mut src, target.len() as u64, &mut enc, &mut out, &mut digest).unwrap();
		assert_eq!(stats.literal, 40000);
		// Literal pieces at CHUNK_SIZE boundaries counted from the append offset.
		let lit_a = &target[10000..10000 + 32768];
		let lit_b = &target[10000 + 32768..];
		let mut want = Vec::new();
		want.extend_from_slice(&32768i32.to_le_bytes());
		want.extend_from_slice(lit_a);
		want.extend_from_slice(&7232i32.to_le_bytes());
		want.extend_from_slice(lit_b);
		want.extend_from_slice(&0i32.to_le_bytes());
		assert_eq!(out, want);
		let sum = file_sum_trailer(digest, 16, false);
		let mut whole = strong.file();
		if mode == 2 {
			whole.update(&target);
		} else {
			whole.update(&target[10000..]);
		}
		assert_eq!(sum, file_sum_trailer(whole, 16, false), "append mode {mode}");
	}
}

#[test]
fn sums_read_validates_and_bounds_allocation() {
	let logger = test_ctx().logger.with_role(Role::Sender);
	let p = proto();
	let mut keep = || -> io::Result<()> { Ok(()) };
	// count 3, blength 0: CVE-2026-53792.
	let mut wire: Vec<u8> = [3i32, 0, 2, 0].iter().flat_map(|v| v.to_le_bytes()).collect();
	let err = Sums::read(&mut wire.as_slice(), p, 16, 0, 0, 0, &mut keep, &logger).unwrap_err();
	assert_eq!(err.code, exit::RERR_PROTOCOL);
	// 1000 blocks with a 16 KiB --max-alloc.
	wire = [1000i32, 700, 2, 0].iter().flat_map(|v| v.to_le_bytes()).collect();
	let err = Sums::read(&mut wire.as_slice(), p, 16, 16384, 0, 0, &mut keep, &logger).unwrap_err();
	assert_eq!(err.code, exit::RERR_MALLOC);
	assert_eq!(
		err.message.as_deref(),
		Some("[sender] exceeded --max-alloc=16384 setting (file=sender.c, line=364)")
	);
	// Two blocks: sum1 + 2-byte sums; append mode reads only the header.
	wire = [2i32, 700, 2, 100, 0x11223344, 0].iter().flat_map(|v| v.to_le_bytes()).collect();
	wire.truncate(16 + 4 + 2);
	wire.extend_from_slice(&0x55667788u32.to_le_bytes());
	wire.extend_from_slice(&[9, 8]);
	let mut r = wire.as_slice();
	let sums = Sums::read(&mut r, p, 16, 0, 0, 0, &mut keep, &logger).unwrap();
	assert!(r.is_empty());
	assert_eq!(sums.flength(), 800);
	assert_eq!(sums.sum1, vec![0x11223344, 0x55667788]);
	assert_eq!(sums.sum2, vec![0, 0, 9, 8]);
	let mut r = &wire[..16];
	let sums = Sums::read(&mut r, p, 16, 0, 1, 0, &mut keep, &logger).unwrap();
	assert_eq!((sums.flength(), sums.sum1.len()), (800, 0));
}
