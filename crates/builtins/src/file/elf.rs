//! The ELF details libmagic reads in C rather than through magic rules
//! (`readelf.c`, file 5.41): linkage, interpreter, notes (build ID, target
//! OS), and whether the symbol table was stripped. Core-file notes are not
//! decoded.

use std::{fmt::Write as _, io};

/// Random access to the file under inspection.
pub(super) trait ReadAt {
	/// Reads into `buf` from `offset`, returning how many bytes were there.
	fn read_at(&mut self, offset: u64, buf: &mut [u8]) -> io::Result<usize>;
}

/// The `-P` limits ELF analysis honours.
#[derive(Clone, Copy)]
pub(super) struct ElfLimits {
	pub notes:   u16,
	pub phnum:   u16,
	pub shnum:   u16,
	/// How much of a segment is read (`BUFSIZ`).
	pub segment: usize,
}

const ET_REL: u16 = 1;
const ET_EXEC: u16 = 2;
const ET_DYN: u16 = 3;
const PT_DYNAMIC: u32 = 2;
const PT_INTERP: u32 = 3;
const PT_NOTE: u32 = 4;
const SHT_SYMTAB: u32 = 2;
const SHT_NOTE: u32 = 7;
const DT_NEEDED: u64 = 1;
const DT_FLAGS_1: u64 = 0x6fff_fffb;
const DF_1_PIE: u64 = 0x0800_0000;

const DID_OS_NOTE: u32 = 1 << 0;
const DID_BUILD_ID: u32 = 1 << 1;
const DID_NETBSD_PAX: u32 = 1 << 2;
const DID_NETBSD_MARCH: u32 = 1 << 3;
const DID_NETBSD_CMODEL: u32 = 1 << 4;
const DID_NETBSD_EMULATION: u32 = 1 << 5;
const DID_NETBSD_UNKNOWN: u32 = 1 << 6;

struct Elf<'s> {
	src:        &'s mut dyn ReadAt,
	out:        String,
	is64:       bool,
	little:     bool,
	/// The file's size; `None` for a pipe.
	fsize:      Option<u64>,
	mime:       bool,
	raw:        bool,
	flags:      u32,
	notes_left: u16,
	segment:    usize,
	mode:       u32,
}

/// Describes the ELF image starting in `head`: the text libmagic appends to
/// the magic rules' description (empty in MIME mode), or `None` when `head`
/// is not ELF. `mode`'s execute bits are rewritten from `DF_1_PIE`, which the
/// rules read to tell a PIE from a shared object.
pub(super) fn describe(
	head: &[u8],
	src: &mut dyn ReadAt,
	fsize: Option<u64>,
	mime: bool,
	raw: bool,
	limits: ElfLimits,
	mode: &mut u32,
) -> Option<String> {
	if head.len() < 6 || head[0] != 0x7f || !matches!(head[1], b'E' | b'O') || head[2] != b'L' || head[3] != b'F' {
		return None;
	}
	let class = head[4];
	let mut elf = Elf {
		src,
		out: String::new(),
		is64: class == 2,
		little: head[5] == 1,
		fsize,
		mime,
		raw,
		flags: 0,
		notes_left: limits.notes,
		segment: limits.segment,
		mode: *mode,
	};
	match class {
		1 | 2 => elf.header(head, limits),
		_ => {
			let _ = write!(elf.out, ", unknown class {class}");
		},
	}
	*mode = elf.mode;
	Some(elf.out)
}

