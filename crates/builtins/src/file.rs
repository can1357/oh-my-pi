//! `file` builtin: determine file types.
//!
//! A port of file 5.41 (libmagic and its command line), run in process so it
//! sees the shell's files, internal URIs included. The tests run in
//! libmagic's order: filesystem type (`fsmagic.c`), compressed contents
//! under `-z`, tar/JSON/CSV recognisers, ELF details, the magic rules, and
//! finally text classification. The rules are file 5.41's own magic database
//! ([`magic`]).
//!
//! macOS ships a patched 5.41, and there the builtin answers as it does (see
//! [`darwin`]): links are followed and nothing is escaped by default, the
//! Mach-O, Java-class and C rules are Apple's, universal binaries get a line
//! per architecture, and equal-strength rules run in the order of the
//! database macOS compiles. Elsewhere it answers as upstream's build on glibc
//! does. `-i` means `--mime` on every platform, as does Apple's `-I`.
//!
//! Left out: `-C`/`-c`/`-l` (compiling, checking and listing magic files),
//! compiled `.mgc` databases, the OLE2 summary-stream and ELF core-note
//! decoders (the magic rules still name those files), and `-z` for the
//! formats without a codec here (see [`compress`]).

mod compress;
mod elf;
mod magic;
#[cfg(test)]
mod tests;
mod text;

use std::{
	borrow::Cow,
	cell::OnceCell,
	ffi::{OsStr, OsString},
	io::{self, Read, Seek, SeekFrom, Write},
	path::Path,
};

use clap::{Arg, ArgAction, ArgMatches, Command, builder::ValueParser};
use jiff::tz::TimeZone;
use omp_vfs::{FileKind, FileTime, Metadata};

use self::{
	elf::{ElfLimits, ReadAt},
	magic::{BINTEST, Buf, Db, Limits, Matcher, NoTail, Report, TEXTTEST, TailSource},
};
use crate::{
	host::{Host, Utility, matches_parser, os_bytes_lossy, strip_errno},
	time_zone::shell_time_zone,
};

const OPT_HELP: &str = "help";
const OPT_VERSION: &str = "version";
const OPT_MAGIC_FILE: &str = "magic-file";
const OPT_UNCOMPRESS: &str = "uncompress";
const OPT_UNCOMPRESS_NOREPORT: &str = "uncompress-noreport";
const OPT_BRIEF: &str = "brief";
const OPT_CHECKING: &str = "checking-printout";
const OPT_EXCLUDE: &str = "exclude";
const OPT_EXCLUDE_QUIET: &str = "exclude-quiet";
const OPT_FILES_FROM: &str = "files-from";
const OPT_SEPARATOR: &str = "separator";
const OPT_MIME: &str = "mime";
const OPT_APPLE: &str = "apple";
const OPT_EXTENSION: &str = "extension";
const OPT_MIME_TYPE: &str = "mime-type";
const OPT_MIME_ENCODING: &str = "mime-encoding";
const OPT_KEEP_GOING: &str = "keep-going";
const OPT_LIST: &str = "list";
const OPT_DEREFERENCE: &str = "dereference";
const OPT_NO_DEREFERENCE: &str = "no-dereference";
const OPT_NO_BUFFER: &str = "no-buffer";
const OPT_NO_PAD: &str = "no-pad";
const OPT_PRINT0: &str = "print0";
const OPT_PRESERVE_DATE: &str = "preserve-date";
const OPT_PARAMETER: &str = "parameter";
const OPT_RAW: &str = "raw";
const OPT_SPECIAL_FILES: &str = "special-files";
const OPT_NO_SANDBOX: &str = "no-sandbox";
const OPT_COMPILE: &str = "compile";
const OPT_DEBUG: &str = "debug";
const OPT_ERROR: &str = "error";
const ARG_FILES: &str = "files";

/// Whether to behave as Apple's `file` rather than upstream's: macOS ships a
/// patched 5.41 whose defaults (links followed, nothing escaped), wording and
/// Mach-O handling differ, and the builtin answers as the system tool would.
fn darwin() -> bool {
	#[cfg(test)]
	if let Some(forced) = tests::FLAVOR.get() {
		return forced;
	}
	cfg!(target_os = "macos")
}

const USAGE: &str = "\
Usage: file [-bcCdEhikLlNnprsSvzZ0] [--apple] [--extension] [--mime-encoding]
            [--mime-type] [-e <testname>] [-F <separator>]  [-f <namefile>]
            [-m <magicfiles>] [-P <parameter=value>] [--exclude-quiet]
            <file> ...
       file -C [-m <magicfiles>]
       file [--help]
";

/// Parsed `file` invocation.
pub(crate) struct FileCli {
	matches: ArgMatches,
}

matches_parser!(FileCli, command);

fn flag(name: &'static str, short: Option<char>) -> Arg {
	let arg = Arg::new(name).long(name).action(ArgAction::SetTrue);
	match short {
		Some(short) => arg.short(short),
		None => arg,
	}
}

