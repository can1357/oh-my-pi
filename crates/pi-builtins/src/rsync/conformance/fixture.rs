//! The shared fixture: a source tree exercising every file type and attribute
//! the comparison observes, plus named tweaks that stage pre-existing
//! destination states. Everything is deterministic: contents come from a fixed
//! PRNG and every timestamp is pinned (with nanoseconds) far from "now", so a
//! timestamp the transfer did not set is distinguishable from one it preserved
//! (see `snapshot::MtimeClass`).

use std::fs;
use std::os::unix::fs::{MetadataExt, PermissionsExt, symlink};
use std::path::Path;
use std::sync::LazyLock;
use std::time::{SystemTime, UNIX_EPOCH};

use crate::rsync::time::system_time;

/// Base of every pinned timestamp (2020-09-13).
const T0: i64 = 1_600_000_000;
/// Nanosecond component of base entries (plus the entry index).
const NS: u32 = 123_456_789;
/// Timestamp of stale destination files.
const OLD: i64 = T0 - 200_000;
/// Timestamp every tweak-created directory ends up with.
const OLD_DIR: i64 = T0 - 300_000;

/// What a base entry is.
enum Kind {
	Dir,
	File(Data),
	/// A hard link to the (already created) path.
	Hardlink(&'static str),
	Symlink(&'static str),
	Fifo,
}

enum Data {
	Bytes(&'static [u8]),
	Big,
	Mid,
	Zeros,
}

/// The base tree, created in order; entry `k` (1-based) gets mtime
/// `T0 + 1000·k` s and `NS + k` ns. Directory modes and times are applied last,
/// deepest first, so creating their children does not disturb them.
const BASE: &[(&str, Kind, u32)] = &[
	("src", Kind::Dir, 0o755),
	("src/empty", Kind::File(Data::Bytes(b"")), 0o644),
	("src/small.txt", Kind::File(Data::Bytes(b"hello world\n")), 0o644),
	("src/exec.sh", Kind::File(Data::Bytes(b"#!/bin/sh\necho hi\n")), 0o755),
	("src/ro.txt", Kind::File(Data::Bytes(b"read only\n")), 0o444),
	("src/private.txt", Kind::File(Data::Bytes(b"secret\n")), 0o600),
	("src/big.bin", Kind::File(Data::Big), 0o644),
	("src/mid.bin", Kind::File(Data::Mid), 0o644),
	("src/zeros.bin", Kind::File(Data::Zeros), 0o644),
	("src/with space.txt", Kind::File(Data::Bytes(b"spaces\n")), 0o644),
	("src/ünï cødé.txt", Kind::File(Data::Bytes(b"unicode\n")), 0o644),
	("src/-dash", Kind::File(Data::Bytes(b"dash\n")), 0o644),
	("src/obj.o", Kind::File(Data::Bytes(b"object\n")), 0o644),
	("src/a.tmp", Kind::File(Data::Bytes(b"temp\n")), 0o644),
	("src/.rsync-filter", Kind::File(Data::Bytes(b"- *.tmp\n")), 0o644),
	("src/hl1", Kind::File(Data::Bytes(b"linked\n")), 0o644),
	("src/hl2", Kind::Hardlink("src/hl1"), 0),
	("src/rel", Kind::Symlink("small.txt"), 0),
	("src/abs", Kind::Symlink("/nonexistent/abs/target"), 0),
	("src/dangling", Kind::Symlink("missing-file"), 0),
	("src/dirlink", Kind::Symlink("sub"), 0),
	("src/sub", Kind::Dir, 0o755),
	("src/sub/inner.txt", Kind::File(Data::Bytes(b"inner\n")), 0o644),
	("src/sub/x.o", Kind::File(Data::Bytes(b"obj\n")), 0o644),
	("src/sub/.rsync-filter", Kind::File(Data::Bytes(b"- inner.txt\n")), 0o644),
	("src/sub/hl3", Kind::Hardlink("src/hl1"), 0),
	("src/sub/unsafe", Kind::Symlink("../../outside.txt"), 0),
	("src/sub/deep", Kind::Dir, 0o700),
	("src/sub/deep/deeper", Kind::Dir, 0o755),
	("src/sub/deep/deeper/leaf.txt", Kind::File(Data::Bytes(b"leaf\n")), 0o644),
	("src/emptydir", Kind::Dir, 0o755),
	("src/sgid", Kind::Dir, 0o2775),
	("src/sgid/f", Kind::File(Data::Bytes(b"g\n")), 0o644),
	("src/fifo", Kind::Fifo, 0o644),
	("outside.txt", Kind::File(Data::Bytes(b"outside\n")), 0o644),
	("list.txt", Kind::File(Data::Bytes(b"small.txt\nsub/inner.txt\nsub/deep\n")), 0o644),
	("list0.txt", Kind::File(Data::Bytes(b"small.txt\0sub/inner.txt\0sub/deep\0")), 0o644),
];

/// xorshift32 bytes: incompressible, reproducible, and identical in every run.
fn noise(seed: u32, len: usize) -> Vec<u8> {
	let mut x = seed;
	(0..len)
		.map(|_| {
			x ^= x << 13;
			x ^= x >> 17;
			x ^= x << 5;
			x as u8
		})
		.collect()
}

/// 1.6 MB: many blocks at the default block size, and more than 1 MiB.
static BIG: LazyLock<Vec<u8>> = LazyLock::new(|| noise(1, 1_600_000));
static MID: LazyLock<Vec<u8>> = LazyLock::new(|| noise(2, 70_000));
/// A long run of zeros between noise, for `--sparse`.
static ZEROS: LazyLock<Vec<u8>> = LazyLock::new(|| {
	let mut data = noise(3, 65_536);
	data.resize(65_536 + 262_144, 0);
	data.extend(noise(4, 65_536));
	data
});

fn data(d: &Data) -> &'static [u8] {
	match d {
		Data::Bytes(b) => *b,
		Data::Big => BIG.as_slice(),
		Data::Mid => MID.as_slice(),
		Data::Zeros => ZEROS.as_slice(),
	}
}

/// Sets atime and mtime without following a final symlink.
fn set_time(path: &Path, secs: i64, nanos: u32) {
	let t = system_time(secs, i64::from(nanos)).unwrap();
	fs::set_times_nofollow(path, fs::FileTimes::new().set_accessed(t).set_modified(t))
		.unwrap_or_else(|e| panic!("{}: {e}", path.display()));
}

fn chmod(path: &Path, mode: u32) {
	fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
}

fn write_file(path: &Path, content: &[u8], mode: u32, secs: i64, nanos: u32) {
	fs::create_dir_all(path.parent().unwrap()).unwrap();
	fs::write(path, content).unwrap();
	chmod(path, mode);
	set_time(path, secs, nanos);
}

/// Builds the base tree plus `tweaks` (comma-separated) under `w`, then pins
/// the times of every directory the tweaks created.
pub(super) fn build(w: &Path, tweaks: &str) {
	let start = SystemTime::now().duration_since(UNIX_EPOCH).unwrap().as_secs() as i64;
	build_base(w);
	for tweak in tweaks.split(',').filter(|t| !t.is_empty()) {
		apply(w, tweak);
	}
	pin_fresh_dirs(w, start - 5);
}

fn build_base(w: &Path) {
	let mut dirs = Vec::new();
	for (index, (rel, kind, mode)) in BASE.iter().enumerate() {
		let k = index as i64 + 1;
		let (secs, nanos) = (T0 + 1000 * k, NS + k as u32);
		let path = w.join(rel);
		match kind {
			Kind::Dir => {
				fs::create_dir_all(&path).unwrap();
				dirs.push((path, *mode, secs, nanos));
			}
			Kind::File(d) => write_file(&path, data(d), *mode, secs, nanos),
			Kind::Hardlink(target) => fs::hard_link(w.join(target), &path).unwrap(),
			Kind::Symlink(target) => {
				symlink(target, &path).unwrap();
				set_time(&path, secs, nanos);
			}
			Kind::Fifo => {
				nix::unistd::mkfifo(path.as_path(), nix::sys::stat::Mode::from_bits_truncate(0o600)).unwrap();
				chmod(&path, *mode);
				set_time(&path, secs, nanos);
			}
		}
	}
	for (path, mode, secs, nanos) in dirs.iter().rev() {
		chmod(path, *mode);
		set_time(path, *secs, *nanos);
	}
}

/// Copies the regular files and real directories of `w/src` to `w/<dest>`
/// with their contents, modes, and mtimes (hard links become separate files;
/// symlinks and specials are left out).
fn mirror(w: &Path, dest: &str) {
	fn walk(from: &Path, to: &Path, dirs: &mut Vec<(std::path::PathBuf, u32)>) {
		fs::create_dir_all(to).unwrap();
		let mut names: Vec<_> = fs::read_dir(from).unwrap().map(|e| e.unwrap().file_name()).collect();
		names.sort();
		for name in names {
			let (a, b) = (from.join(&name), to.join(&name));
			let meta = fs::symlink_metadata(&a).unwrap();
			if meta.is_dir() {
				walk(&a, &b, dirs);
				dirs.push((b, meta.mode() & 0o7777));
			} else if meta.is_file() {
				fs::write(&b, fs::read(&a).unwrap()).unwrap();
				chmod(&b, meta.mode() & 0o7777);
				set_time(&b, meta.mtime(), meta.mtime_nsec() as u32);
			}
		}
	}
	let mut dirs = Vec::new();
	walk(&w.join("src"), &w.join(dest), &mut dirs);
	for (dir, mode) in dirs {
		chmod(&dir, mode);
	}
}

/// Applies one named destination-state tweak.
fn apply(w: &Path, tweak: &str) {
	let j = |rel: &str| w.join(rel);
	match tweak {
		// A previous, outdated copy: same size and time but different content
		// (small.txt), same content but old time (mid.bin), a delta basis
		// (big.bin), a newer file (with space.txt), a mode change (ro.txt), and
		// extraneous files for the deletion modes (junk.o is excluded by `*.o`).
		"stale" => {
			fs::create_dir_all(j("dst/sub")).unwrap();
			write_file(&j("dst/small.txt"), b"HELLO WORLD\n", 0o644, T0 + 3000, NS + 3);
			write_file(&j("dst/mid.bin"), &MID, 0o644, OLD, 0);
			let mut big = BIG.to_vec();
			big[800_000..800_100].fill(0xaa);
			write_file(&j("dst/big.bin"), &big, 0o644, OLD, 0);
			write_file(&j("dst/with space.txt"), b"newer!\n", 0o644, T0 + 100_000_000, 0);
			write_file(&j("dst/extra.txt"), b"extra\n", 0o644, OLD, 0);
			write_file(&j("dst/extradir/x.txt"), b"x\n", 0o644, OLD, 0);
			write_file(&j("dst/sub/extra2"), b"e\n", 0o644, OLD, 0);
			write_file(&j("dst/junk.o"), b"junk\n", 0o644, OLD, 0);
			write_file(&j("dst/ro.txt"), b"old ro\n", 0o644, OLD, 0);
		}
		// An exact copy of the regular files.
		"copy" => mirror(w, "dst"),
		// Every regular destination file one second newer (`--modify-window`).
		"shift1" => {
			fn walk(dir: &Path) {
				for entry in fs::read_dir(dir).unwrap() {
					let path = entry.unwrap().path();
					let meta = fs::symlink_metadata(&path).unwrap();
					if meta.is_dir() {
						walk(&path);
					} else if meta.is_file() {
						set_time(&path, meta.mtime() + 1, meta.mtime_nsec() as u32);
					}
				}
			}
			walk(&j("dst"));
		}
		// Truncated destination files (`--append`, `--partial`).
		"prefix" => {
			write_file(&j("dst/big.bin"), &BIG[..600_000], 0o644, OLD, 0);
			write_file(&j("dst/mid.bin"), &MID[..30_000], 0o644, OLD, 0);
		}
		// A leftover partial file in a partial dir.
		"partialdir" => write_file(&j("dst/.rsync-partial/big.bin"), &BIG[..800_000], 0o644, OLD, 0),
		// Non-empty directories where the source has a symlink and a file, and a
		// file where it has a directory.
		"conflict" => {
			write_file(&j("dst/rel/f"), b"f\n", 0o644, OLD, 0);
			write_file(&j("dst/small.txt/f"), b"f\n", 0o644, OLD, 0);
			write_file(&j("dst/sub"), b"notadir\n", 0o644, OLD, 0);
		}
		// An earlier backup for the alternate-basis options.
		"prev" => {
			mirror(w, "prev");
			write_file(&j("prev/small.txt"), b"HELLO WORLD\n", 0o644, OLD, 0);
		}
		// A similarly named basis for `--fuzzy`.
		"fuzzy" => {
			let mut big = BIG.to_vec();
			big[100..200].fill(0x55);
			write_file(&j("dst/big-1.bin"), &big, 0o644, OLD, 0);
		}
		// A destination symlink to a directory inside the destination (`-K`).
		"keepdir" => {
			fs::create_dir_all(j("dst/realsub")).unwrap();
			symlink("realsub", j("dst/sub")).unwrap();
			set_time(&j("dst/sub"), OLD, 0);
		}
		// A destination symlink to a directory outside the destination.
		"keepdir_out" => {
			fs::create_dir_all(j("elsewhere")).unwrap();
			fs::create_dir_all(j("dst")).unwrap();
			symlink("../elsewhere", j("dst/sub")).unwrap();
			set_time(&j("dst/sub"), OLD, 0);
		}
		// Temp dirs inside and outside the destination.
		"tmpdir" => {
			fs::create_dir_all(j("tmpd")).unwrap();
			fs::create_dir_all(j("dst/.tmpd")).unwrap();
		}
		other => panic!("unknown fixture tweak {other:?}"),
	}
}

/// Gives every real directory under `w` modified at or after `since` the
/// pinned [`OLD_DIR`] time.
fn pin_fresh_dirs(w: &Path, since: i64) {
	for entry in fs::read_dir(w).unwrap() {
		let path = entry.unwrap().path();
		let meta = fs::symlink_metadata(&path).unwrap();
		if meta.is_dir() {
			pin_fresh_dirs(&path, since);
			if meta.mtime() >= since {
				set_time(&path, OLD_DIR, 0);
			}
		}
	}
}

/// Creates the daemon's writable module root with a pinned time.
pub(super) fn module_root(w: &Path) {
	let rw = w.join("rw");
	fs::create_dir_all(&rw).unwrap();
	set_time(&rw, OLD_DIR, 0);
}
