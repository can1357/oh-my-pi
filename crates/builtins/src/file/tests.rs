//! Behaviour of the `file` builtin, checked against what file 5.41 prints:
//! Apple's build for the Darwin flavor, and for the other an upstream build
//! whose rule sort is stable, as it is on glibc.

use std::{cell::Cell, fs, path::Path};

use super::FileCli;
use crate::host::run_util;

thread_local! {
	/// Forces the flavor [`super::darwin`] reports, so both are tested on
	/// every platform.
	pub(super) static FLAVOR: Cell<Option<bool>> = const { Cell::new(None) };
}

/// Which `file` the builtin imitates.
#[derive(Clone, Copy)]
enum Flavor {
	/// Upstream file 5.41, as Linux distributions ship it.
	Upstream,
	/// Apple's file 5.41, as macOS ships it.
	Darwin,
}

/// Runs `file` with `args` in `dir`; returns the exit status and raw output.
fn run_bytes(flavor: Flavor, dir: &Path, stdin: &str, args: &[&str]) -> (i32, Vec<u8>, String) {
	FLAVOR.set(Some(matches!(flavor, Flavor::Darwin)));
	let (code, capture) = run_util::<FileCli>(args, stdin, dir);
	FLAVOR.set(None);
	(code, capture.stdout(), capture.err())
}

fn run(flavor: Flavor, dir: &Path, args: &[&str]) -> (i32, String, String) {
	let (code, stdout, stderr) = run_bytes(flavor, dir, "", args);
	(code, String::from_utf8_lossy(&stdout).into_owned(), stderr)
}

/// The description `file -b` gives `name`.
fn describe(flavor: Flavor, dir: &Path, name: &str) -> String {
	let (code, stdout, stderr) = run(flavor, dir, &["-b", name]);
	assert_eq!((code, stderr.as_str()), (0, ""), "file -b {name}");
	stdout.trim_end_matches('\n').to_owned()
}

fn write(dir: &Path, name: &str, bytes: impl AsRef<[u8]>) {
	fs::write(dir.join(name), bytes).unwrap();
}

/// A directory holding the text fixtures most tests use.
fn text_fixtures() -> tempfile::TempDir {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path();
	write(root, "ascii.txt", "hello world\n");
	write(root, "utf8.txt", "h\u{e9}llo w\u{f6}rld\n");
	write(root, "utf8bom.txt", b"\xef\xbb\xbfhello\n");
	write(root, "sh.sh", "#!/bin/sh\necho hi\n");
	write(root, "j.json", "{\"a\":1,\"b\":[1,2,3]}\n");
	write(root, "long.txt", format!("{}\n", "x".repeat(400)));
	write(root, "nul4", [0u8; 4]);
	dir
}

/// A PNG signature and header for a 640x480 RGBA image.
fn png() -> Vec<u8> {
	let mut bytes = b"\x89PNG\r\n\x1a\n\0\0\0\x0dIHDR".to_vec();
	bytes.extend_from_slice(&640u32.to_be_bytes());
	bytes.extend_from_slice(&480u32.to_be_bytes());
	bytes.extend_from_slice(&[8, 6, 0, 0, 0, 0, 0, 0, 0]);
	bytes.extend_from_slice(b"\0\0\0\0IEND\xae\x42\x60\x82");
	bytes
}

/// `gzip` of `hello\n` with no name and no timestamp.
const GZIP: &[u8] = &[
	0x1f, 0x8b, 0x08, 0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0xff, 0xcb, 0x48, 0xcd, 0xc9, 0xc9, 0xe7, 0x02, 0x00,
	0x20, 0x30, 0x3a, 0x36, 0x06, 0x00, 0x00, 0x00,
];

/// `gzip` of `hello\n` recorded as `a\x01b`, modified one second into 1970.
const GZIP_NAMED: &[u8] = &[
	0x1f, 0x8b, 0x08, 0x08, 0x01, 0x00, 0x00, 0x00, 0x00, 0xff, 0x61, 0x01, 0x62, 0x00, 0xcb, 0x48, 0xcd, 0xc9,
	0xc9, 0xe7, 0x02, 0x00, 0x20, 0x30, 0x3a, 0x36, 0x06, 0x00, 0x00, 0x00,
];

/// A zip archive whose one member `a.txt` is `hello\n`, stored.
const ZIP_STORED: &str = "504b03041400000000000000215020303a36060000000600000005000000612e74787468656c6c6f0a504b01021403140000000000\
                          0000215020303a360600000006000000050000000000000000000000800100000000612e747874504b0506000000000100010033\
                          000000290000000000";

fn unhex(text: &str) -> Vec<u8> {
	let digits: Vec<u8> = text.bytes().filter(u8::is_ascii_hexdigit).collect();
	digits
		.chunks_exact(2)
		.map(|pair| u8::from_str_radix(std::str::from_utf8(pair).unwrap(), 16).unwrap())
		.collect()
}