fn command() -> Command {
	Command::new(FileCli::NAME)
		.disable_help_flag(true)
		.disable_version_flag(true)
		.infer_long_args(true)
		.arg(flag(OPT_HELP, None))
		.arg(flag(OPT_VERSION, Some('v')))
		.arg(Arg::new(OPT_MAGIC_FILE).short('m').long(OPT_MAGIC_FILE).value_parser(ValueParser::os_string()))
		.arg(flag(OPT_UNCOMPRESS, Some('z')))
		.arg(flag(OPT_UNCOMPRESS_NOREPORT, Some('Z')))
		.arg(Arg::new(OPT_BRIEF).short('b').long(OPT_BRIEF).action(ArgAction::Count))
		.arg(flag(OPT_CHECKING, Some('c')))
		.arg(Arg::new(OPT_EXCLUDE).short('e').long(OPT_EXCLUDE).action(ArgAction::Append))
		.arg(Arg::new(OPT_EXCLUDE_QUIET).long(OPT_EXCLUDE_QUIET).action(ArgAction::Append))
		.arg(
			Arg::new(OPT_FILES_FROM)
				.short('f')
				.long(OPT_FILES_FROM)
				.action(ArgAction::Append)
				.value_parser(ValueParser::os_string()),
		)
		.arg(Arg::new(OPT_SEPARATOR).short('F').long(OPT_SEPARATOR).value_parser(ValueParser::os_string()))
		// Apple's `file` spells it `-I`.
		.arg(flag(OPT_MIME, Some('i')).short_alias('I'))
		.arg(flag(OPT_APPLE, None))
		.arg(flag(OPT_EXTENSION, None))
		.arg(flag(OPT_MIME_TYPE, None))
		.arg(flag(OPT_MIME_ENCODING, None))
		.arg(flag(OPT_KEEP_GOING, Some('k')))
		.arg(flag(OPT_LIST, Some('l')))
		.arg(flag(OPT_DEREFERENCE, Some('L')).overrides_with(OPT_NO_DEREFERENCE))
		.arg(flag(OPT_NO_DEREFERENCE, Some('h')).overrides_with(OPT_DEREFERENCE))
		.arg(flag(OPT_NO_BUFFER, Some('n')))
		.arg(flag(OPT_NO_PAD, Some('N')))
		.arg(Arg::new(OPT_PRINT0).short('0').long(OPT_PRINT0).action(ArgAction::Count))
		.arg(flag(OPT_PRESERVE_DATE, Some('p')))
		.arg(Arg::new(OPT_PARAMETER).short('P').long(OPT_PARAMETER).action(ArgAction::Append))
		.arg(flag(OPT_RAW, Some('r')))
		.arg(flag(OPT_SPECIAL_FILES, Some('s')))
		.arg(flag(OPT_NO_SANDBOX, Some('S')))
		.arg(flag(OPT_COMPILE, Some('C')))
		.arg(flag(OPT_DEBUG, Some('d')))
		.arg(Arg::new(OPT_ERROR).short('E').action(ArgAction::SetTrue))
		.arg(
			Arg::new(ARG_FILES)
				.value_name("FILE")
				.num_args(0..)
				.value_parser(ValueParser::os_string()),
		)
}