impl Elf<'_> {
	fn u16(&self, b: &[u8], at: usize) -> u16 {
		let raw = [b[at], b[at + 1]];
		if self.little { u16::from_le_bytes(raw) } else { u16::from_be_bytes(raw) }
	}

	fn u32(&self, b: &[u8], at: usize) -> u32 {
		let raw = [b[at], b[at + 1], b[at + 2], b[at + 3]];
		if self.little { u32::from_le_bytes(raw) } else { u32::from_be_bytes(raw) }
	}

	fn u64(&self, b: &[u8], at: usize) -> u64 {
		let mut raw = [0; 8];
		raw.copy_from_slice(&b[at..at + 8]);
		if self.little { u64::from_le_bytes(raw) } else { u64::from_be_bytes(raw) }
	}

	/// A class-sized word: at `at32` in the 32-bit layout, `at64` in the
	/// 64-bit one.
	fn word(&self, b: &[u8], at32: usize, at64: usize) -> u64 {
		if self.is64 { self.u64(b, at64) } else { u64::from(self.u32(b, at32)) }
	}

	/// Reads up to `len` bytes at `offset`; `None` on an I/O error.
	fn pread(&mut self, offset: u64, len: usize) -> Option<Vec<u8>> {
		let mut buf = vec![0; len];
		let read = self.src.read_at(offset, &mut buf).ok()?;
		buf.truncate(read);
		Some(buf)
	}

	/// Reads exactly `len` bytes at `offset`.
	fn pread_exact(&mut self, offset: u64, len: usize) -> Option<Vec<u8>> {
		self.pread(offset, len).filter(|buf| buf.len() == len)
	}

	fn too_many(&mut self, what: &str, count: u16) {
		if !self.mime {
			let _ = write!(self.out, ", too many {what} ({count})");
		}
	}

	/// `elfclass.h`: dispatches on the object type.
	fn header(&mut self, head: &[u8], limits: ElfLimits) {
		let header_size = if self.is64 { 64 } else { 52 };
		if head.len() <= header_size {
			return;
		}
		let kind = self.u16(head, 16);
		let (phnum, shnum, phentsize, shentsize, shstrndx) = if self.is64 {
			(self.u16(head, 56), self.u16(head, 60), self.u16(head, 54), self.u16(head, 58), self.u16(head, 62))
		} else {
			(self.u16(head, 44), self.u16(head, 48), self.u16(head, 42), self.u16(head, 46), self.u16(head, 50))
		};
		let phoff = self.word(head, 28, 32);
		let shoff = self.word(head, 32, 40);
		if matches!(kind, ET_EXEC | ET_DYN) {
			if phnum > limits.phnum {
				return self.too_many("program", phnum);
			}
			if shnum > limits.shnum {
				return self.too_many("section", shnum);
			}
			if !self.program_headers(phoff, phnum, usize::from(phentsize), shnum) {
				return;
			}
		}
		if matches!(kind, ET_REL | ET_EXEC | ET_DYN) {
			if shnum > limits.shnum {
				return self.too_many("section headers", shnum);
			}
			self.section_headers(shoff, shnum, usize::from(shentsize), usize::from(shstrndx));
		}
		if self.notes_left == 0 {
			self.too_many("notes", limits.notes);
		}
	}

	/// `dophn_exec`: static or dynamic linkage and the interpreter. `false`
	/// ends the analysis.
	fn program_headers(&mut self, mut off: u64, num: u16, size: usize, shnum: u16) -> bool {
		let entry_size = if self.is64 { 56 } else { 32 };
		if num == 0 {
			self.out.push_str(", no program header");
			return true;
		}
		if size != entry_size {
			self.out.push_str(", corrupted program header size");
			return true;
		}
		let mut interp: Vec<u8> = Vec::new();
		let (mut pie, mut dynamic, mut need) = (false, false, 0usize);
		for _ in 0..num {
			let Some(ph) = self.pread_exact(off, entry_size) else {
				let _ = write!(self.out, ", can't read elf program headers at {off}");
				return true;
			};
			off += size as u64;
			let kind = self.u32(&ph, 0);
			let offset = self.word(&ph, 4, 8);
			let filesz = self.word(&ph, 16, 32);
			let mut align = 4u64;
			match kind {
				PT_DYNAMIC | PT_INTERP => {},
				PT_NOTE => {
					// Already handled through the section headers.
					if shnum != 0 {
						continue;
					}
					align = self.word(&ph, 28, 48);
					if align & 0x8000_0000 != 0 || align < 4 {
						let _ = write!(self.out, ", invalid note alignment {align:#x}");
						align = 4;
					}
				},
				_ => continue,
			}
			let len = usize::try_from(filesz).map_or(self.segment, |filesz| filesz.min(self.segment));
			let Some(mut buf) = self.pread(offset, len) else {
				let _ = write!(self.out, ", can't read section at {offset}");
				return true;
			};
			match kind {
				PT_DYNAMIC => {
					dynamic = true;
					// DF_1_PIE decides whether this is a PIE.
					self.mode &= !0o111;
					let entry = if self.is64 { 16 } else { 8 };
					for item in buf.chunks_exact(entry) {
						let (tag, value) = if self.is64 {
							(self.u64(item, 0), self.u64(item, 8))
						} else {
							(u64::from(self.u32(item, 0)), u64::from(self.u32(item, 4)))
						};
						match tag {
							DT_FLAGS_1 => {
								pie = true;
								if value & DF_1_PIE != 0 {
									self.mode |= 0o111;
								} else {
									self.mode &= !0o111;
								}
							},
							DT_NEEDED => need += 1,
							_ => {},
						}
					}
				},
				PT_INTERP => {
					need += 1;
					if self.mime {
						continue;
					}
					if buf.first().is_some_and(|&c| c != 0) {
						buf.pop();
						let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
						buf.truncate(end);
						interp = buf;
					} else {
						interp = b"*empty*".to_vec();
					}
				},
				_ => {
					if self.mime {
						return false;
					}
					self.notes(&buf, align as usize);
				},
			}
		}
		if self.mime {
			return false;
		}
		let linking = if !dynamic {
			"statically"
		} else if pie && need == 0 {
			"static-pie"
		} else {
			"dynamically"
		};
		let _ = write!(self.out, ", {linking} linked");
		if !interp.is_empty() {
			self.out.push_str(", interpreter ");
			self.push_printable(&interp);
		}
		true
	}

	/// `file_printable`: text from the file, non-printable bytes as `\ooo`.
	fn push_printable(&mut self, text: &[u8]) {
		for &c in text {
			if self.raw || (0x20..0x7f).contains(&c) {
				self.out.push(c as char);
			} else {
				let _ = write!(self.out, "\\{c:03o}");
			}
		}
	}

	/// Runs `donote` over a note segment or section.
	fn notes(&mut self, buf: &[u8], align: usize) {
		let mut offset = 0;
		while offset < buf.len() {
			offset = self.note(buf, offset, align);
			if offset == 0 {
				break;
			}
		}
	}

	/// `donote`: decodes the note at `offset`, returning where the next one
	/// starts, or 0 to stop.
	fn note(&mut self, buf: &[u8], mut offset: usize, align: usize) -> usize {
		const HEADER: usize = 12;
		let size = buf.len();
		if self.notes_left == 0 {
			return 0;
		}
		self.notes_left -= 1;
		if HEADER + offset > size {
			return HEADER + offset;
		}
		let namesz = self.u32(buf, offset);
		let descsz = self.u32(buf, offset + 4);
		let kind = self.u32(buf, offset + 8);
		offset += HEADER;
		if namesz == 0 && descsz == 0 {
			return offset.max(size);
		}
		if namesz & 0x8000_0000 != 0 {
			let _ = write!(self.out, ", bad note name size {namesz:#x}");
			return 0;
		}
		if descsz & 0x8000_0000 != 0 {
			let _ = write!(self.out, ", bad note description size {descsz:#x}");
			return 0;
		}
		let (namesz, descsz) = (namesz as usize, descsz as usize);
		let align_up = |value: usize| value.div_ceil(align) * align;
		let noff = offset;
		let doff = align_up(offset + namesz);
		if offset + namesz > size {
			return doff;
		}
		let next = align_up(doff + descsz);
		if doff + descsz > size {
			return next.max(size);
		}
		// The name as the C string libmagic compares.
		let name = &buf[noff..noff + namesz];
		let name = &name[..name.iter().position(|&c| c == 0).unwrap_or(name.len())];
		let desc = &buf[doff..doff + descsz];

		if self.flags & DID_OS_NOTE == 0 && self.os_note(name, namesz, kind, desc) {
			return next;
		}
		if self.flags & DID_BUILD_ID == 0 && self.build_id_note(name, namesz, kind, desc) {
			return next;
		}
		if self.flags & DID_NETBSD_PAX == 0 && namesz == 4 && name == b"PaX" && kind == 3 && descsz == 4 {
			const PAX: [&str; 6] = ["+mprotect", "-mprotect", "+segvguard", "-segvguard", "+ASLR", "-ASLR"];
			self.flags |= DID_NETBSD_PAX;
			let bits = self.u32(desc, 0);
			if bits != 0 {
				self.out.push_str(", PaX: ");
			}
			let mut first = true;
			for (bit, label) in PAX.iter().enumerate() {
				if bits & (1 << bit) != 0 {
					if !first {
						self.out.push(',');
					}
					first = false;
					self.out.push_str(label);
				}
			}
			return next;
		}
		if namesz == 7 && name == b"NetBSD" {
			let (flag, tag) = match kind {
				1 => return next,
				5 => (DID_NETBSD_MARCH, "compiled for"),
				6 => (DID_NETBSD_CMODEL, "compiler model"),
				2 => (DID_NETBSD_EMULATION, "emulation:"),
				_ => {
					if self.flags & DID_NETBSD_UNKNOWN == 0 {
						self.flags |= DID_NETBSD_UNKNOWN;
						let _ = write!(self.out, ", note={kind}");
					}
					return next;
				},
			};
			if self.flags & flag == 0 {
				self.flags |= flag;
				let text = &desc[..desc.len().min(100)];
				let text = &text[..text.iter().position(|&c| c == 0).unwrap_or(text.len())];
				let _ = write!(self.out, ", {tag}: {}", String::from_utf8_lossy(text));
			}
		}
		next
	}

	/// `do_os_note`: the OS and version the image targets.
	fn os_note(&mut self, name: &[u8], namesz: usize, kind: u32, desc: &[u8]) -> bool {
		if kind != 1 {
			return false;
		}
		match (namesz, name, desc.len()) {
			(5, b"SuSE", 2) => {
				let _ = write!(self.out, ", for SuSE {}.{}", desc[0], desc[1]);
			},
			(4, b"GNU", 16) => {
				let os = match self.u32(desc, 0) {
					0 => "Linux",
					1 => "Hurd",
					2 => "Solaris",
					3 => "kFreeBSD",
					4 => "kNetBSD",
					_ => "<unknown>",
				};
				let _ = write!(
					self.out,
					", for GNU/{os} {}.{}.{}",
					self.u32(desc, 4) as i32,
					self.u32(desc, 8) as i32,
					self.u32(desc, 12) as i32
				);
			},
			(7, b"NetBSD", 4) => {
				let version = self.u32(desc, 0);
				self.out.push_str(", for NetBSD");
				// `MMmmrrpp00`: major, minor, release, patch level.
				if version > 100_000_000 {
					let patch = (version / 100) % 100;
					let mut release = (version / 10_000) % 100;
					let _ = write!(self.out, " {}.{}", version / 100_000_000, (version / 1_000_000) % 100);
					if release == 0 && patch != 0 {
						let _ = write!(self.out, ".{patch}");
					} else if release != 0 {
						while release > 26 {
							self.out.push('Z');
							release -= 26;
						}
						self.out.push((b'A' + release as u8 - 1) as char);
					}
				}
			},
			(8, b"FreeBSD", 4) => {
				let version = self.u32(desc, 0);
				self.out.push_str(", for FreeBSD");
				self.freebsd_version(version);
			},
			(8, b"OpenBSD", 4) => self.out.push_str(", for OpenBSD"),
			(10, b"DragonFly", 4) => {
				let version = self.u32(desc, 0);
				let _ = write!(
					self.out,
					", for DragonFly {}.{}.{}",
					version / 100_000,
					version / 10_000 % 10,
					version % 10_000
				);
			},
			_ => return false,
		}
		self.flags |= DID_OS_NOTE;
		true
	}

	/// `do_note_freebsd_version`: `__FreeBSD_version` as a release number.
	fn freebsd_version(&mut self, v: u32) {
		if v == 460_002 {
			self.out.push_str(" 4.6.2");
		} else if v < 460_100 {
			let _ = write!(self.out, " {}.{}", v / 100_000, v / 10_000 % 10);
			if v / 1000 % 10 > 0 {
				let _ = write!(self.out, ".{}", v / 1000 % 10);
			}
			if v % 1000 > 0 || v % 100_000 == 0 {
				let _ = write!(self.out, " ({v})");
			}
		} else if v < 500_000 {
			let _ = write!(self.out, " {}.{}", v / 100_000, v / 10_000 % 10 + v / 1000 % 10);
			if v / 100 % 10 > 0 {
				let _ = write!(self.out, " ({v})");
			} else if v / 10 % 10 > 0 {
				let _ = write!(self.out, ".{}", v / 10 % 10);
			}
		} else {
			let _ = write!(self.out, " {}.{}", v / 100_000, v / 1000 % 100);
			if v / 100 % 10 > 0 || v % 100_000 / 100 == 0 {
				let _ = write!(self.out, " ({v})");
			} else if v / 10 % 10 > 0 {
				let _ = write!(self.out, ".{}", v / 10 % 10);
			}
		}
	}

	/// `do_bid_note`: the GNU or Go build ID.
	fn build_id_note(&mut self, name: &[u8], namesz: usize, kind: u32, desc: &[u8]) -> bool {
		if namesz == 4 && name == b"GNU" && kind == 3 && (4..=20).contains(&desc.len()) {
			self.flags |= DID_BUILD_ID;
			let hash = match desc.len() {
				8 => "xxHash",
				16 => "md5/uuid",
				20 => "sha1",
				_ => "unknown",
			};
			let _ = write!(self.out, ", BuildID[{hash}]=");
			for byte in desc {
				let _ = write!(self.out, "{byte:02x}");
			}
			return true;
		}
		if namesz == 4 && name == b"Go" && kind == 4 && desc.len() < 128 {
			let text = &desc[..desc.iter().position(|&c| c == 0).unwrap_or(desc.len())];
			let _ = write!(self.out, ", Go BuildID={}", String::from_utf8_lossy(text));
			return true;
		}
		false
	}

	/// `doshn`: notes in sections, debug info, and whether a symbol table is
	/// left.
	fn section_headers(&mut self, mut off: u64, num: u16, size: usize, strtab: usize) {
		if self.mime {
			return;
		}
		let entry_size = if self.is64 { 64 } else { 40 };
		if num == 0 {
			self.out.push_str(", no section header");
			return;
		}
		if size != entry_size {
			self.out.push_str(", corrupted section header size");
			return;
		}
		let strtab_at = off + (size * strtab) as u64;
		let Some(mut sh) = self.pread_exact(strtab_at, entry_size) else {
			let _ = write!(self.out, ", missing section headers at {strtab_at}");
			return;
		};
		let name_off = self.word(&sh, 16, 24);
		if self.fsize.is_some_and(|fsize| fsize < name_off) {
			let _ = write!(self.out, ", too large section header offset {name_off}");
			return;
		}
		let (mut stripped, mut debug_info) = (true, false);
		for _ in 0..num {
			// The name read here belongs to the header read on the previous
			// pass, as in libmagic.
			let name_at = name_off + u64::from(self.u32(&sh, 0));
			let Some(name) = self.pread(name_at, 49) else {
				let _ = write!(self.out, ", can't read name of elf section at {name_at}");
				return;
			};
			if name.starts_with(b".debug_info\0") {
				debug_info = true;
				stripped = false;
			}
			let Some(next) = self.pread_exact(off, entry_size) else {
				let _ = write!(self.out, ", can't read elf section at {off}");
				return;
			};
			sh = next;
			off += size as u64;
			let kind = self.u32(&sh, 4);
			let sh_offset = self.word(&sh, 16, 24);
			let sh_size = self.word(&sh, 20, 32);
			if kind == SHT_SYMTAB {
				stripped = false;
			} else if self.fsize.is_some_and(|fsize| sh_offset > fsize) {
				continue;
			}
			if kind == SHT_NOTE {
				let fsize = self.fsize.unwrap_or(u64::MAX);
				if sh_size.saturating_add(sh_offset) > fsize {
					let _ = write!(
						self.out,
						", note offset/size {sh_offset:#x}+{sh_size:#x} exceeds file size {fsize:#x}"
					);
					return;
				}
				let Some(notes) = usize::try_from(sh_size).ok().and_then(|len| self.pread_exact(sh_offset, len)) else {
					let _ = write!(self.out, ", can't read elf note at {sh_offset}");
					return;
				};
				self.notes(&notes, 4);
			}
		}
		if debug_info {
			self.out.push_str(", with debug_info");
		}
		self.out.push_str(if stripped { ", stripped" } else { ", not stripped" });
	}
}