/// A tar header block for `a.txt`, with `magic` in the ustar field.
fn tar_header(magic: &[u8; 8]) -> Vec<u8> {
	let mut block = vec![0u8; 1024];
	block[..5].copy_from_slice(b"a.txt");
	block[100..107].copy_from_slice(b"0000644");
	block[124..135].copy_from_slice(b"00000000000");
	block[156] = b'0';
	block[257..265].copy_from_slice(magic);
	block[148..156].fill(b' ');
	let sum: u32 = block[..512].iter().map(|&byte| u32::from(byte)).sum();
	block[148..155].copy_from_slice(format!("{sum:06o}\0").as_bytes());
	block
}

/// A 64-bit x86-64 ELF image: an ABI note and a build ID in a note section,
/// and unless `linked_statically` an interpreter and a dynamic segment whose
/// `DF_1_PIE` flag is `pie`. `symbols` adds a symbol table.
fn elf(pie: bool, linked_statically: bool, symbols: bool) -> Vec<u8> {
	fn note(kind: u32, desc: &[u8]) -> Vec<u8> {
		let mut note = Vec::new();
		for word in [4, desc.len() as u32, kind] {
			note.extend_from_slice(&word.to_le_bytes());
		}
		note.extend_from_slice(b"GNU\0");
		note.extend_from_slice(desc);
		note
	}
	let interp = b"/lib64/ld-linux-x86-64.so.2\0".to_vec();
	let mut dynamic = Vec::new();
	for word in [1u64, 1, 0x6fff_fffb, if pie { 0x0800_0001 } else { 1 }, 0, 0] {
		dynamic.extend_from_slice(&word.to_le_bytes());
	}
	let abi: Vec<u8> = [0u32, 3, 2, 0].iter().flat_map(|word| word.to_le_bytes()).collect();
	let build_id: Vec<u8> = (0..20).collect();
	let notes = [note(1, &abi), note(3, &build_id)].concat();
	let third = if symbols { ".symtab" } else { ".text" };
	let shstrtab = format!("\0.shstrtab\0.note\0{third}\0.data\0").into_bytes();
	let name_at = |name: &str| shstrtab.windows(name.len()).position(|window| window == name.as_bytes()).unwrap();

	let segments: Vec<(u32, &Vec<u8>)> = if linked_statically { Vec::new() } else { vec![(3, &interp), (2, &dynamic)] };
	let mut body = Vec::new();
	let body_start = 64 + 56 * segments.len();
	let mut program_headers = Vec::new();
	for (kind, bytes) in &segments {
		let offset = (body_start + body.len()) as u64;
		program_headers.extend_from_slice(&kind.to_le_bytes());
		program_headers.extend_from_slice(&4u32.to_le_bytes());
		for word in [offset, offset, offset, bytes.len() as u64, bytes.len() as u64, 1] {
			program_headers.extend_from_slice(&word.to_le_bytes());
		}
		body.extend_from_slice(bytes);
	}
	let notes_at = (body_start + body.len()) as u64;
	body.extend_from_slice(&notes);
	let names_at = (body_start + body.len()) as u64;
	body.extend_from_slice(&shstrtab);
	let section_headers_at = (body_start + body.len()) as u64;

	let sections: [(usize, u32, u64, u64); 5] = [
		(0, 0, 0, 0),
		(name_at(".shstrtab"), 3, names_at, shstrtab.len() as u64),
		(name_at(".note"), 7, notes_at, notes.len() as u64),
		(name_at(third), if symbols { 2 } else { 1 }, 0, 0),
		(name_at(".data"), 1, 0, 0),
	];
	let mut image = b"\x7fELF\x02\x01\x01\0\0\0\0\0\0\0\0\0".to_vec();
	image.extend_from_slice(&(if pie { 3u16 } else { 2 }).to_le_bytes());
	image.extend_from_slice(&62u16.to_le_bytes());
	image.extend_from_slice(&1u32.to_le_bytes());
	image.extend_from_slice(&0x1000u64.to_le_bytes());
	image.extend_from_slice(&(if segments.is_empty() { 0u64 } else { 64 }).to_le_bytes());
	image.extend_from_slice(&section_headers_at.to_le_bytes());
	image.extend_from_slice(&0u32.to_le_bytes());
	for half in [64u16, 56, segments.len() as u16, 64, sections.len() as u16, 1] {
		image.extend_from_slice(&half.to_le_bytes());
	}
	image.extend_from_slice(&program_headers);
	image.extend_from_slice(&body);
	for (name, kind, offset, size) in sections {
		image.extend_from_slice(&(name as u32).to_le_bytes());
		image.extend_from_slice(&kind.to_le_bytes());
		for word in [0u64, 0, offset, size] {
			image.extend_from_slice(&word.to_le_bytes());
		}
		image.extend_from_slice(&[0; 8]);
		for word in [1u64, 0] {
			image.extend_from_slice(&word.to_le_bytes());
		}
	}
	image
}