/// `--help`, as file 5.41 prints it. `name_max` is `FILE_NAME_MAX`.
fn help(name_max: u16) -> String {
	format!(
		"\
Usage: file [OPTION...] [FILE...]
Determine type of FILEs.

      --help                 display this help and exit
  -v, --version              output version information and exit
  -m, --magic-file LIST      use LIST as a colon-separated list of magic
                               number files
  -z, --uncompress           try to look inside compressed files
  -Z, --uncompress-noreport  only print the contents of compressed files
  -b, --brief                do not prepend filenames to output lines
  -c, --checking-printout    print the parsed form of the magic file, use in
                               conjunction with -m to debug a new magic file
                               before installing it
  -e, --exclude TEST         exclude TEST from the list of test to be
                               performed for file. Valid tests are:
                               apptype, ascii, cdf, compress, csv, elf,
                               encoding, soft, tar, json, text,
                               tokens
      --exclude-quiet TEST         like exclude, but ignore unknown tests
  -f, --files-from FILE      read the filenames to be examined from FILE
  -F, --separator STRING     use string as separator instead of `:'
  -i, --mime                 output MIME type strings (--mime-type and
                               --mime-encoding)
      --apple                output the Apple CREATOR/TYPE
      --extension            output a slash-separated list of extensions
      --mime-type            output the MIME type
      --mime-encoding        output the MIME encoding
  -k, --keep-going           don't stop at the first match
  -l, --list                 list magic strength
  -L, --dereference          follow symlinks
  -h, --no-dereference       don't follow symlinks (default)
  -n, --no-buffer            do not buffer output
  -N, --no-pad               do not pad output
  -0, --print0               terminate filenames with ASCII NUL
  -p, --preserve-date        preserve access times on files
  -P, --parameter            set file engine parameter limits
                                   bytes 1048576 max bytes to look inside file
                               elf_notes     256 max ELF notes processed
                               elf_phnum    2048 max ELF prog sections processed
                               elf_shnum   32768 max ELF sections processed
                                encoding   65536 max bytes to scan for encoding
                                   indir      50 recursion limit for indirection
                                    name {name_max:7} use limit for name/use magic
                                   regex    8192 length limit for REGEX searches
  -r, --raw                  don't translate unprintable chars to \\ooo
  -s, --special-files        treat special (block/char devices) files as
                             ordinary ones
  -S, --no-sandbox           disable system call sandboxing
  -C, --compile              compile file specified by -m
  -d, --debug                print debugging messages

Report bugs to https://bugs.astron.com/
"
	)
}

/// Everything the command line selects (`ms->flags` and the `-P` limits).
#[derive(Clone)]
struct Opts {
	mime_type:      bool,
	mime_encoding:  bool,
	extension:      bool,
	apple:          bool,
	keep_going:     bool,
	raw:            bool,
	error:          bool,
	devices:        bool,
	symlink:        bool,
	compress:       bool,
	transparent:    bool,
	preserve_atime: bool,
	no_ascii:       bool,
	no_compress:    bool,
	no_csv:         bool,
	no_elf:         bool,
	no_encoding:    bool,
	no_soft:        bool,
	no_tar:         bool,
	no_json:        bool,
	bytes_max:      usize,
	encoding_max:   usize,
	elf:            ElfLimits,
	indir_max:      u16,
	name_max:       u16,
	regex_max:      usize,
	/// See [`darwin`].
	darwin:         bool,
}

impl Opts {
	const fn mime(&self) -> bool {
		self.mime_type || self.mime_encoding
	}

	/// The creator and extension modes print nothing but annotations.
	const fn silent(&self) -> bool {
		self.apple || self.extension
	}

	const fn report(&self) -> Report {
		if self.apple {
			Report::Apple
		} else if self.extension {
			Report::Extension
		} else if self.mime_type {
			Report::Mime
		} else if self.mime_encoding {
			Report::Silent
		} else {
			Report::Description
		}
	}

	/// `-e TEST`: `false` for an unknown test name.
	fn exclude(&mut self, test: &str) -> bool {
		match test {
			"ascii" | "text" => self.no_ascii = true,
			"compress" => self.no_compress = true,
			"csv" => self.no_csv = true,
			"elf" => self.no_elf = true,
			"encoding" => self.no_encoding = true,
			"soft" => self.no_soft = true,
			"tar" => self.no_tar = true,
			"json" => self.no_json = true,
			// No OS/2 application types or OLE2 summaries are read, and
			// `tokens` is obsolete upstream.
			"apptype" | "cdf" | "tokens" => {},
			_ => return false,
		}
		true
	}

	/// `-P name=value`: `false` for an unknown parameter. libmagic compares
	/// only as many characters as were typed, so a prefix selects the first
	/// parameter it starts.
	fn set_param(&mut self, param: &str) -> bool {
		let Some((name, value)) = param.split_once('=') else { return false };
		// `atoi`: leading digits, 0 without any.
		let digits = value.trim_start();
		let end = digits.bytes().position(|c| !c.is_ascii_digit()).unwrap_or(digits.len());
		let value: usize = digits[..end].parse().unwrap_or(0);
		let small = u16::try_from(value).unwrap_or(u16::MAX);
		const NAMES: [&str; 8] =
			["bytes", "elf_notes", "elf_phnum", "elf_shnum", "encoding", "indir", "name", "regex"];
		match NAMES.iter().position(|known| known.starts_with(name)) {
			Some(0) => self.bytes_max = value,
			Some(1) => self.elf.notes = small,
			Some(2) => self.elf.phnum = small,
			Some(3) => self.elf.shnum = small,
			Some(4) => self.encoding_max = value,
			Some(5) => self.indir_max = small,
			Some(6) => self.name_max = small,
			Some(7) => self.regex_max = value,
			_ => return false,
		}
		true
	}
}

/// Positional reads of an open file.
struct FileSource<'f>(&'f omp_vfs::File);

impl ReadAt for FileSource<'_> {
	fn read_at(&mut self, offset: u64, buf: &mut [u8]) -> io::Result<usize> {
		let mut file = self.0;
		file.seek(SeekFrom::Start(offset))?;
		let mut filled = 0;
		while filled < buf.len() {
			match file.read(&mut buf[filled..]) {
				Ok(0) => break,
				Ok(read) => filled += read,
				Err(err) if err.kind() == io::ErrorKind::Interrupted => {},
				Err(err) => return Err(err),
			}
		}
		Ok(filled)
	}
}

/// Positional reads of data held in memory (standard input).
struct MemorySource<'d>(&'d [u8]);

impl ReadAt for MemorySource<'_> {
	fn read_at(&mut self, offset: u64, buf: &mut [u8]) -> io::Result<usize> {
		let start = usize::try_from(offset).unwrap_or(usize::MAX).min(self.0.len());
		let len = buf.len().min(self.0.len() - start);
		buf[..len].copy_from_slice(&self.0[start..start + len]);
		Ok(len)
	}
}

/// The end of a regular file, read the first time a rule asks for it.
struct FileTail<'f> {
	file:     &'f omp_vfs::File,
	size:     u64,
	/// The head buffer, which is the tail too when it holds the whole file.
	head:     &'f [u8],
	bytes:    OnceCell<Option<Vec<u8>>>,
}

impl TailSource for FileTail<'_> {
	fn tail(&self) -> Option<&[u8]> {
		if self.size <= self.head.len() as u64 {
			return Some(self.head);
		}
		self
			.bytes
			.get_or_init(|| {
				let mut bytes = vec![0; self.head.len()];
				let read = FileSource(self.file).read_at(self.size - bytes.len() as u64, &mut bytes).ok()?;
				bytes.truncate(read);
				Some(bytes)
			})
			.as_deref()
	}
}

/// One file's identification in progress (`struct magic_set`).
struct Scan<'s> {
	opts:   Opts,
	db:     &'s Db<'s>,
	zone:   TimeZone,
	/// The description so far.
	out:    Vec<u8>,
	/// Set by a `file_error`: `out` then holds the message, printed after
	/// `ERROR: `.
	failed: bool,
}

/// The bytes of `text` up to its trailing NULs, keeping at least one byte.
fn trim_nuls(text: &[u8]) -> &[u8] {
	let mut len = text.len();
	while len > 1 && text[len - 1] == 0 {
		len -= 1;
	}
	&text[..len]
}

impl Scan<'_> {
	fn print(&mut self, text: impl AsRef<[u8]>) {
		self.out.extend_from_slice(text.as_ref());
	}

	/// `file_error`: the message joins whatever was printed and the file is
	/// reported as an error.
	fn fail(&mut self, message: impl AsRef<[u8]>) {
		if !self.out.is_empty() {
			self.out.push(b' ');
		}
		self.print(message);
		self.failed = true;
	}

	/// `handle_mime`: an `inode/…` type for something that is not a regular
	/// file.
	fn inode_mime(&mut self, kind: &str) {
		if self.opts.mime_type {
			self.print("inode/");
			self.print(kind);
			if self.opts.mime_encoding {
				self.print("; charset=");
			}
		}
		if self.opts.mime_encoding {
			self.print("binary");
		}
	}

	/// `checkdone`: under `-k` the tests go on after a match, separated.
	fn check_done(&mut self) -> bool {
		if !self.opts.keep_going {
			return true;
		}
		self.print("\n- ");
		false
	}

	/// `file_fsmagic`: identifies `name` by what it is on the filesystem.
	/// Returns the metadata when the contents are to be examined.
	fn fsmagic(&mut self, host: &Host, name: &OsStr, display: &[u8]) -> Option<Metadata> {
		let fs = host.fs();
		let stat = if self.opts.symlink {
			let followed = fs.metadata(host.resolve(name));
			// Apple: a dangling link under `-L` is described as with `-h`.
			if self.opts.darwin && followed.is_err() {
				fs.symlink_metadata(host.paths().resolve_link(name))
			} else {
				followed
			}
		} else {
			fs.symlink_metadata(host.paths().resolve_link(name))
		};
		let meta = match stat {
			Ok(meta) => meta,
			Err(err) => {
				let reason = strip_errno(&err);
				if self.opts.error {
					self.fail(format!("cannot stat `{}' ({reason})", String::from_utf8_lossy(display)));
				} else {
					self.print(b"cannot open `");
					self.print(display);
					self.print(format!("' ({reason})"));
				}
				return None;
			},
		};
		let mime = self.opts.mime();
		let silent = self.opts.silent();
		let mode = meta.mode();
		let mut did = false;
		if !mime && !silent {
			for (bit, label) in [(0o4000, "setuid"), (0o2000, "setgid"), (0o1000, "sticky")] {
				if mode & bit != 0 {
					if did {
						self.print(", ");
					}
					did = true;
					self.print(label);
				}
			}
		}
		// Whether the contents still need examining.
		let mut examine = false;
		let comma = if did { ", " } else { "" };
		match meta.file_type().kind() {
			FileKind::Dir => {
				if mime {
					self.inode_mime("directory");
				} else if !silent {
					self.print(comma);
					self.print("directory");
				}
			},
			kind @ (FileKind::CharDevice | FileKind::BlockDevice) => {
				let (label, inode) =
					if kind == FileKind::CharDevice { ("character", "chardevice") } else { ("block", "blockdevice") };
				if self.opts.devices {
					examine = true;
				} else if mime {
					self.inode_mime(inode);
				} else if !silent {
					self.print(comma);
					self.print(label);
					self.print(" special");
					#[cfg(unix)]
					if let Some(rdev) = meta.rdev() {
						use uucore::fs::{major, minor};
						self.print(format!(" ({}/{})", major(rdev as _), minor(rdev as _)));
					}
				}
			},
			FileKind::Fifo => {
				if !self.opts.devices {
					if mime {
						self.inode_mime("fifo");
					} else if !silent {
						self.print(comma);
						self.print("fifo (named pipe)");
					}
				}
			},
			FileKind::Symlink => {
				let target = match fs.read_link(host.paths().resolve_link(name)) {
					Ok(target) => target,
					Err(err) => {
						let reason = strip_errno(&err);
						if self.opts.error {
							self.fail(format!("unreadable symlink `{}' ({reason})", String::from_utf8_lossy(display)));
						} else if mime {
							self.inode_mime("symlink");
						} else if !silent {
							self.print(comma);
							self.print(b"unreadable symlink `");
							self.print(display);
							self.print(format!("' ({reason})"));
						}
						return None;
					},
				};
				let target = os_bytes_lossy(target.as_os_str());
				if let Err(err) = fs.metadata(host.resolve(name)) {
					// `bad_link`.
					if self.opts.mime_type {
						self.print("inode/symlink");
					} else if !mime {
						if self.opts.error {
							self.fail(format!(
								"broken symbolic link to {} ({})",
								String::from_utf8_lossy(&target),
								strip_errno(&err)
							));
						} else {
							self.print("broken symbolic link to ");
							self.print(&target);
						}
					}
					return None;
				}
				if mime {
					self.inode_mime("symlink");
				} else if !silent {
					self.print(comma);
					self.print("symbolic link to ");
					self.print(&target);
				}
			},
			FileKind::Socket => {
				if mime {
					self.inode_mime("socket");
				} else if !silent {
					self.print(comma);
					self.print("socket");
				}
			},
			FileKind::File => {
				// With `-s` the size is not trusted: raw devices report zero.
				if !self.opts.devices && meta.len() == 0 {
					if mime {
						self.inode_mime("x-empty");
					} else if !silent {
						self.print(comma);
						self.print("empty");
					}
				} else {
					examine = true;
				}
			},
			FileKind::Unknown => {
				self.fail(format!("invalid mode 0{mode:o}"));
				return None;
			},
		}
		if !silent && !mime && did && examine {
			self.print(" ");
		}
		// The silent modes leave everything to the content tests.
		(examine || silent).then_some(meta)
	}

	/// `unreadable_info`: a file that can be seen but not opened.
	fn unreadable(&mut self, host: &Host, path: &Path, meta: &Metadata, err: &io::Error) {
		if self.opts.darwin {
			self.print(format!("cannot open: {}", strip_errno(err)));
			return;
		}
		if host.fs().access(path, false, true, false).is_ok() {
			self.print("writable, ");
		}
		if host.fs().access(path, false, false, true).is_ok() {
			self.print("executable, ");
		}
		if meta.is_file() {
			self.print("regular file, ");
		}
		self.print("no read permission");
	}

	/// `file_or_fd` for a named file.
	fn named(&mut self, host: &Host, name: &OsStr, display: &[u8]) {
		let Some(meta) = self.fsmagic(host, name, display) else { return };
		if meta.is_dir() {
			// Only the silent modes get here: reading a directory fails.
			self.fail(format!("cannot read `{}' (Is a directory)", String::from_utf8_lossy(display)));
			return;
		}
		let path = host.resolve(name);
		// A pipe is not waited on for data.
		let opened = if meta.file_type().kind() == FileKind::Fifo {
			Err(io::Error::from(io::ErrorKind::WouldBlock))
		} else {
			host.fs().open(&path)
		};
		let file = match opened {
			Ok(file) => file,
			Err(err) => {
				self.unreadable(host, &path, &meta, &err);
				return;
			},
		};
		let mut head = Vec::new();
		// What was opened, which is the link's target when a silent mode
		// followed one.
		let meta = file.metadata().unwrap_or(meta);
		if let Err(err) = (&file).take(self.opts.bytes_max as u64).read_to_end(&mut head) {
			self.fail(format!("cannot read `{}' ({})", String::from_utf8_lossy(display), strip_errno(&err)));
			return;
		}
		let regular = meta.is_file();
		let size = meta.len();
		let tail = FileTail { file: &file, size, head: &head, bytes: OnceCell::new() };
		let tail: &dyn TailSource = if regular { &tail } else { &NoTail };
		let fsize = (regular || size != 0).then_some(size);
		self.buffer(Some(display), &head, Some(&mut FileSource(&file)), tail, fsize, meta.mode());
		if self.opts.preserve_atime
			&& let (Ok(accessed), Ok(modified)) = (meta.accessed(), meta.modified())
		{
			// Best effort, as in file(1).
			let _ = host.fs().set_times(&path, FileTime::At(accessed), FileTime::At(modified), true);
		}
	}

	/// `file_or_fd` for standard input.
	fn stdin(&mut self, host: &mut Host) {
		let mut head = Vec::new();
		if let Err(err) = (&mut host.stdin).take(self.opts.bytes_max as u64).read_to_end(&mut head) {
			self.fail(format!("cannot read `/dev/stdin' ({})", strip_errno(&err)));
			return;
		}
		// ELF analysis seeks, so libmagic spools an ELF pipe to a file.
		if head.starts_with(b"\x7fELF") && !self.opts.no_elf {
			let mut all = head.clone();
			if host.stdin.read_to_end(&mut all).is_ok() {
				let fsize = Some(all.len() as u64);
				self.buffer(None, &head, Some(&mut MemorySource(&all)), &NoTail, fsize, 0);
				return;
			}
		}
		self.buffer(None, &head, None, &NoTail, None, 0);
	}

	fn limits(&self) -> Limits {
		Limits {
			indir_max:  self.opts.indir_max,
			name_max:   self.opts.name_max,
			regex_max:  self.opts.regex_max,
			keep_going: self.opts.keep_going,
			raw:        self.opts.raw,
		}
	}

	/// `file_softmagic`, appending to the description.
	fn softmagic(&mut self, data: &[u8], tail: &dyn TailSource, mode: u32, test: u8, text: bool) -> bool {
		let mut matcher = Matcher::new(self.db, self.opts.report(), self.limits(), &self.zone, mode);
		matcher.out = std::mem::take(&mut self.out);
		let rv = matcher.softmagic(Buf { data, tail }, test, text);
		self.out = matcher.out;
		rv != 0
	}

	/// `file_buffer`: runs the content tests over `data`, the start of the
	/// file. `source` reaches the rest of it, when there is a file behind.
	fn buffer(
		&mut self,
		name: Option<&[u8]>,
		data: &[u8],
		mut source: Option<&mut (dyn ReadAt + '_)>,
		tail: &dyn TailSource,
		fsize: Option<u64>,
		mut mode: u32,
	) {
		let nb = data.len();
		let mime_encoding_only = self.opts.mime_encoding && !self.opts.mime_type;
		let silent = self.opts.silent();
		let mut code_mime = "binary";
		let mut looks_text = false;
		// The outcome of the last test that ran.
		let mut matched = false;
		'tests: {
			if nb < 2 {
				break 'tests;
			}
			if !self.opts.no_encoding {
				let encoding = text::detect(data, self.opts.encoding_max);
				looks_text = encoding.text;
				code_mime = encoding.mime;
			}
			if !self.opts.no_compress && self.opts.compress && self.zmagic(name, data) {
				return;
			}
			if !self.opts.no_tar && !silent && let Some(kind) = text::tar_kind(data) {
				if !mime_encoding_only {
					self.print(if self.opts.mime() { "application/x-tar" } else { kind });
				}
				matched = true;
				if self.check_done() {
					break 'tests;
				}
			} else {
				matched = false;
			}
			if !self.opts.no_json {
				matched = !silent && text::is_json(data);
				if matched {
					if !mime_encoding_only {
						self.print(if self.opts.mime() { "application/json" } else { "JSON data" });
					}
					if self.check_done() {
						break 'tests;
					}
				}
			}
			if !self.opts.no_csv {
				matched = looks_text && !silent && text::is_csv(data);
				if matched {
					if !mime_encoding_only {
						self.print(if self.opts.mime() { "text/csv" } else { "CSV text" });
					}
					if self.check_done() {
						break 'tests;
					}
				}
			}
			// ELF details are gathered first (they settle whether the image
			// is a PIE) and printed after the rules' description.
			let mut elf_details = None;
			if !self.opts.no_elf
				&& nb > 5
				&& !silent
				&& let Some(source) = source.as_deref_mut()
			{
				elf_details =
					elf::describe(data, source, fsize, self.opts.mime(), self.opts.raw, self.opts.elf, &mut mode);
			}
			if !self.opts.no_soft {
				matched = self.softmagic(data, tail, mode, BINTEST, looks_text);
				if matched {
					if let Some(details) = &elf_details {
						self.print(details);
					}
					if self.opts.darwin {
						self.macho_slices(name, data, source.as_deref_mut());
					}
					if self.check_done() {
						break 'tests;
					}
				}
			}
			if !self.opts.no_ascii {
				matched = self.ascmagic(data, tail, mode, looks_text);
				if matched {
					break 'tests;
				}
			}
		}
		if !matched {
			// `file_default`.
			if self.opts.mime() {
				if self.opts.mime_type {
					self.print(if nb != 0 { "application/octet-stream" } else { "application/x-empty" });
				}
			} else if self.opts.apple {
				self.print("UNKNUNKN");
			} else if self.opts.extension {
				self.print("???");
			} else {
				self.print(match nb {
					0 => "empty",
					1 => "very short file (no magic)",
					_ => "data",
				});
			}
		}
		if self.out.ends_with(b"\n- ") {
			self.out.truncate(self.out.len() - 3);
		}
		if self.opts.mime_encoding {
			if self.opts.mime_type {
				self.print("; charset=");
			}
			self.print(code_mime);
		}
	}

	/// `file_zmagic`: under `-z`, describes what the compressed data holds,
	/// then the compression itself in parentheses.
	fn zmagic(&mut self, name: Option<&[u8]>, data: &[u8]) -> bool {
		let Some(unpacked) = compress::unpack(data, self.opts.bytes_max) else { return false };
		self.opts.compress = false;
		match unpacked {
			compress::Unpacked::Data(inner) => self.buffer(name, &inner, None, &NoTail, None, 0),
			compress::Unpacked::Error(method, message) => {
				if self.opts.mime() {
					let message: String =
						message.chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '-' }).collect();
					self.print(format!("application/x-decompression-error-{method}-{message}"));
				} else {
					self.print(format!("ERROR:[{method}: {message}]"));
				}
			},
		}
		let both = self.opts.mime_type && self.opts.mime_encoding;
		if !self.opts.transparent && (both || !self.opts.mime()) {
			self.print(if both { " compressed-encoding=" } else { " (" });
			let outer = std::mem::take(&mut self.out);
			self.buffer(None, data, None, &NoTail, None, 0);
			let described = std::mem::replace(&mut self.out, outer);
			self.print(described);
			if !both {
				self.print(")");
			}
		}
		self.opts.compress = true;
		true
	}

	/// `file_ascmagic`: text files. Runs the text rules over the decoded
	/// characters, then appends the character set and line structure.
	fn ascmagic(&mut self, data: &[u8], tail: &dyn TailSource, mode: u32, text: bool) -> bool {
		let trimmed = trim_nuls(data);
		// An even-sized buffer is not cut at an odd byte: that would lose the
		// last UTF-16 character.
		let len = trimmed.len() + usize::from(trimmed.len() & 1 != 0 && data.len() & 1 == 0);
		let data = &data[..len];
		let encoding = text::detect(data, self.opts.encoding_max);
		if !encoding.text {
			return false;
		}
		let nbytes = trim_nuls(data).len();
		if nbytes <= 1 {
			return false;
		}
		let silent = self.opts.silent();
		let mut need_separator = false;
		if !encoding.chars.is_empty() && !self.opts.no_soft {
			let Some(utf8) = text::encode_utf8(&encoding.chars) else { return false };
			let found = self.softmagic(&utf8, tail, mode, TEXTTEST, text);
			need_separator = found;
			if silent {
				return found;
			}
		}
		if silent {
			return false;
		}
		let lines = text::scan_lines(&encoding.chars, nbytes >= self.opts.bytes_max);
		let printed = !self.out.is_empty();
		if self.opts.mime() {
			if self.opts.mime_type {
				if printed {
					// The text rules gave a type already.
					if !self.opts.keep_going {
						return true;
					}
					if need_separator {
						self.print("\n- ");
					}
				} else {
					self.print("text/plain");
				}
			}
			return true;
		}
		let mut executable = false;
		if printed {
			// Upstream folds a rule's trailing "text" into the character-set
			// clause; Apple keeps the rule's wording.
			if self.opts.darwin {
				self.print(", ");
			} else if self.out.ends_with(b" text") {
				self.out.truncate(self.out.len() - " text".len());
				self.print(", ");
			} else if self.out.ends_with(b" text executable") {
				self.out.truncate(self.out.len() - " text executable".len());
				self.print(", ");
				executable = true;
			} else {
				self.print(", ");
			}
		}
		self.print(encoding.code);
		self.print(" text");
		if executable {
			self.print(" executable");
		}
		if lines.longest != 0 {
			self.print(format!(", with very long lines ({})", lines.longest));
		}
		// Line terminators are reported unless they are all plain LF.
		let none = lines.crlf == 0 && lines.cr == 0 && lines.nel == 0 && lines.lf == 0;
		if none || lines.crlf != 0 || lines.cr != 0 || lines.nel != 0 {
			self.print(", with");
			if none {
				self.print(" no");
			} else {
				let kinds = [(lines.crlf, " CRLF"), (lines.cr, " CR"), (lines.lf, " LF"), (lines.nel, " NEL")];
				let mut first = true;
				for (count, label) in kinds {
					if count != 0 {
						if !first {
							self.print(",");
						}
						first = false;
						self.print(label);
					}
				}
			}
			self.print(" line terminators");
		}
		if lines.escapes {
			self.print(", with escape sequences");
		}
		if lines.backspace {
			self.print(", with overstriking");
		}
		true
	}

	/// Apple's `file_trymacho`: one line per architecture of a universal
	/// binary, each describing that slice's Mach-O header.
	fn macho_slices(&mut self, name: Option<&[u8]>, data: &[u8], mut source: Option<&mut (dyn ReadAt + '_)>) {
		const FAT_HEADER: usize = 8;
		const FAT_ARCH: usize = 20;
		const MACH_HEADER: usize = 28;
		if data.len() < FAT_HEADER + FAT_ARCH + MACH_HEADER {
			return;
		}
		let big_endian = match data[..4] {
			[0xca, 0xfe, 0xba, 0xbe] => true,
			[0xbe, 0xba, 0xfe, 0xca] => false,
			_ => return,
		};
		let word = |bytes: &[u8], at: usize| {
			let raw = [bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]];
			if big_endian { u32::from_be_bytes(raw) } else { u32::from_le_bytes(raw) }
		};
		// A header inside the buffer is read from it, one beyond from the
		// file.
		let mut fetch = |offset: u64, len: usize| -> Option<Vec<u8>> {
			if offset <= (data.len() - len) as u64 {
				let start = offset as usize;
				return Some(data[start..start + len].to_vec());
			}
			let mut bytes = vec![0; len];
			let read = source.as_deref_mut()?.read_at(offset, &mut bytes).ok()?;
			(read == len).then_some(bytes)
		};
		for index in 0..u64::from(word(data, 4)) {
			let Some(arch) = fetch(FAT_HEADER as u64 + index * FAT_ARCH as u64, FAT_ARCH) else { return };
			if (word(&arch, 12) as usize) < MACH_HEADER {
				return;
			}
			let Some(header) = fetch(u64::from(word(&arch, 8)), MACH_HEADER) else { return };
			let (cpu, subtype) = (word(&arch, 0), word(&arch, 4) & 0x00ff_ffff);
			self.print("\n");
			self.print(name.unwrap_or(b"(null)"));
			match macho_arch_name(cpu, subtype) {
				Some(arch_name) => self.print(format!(" (for architecture {arch_name}):\t")),
				None => self.print(format!(
					" (for architecture cputype ({}) cpusubtype ({})):\t",
					cpu as i32, subtype as i32
				)),
			}
			self.buffer(name, &header, None, &NoTail, None, 0);
		}
	}
}

