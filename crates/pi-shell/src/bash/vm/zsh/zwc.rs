//! zsh's word code files (`.zwc`): the dump writer of `zcompile`
//! (`write_dump`) and the header reader behind `zcompile -t` and the
//! digest lookups of `source`/autoload (`load_dump_header`,
//! `dump_find_func`), zsh 5.9 `Src/parse.c`.
//!
//! A dump holds a header and the programs twice: in the byte order of the
//! host that wrote it, then in the other one. The header starts with
//! `FD_MAGIC` (the reader's own order) or `FD_OMAGIC` (the other half is
//! the reader's, at the offset the header names), a flags byte, that
//! offset, the version string, and one entry per program (where its code
//! starts, its lengths, its flags and its name).
//!
//! The bytes are zsh's except the padding after each program's string
//! table: zsh writes whatever its heap holds there (it never reads them);
//! this writer writes zeros.
//!
//! Ported from zsh 5.9 (MIT-style licence, Copyright (c) 1992-1997 Paul
//! Falstad and the zsh development group).

use bstr::BString;

use crate::bash::syntax::zsh::wordcode::Eprog;

/// The version a dump names (zsh `ZSH_VERSION`); readers reject others.
pub const ZSH_VERSION: &[u8] = b"5.9";
/// The file name extension (zsh `FD_EXT`).
pub const FD_EXT: &[u8] = b".zwc";
/// Smallest dump `zcompile` maps by default (zsh `FD_MINMAP`).
const FD_MINMAP: usize = 4096;
/// Header words before the function entries (zsh `FD_PRELEN`).
const FD_PRELEN: usize = 12;
/// zsh `FD_MAGIC`.
const FD_MAGIC: u32 = 0x0405_0607;
/// zsh `FD_OMAGIC`.
const FD_OMAGIC: u32 = 0x0706_0504;
/// zsh `FDF_MAP`: the dump is to be mapped.
const FDF_MAP: u8 = 1;
/// zsh `FDF_OTHER`: this header is the other byte order's.
const FDF_OTHER: u8 = 2;
/// Words of a function entry before its name (`struct fdhead`).
const FDHEAD_WORDS: usize = 6;

/// zsh `FDHF_KSHLOAD`: the function loads as under `ksh_autoload`.
pub const FDHF_KSHLOAD: u32 = 1;
/// zsh `FDHF_ZSHLOAD`: the function loads as without `ksh_autoload`.
pub const FDHF_ZSHLOAD: u32 = 2;

/// How the reading shell takes the dump in (`zcompile -R`/`-M`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Map {
	/// `-R`: read into memory.
	Read,
	/// Neither: mapped when it is at least `FD_MINMAP` bytes.
	Auto,
	/// `-M`: mapped.
	Mapped,
}

/// One program of a dump (zsh `struct wcfunc`).
pub struct DumpProg<'a> {
	/// The file or function name it is stored under.
	pub name:  &'a [u8],
	/// The compiled code.
	pub prog:  &'a Eprog,
	/// `FDHF_KSHLOAD`, `FDHF_ZSHLOAD` or 0.
	pub flags: u32,
}

/// Words a program takes in the dump: its code and strings, rounded up.
const fn prog_words(p: &Eprog) -> usize {
	p.byte_len().div_ceil(4)
}

/// Words of a function entry with its name (`head.hlen`).
const fn head_words(name: &[u8]) -> usize {
	FDHEAD_WORDS + (name.len() + 4) / 4
}