/// A 64-bit Mach-O header.
fn macho_header(cpu: u32, subtype: u32, file_type: u32, flags: u32) -> Vec<u8> {
	[0xfeed_facf, cpu, subtype, file_type, 0, 0, flags, 0].iter().flat_map(|word: &u32| word.to_le_bytes()).collect()
}

const CPU_X86_64: u32 = 0x0100_0007;
const CPU_ARM64: u32 = 0x0100_000c;

/// A universal binary: an x86_64 dylib at 4096 and an arm64 executable at
/// 8192.
fn macho_universal() -> Vec<u8> {
	let mut image: Vec<u8> = [0xcafe_babe, 2, CPU_X86_64, 3, 4096, 32, 12, CPU_ARM64, 0, 8192, 32, 12]
		.iter()
		.flat_map(|word: &u32| word.to_be_bytes())
		.collect();
	image.resize(4096, 0);
	image.extend_from_slice(&macho_header(CPU_X86_64, 3, 6, 0x0010_0085));
	image.resize(8192, 0);
	image.extend_from_slice(&macho_header(CPU_ARM64, 0, 2, 0x0020_0085));
	image
}

#[test]
fn text_is_described_by_encoding_and_line_structure() {
	let dir = text_fixtures();
	let root = dir.path();
	write(root, "noeol.txt", "hello world");
	write(root, "crlf.txt", "a\r\nb\r\n");
	write(root, "cr.txt", "a\rb\r");
	write(root, "mixed.txt", "a\r\nb\nc\r");
	write(root, "latin1.txt", b"h\xe9llo\n");
	write(root, "utf16le.txt", b"\xff\xfeh\0i\0\n\0");
	write(root, "utf16be.txt", b"\xfe\xff\0h\0i\0\n");
	write(root, "esc.txt", "a\x1b[31mred\x1b[0m\n");
	write(root, "overstrike.txt", "a\x08_b\n");
	write(root, "textnul", b"abc\0def\n");
	for (name, expected) in [
		("ascii.txt", "ASCII text"),
		("noeol.txt", "ASCII text, with no line terminators"),
		("crlf.txt", "ASCII text, with CRLF line terminators"),
		("cr.txt", "ASCII text, with CR line terminators"),
		("mixed.txt", "ASCII text, with CRLF, CR, LF line terminators"),
		("utf8.txt", "Unicode text, UTF-8 text"),
		("utf8bom.txt", "Unicode text, UTF-8 (with BOM) text"),
		("latin1.txt", "ISO-8859 text"),
		("utf16le.txt", "Unicode text, UTF-16, little-endian text"),
		("utf16be.txt", "Unicode text, UTF-16, big-endian text"),
		("esc.txt", "ASCII text, with escape sequences"),
		("overstrike.txt", "ASCII text, with overstriking"),
		("long.txt", "ASCII text, with very long lines (400)"),
		("textnul", "data"),
		("nul4", "data"),
	] {
		assert_eq!(describe(Flavor::Upstream, root, name), expected, "{name}");
		assert_eq!(describe(Flavor::Darwin, root, name), expected, "{name}");
	}
}

/// Text that a magic rule recognises: upstream folds the rule's "text" into
/// the character-set clause, Apple's build prints the rule's words as written
/// and keeps an older set of C rules.
#[test]
fn scripts_and_source_are_worded_as_each_platform_words_them() {
	let dir = text_fixtures();
	let root = dir.path();
	write(root, "py.py", "#!/usr/bin/env python3\nprint(1)\n");
	write(root, "node.js", "#!/usr/bin/env node\nconsole.log(1)\n");
	write(root, "c.c", "#include <stdio.h>\nint main(void) { printf(\"hi\"); return 0; }\n");
	write(root, "x.xml", "<?xml version=\"1.0\" encoding=\"UTF-8\"?>\n<a><b/></a>\n");
	write(root, "h.html", "<!DOCTYPE html>\n<html><head><title>x</title></head><body></body></html>\n");
	write(root, "p.diff", "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n");
	for (name, upstream, darwin) in [
		("sh.sh", "POSIX shell script, ASCII text executable", "POSIX shell script text executable, ASCII text"),
		("py.py", "Python script, ASCII text executable", "Python script text executable, ASCII text"),
		(
			"node.js",
			"a /usr/bin/env node script, ASCII text executable",
			"a /usr/bin/env node script text executable, ASCII text",
		),
		("c.c", "C source, ASCII text", "c program text, ASCII text"),
		("x.xml", "XML 1.0 document, ASCII text", "XML 1.0 document text, ASCII text"),
		("h.html", "HTML document, ASCII text", "HTML document text, ASCII text"),
		("p.diff", "unified diff output, ASCII text", "unified diff output text, ASCII text"),
	] {
		assert_eq!(describe(Flavor::Upstream, root, name), upstream, "{name}");
		assert_eq!(describe(Flavor::Darwin, root, name), darwin, "{name}");
	}
}