/// `macho_arch_name_for_cpu_type`: the architecture names of libmacho.
fn macho_arch_name(cpu: u32, subtype: u32) -> Option<&'static str> {
	const X86_64: u32 = 0x0100_0007;
	const ARM64: u32 = 0x0100_000c;
	const ARM64_32: u32 = 0x0200_000c;
	const PPC64: u32 = 0x0100_0012;
	Some(match (cpu, subtype) {
		(7, 3) => "i386",
		(7, 4) => "i486",
		(7, 5) => "i586",
		(X86_64, 3) => "x86_64",
		(X86_64, 8) => "x86_64h",
		(12, 0) => "arm",
		(12, 5) => "armv4t",
		(12, 6) => "armv6",
		(12, 7) => "armv5",
		(12, 8) => "xscale",
		(12, 9) => "armv7",
		(12, 10) => "armv7f",
		(12, 11) => "armv7s",
		(12, 12) => "armv7k",
		(12, 13) => "armv8",
		(12, 14) => "armv6m",
		(12, 15) => "armv7m",
		(12, 16) => "armv7em",
		(ARM64, 0) => "arm64",
		(ARM64, 1) => "arm64v8",
		(ARM64, 2) => "arm64e",
		(ARM64, 12) => "arm64e.x1",
		(ARM64_32, 0 | 1) => "arm64_32",
		(18, 0) => "ppc",
		(18, 100) => "ppc970",
		(PPC64, 0) => "ppc64",
		(PPC64, 100) => "ppc970-64",
		(6, _) => "m68k",
		_ => return None,
	})
}