/// The dump zsh's `build_dump`/`build_cur_dump` + `write_dump` write for
/// `progs`.
pub fn write_dump(progs: &[DumpProg<'_>], map: Map) -> Vec<u8> {
	let hlen0 = FD_PRELEN + progs.iter().map(|p| head_words(p.name)).sum::<usize>();
	let tlen_words: usize = progs.iter().map(|p| prog_words(p.prog)).sum();
	// zsh's `tlen`: the byte length of one byte order's half.
	let tlen = (tlen_words + hlen0) * 4;
	let mapped = match map {
		Map::Read => false,
		Map::Mapped => true,
		Map::Auto => tlen >= FD_MINMAP,
	};
	let mut out = Vec::with_capacity(tlen * 2);
	for other in [false, true] {
		let word = |w: u32| -> [u8; 4] {
			if other {
				w.swap_bytes().to_ne_bytes()
			} else {
				w.to_ne_bytes()
			}
		};
		// The prelude: magic, flags and `other` offset bytes, version. Its
		// words are not swapped (only the magic tells the halves apart).
		let mut pre = [0u8; FD_PRELEN * 4];
		let magic = if other { FD_OMAGIC } else { FD_MAGIC };
		pre[..4].copy_from_slice(&magic.to_ne_bytes());
		let map_flag = if mapped { FDF_MAP } else { 0 };
		let other_flag = if other { FDF_OTHER } else { 0 };
		pre[4] = map_flag | other_flag;
		pre[5] = (tlen & 0xff) as u8;
		pre[6] = ((tlen >> 8) & 0xff) as u8;
		pre[7] = ((tlen >> 16) & 0xff) as u8;
		pre[8..8 + ZSH_VERSION.len()].copy_from_slice(ZSH_VERSION);
		out.extend_from_slice(&pre);
		let mut hlen = hlen0;
		for p in progs {
			let start = hlen as u32;
			hlen += prog_words(p.prog);
			let tail = p.name.iter().rposition(|&c| c == b'/').map_or(0, |i| i + 1);
			let head = [
				start,
				p.prog.byte_len() as u32,
				p.prog.npats,
				(p.prog.prog.len() * 4) as u32,
				head_words(p.name) as u32,
				p.flags | ((tail as u32) << 2),
			];
			let mut bytes = [0u8; FDHEAD_WORDS * 4];
			for (i, w) in head.iter().enumerate() {
				bytes[i * 4..i * 4 + 4].copy_from_slice(&word(*w));
			}
			out.extend_from_slice(&bytes);
			out.extend_from_slice(p.name);
			out.push(0);
			// zsh pads the name with the first bytes of the entry.
			let used = (p.name.len() + 1) & 3;
			if used != 0 {
				out.extend_from_slice(&bytes[..4 - used]);
			}
		}
		for p in progs {
			for &w in &p.prog.prog {
				out.extend_from_slice(&word(w));
			}
			out.extend_from_slice(&p.prog.strs);
			let pad = prog_words(p.prog) * 4 - p.prog.byte_len();
			out.resize(out.len() + pad, 0);
		}
	}
	out
}

/// Why a file is not a dump this shell reads (`load_dump_header`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BadDump {
	/// Too short or not a dump: `invalid zwc file`.
	Invalid,
	/// A dump of another zsh version (the version it names).
	Version(Vec<u8>),
}

/// The header of a dump in the reader's byte order (zsh's `Wordcode`
/// header: the prelude and the function entries).
pub struct DumpHeader {
	/// Where the reader's half starts in the file.
	off:   usize,
	/// The header's bytes (a whole number of words).
	bytes: Vec<u8>,
}

/// One function entry of a [`DumpHeader`].
pub struct DumpFunc<'a> {
	/// The name it was stored under (`fdname`).
	pub name: &'a [u8],
	/// Offset of the base name in `name` (`fdhtail`).
	pub tail: usize,
	/// Word offset of its code in the half (`start`).
	start:    usize,
	/// Bytes of code and strings (`len`).
	len:      usize,
	/// Patterns it numbers (`npats`).
	npats:    u32,
	/// Byte offset of its strings in its code (`strs`).
	strs:     usize,
}

impl DumpHeader {
	/// zsh `load_dump_header` over the bytes of a file.
	///
	/// # Errors
	/// [`BadDump`] when zsh would reject the file.
	pub fn parse(data: &[u8]) -> Result<Self, BadDump> {
		let pre_bytes = (FD_PRELEN + 1) * 4;
		let Some(first) = data.get(..pre_bytes) else {
			return Err(BadDump::Invalid);
		};
		let magic = u32::from_ne_bytes([first[0], first[1], first[2], first[3]]);
		if magic != FD_MAGIC && magic != FD_OMAGIC {
			return Err(BadDump::Invalid);
		}
		let version = &first[8..FD_PRELEN * 4];
		let version = &version[..version
			.iter()
			.position(|&c| c == 0)
			.unwrap_or(version.len())];
		if version != ZSH_VERSION {
			return Err(BadDump::Version(version.to_vec()));
		}
		let off = if magic == FD_MAGIC {
			0
		} else {
			usize::from(first[5]) | (usize::from(first[6]) << 8) | (usize::from(first[7]) << 16)
		};
		let pre = data.get(off..off + pre_bytes).ok_or(BadDump::Invalid)?;
		let len = word_at(pre, FD_PRELEN) as usize * 4;
		let bytes = data
			.get(off..off + len.max(pre_bytes))
			.ok_or(BadDump::Invalid)?;
		Ok(Self { off, bytes: bytes.to_vec() })
	}