#[test]
fn structured_text_is_recognised_before_plain_text() {
	let dir = text_fixtures();
	let root = dir.path();
	write(root, "c.csv", "a,b,c\n1,2,3\n4,5,6\n");
	write(root, "lines.jsonl", "{\"a\":1}\n{\"b\":2}\n");
	write(root, "num.json", "123\n");
	assert_eq!(describe(Flavor::Upstream, root, "j.json"), "JSON data");
	assert_eq!(describe(Flavor::Upstream, root, "lines.jsonl"), "JSON data");
	// A bare scalar is not JSON to file(1).
	assert_eq!(describe(Flavor::Upstream, root, "num.json"), "ASCII text");
	assert_eq!(describe(Flavor::Upstream, root, "c.csv"), "CSV text");
}

#[test]
fn binary_formats_are_described_from_their_headers() {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path();
	write(root, "i.png", png());
	write(root, "g.gif", b"GIF89a\x40\x01\xc8\x00\x80\x00\x00\0\0\0\0\0\0;");
	write(root, "p.pdf", b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n1 0 obj\n<<>>\nendobj\n");
	write(root, "w.wasm", b"\0asm\x01\0\0\0");
	write(root, "g.gz", GZIP);
	write(root, "s.zip", unhex(ZIP_STORED));
	write(root, "ustar.tar", tar_header(b"ustar\x0000"));
	write(root, "gnu.tar", tar_header(b"ustar  \0"));
	for (name, expected) in [
		("i.png", "PNG image data, 640 x 480, 8-bit/color RGBA, non-interlaced"),
		("g.gif", "GIF image data, version 89a, 320 x 200"),
		("p.pdf", "PDF document, version 1.4"),
		("w.wasm", "WebAssembly (wasm) binary module version 0x1 (MVP)"),
		("g.gz", "gzip compressed data, truncated"),
		("s.zip", "Zip archive data, at least v2.0 to extract, compression method=store"),
		("ustar.tar", "POSIX tar archive"),
		("gnu.tar", "POSIX tar archive (GNU)"),
	] {
		assert_eq!(describe(Flavor::Upstream, root, name), expected, "{name}");
		assert_eq!(describe(Flavor::Darwin, root, name), expected, "{name}");
	}
}

/// The ELF details come from walking the program and section headers, not
/// from magic rules: linkage, the interpreter, the ABI and build-ID notes,
/// and whether a symbol table is left.
#[test]
fn elf_images_report_linkage_interpreter_notes_and_stripping() {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path();
	write(root, "pie", elf(true, false, false));
	write(root, "exec", elf(false, false, false));
	write(root, "static", elf(false, true, true));
	const NOTES: &str = "for GNU/Linux 3.2.0, BuildID[sha1]=000102030405060708090a0b0c0d0e0f10111213";
	const LINKED: &str = "dynamically linked, interpreter /lib64/ld-linux-x86-64.so.2";
	for flavor in [Flavor::Upstream, Flavor::Darwin] {
		assert_eq!(
			describe(flavor, root, "pie"),
			format!("ELF 64-bit LSB pie executable, x86-64, version 1 (SYSV), {LINKED}, {NOTES}, stripped")
		);
		assert_eq!(
			describe(flavor, root, "exec"),
			format!("ELF 64-bit LSB executable, x86-64, version 1 (SYSV), {LINKED}, {NOTES}, stripped")
		);
		assert_eq!(
			describe(flavor, root, "static"),
			format!("ELF 64-bit LSB executable, x86-64, version 1 (SYSV), no program header, {NOTES}, not stripped")
		);
	}
	let (_, stdout, _) = run(Flavor::Upstream, root, &["-i", "pie", "exec"]);
	assert_eq!(
		stdout,
		"pie:  application/x-pie-executable; charset=binary\nexec: application/x-executable; charset=binary\n"
	);
}

/// Apple's build names the architecture last and lists a universal binary's
/// slices on lines of their own; upstream prints the header flags and escapes
/// the separator its nested match emits. That separator appears where a
/// weaker rule matched the slice first, which depends on the order of
/// equal-strength rules: source order upstream (glibc's stable sort), the
/// compiled database's order on macOS.
#[test]
fn macho_images_are_described_as_each_platform_describes_them() {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path();
	write(root, "thin", macho_header(CPU_ARM64, 0, 2, 0x0020_0085));
	write(root, "fat", macho_universal());
	assert_eq!(describe(Flavor::Darwin, root, "thin"), "Mach-O 64-bit executable arm64");
	assert_eq!(
		describe(Flavor::Upstream, root, "thin"),
		"Mach-O 64-bit arm64 executable, flags:<NOUNDEFS|DYLDLINK|TWOLEVEL|PIE>"
	);
	let (code, stdout, _) = run(Flavor::Darwin, root, &["fat"]);
	assert_eq!(code, 0);
	assert_eq!(
		stdout,
		"fat: Mach-O universal binary with 2 architectures: [x86_64:\n- Mach-O 64-bit dynamically linked shared \
		 library x86_64] [arm64:Mach-O 64-bit executable arm64]\nfat (for architecture x86_64):\tMach-O 64-bit \
		 dynamically linked shared library x86_64\nfat (for architecture arm64):\tMach-O 64-bit executable arm64\n"
	);
	assert_eq!(
		describe(Flavor::Upstream, root, "fat"),
		"Mach-O universal binary with 2 architectures: [x86_64:\\012- Mach-O 64-bit x86_64 dynamically linked \
		 shared library, flags:<NOUNDEFS|DYLDLINK|TWOLEVEL|NO_REEXPORTED_DYLIBS>] [arm64:Mach-O 64-bit arm64 \
		 executable, flags:<NOUNDEFS|DYLDLINK|TWOLEVEL|PIE>]"
	);
	let (_, stdout, _) = run(Flavor::Darwin, root, &["--mime-type", "fat"]);
	assert_eq!(
		stdout,
		"fat: application/x-mach-binary\nfat (for architecture x86_64):\tapplication/x-mach-binary\nfat (for \
		 architecture arm64):\tapplication/x-mach-binary\n"
	);
}

/// Directories, links, pipes and missing files are named from their inode
/// alone. A missing operand is reported on stdout with status 0, as file(1)
/// does; `-E` turns it into an error.
#[cfg(unix)]
#[test]
fn filesystem_objects_are_named_without_reading_them() {
	let dir = text_fixtures();
	let root = dir.path();
	fs::create_dir(root.join("dir")).unwrap();
	write(root, "empty", "");
	std::os::unix::fs::symlink("ascii.txt", root.join("link")).unwrap();
	std::os::unix::fs::symlink("nonexistent", root.join("broken")).unwrap();
	omp_vfs::BlockingFs::native().make_fifo(root.join("fifo"), 0o644).unwrap();

	let (code, stdout, stderr) = run(Flavor::Upstream, root, &["dir", "empty", "link", "broken", "fifo", "gone"]);
	assert_eq!((code, stderr.as_str()), (0, ""));
	assert_eq!(
		stdout,
		"dir:    directory\nempty:  empty\nlink:   symbolic link to ascii.txt\nbroken: broken symbolic link to \
		 nonexistent\nfifo:   fifo (named pipe)\ngone:   cannot open `gone' (No such file or directory)\n"
	);
	// `-L` follows links; a dangling one is still described as a link.
	let (_, stdout, _) = run(Flavor::Upstream, root, &["-L", "link"]);
	assert_eq!(stdout, "link: ASCII text\n");
	// Apple's build follows by default and `-h` turns that off.
	let (_, stdout, _) = run(Flavor::Darwin, root, &["link", "broken"]);
	assert_eq!(stdout, "link:   ASCII text\nbroken: broken symbolic link to nonexistent\n");
	let (_, stdout, _) = run(Flavor::Darwin, root, &["-h", "link"]);
	assert_eq!(stdout, "link: symbolic link to ascii.txt\n");

	let (code, stdout, _) = run(Flavor::Upstream, root, &["-E", "gone"]);
	assert_eq!(code, 1);
	assert_eq!(stdout, "gone: ERROR: cannot stat `gone' (No such file or directory)\n");
	// A dangling link has a MIME type but no encoding, and file(1) reports
	// the missing answer as an error.
	let (_, stdout, _) = run(Flavor::Upstream, root, &["--mime-type", "broken"]);
	assert_eq!(stdout, "broken: inode/symlink\n");
	let (code, stdout, _) = run(Flavor::Upstream, root, &["--mime-encoding", "broken"]);
	assert_eq!((code, stdout.as_str()), (1, "broken: ERROR: (null)\n"));
}

#[cfg(unix)]
#[test]
fn special_files_flag_reads_devices_as_ordinary_files() {
	let dir = tempfile::tempdir().unwrap();
	let (_, stdout, _) = run(Flavor::Upstream, dir.path(), &["/dev/null"]);
	assert!(stdout.starts_with("/dev/null: character special ("), "{stdout}");
	let (_, stdout, _) = run(Flavor::Upstream, dir.path(), &["-s", "/dev/null"]);
	assert_eq!(stdout, "/dev/null: empty\n");
}

#[test]
fn names_are_padded_to_a_column_unless_told_otherwise() {
	let dir = text_fixtures();
	let root = dir.path();
	let both = ["ascii.txt", "utf8bom.txt"];
	let (_, stdout, _) = run(Flavor::Upstream, root, &both);
	assert_eq!(stdout, "ascii.txt:   ASCII text\nutf8bom.txt: Unicode text, UTF-8 (with BOM) text\n");
	let (_, stdout, _) = run(Flavor::Upstream, root, &["-N", both[0], both[1]]);
	assert_eq!(stdout, "ascii.txt: ASCII text\nutf8bom.txt: Unicode text, UTF-8 (with BOM) text\n");
	let (_, stdout, _) = run(Flavor::Upstream, root, &["-b", both[0], both[1]]);
	assert_eq!(stdout, "ASCII text\nUnicode text, UTF-8 (with BOM) text\n");
	let (_, stdout, _) = run(Flavor::Upstream, root, &["-F", " =>", "ascii.txt"]);
	assert_eq!(stdout, "ascii.txt => ASCII text\n");
	// `-bb` is brief for one operand only.
	let (_, stdout, _) = run(Flavor::Upstream, root, &["-bb", "ascii.txt"]);
	assert_eq!(stdout, "ASCII text\n");
	let (_, stdout, _) = run(Flavor::Upstream, root, &["-bb", "ascii.txt", "utf8.txt"]);
	assert_eq!(stdout, "ascii.txt: ASCII text\nutf8.txt:  Unicode text, UTF-8 text\n");
}

/// `-0` ends the name with NUL so names holding the separator stay
/// parseable; given twice it replaces the separator and the newline too.
#[test]
fn print0_terminates_names_and_then_lines_with_nul() {
	let dir = text_fixtures();
	let (_, stdout, _) = run_bytes(Flavor::Upstream, dir.path(), "", &["-0", "ascii.txt"]);
	assert_eq!(stdout, b"ascii.txt\0: ASCII text\n");
	let (_, stdout, _) = run_bytes(Flavor::Upstream, dir.path(), "", &["-00", "ascii.txt"]);
	assert_eq!(stdout, b"ascii.txt\0ASCII text\0");
}

#[test]
fn mime_flags_print_type_and_charset() {
	let dir = text_fixtures();
	let root = dir.path();
	fs::create_dir(root.join("dir")).unwrap();
	write(root, "empty", "");
	write(root, "i.png", png());
	write(root, "latin1.txt", b"h\xe9llo\n");
	let (_, stdout, _) =
		run(Flavor::Upstream, root, &["-i", "ascii.txt", "utf8.txt", "j.json", "sh.sh", "i.png", "nul4", "dir", "empty"]);
	assert_eq!(
		stdout,
		"ascii.txt: text/plain; charset=us-ascii\nutf8.txt:  text/plain; charset=utf-8\nj.json:    \
		 application/json; charset=us-ascii\nsh.sh:     text/x-shellscript; charset=us-ascii\ni.png:     image/png; \
		 charset=binary\nnul4:      application/octet-stream; charset=binary\ndir:       inode/directory; \
		 charset=binary\nempty:     inode/x-empty; charset=binary\n"
	);
	// Apple's `file` spells the flag `-I`; both spellings mean MIME here.
	let (_, stdout, _) = run(Flavor::Darwin, root, &["-I", "ascii.txt"]);
	assert_eq!(stdout, "ascii.txt: text/plain; charset=us-ascii\n");
	let (_, stdout, _) = run(Flavor::Upstream, root, &["--mime-type", "ascii.txt", "i.png", "dir"]);
	assert_eq!(stdout, "ascii.txt: text/plain\ni.png:     image/png\ndir:       inode/directory\n");
	let (_, stdout, _) =
		run(Flavor::Upstream, root, &["--mime-encoding", "ascii.txt", "utf8.txt", "latin1.txt", "i.png", "dir"]);
	assert_eq!(
		stdout,
		"ascii.txt:  us-ascii\nutf8.txt:   utf-8\nlatin1.txt: iso-8859-1\ni.png:      binary\ndir:        binary\n"
	);
}

/// `--extension` and `--apple` print what the matching rule declares, or a
/// placeholder when it declares nothing.
#[test]
fn extension_and_apple_flags_print_a_rules_annotations() {
	let dir = text_fixtures();
	write(dir.path(), "i.png", png());
	write(dir.path(), "g.gif", b"GIF89a\x40\x01\xc8\x00\x80\x00\x00\0\0\0\0\0\0;");
	let (_, stdout, _) = run(Flavor::Upstream, dir.path(), &["--extension", "i.png", "ascii.txt"]);
	assert_eq!(stdout, "i.png:     png\nascii.txt: ???\n");
	let (_, stdout, _) = run(Flavor::Upstream, dir.path(), &["--apple", "g.gif", "i.png", "ascii.txt"]);
	assert_eq!(stdout, "g.gif:     8BIMGIFf\ni.png:     UNKNUNKN\nascii.txt: UNKNUNKN\n");
}

/// Names come from `-f` lists (each padded to its own widest name), from
/// operands, and `-` is standard input, shown as `/dev/stdin`.
#[test]
fn operands_come_from_name_files_and_standard_input() {
	let dir = text_fixtures();
	let root = dir.path();
	write(root, "names", "ascii.txt\nutf8.txt\n");
	let (code, stdout, _) = run(Flavor::Upstream, root, &["-f", "names", "nul4"]);
	assert_eq!(code, 0);
	assert_eq!(stdout, "ascii.txt: ASCII text\nutf8.txt:  Unicode text, UTF-8 text\nnul4: data\n");

	let (_, stdout, _) = run_bytes(Flavor::Upstream, root, "ascii.txt\nutf8.txt\n", &["-f", "-"]);
	assert_eq!(stdout, b"ascii.txt: ASCII text\nutf8.txt: Unicode text, UTF-8 text\n");

	let (_, stdout, _) = run_bytes(Flavor::Upstream, root, "#!/bin/sh\necho hi\n", &["-"]);
	assert_eq!(stdout, b"/dev/stdin: POSIX shell script, ASCII text executable\n");

	let (code, _, stderr) = run(Flavor::Upstream, root, &["-f", "absent"]);
	assert_eq!(code, 1);
	assert_eq!(stderr, "file: Cannot open `absent' (No such file or directory)\n");
}

/// `-k` reports every matching rule. Upstream escapes the newline of its
/// separator like any other control character; Apple's build never escapes.
#[test]
fn keep_going_lists_every_match() {
	let dir = text_fixtures();
	let (_, stdout, _) = run(Flavor::Upstream, dir.path(), &["-k", "sh.sh", "j.json"]);
	assert_eq!(
		stdout,
		"sh.sh:  POSIX shell script text executable\\012- a /bin/sh script text executable\\012- a /bin/sh script, \
		 ASCII text executable\nj.json: JSON data\\012- , ASCII text\n"
	);
	let (_, stdout, _) = run(Flavor::Darwin, dir.path(), &["-k", "sh.sh"]);
	assert_eq!(
		stdout,
		"sh.sh: POSIX shell script text executable\n- a /bin/sh script text executable\n- a /bin/sh script text \
		 executable, ASCII text\n"
	);
}

/// `-z` describes what the compressed data holds, then the container in
/// parentheses; `-Z` drops the container. A zip archive's first member is
/// read as GNU gzip reads one.
#[test]
fn uncompress_flags_look_inside_compressed_data() {
	let dir = tempfile::tempdir().unwrap();
	let root = dir.path();
	write(root, "g.gz", GZIP);
	write(root, "s.zip", unhex(ZIP_STORED));
	write(root, "plain", "hello\n");
	let (_, stdout, _) = run(Flavor::Upstream, root, &["-z", "g.gz", "plain"]);
	assert_eq!(stdout, "g.gz:  ASCII text (gzip compressed data)\nplain: ASCII text\n");
	let (_, stdout, _) = run(Flavor::Upstream, root, &["-Z", "g.gz"]);
	assert_eq!(stdout, "g.gz: ASCII text\n");
	let (_, stdout, _) = run(Flavor::Upstream, root, &["-zi", "g.gz"]);
	assert_eq!(
		stdout,
		"g.gz: text/plain; charset=us-ascii compressed-encoding=application/gzip; charset=binary\n"
	);
	let (_, stdout, _) = run(Flavor::Upstream, root, &["-z", "s.zip"]);
	assert_eq!(
		stdout,
		"s.zip: ASCII text (Zip archive data, at least v2.0 to extract, compression method=store)\n"
	);
}

/// Bytes taken from the file (here a gzip member's recorded name) are
/// escaped unless `-r` asks for them raw; Apple's build is always raw.
#[test]
fn raw_flag_leaves_unprintable_characters_alone() {
	let dir = tempfile::tempdir().unwrap();
	write(dir.path(), "n.gz", GZIP_NAMED);
	let escaped = "gzip compressed data, was \"a\\001b\", last modified: Thu Jan  1 00:00:01 1970, truncated";
	assert_eq!(describe(Flavor::Upstream, dir.path(), "n.gz"), escaped);
	let raw = escaped.replace("\\001", "\u{1}");
	let (_, stdout, _) = run(Flavor::Upstream, dir.path(), &["-rb", "n.gz"]);
	assert_eq!(stdout.trim_end_matches('\n'), raw);
	assert_eq!(describe(Flavor::Darwin, dir.path(), "n.gz"), raw);
}

#[test]
fn excluded_tests_are_skipped() {
	let dir = text_fixtures();
	let root = dir.path();
	// Without the magic rules a script is just text; without the text test
	// nothing identifies it, since its rules are text rules.
	let (_, stdout, _) = run(Flavor::Upstream, root, &["-e", "soft", "sh.sh"]);
	assert_eq!(stdout, "sh.sh: ASCII text\n");
	let (_, stdout, _) = run(Flavor::Upstream, root, &["-e", "ascii", "sh.sh"]);
	assert_eq!(stdout, "sh.sh: data\n");
	let (_, stdout, _) = run(Flavor::Upstream, root, &["-e", "json", "j.json"]);
	assert_eq!(stdout, "j.json: ASCII text\n");
	let (_, stdout, _) = run(Flavor::Upstream, root, &["--exclude-quiet", "nonsense", "ascii.txt"]);
	assert_eq!(stdout, "ascii.txt: ASCII text\n");

	let (code, stdout, stderr) = run(Flavor::Upstream, root, &["-e", "nonsense", "ascii.txt"]);
	assert_eq!((code, stdout.as_str()), (1, ""));
	assert!(stderr.starts_with("Usage: file [-bcCdEhikLlNnprsSvzZ0]"), "{stderr}");
}

#[test]
fn parameters_bound_how_much_is_examined() {
	let dir = text_fixtures();
	let root = dir.path();
	// Four bytes of a long line hold no terminator and are not a long line.
	let (_, stdout, _) = run(Flavor::Upstream, root, &["-P", "bytes=4", "long.txt"]);
	assert_eq!(stdout, "long.txt: ASCII text, with no line terminators\n");
	let (code, _, stderr) = run(Flavor::Upstream, root, &["-P", "nonsense=1", "ascii.txt"]);
	assert_eq!((code, stderr.as_str()), (1, "file: Unknown param nonsense=1\n"));
}

#[test]
fn magic_file_flag_replaces_the_bundled_rules() {
	let dir = text_fixtures();
	let root = dir.path();
	write(root, "magic", "# greeting files\n0\tstring\tHELLO\tGreeting file,\n!:mime\ttext/x-hello\n>5\tbyte\tx\tversion %d\n");
	write(root, "hello.bin", b"HELLO\x07\x00\x01");
	write(root, "i.png", png());
	let (code, stdout, stderr) = run(Flavor::Upstream, root, &["-m", "magic", "hello.bin", "i.png", "ascii.txt"]);
	assert_eq!((code, stderr.as_str()), (0, ""));
	assert_eq!(stdout, "hello.bin: Greeting file, version 7\ni.png:     data\nascii.txt: ASCII text\n");
	let (_, stdout, _) = run(Flavor::Upstream, root, &["-m", "magic", "--mime-type", "hello.bin"]);
	assert_eq!(stdout, "hello.bin: text/x-hello\n");
}

/// `-p` puts the access time back after reading the file.
#[test]
fn preserve_date_restores_the_access_time() {
	let dir = text_fixtures();
	let path = dir.path().join("ascii.txt");
	let then = std::time::SystemTime::UNIX_EPOCH + std::time::Duration::from_secs(1_000_000_000);
	let times = fs::FileTimes::new().set_accessed(then).set_modified(then);
	fs::File::options().write(true).open(&path).unwrap().set_times(times).unwrap();
	let (code, stdout, _) = run(Flavor::Upstream, dir.path(), &["-p", "ascii.txt"]);
	assert_eq!((code, stdout.as_str()), (0, "ascii.txt: ASCII text\n"));
	assert_eq!(fs::metadata(&path).unwrap().accessed().unwrap(), then);
}

#[test]
fn usage_help_and_version() {
	let dir = text_fixtures();
	let (code, stdout, stderr) = run(Flavor::Upstream, dir.path(), &[]);
	assert_eq!((code, stdout.as_str()), (1, ""));
	assert!(stderr.starts_with("Usage: file [-bcCdEhikLlNnprsSvzZ0]"), "{stderr}");

	let (code, stdout, stderr) = run(Flavor::Upstream, dir.path(), &["--help"]);
	assert_eq!((code, stderr.as_str()), (0, ""));
	assert!(stdout.starts_with("Usage: file [OPTION...] [FILE...]\nDetermine type of FILEs.\n"), "{stdout}");
	assert!(stdout.contains("  -z, --uncompress           try to look inside compressed files\n"));

	let (code, stdout, _) = run(Flavor::Upstream, dir.path(), &["-v"]);
	assert_eq!(code, 0);
	assert!(stdout.starts_with("file-5.41\n"), "{stdout}");

	// The flags that only tune file(1)'s own process are accepted.
	let (code, stdout, _) = run(Flavor::Upstream, dir.path(), &["-n", "-S", "-d", "ascii.txt"]);
	assert_eq!((code, stdout.as_str()), (0, "ascii.txt: ASCII text\n"));
}