/// `file_getbuffer`: the description with non-printable characters as
/// `\ooo`, unless output is raw.
fn printable(text: &[u8], raw: bool) -> Cow<'_, [u8]> {
	if raw {
		return Cow::Borrowed(text);
	}
	let keep = |c: char| !c.is_control();
	let push_octal = |out: &mut Vec<u8>, byte: u8| {
		out.extend_from_slice(&[b'\\', b'0' + (byte >> 6), b'0' + ((byte >> 3) & 7), b'0' + (byte & 7)]);
	};
	let mut out = Vec::new();
	match std::str::from_utf8(text) {
		Ok(decoded) => {
			if decoded.chars().all(keep) {
				return Cow::Borrowed(text);
			}
			let mut utf8 = [0; 4];
			for c in decoded.chars() {
				let bytes = c.encode_utf8(&mut utf8).as_bytes();
				if keep(c) {
					out.extend_from_slice(bytes);
				} else {
					for &byte in bytes {
						push_octal(&mut out, byte);
					}
				}
			}
		},
		// Not valid in the locale's encoding: byte by byte.
		Err(_) => {
			for &byte in text {
				if byte.is_ascii() && keep(byte as char) {
					out.push(byte);
				} else {
					push_octal(&mut out, byte);
				}
			}
		},
	}
	Cow::Owned(out)
}