	/// The program stored as function `name` (zsh `check_dump_file` with
	/// `dupeprog`): a copy of its code and strings from `data`, the bytes
	/// the header came from. `None` when the dump holds no such function or
	/// is cut short.
	pub fn func_prog(&self, data: &[u8], name: &[u8]) -> Option<Eprog> {
		let funcs = self.funcs();
		let f = funcs.iter().find(|f| f.name.get(f.tail..) == Some(name))?;
		let base = self.off + f.start * 4;
		let code = data.get(base..base + f.strs)?;
		let strs = data.get(base + f.strs..base + f.len)?;
		Some(Eprog {
			prog:  code
				.as_chunks::<4>()
				.0
				.iter()
				.map(|c| u32::from_ne_bytes([c[0], c[1], c[2], c[3]]))
				.collect(),
			strs:  strs.to_vec(),
			npats: f.npats,
		})
	}

	/// The base names (metafied) of the functions [`Self::func_prog`]
	/// loads from `data`: the first entry of each name, whole in `data`.
	pub fn loadable(&self, data: &[u8]) -> std::collections::HashSet<BString> {
		let mut seen = std::collections::HashSet::new();
		let mut out = std::collections::HashSet::new();
		for f in self.funcs() {
			let Some(name) = f.name.get(f.tail..) else {
				continue;
			};
			if !seen.insert(name) {
				continue;
			}
			let base = self.off + f.start * 4;
			if f.strs <= f.len && data.get(base..base + f.len).is_some() {
				out.insert(BString::from(name));
			}
		}
		out
	}

	/// Word `i` of the header (0 past its end).
	fn word(&self, i: usize) -> u32 {
		word_at(&self.bytes, i)
	}

	/// Whether the dump is to be mapped (`fdflags & FDF_MAP`).
	pub fn mapped(&self) -> bool {
		self.bytes.get(4).is_some_and(|&b| b & FDF_MAP != 0)
	}

	/// The version string (`fdversion`).
	pub fn version(&self) -> &[u8] {
		let v = self.bytes.get(8..FD_PRELEN * 4).unwrap_or_default();
		&v[..v.iter().position(|&c| c == 0).unwrap_or(v.len())]
	}

	/// The function entries in order (`firstfdhead` … `nextfdhead`).
	pub fn funcs(&self) -> Vec<DumpFunc<'_>> {
		let mut out = Vec::new();
		let end = (self.word(FD_PRELEN) as usize).min(self.bytes.len() / 4);
		let mut at = FD_PRELEN;
		while at + FDHEAD_WORDS <= end {
			let hlen = self.word(at + 4) as usize;
			let flags = self.word(at + 5);
			let name = self
				.bytes
				.get((at + FDHEAD_WORDS) * 4..)
				.unwrap_or_default();
			let name = &name[..name.iter().position(|&c| c == 0).unwrap_or(name.len())];
			out.push(DumpFunc {
				name,
				tail: (flags >> 2) as usize,
				start: self.word(at) as usize,
				len: self.word(at + 1) as usize,
				npats: self.word(at + 2),
				strs: self.word(at + 3) as usize,
			});
			if hlen == 0 {
				break;
			}
			at += hlen;
		}
		out
	}

	/// zsh `dump_find_func`: whether a function's base name is `name`.
	pub fn find_func(&self, name: &[u8]) -> bool {
		self
			.funcs()
			.iter()
			.any(|f| f.name.get(f.tail..) == Some(name))
	}
}

/// Dumps of `/bin/zsh -f -c 'zcompile [-R] /tmp/zcfix/NAME.zsh.zwc
/// /tmp/zcfix/NAME.zsh'` 5.9 (arm64, little-endian), the padding after each
/// program's strings zeroed (zsh writes heap garbage there).
#[cfg(all(test, target_endian = "little"))]
mod tests {
	use super::*;
	use crate::bash::syntax::{Features, NO_ALIASES, zsh::wordcode::compile};

	macro_rules! fixture {
		($name:literal) => {
			(
				$name,
				include_bytes!(concat!("../../../testkit/fixtures/zcompile/", $name, ".zsh")),
				include_bytes!(concat!("../../../testkit/fixtures/zcompile/", $name, ".zwc")),
			)
		};
	}

	const FIXTURES: [(&str, &[u8], &[u8]); 8] = [
		fixture!("simple"),
		fixture!("compound"),
		fixture!("funcs"),
		fixture!("cond"),
		fixture!("redir"),
		fixture!("misc"),
		fixture!("zmv"),
		fixture!("zcalc"),
	];

	/// zsh -f's parse-affecting defaults (`shortloops`, `multifuncdef`);
	/// `zcompile` always reads comments.
	fn features() -> Features {
		Features::ZSH
			| Features::ZSH_SHORT_LOOPS
			| Features::ZSH_MULTI_FUNC_DEF
			| Features::ZSH_INTERACTIVE_COMMENTS
	}