/// The output layout the command line selects.
struct Layout {
	brief:     bool,
	no_pad:    bool,
	no_buffer: bool,
	/// `-0` given once ends names with NUL; twice ends lines with it too.
	nul:       u8,
	separator: Vec<u8>,
}

/// `file_mbswidth`.
fn width(name: &[u8]) -> usize {
	ansi_width::ansi_width(&String::from_utf8_lossy(name))
}

impl Scan<'_> {
	/// `process`: identifies one operand and writes its line. Returns whether
	/// it was an error.
	fn process(
		&mut self,
		host: &mut Host,
		out: &mut impl Write,
		layout: &Layout,
		name: &OsStr,
		wid: usize,
	) -> bool {
		let std_in = name == "-";
		let display = os_bytes_lossy(name);
		if wid > 0 && !layout.brief {
			let shown: &[u8] = if std_in { b"/dev/stdin" } else { &display };
			let _ = out.write_all(shown);
			if layout.nul > 0 {
				let _ = out.write_all(b"\0");
			}
			if layout.nul < 2 {
				let _ = out.write_all(&layout.separator);
				let pad = if layout.no_pad { 0 } else { wid.saturating_sub(width(&display)) };
				let _ = write!(out, "{:pad$} ", "");
			}
		}
		self.out.clear();
		self.failed = false;
		if std_in {
			self.stdin(host);
		} else {
			self.named(host, name, &display);
		}
		if self.out.is_empty() {
			// Nothing to say at all is libmagic's NULL result, which file(1)
			// prints through `%s`.
			self.failed = true;
			let _ = out.write_all(b"ERROR: (null)");
		} else if self.failed {
			let _ = out.write_all(b"ERROR: ");
			let _ = out.write_all(&self.out);
		} else {
			let _ = out.write_all(&printable(&self.out, self.opts.raw));
		}
		let _ = out.write_all(if layout.nul > 1 { b"\0" } else { b"\n" });
		if layout.no_buffer {
			let _ = out.flush();
		}
		self.failed
	}
}

/// The magic sources `-m LIST` names: each file, and each regular file of a
/// directory in name order.
fn read_magic_files(host: &Host, list: &OsStr) -> io::Result<Vec<Vec<u8>>> {
	let mut sources = Vec::new();
	for entry in os_bytes_lossy(list).split(|&c| c == b':') {
		let path = host.resolve(&*String::from_utf8_lossy(entry));
		let mut files = Vec::new();
		if host.fs().is_dir(&path) {
			for child in host.fs().read_dir(&path)? {
				let child = child?;
				let name = child.file_name();
				if !os_bytes_lossy(&name).starts_with(b".") && host.fs().is_file(path.join(&name)) {
					files.push(path.join(name));
				}
			}
			files.sort();
		} else {
			files.push(path);
		}
		for file in files {
			let source = host.fs().read(&file)?;
			// A compiled database starts with the magic number.
			if source.starts_with(&0xF11E_041Cu32.to_le_bytes()) || source.starts_with(&0xF11E_041Cu32.to_be_bytes()) {
				return Err(io::Error::other(format!("{}: compiled magic is not supported", file.display())));
			}
			sources.push(source);
		}
	}
	Ok(sources)
}

impl Utility for FileCli {
	const NAME: &'static str = "file";

	fn run(self, host: &mut Host) -> i32 {
		let matches = &self.matches;
		let flag = |name: &str| matches.get_flag(name);
		let darwin = darwin();
		// `FILE_NAME_MAX`: Apple raised it.
		let name_max = if darwin { 60 } else { 50 };
		if flag(OPT_HELP) {
			let _ = host.stdout.write_all(help(name_max).as_bytes());
			return 0;
		}
		if flag(OPT_VERSION) {
			let from = matches
				.get_one::<OsString>(OPT_MAGIC_FILE)
				.map_or(Cow::Borrowed("(builtin)"), |list| list.to_string_lossy());
			let _ = writeln!(host.stdout, "file-5.41\nmagic file from {from}");
			return 0;
		}
		let usage = |host: &mut Host| {
			let _ = host.stderr.write_all(USAGE.as_bytes());
			if darwin {
				let _ = writeln!(host.stderr, "Try `file --help' for more information.");
			}
			1
		};
		for (option, what) in [(OPT_COMPILE, "-C"), (OPT_CHECKING, "-c"), (OPT_LIST, "-l")] {
			if flag(option) {
				host.error(format!("{what} is not supported: magic files are read as source"), 1);
				return 1;
			}
		}

		let mime = flag(OPT_MIME);
		let mut opts = Opts {
			mime_type:      mime || flag(OPT_MIME_TYPE),
			mime_encoding:  mime || flag(OPT_MIME_ENCODING),
			extension:      flag(OPT_EXTENSION),
			apple:          flag(OPT_APPLE),
			keep_going:     flag(OPT_KEEP_GOING),
			// Apple's `file` never escapes, which its multi-line Mach-O
			// output relies on.
			raw:            flag(OPT_RAW) || darwin,
			error:          flag(OPT_ERROR),
			devices:        flag(OPT_SPECIAL_FILES),
			// Following links is the POSIX default, which Apple's `file`
			// always runs under.
			symlink:        flag(OPT_DEREFERENCE)
				|| (!flag(OPT_NO_DEREFERENCE) && (darwin || host.var("POSIXLY_CORRECT").is_some())),
			compress:       flag(OPT_UNCOMPRESS) || flag(OPT_UNCOMPRESS_NOREPORT),
			transparent:    flag(OPT_UNCOMPRESS_NOREPORT),
			preserve_atime: flag(OPT_PRESERVE_DATE),
			no_ascii:       false,
			no_compress:    false,
			no_csv:         false,
			no_elf:         false,
			no_encoding:    false,
			no_soft:        false,
			no_tar:         false,
			no_json:        false,
			bytes_max:      1024 * 1024,
			encoding_max:   64 * 1024,
			// libmagic reads segments through a `BUFSIZ` buffer, so the C
			// library's value decides how much of a dynamic section it sees.
			elf:            ElfLimits { notes: 256, phnum: 2048, shnum: 32768, segment: if darwin { 1024 } else { 8192 } },
			indir_max:      50,
			name_max,
			regex_max:      8192,
			darwin,
		};
		let mut unknown_test = false;
		for test in matches.get_many::<String>(OPT_EXCLUDE).into_iter().flatten() {
			unknown_test |= !opts.exclude(test);
		}
		for test in matches.get_many::<String>(OPT_EXCLUDE_QUIET).into_iter().flatten() {
			opts.exclude(test);
		}
		if unknown_test {
			return usage(host);
		}
		for param in matches.get_many::<String>(OPT_PARAMETER).into_iter().flatten() {
			if !opts.set_param(param) {
				host.error(format!("Unknown param {param}"), 1);
				return 1;
			}
		}

		let name_files: Vec<&OsString> = matches.get_many::<OsString>(OPT_FILES_FROM).into_iter().flatten().collect();
		let files: Vec<&OsString> = matches.get_many::<OsString>(ARG_FILES).into_iter().flatten().collect();
		if name_files.is_empty() && files.is_empty() {
			return usage(host);
		}

		let custom = match matches.get_one::<OsString>(OPT_MAGIC_FILE) {
			Some(list) => match read_magic_files(host, list) {
				Ok(sources) => Some(sources),
				Err(err) => {
					host.error(strip_errno(&err), 1);
					return 1;
				},
			},
			None => None,
		};
		let custom_db = custom.as_ref().map(|sources| {
			let sources: Vec<&[u8]> = sources.iter().map(Vec::as_slice).collect();
			Db::parse(&sources)
		});
		let db: &Db<'_> = match &custom_db {
			Some(db) => db,
			None => magic::builtin(darwin),
		};