	fn dump_of(name: &str, src: &[u8]) -> Vec<u8> {
		let prog =
			compile(src, features(), NO_ALIASES, false).unwrap_or_else(|e| panic!("{name}: {e:?}"));
		let path = format!("/tmp/zcfix/{name}.zsh");
		write_dump(&[DumpProg { name: path.as_bytes(), prog: &prog, flags: 0 }], Map::Auto)
	}

	#[test]
	fn zcompile_dumps_are_zshs() {
		for (name, src, want) in FIXTURES {
			let got = dump_of(name, src);
			if got != want {
				let at = got
					.iter()
					.zip(want)
					.position(|(a, b)| a != b)
					.unwrap_or(got.len().min(want.len()));
				panic!(
					"{name}: dump differs from zsh's at byte {at} (word {}): got {} bytes, want {}",
					at / 4,
					got.len(),
					want.len()
				);
			}
		}
	}

	#[test]
	fn zcompile_header_lists_zshs_dumps() {
		for (name, _, data) in FIXTURES {
			let head = DumpHeader::parse(data).unwrap_or_else(|_| panic!("{name}"));
			assert_eq!(head.version(), b"5.9");
			// zmv and zcalc are 4096 bytes or more: mapped by default.
			assert_eq!(head.mapped(), matches!(name, "zmv" | "zcalc"), "{name}");
			let names: Vec<&[u8]> = head.funcs().iter().map(|f| f.name).collect();
			let want = format!("/tmp/zcfix/{name}.zsh");
			assert_eq!(names, [want.as_bytes()]);
			assert!(head.find_func(format!("{name}.zsh").as_bytes()));
			assert!(!head.find_func(b"other"));
		}
	}

	#[test]
	fn zcompile_dump_programs_read_back() {
		let (name, src, _) = FIXTURES[2];
		let prog = compile(src, features(), NO_ALIASES, false).expect("funcs compiles");
		let data = write_dump(
			&[DumpProg { name: b"dir/one", prog: &prog, flags: FDHF_KSHLOAD }, DumpProg {
				name:  b"two",
				prog:  &prog,
				flags: FDHF_ZSHLOAD,
			}],
			Map::Read,
		);
		let head = DumpHeader::parse(&data).expect(name);
		let funcs = head.funcs();
		assert_eq!(funcs.len(), 2);
		assert_eq!((funcs[0].name, funcs[0].tail), (&b"dir/one"[..], 4));
		assert_eq!((funcs[1].name, funcs[1].tail), (&b"two"[..], 0));
		assert_eq!(word_at(&data, FD_PRELEN + 5), FDHF_KSHLOAD | (4 << 2));
		let second = FD_PRELEN + word_at(&data, FD_PRELEN + 4) as usize;
		assert_eq!(word_at(&data, second + 5), FDHF_ZSHLOAD);
		assert_eq!(head.func_prog(&data, b"one"), Some(prog.clone()));
		assert_eq!(head.func_prog(&data, b"two"), Some(prog));
		assert_eq!(head.func_prog(&data, b"dir/one"), None);
	}

	#[test]
	fn zcompile_rejects_other_files() {
		assert_eq!(DumpHeader::parse(b"short").err(), Some(BadDump::Invalid));
		let mut data = vec![0u8; 64];
		assert_eq!(DumpHeader::parse(&data).err(), Some(BadDump::Invalid));
		data[..4].copy_from_slice(&FD_MAGIC.to_ne_bytes());
		data[8..11].copy_from_slice(b"5.8");
		assert_eq!(DumpHeader::parse(&data).err(), Some(BadDump::Version(b"5.8".to_vec())));
	}

	#[test]
	fn zcompile_reports_syntax_errors_with_zshs_lines() {
		// zsh: `zsh:3: parse error near `\n'` for an `if` never closed.
		let err = compile(b"echo hi\nif foo; then\n", features(), NO_ALIASES, false).unwrap_err();
		assert_eq!(
			err,
			crate::bash::syntax::zsh::wordcode::CompileError::Syntax(vec![(
				3,
				b"parse error near `\\n'".to_vec()
			)])
		);
	}
}

/// Word `i` of `bytes` in the reader's byte order (0 past the end).
fn word_at(bytes: &[u8], i: usize) -> u32 {
	bytes
		.get(i * 4..i * 4 + 4)
		.map_or(0, |c| u32::from_ne_bytes([c[0], c[1], c[2], c[3]]))
}