		let brief = matches.get_count(OPT_BRIEF);
		let mut layout = Layout {
			brief:     brief > 0,
			no_pad:    flag(OPT_NO_PAD),
			no_buffer: flag(OPT_NO_BUFFER),
			nul:       matches.get_count(OPT_PRINT0),
			separator: matches
				.get_one::<OsString>(OPT_SEPARATOR)
				.map_or_else(|| b":".to_vec(), |separator| os_bytes_lossy(separator).into_owned()),
		};
		let mut scan = Scan { opts, db, zone: shell_time_zone(host), out: Vec::new(), failed: false };
		let mut out = host.stdout_writer();
		let mut failed = false;

		for list in name_files {
			let names = if list == "-" {
				let mut names = Vec::new();
				host.stdin.read_to_end(&mut names).map(|_| names)
			} else {
				host.fs().read(host.resolve(list))
			};
			let names = match names {
				Ok(names) => names,
				Err(err) => {
					let _ = out.flush();
					host.error(format!("Cannot open `{}' ({})", list.to_string_lossy(), strip_errno(&err)), 1);
					failed = true;
					continue;
				},
			};
			if names.is_empty() {
				continue;
			}
			let names: Vec<&[u8]> = names.strip_suffix(b"\n").unwrap_or(&names).split(|&c| c == b'\n').collect();
			// Names read from standard input are not padded to a column.
			let wid = if list == "-" { 1 } else { names.iter().map(|name| width(name)).max().unwrap_or(0) };
			for name in names {
				if host.is_cancelled() {
					return 130;
				}
				let name = String::from_utf8_lossy(name);
				failed |= scan.process(host, &mut out, &layout, OsStr::new(&*name), wid);
			}
		}

		// `-bb` is brief only for a single operand.
		if brief == 2 {
			layout.brief = files.len() <= 1;
		}
		let wid = files.iter().map(|name| width(&os_bytes_lossy(name))).max().unwrap_or(0);
		for name in files {
			if host.is_cancelled() {
				return 130;
			}
			failed |= scan.process(host, &mut out, &layout, name, wid);
		}
		let _ = out.flush();
		i32::from(failed)
	}
}
