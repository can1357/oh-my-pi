//! BSD `stat` (macOS `/usr/bin/stat`): option parsing and the format renderer.
//!
//! GNU `stat` is the builtin's primary personality. Invocations shaped like
//! BSD stat (see [`is_bsd_invocation`]) are parsed here with BSD `getopt`
//! rules and rendered natively from the file metadata, following
//! FreeBSD/Apple `stat.c`: [`render`] is its `output()` and [`format1`] its
//! `format1()`. Fields a platform or virtual filesystem cannot report print
//! `?`; BSD file flags and device names come only from native macOS
//! metadata.

use std::{
	ffi::OsString,
	io::{self, Write},
	path::{Path, PathBuf},
	time::{SystemTime, UNIX_EPOCH},
};

use jiff::{Timestamp, tz::TimeZone};
use omp_vfs::{BlockingFs, Metadata};
use uucore::fsext::MetadataTimeField;
#[cfg(unix)]
use uucore::{
	entries,
	fs::{major, minor},
};

use super::imp::{allocated_blocks, file_mode, file_time};
use crate::{
	host::{Host, strip_errno},
	time_zone::shell_time_zone,
};

/// Format used when no output style is selected.
const DEF_FORMAT: &[u8] =
	b"%d %i %Sp %l %Su %Sg %r %z \"%Sa\" \"%Sm\" \"%Sc\" \"%SB\" %k %b %#Xf %N";
/// `-l`: `ls -lT` lines.
const LS_FORMAT: &[u8] = b"%Sp %l %Su %Sg %Z %Sm %N%SY";
/// `-F`: `ls -lTF` lines.
const LSF_FORMAT: &[u8] = b"%Sp %l %Su %Sg %Z %Sm %N%T%SY";
/// `-r`: every field as a raw number.
const RAW_FORMAT: &[u8] = b"%d %i %#p %l %u %g %r %z %a %m %c %B %k %b %f %N";
/// `-s`: eval-able shell assignments.
const SHELL_FORMAT: &[u8] = b"st_dev=%d st_ino=%i st_mode=%#p st_nlink=%l st_uid=%u st_gid=%g \
	st_rdev=%r st_size=%z st_atime=%a st_mtime=%m st_ctime=%c st_birthtime=%B st_blksize=%k \
	st_blocks=%b st_flags=%f";
/// `-x`: the Linux-like verbose block, verbatim from Apple's `stat` (its
/// undocumented `%A` datum is `st_mode & 07777`).
const LINUX_FORMAT: &[u8] = b"  File: \"%N\"%n  Size: %-11z  FileType: %HT%n  Mode: \
	(%0Mp%03OA/%.10Sp)         Uid: (%5u/%8Su)  Gid: (%5g/%8Sg)%nDevice: %Hd,%Ld   Inode: %i    \
	Links: %l%nAccess: %Sa%nModify: %Sm%nChange: %Sc%n Birth: %SB";
/// Default `-t` time format.
const TIME_FORMAT: &[u8] = b"%b %e %T %Y";
/// `-x` time format unless `-t` overrides it.
const LINUX_TIME_FORMAT: &[u8] = b"%c";
/// BSD `usage()` line.
const USAGE: &[u8] =
	b"usage: stat [-FLnq] [-f format | -l | -r | -s | -x] [-t timefmt] [file ...]\n";

/// Bytes `stat.c` keeps of one rendered directive: its `PATH_MAX + 4`
/// buffer minus the terminator, with macOS `PATH_MAX`.
const FIELD_CAP: usize = 1028;
/// Bytes `stat.c` keeps of each `%Z` device piece (a 20-byte buffer).
const DEVICE_PIECE_CAP: usize = 19;

/// Whether `argv` is a BSD-shaped invocation.
///
/// The options before the first operand are walked with BSD `getopt` rules
/// (`f` and `t` take a value). The invocation is BSD when they use a flag
/// GNU stat lacks (`F`, `l`, `n`, `q`, `r`, `s`, `x`) or give `-f`/`-t` a
/// value containing `%`; values starting with `-` are not counted, so GNU
/// `stat -f -c%S` stays GNU. A long option or the GNU-only `-c` means GNU.
/// Letters neither stat knows do not decide either way.
pub(super) fn is_bsd_invocation(argv: &[OsString]) -> bool {
	let mut args = argv.iter().skip(1).map(|arg| arg.as_encoded_bytes());
	let mut bsd = false;
	while let Some(arg) = args.next() {
		let Some(cluster) = arg.strip_prefix(b"-") else {
			break;
		};
		if cluster.is_empty() || cluster == b"-" {
			break;
		}
		if cluster.starts_with(b"-") {
			return false;
		}
		for (k, &letter) in cluster.iter().enumerate() {
			match letter {
				b'F' | b'l' | b'n' | b'q' | b'r' | b's' | b'x' => bsd = true,
				b'c' => return false,
				b'f' | b't' => {
					let value = if k + 1 < cluster.len() { Some(&cluster[k + 1..]) } else { args.next() };
					if value.is_some_and(|value| !value.starts_with(b"-") && value.contains(&b'%')) {
						bsd = true;
					}
					break;
				},
				_ => {},
			}
		}
	}
	bsd
}

/// A parsed BSD invocation.
struct Invocation {
	follow:      bool,
	no_newline:  bool,
	quiet:       bool,
	format:      Vec<u8>,
	time_format: Vec<u8>,
	files:       Vec<OsString>,
}

/// Parses BSD `stat` arguments (`argv` without the command name) like
/// `getopt("f:FlLnqrst:x")`: options end at the first operand or `--`.
/// `Err` holds the complete diagnostic for stderr.
fn parse(args: &[OsString]) -> Result<Invocation, Vec<u8>> {
	let mut ls_f = false;
	let mut follow = false;
	let mut no_newline = false;
	let mut quiet = false;
	let mut style: Option<u8> = None;
	let mut format: Option<Vec<u8>> = None;
	let mut time_format: Option<Vec<u8>> = None;

	let mut index = 0;
	'args: while let Some(arg) = args.get(index) {
		let arg = arg.as_encoded_bytes();
		let Some(cluster) = arg.strip_prefix(b"-").filter(|cluster| !cluster.is_empty()) else {
			break;
		};
		index += 1;
		if cluster == b"-" {
			break;
		}
		for (k, &letter) in cluster.iter().enumerate() {
			match letter {
				b'F' => ls_f = true,
				b'L' => follow = true,
				b'n' => no_newline = true,
				b'q' => quiet = true,
				b'f' | b't' => {
					let value = if k + 1 < cluster.len() {
						cluster[k + 1..].to_vec()
					} else if let Some(next) = args.get(index) {
						index += 1;
						next.as_encoded_bytes().to_vec()
					} else {
						let mut message = b"stat: option requires an argument -- ".to_vec();
						message.extend([letter, b'\n']);
						message.extend_from_slice(USAGE);
						return Err(message);
					};
					if letter == b't' {
						time_format = Some(value);
					} else {
						format = Some(value);
						select_style(&mut style, letter)?;
					}
					continue 'args;
				},
				b'l' | b'r' | b's' | b'x' => select_style(&mut style, letter)?,
				_ => {
					let mut message = b"stat: illegal option -- ".to_vec();
					message.extend([letter, b'\n']);
					message.extend_from_slice(USAGE);
					return Err(message);
				},
			}
		}
	}

	let style = style.unwrap_or(if ls_f { b'l' } else { b'f' });
	if ls_f && style != b'l' {
		return Err(format!("stat: can't use format '{}' with -F\n", char::from(style)).into_bytes());
	}
	let format = match style {
		b'l' if ls_f => LSF_FORMAT.to_vec(),
		b'l' => LS_FORMAT.to_vec(),
		b'r' => RAW_FORMAT.to_vec(),
		b's' => SHELL_FORMAT.to_vec(),
		b'x' => {
			time_format.get_or_insert_with(|| LINUX_TIME_FORMAT.to_vec());
			LINUX_FORMAT.to_vec()
		},
		_ => format.unwrap_or_else(|| DEF_FORMAT.to_vec()),
	};
	Ok(Invocation {
		follow,
		no_newline,
		quiet,
		format,
		time_format: time_format.unwrap_or_else(|| TIME_FORMAT.to_vec()),
		files: args[index..].to_vec(),
	})
}

/// Records the output style `letter`; BSD allows only one.
fn select_style(style: &mut Option<u8>, letter: u8) -> Result<(), Vec<u8>> {
	if let Some(previous) = *style {
		return Err(format!(
			"stat: can't use format '{}' with '{}'\n",
			char::from(previous),
			char::from(letter)
		)
		.into_bytes());
	}
	*style = Some(letter);
	Ok(())
}

/// Runs BSD `stat` with `args` (`argv` without the command name); with no
/// file operands it describes standard input, as BSD does.
pub(super) fn run(args: &[OsString], host: &mut Host) -> i32 {
	let invocation = match parse(args) {
		Ok(invocation) => invocation,
		Err(message) => {
			let _ = host.stderr.write_all(&message);
			return 1;
		},
	};
	let time_zone = shell_time_zone(host);
	let operands: Vec<Option<&OsString>> = if invocation.files.is_empty() {
		vec![None]
	} else {
		invocation.files.iter().map(Some).collect()
	};
	let mut status = 0;
	for (index, operand) in operands.into_iter().enumerate() {
		let (name, path, result) = match operand {
			Some(file) => {
				let path = host.resolve(file);
				let result = if invocation.follow {
					// Like BSD, a broken link falls back to the link itself.
					host.fs().metadata(&path).or_else(|error| {
						if error.kind() == io::ErrorKind::NotFound {
							host.fs().symlink_metadata(&path).map_err(|_| error)
						} else {
							Err(error)
						}
					})
				} else {
					host.fs().symlink_metadata(&path)
				};
				(file.as_encoded_bytes(), path, result)
			},
			None => {
				let name: &[u8] = b"(stdin)";
				let stdin = host.resolve("/dev/stdin");
				(name, host.resolve("(stdin)"), host.fs().metadata(stdin))
			},
		};
		let meta = match result {
			Ok(meta) => meta,
			Err(error) => {
				status = 1;
				if !invocation.quiet {
					let mut message = b"stat: ".to_vec();
					message.extend_from_slice(name);
					message.extend_from_slice(format!(": stat: {}\n", strip_errno(&error)).as_bytes());
					let _ = host.stderr.write_all(&message);
				}
				continue;
			},
		};
		let subject = Subject {
			name,
			path: &path,
			mode: file_mode(&meta),
			meta: &meta,
			fs: host.fs(),
			time_zone: &time_zone,
			time_format: &invocation.time_format,
		};
		let mut out = Vec::with_capacity(256);
		let rendered = render(&invocation.format, &subject, index + 1, &mut out);
		if rendered.is_ok() && !invocation.no_newline && out.last().is_some_and(|&last| last != b'\n') {
			out.push(b'\n');
		}
		let _ = host.stdout.write_all(&out);
		if let Err(directive) = rendered {
			// BSD exits on the first bad directive, keeping what it printed.
			let mut message = b"stat: ".to_vec();
			message.extend_from_slice(directive);
			message.extend_from_slice(b": bad format\n");
			let _ = host.stderr.write_all(&message);
			return 1;
		}
	}
	status
}

/// The file a format is rendered for.
struct Subject<'a> {
	/// Operand as typed (`%N`).
	name:        &'a [u8],
	/// Resolved operand for `%R` and `%Y`.
	path:        &'a Path,
	meta:        &'a Metadata,
	/// POSIX `st_mode`.
	mode:        u32,
	fs:          &'a BlockingFs,
	time_zone:   &'a TimeZone,
	time_format: &'a [u8],
}

/// `printf(3)` flags of a directive.
#[derive(Clone, Copy, Default)]
struct Flags {
	pound: bool,
	space: bool,
	plus:  bool,
	zero:  bool,
	minus: bool,
}

/// Output representation (`fmt`) of a directive.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Repr {
	Decimal,
	Octal,
	Unsigned,
	Hex,
	Float,
	String,
}

impl Repr {
	/// The `FMTF_*` bit.
	const fn bit(self) -> u8 {
		match self {
			Self::Decimal => 1,
			Self::Octal => 2,
			Self::Unsigned => 4,
			Self::Hex => 8,
			Self::Float => 16,
			Self::String => 32,
		}
	}
}

/// `FMTF_*` bits of the integer representations.
const NUMERIC: u8 = Repr::Decimal.bit() | Repr::Octal.bit() | Repr::Unsigned.bit() | Repr::Hex.bit();
/// `FMTF_STRING`.
const STRING: u8 = Repr::String.bit();

/// Sub-field selector (`sub`) of a directive.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Piece {
	High,
	Middle,
	Low,
}

/// One parsed `%[flags][size][.prec][fmt][sub]datum` directive.
#[derive(Clone, Copy)]
struct Spec {
	flags: Flags,
	size:  Option<usize>,
	prec:  Option<usize>,
	repr:  Option<Repr>,
	piece: Option<Piece>,
	datum: u8,
}

/// Renders `format` for one file into `out` (BSD `output()`), without the
/// trailing newline. `Err` is the offending directive text; `out` then holds
/// what preceded it.
fn render<'f>(format: &'f [u8], subject: &Subject, number: usize, out: &mut Vec<u8>) -> Result<(), &'f [u8]> {
	let mut i = 0;
	while let Some(&c) = format.get(i) {
		if c != b'%' {
			out.push(c);
			i += 1;
			continue;
		}
		let start = i;
		i += 1;
		match format.get(i) {
			Some(b'n') => out.push(b'\n'),
			Some(b't') => out.push(b'\t'),
			Some(b'%') => out.push(b'%'),
			Some(b'@') => out.extend_from_slice(number.to_string().as_bytes()),
			_ => {
				let (spec, end) = parse_directive(format, start, i)?;
				i = end;
				let field = format1(subject, &spec).ok_or(&format[start..end])?;
				out.extend_from_slice(&field[..field.len().min(FIELD_CAP)]);
				continue;
			},
		}
		i += 1;
	}
	Ok(())
}

/// Parses the directive starting at `format[start]` (`%`), with `i` just past
/// the `%`. Returns the spec and the index past the datum; `Err` is the
/// directive through the first character that cannot belong to it.
fn parse_directive(format: &[u8], start: usize, mut i: usize) -> Result<(Spec, usize), &[u8]> {
	let bad = |i: usize| directive_through(format, start, i);
	let mut flags = Flags::default();
	while let Some(&c) = format.get(i) {
		match c {
			b'#' => flags.pound = true,
			b' ' => flags.space = true,
			b'+' => flags.plus = true,
			b'0' => flags.zero = true,
			b'-' => flags.minus = true,
			_ => break,
		}
		i += 1;
	}
	let number = |i: &mut usize| -> Result<usize, ()> {
		let mut value: i32 = 0;
		while let Some(&digit) = format.get(*i).filter(|c| c.is_ascii_digit()) {
			*i += 1;
			value = value
				.checked_mul(10)
				.and_then(|value| value.checked_add(i32::from(digit - b'0')))
				.ok_or(())?;
		}
		Ok(value as usize)
	};
	let size = if format.get(i).is_some_and(u8::is_ascii_digit) {
		Some(number(&mut i).map_err(|()| bad(i))?)
	} else {
		None
	};
	let prec = if format.get(i) == Some(&b'.') {
		i += 1;
		Some(number(&mut i).map_err(|()| bad(i))?)
	} else {
		None
	};
	let repr = match format.get(i) {
		Some(b'D') => Some(Repr::Decimal),
		Some(b'O') => Some(Repr::Octal),
		Some(b'U') => Some(Repr::Unsigned),
		Some(b'X') => Some(Repr::Hex),
		Some(b'F') => Some(Repr::Float),
		Some(b'S') => Some(Repr::String),
		_ => None,
	};
	i += usize::from(repr.is_some());
	let piece = match format.get(i) {
		Some(b'H') => Some(Piece::High),
		Some(b'M') => Some(Piece::Middle),
		Some(b'L') => Some(Piece::Low),
		_ => None,
	};
	i += usize::from(piece.is_some());
	match format.get(i) {
		Some(&datum) if b"RdipluAgramcBzbkfvYTNZ".contains(&datum) => {
			Ok((Spec { flags, size, prec, repr, piece, datum }, i + 1))
		},
		_ => Err(bad(i)),
	}
}

/// The directive text from `start` through `format[i]` (or the end), as BSD
/// quotes it in `bad format`.
fn directive_through(format: &[u8], start: usize, i: usize) -> &[u8] {
	&format[start..(i + 1).min(format.len())]
}

/// Renders one directive (BSD `format1()`); `None` is a bad format.
fn format1(subject: &Subject, spec: &Spec) -> Option<Vec<u8>> {
	let meta = subject.meta;
	let mut piece = spec.piece;
	let explicit_string = spec.repr == Some(Repr::String);
	// `data` is `None` for a field the backend does not report; `small`
	// marks 32-bit fields whose non-decimal output drops sign extension.
	let mut data: Option<u64> = Some(0);
	let mut small = false;
	let mut nanos = 0;
	let sdata: Option<Vec<u8>>;
	let formats: u8;
	let default: Repr;
	match spec.datum {
		datum @ (b'd' | b'r') => {
			let raw = if datum == b'd' { meta.dev() } else { meta.rdev() };
			small = cfg!(target_os = "macos");
			let kind = if datum == b'd' {
				S_IFBLK
			} else {
				match subject.mode & S_IFMT {
					kind @ (S_IFCHR | S_IFBLK) => kind,
					_ => 0,
				}
			};
			sdata = raw.filter(|_| explicit_string).map(|raw| device_name(raw, kind));
			data = match piece {
				Some(Piece::High) => raw.and_then(device_major),
				Some(Piece::Low) => raw.and_then(device_minor),
				_ => raw,
			};
			if matches!(piece, Some(Piece::High | Piece::Low)) {
				piece = None;
			}
			formats = NUMERIC | STRING;
			default = Repr::Unsigned;
		},
		datum @ (b'p' | b'A') => {
			let mode = if datum == b'A' { subject.mode & 0o7777 } else { subject.mode };
			let text = strmode(subject.mode);
			let (value, text) = match piece.take() {
				Some(Piece::High) => (mode >> 12, &text[1..4]),
				Some(Piece::Middle) => ((mode >> 9) & 0o7, &text[4..7]),
				Some(Piece::Low) => (mode & 0o777, &text[7..10]),
				None => (mode, &text[..]),
			};
			data = Some(u64::from(value));
			sdata = Some(text.to_vec());
			formats = NUMERIC | STRING;
			default = Repr::Octal;
		},
		b'i' => {
			data = meta.ino();
			(sdata, formats, default) = (None, NUMERIC, Repr::Unsigned);
		},
		b'l' => {
			data = meta.nlink();
			small = cfg!(target_os = "macos");
			(sdata, formats, default) = (None, NUMERIC, Repr::Unsigned);
		},
		datum @ (b'u' | b'g') => {
			let id = if datum == b'u' { meta.uid() } else { meta.gid() };
			data = id.map(u64::from);
			sdata = id.filter(|_| explicit_string).map(|id| owner_name(id, datum == b'u'));
			(formats, default) = (NUMERIC | STRING, Repr::Unsigned);
		},
		datum @ (b'a' | b'm' | b'c' | b'B') => {
			let field = match datum {
				b'a' => MetadataTimeField::Access,
				b'm' => MetadataTimeField::Modification,
				b'c' => MetadataTimeField::Change,
				_ => MetadataTimeField::Birth,
			};
			let time = file_time(meta, field).map(split_time);
			// macOS reports an unknown birth time as the Epoch.
			let time = if matches!(field, MetadataTimeField::Birth) { Some(time.unwrap_or((0, 0))) } else { time };
			data = time.map(|(seconds, _)| seconds as u64);
			nanos = time.map_or(0, |(_, nanos)| nanos);
			sdata = time
				.filter(|_| explicit_string)
				.map(|(seconds, _)| strftime(subject.time_format, seconds, subject.time_zone));
			(formats, default) = (NUMERIC | Repr::Float.bit() | STRING, Repr::Decimal);
		},
		b'z' => {
			data = Some(meta.len());
			(sdata, formats, default) = (None, NUMERIC, Repr::Unsigned);
		},
		b'b' => {
			data = allocated_blocks(meta, subject.path, subject.fs);
			(sdata, formats, default) = (None, NUMERIC, Repr::Unsigned);
		},
		b'k' => {
			data = meta.blksize();
			small = cfg!(target_os = "macos");
			(sdata, formats, default) = (None, NUMERIC, Repr::Unsigned);
		},
		b'f' => {
			let flags = file_flags(meta);
			data = flags.map(u64::from);
			sdata = flags.filter(|_| explicit_string).map(flags_to_string);
			(formats, default) = (NUMERIC | STRING, Repr::Unsigned);
		},
		b'v' => {
			data = Some(u64::from(generation(meta)));
			(sdata, formats, default) = (None, NUMERIC, Repr::Unsigned);
		},
		b'R' => {
			let (path, resolved) = realpath(subject.fs, subject.path);
			let path = path.into_os_string().into_encoded_bytes();
			sdata = Some(match (resolved, explicit_string) {
				(true, true) => [b" -> ".as_slice(), &path].concat(),
				(false, true) => Vec::new(),
				(_, false) => path,
			});
			(formats, default) = (STRING, Repr::String);
		},
		b'Y' => {
			let target = if subject.mode & S_IFMT == S_IFLNK {
				subject.fs.read_link(subject.path).ok()
			} else {
				None
			};
			sdata = Some(target.map_or_else(Vec::new, |target| {
				let target = target.into_os_string().into_encoded_bytes();
				if explicit_string { [b" -> ".as_slice(), &target].concat() } else { target }
			}));
			(formats, default) = (STRING, Repr::String);
		},
		b'T' => {
			let text: &[u8] = match piece {
				None | Some(Piece::Low) => {
					piece = None;
					match subject.mode & S_IFMT {
						S_IFIFO => b"|",
						S_IFDIR => b"/",
						S_IFREG if subject.mode & 0o111 != 0 => b"*",
						S_IFLNK => b"@",
						S_IFSOCK => b"=",
						S_IFWHT => b"%",
						_ => b"",
					}
				},
				Some(Piece::High) => {
					piece = None;
					match subject.mode & S_IFMT {
						S_IFIFO => b"Fifo File",
						S_IFCHR => b"Character Device",
						S_IFDIR => b"Directory",
						S_IFBLK => b"Block Device",
						S_IFREG => b"Regular File",
						S_IFLNK => b"Symbolic Link",
						S_IFSOCK => b"Socket",
						S_IFWHT => b"Whiteout File",
						_ => b"???",
					}
				},
				Some(Piece::Middle) => b"",
			};
			sdata = Some(text.to_vec());
			(formats, default) = (STRING, Repr::String);
		},
		b'N' => {
			sdata = Some(subject.name.to_vec());
			(formats, default) = (STRING, Repr::String);
		},
		// `Z`: `major,minor` for devices, the size otherwise.
		_ => {
			if !matches!(subject.mode & S_IFMT, S_IFCHR | S_IFBLK) {
				return format1(subject, &Spec { piece: None, datum: b'z', ..*spec });
			}
			let device_piece = |piece| {
				let mut text = format1(subject, &Spec { piece: Some(piece), datum: b'r', ..*spec })?;
				text.truncate(DEVICE_PIECE_CAP);
				Some(text)
			};
			let mut text = device_piece(Piece::High)?;
			text.push(b',');
			text.extend(device_piece(Piece::Low)?);
			return Some(text);
		},
	}

	let repr = spec.repr.unwrap_or(default);
	if piece.is_some() || formats & repr.bit() == 0 {
		return None;
	}
	let mut out = Vec::new();
	let Some(data) = data else {
		printf_string(&mut out, spec, b"?");
		return Some(out);
	};
	match repr {
		Repr::String => printf_string(&mut out, spec, &sdata?),
		Repr::Float => {
			if spec.prec == Some(0) {
				printf_integer(&mut out, spec.flags, spec.size, None, Repr::Decimal, data);
			} else {
				// The width covers the seconds, the point, and the digits.
				let prec = spec.prec.unwrap_or(9);
				let width = spec.size.and_then(|size| size.checked_sub(prec + 1)).filter(|&width| width > 0);
				printf_integer(&mut out, spec.flags, width, None, Repr::Decimal, data);
				let shown = prec.min(9);
				let fraction = nanos / 10_i64.pow((9 - shown) as u32);
				let _ = write!(out, ".{fraction:0shown$}");
				out.resize(out.len() + prec.saturating_sub(9), b'0');
			}
		},
		Repr::Decimal => printf_integer(&mut out, spec.flags, spec.size, spec.prec, repr, data),
		_ => {
			let data = if small { u64::from(data as u32) } else { data };
			printf_integer(&mut out, spec.flags, spec.size, spec.prec, repr, data);
		},
	}
	Some(out)
}

/// `printf("%{flags}{size}.{prec}s")`: precision truncates, `0` pads with
/// zeros as BSD libc does.
fn printf_string(out: &mut Vec<u8>, spec: &Spec, text: &[u8]) {
	let text = &text[..spec.prec.map_or(text.len(), |prec| prec.min(text.len()))];
	let pad = spec.size.unwrap_or(0).saturating_sub(text.len());
	if spec.flags.minus {
		out.extend_from_slice(text);
		out.resize(out.len() + pad, b' ');
	} else {
		out.resize(out.len() + pad, if spec.flags.zero { b'0' } else { b' ' });
		out.extend_from_slice(text);
	}
}

/// `printf("%{flags}{size}.{prec}ll{d,o,u,x}")` of `data`; decimal reads it
/// as signed.
fn printf_integer(out: &mut Vec<u8>, flags: Flags, size: Option<usize>, prec: Option<usize>, repr: Repr, data: u64) {
	let (negative, magnitude) = if repr == Repr::Decimal {
		let value = data as i64;
		(value < 0, value.unsigned_abs())
	} else {
		(false, data)
	};
	// An explicit zero precision prints no digits for zero, except `%#.0o`.
	let mut digits = if prec == Some(0) && magnitude == 0 {
		String::new()
	} else {
		match repr {
			Repr::Octal => format!("{magnitude:o}"),
			Repr::Hex => format!("{magnitude:x}"),
			_ => magnitude.to_string(),
		}
	};
	if repr == Repr::Octal && flags.pound && !digits.starts_with('0') {
		digits.insert(0, '0');
	}
	let prefix = match repr {
		Repr::Decimal if negative => "-",
		Repr::Decimal if flags.plus => "+",
		Repr::Decimal if flags.space => " ",
		Repr::Hex if flags.pound && magnitude != 0 => "0x",
		_ => "",
	};
	let precision_zeros = prec.map_or(0, |prec| prec.saturating_sub(digits.len()));
	let pad = size.unwrap_or(0).saturating_sub(prefix.len() + precision_zeros + digits.len());
	if flags.minus {
		out.extend_from_slice(prefix.as_bytes());
		out.resize(out.len() + precision_zeros, b'0');
		out.extend_from_slice(digits.as_bytes());
		out.resize(out.len() + pad, b' ');
	} else if flags.zero && prec.is_none() {
		out.extend_from_slice(prefix.as_bytes());
		out.resize(out.len() + pad, b'0');
		out.extend_from_slice(digits.as_bytes());
	} else {
		out.resize(out.len() + pad, b' ');
		out.extend_from_slice(prefix.as_bytes());
		out.resize(out.len() + precision_zeros, b'0');
		out.extend_from_slice(digits.as_bytes());
	}
}

/// `st_mode` file type mask.
const S_IFMT: u32 = 0o170_000;
/// FIFO type bits.
const S_IFIFO: u32 = 0o010_000;
/// Character device type bits.
const S_IFCHR: u32 = 0o020_000;
/// Directory type bits.
const S_IFDIR: u32 = 0o040_000;
/// Block device type bits.
const S_IFBLK: u32 = 0o060_000;
/// Regular file type bits.
const S_IFREG: u32 = 0o100_000;
/// Symbolic link type bits.
const S_IFLNK: u32 = 0o120_000;
/// Socket type bits.
const S_IFSOCK: u32 = 0o140_000;
/// BSD whiteout type bits.
const S_IFWHT: u32 = 0o160_000;

/// `strmode(3)` without its trailing space: `-rwsr-xr-x`.
fn strmode(mode: u32) -> [u8; 10] {
	let kind = match mode & S_IFMT {
		S_IFDIR => b'd',
		S_IFCHR => b'c',
		S_IFBLK => b'b',
		S_IFREG => b'-',
		S_IFLNK => b'l',
		S_IFSOCK => b's',
		S_IFIFO => b'p',
		S_IFWHT => b'w',
		_ => b'?',
	};
	let bit = |mask: u32, set: u8| if mode & mask != 0 { set } else { b'-' };
	let exec = |exec: u32, special: u32, both: u8, special_only: u8| match (mode & exec != 0, mode & special != 0) {
		(false, false) => b'-',
		(true, false) => b'x',
		(false, true) => special_only,
		(true, true) => both,
	};
	[
		kind,
		bit(0o400, b'r'),
		bit(0o200, b'w'),
		exec(0o100, 0o4000, b's', b'S'),
		bit(0o040, b'r'),
		bit(0o020, b'w'),
		exec(0o010, 0o2000, b's', b'S'),
		bit(0o004, b'r'),
		bit(0o002, b'w'),
		exec(0o001, 0o1000, b't', b'T'),
	]
}

/// `user_from_uid`/`group_from_gid`: the name, or the number when unknown.
#[cfg(unix)]
fn owner_name(id: u32, user: bool) -> Vec<u8> {
	let name = if user { entries::uid2usr(id) } else { entries::gid2grp(id) };
	name.unwrap_or_else(|_| id.to_string()).into_bytes()
}

/// The owner number; Windows has no POSIX owner names.
#[cfg(not(unix))]
fn owner_name(id: u32, _user: bool) -> Vec<u8> {
	id.to_string().into_bytes()
}

/// `major()` of a device number.
#[cfg(unix)]
fn device_major(dev: u64) -> Option<u64> {
	Some(major(dev as _) as u64)
}

/// `minor()` of a device number.
#[cfg(unix)]
fn device_minor(dev: u64) -> Option<u64> {
	Some(minor(dev as _) as u64)
}

/// A Windows volume serial has no major number.
#[cfg(not(unix))]
const fn device_major(_dev: u64) -> Option<u64> {
	None
}

/// A Windows volume serial has no minor number.
#[cfg(not(unix))]
const fn device_minor(_dev: u64) -> Option<u64> {
	None
}

#[cfg(target_os = "macos")]
unsafe extern "C" {
	fn devname_r(
		dev: libc::dev_t,
		kind: libc::mode_t,
		buf: *mut libc::c_char,
		len: libc::c_int,
	) -> *mut libc::c_char;
	fn fflagstostr(flags: libc::c_ulong) -> *mut libc::c_char;
}

/// `devname(3)` of `dev` as a `kind` (`S_IFCHR`/`S_IFBLK`/0) device, or
/// `???`.
#[cfg(target_os = "macos")]
fn device_name(dev: u64, kind: u32) -> Vec<u8> {
	let mut buf = [0 as libc::c_char; 64];
	// SAFETY: `buf` is writable for the length passed; the result is NULL or
	// points into `buf`.
	let name = unsafe {
		devname_r(dev as libc::dev_t, kind as libc::mode_t, buf.as_mut_ptr(), buf.len() as libc::c_int)
	};
	if name.is_null() {
		return b"???".to_vec();
	}
	// SAFETY: a non-NULL result is a NUL-terminated name inside `buf`.
	unsafe { std::ffi::CStr::from_ptr(name) }.to_bytes().to_vec()
}

/// Only macOS can name devices.
#[cfg(not(target_os = "macos"))]
fn device_name(_dev: u64, _kind: u32) -> Vec<u8> {
	b"???".to_vec()
}

/// BSD `st_flags` from native macOS metadata; unknown for providers.
#[cfg(target_os = "macos")]
fn file_flags(meta: &Metadata) -> Option<u32> {
	meta.native().map(std::os::macos::fs::MetadataExt::st_flags)
}

/// Platforms without BSD file flags report none.
#[cfg(not(target_os = "macos"))]
const fn file_flags(_meta: &Metadata) -> Option<u32> {
	Some(0)
}

/// `fflagstostr(3)` (as `ls -lO`), `-` for no flags.
#[cfg(target_os = "macos")]
fn flags_to_string(flags: u32) -> Vec<u8> {
	// SAFETY: `fflagstostr` returns NULL or a malloc'd NUL-terminated string,
	// which is copied and then freed exactly once.
	let text = unsafe {
		let raw = fflagstostr(libc::c_ulong::from(flags));
		if raw.is_null() {
			Vec::new()
		} else {
			let text = std::ffi::CStr::from_ptr(raw).to_bytes().to_vec();
			libc::free(raw.cast());
			text
		}
	};
	if text.is_empty() { b"-".to_vec() } else { text }
}

/// Platforms without BSD file flags name none.
#[cfg(not(target_os = "macos"))]
fn flags_to_string(_flags: u32) -> Vec<u8> {
	b"-".to_vec()
}

/// Inode generation (`st_gen`) from native macOS metadata, which reports `0`
/// to non-root users.
#[cfg(target_os = "macos")]
fn generation(meta: &Metadata) -> u32 {
	meta.native().map_or(0, std::os::macos::fs::MetadataExt::st_gen)
}

/// Other platforms do not expose the generation; `0` as macOS shows
/// non-root users.
#[cfg(not(target_os = "macos"))]
const fn generation(_meta: &Metadata) -> u32 {
	0
}

/// `realpath(3)`: the canonical path and `true`, or on failure the path
/// that caused it (trailing links followed, the parent canonicalized) and
/// `false`, as macOS leaves it in the result buffer.
fn realpath(fs: &BlockingFs, path: &Path) -> (PathBuf, bool) {
	if let Ok(canonical) = fs.canonicalize(path) {
		return (canonical, true);
	}
	let mut problem = path.to_path_buf();
	for _ in 0..32 {
		let Ok(target) = fs.read_link(&problem) else {
			break;
		};
		problem = problem.parent().map_or_else(|| target.clone(), |parent| parent.join(&target));
	}
	if let (Some(parent), Some(name)) = (problem.parent(), problem.file_name())
		&& let Ok(parent) = fs.canonicalize(parent)
	{
		return (parent.join(name), false);
	}
	(problem, false)
}

/// `(seconds, nanoseconds)` since the Epoch, flooring times before it.
fn split_time(time: SystemTime) -> (i64, i64) {
	match time.duration_since(UNIX_EPOCH) {
		Ok(after) => (after.as_secs() as i64, i64::from(after.subsec_nanos())),
		Err(before) => {
			let before = before.duration();
			let seconds = -(before.as_secs() as i64);
			match before.subsec_nanos() {
				0 => (seconds, 0),
				nanos => (seconds - 1, 1_000_000_000 - i64::from(nanos)),
			}
		},
	}
}

/// Broken-down local time for [`strftime`].
struct Tm {
	epoch:    i64,
	year:     i64,
	/// 1-based.
	month:    usize,
	day:      i64,
	hour:     i64,
	minute:   i64,
	second:   i64,
	/// 0 is Sunday.
	weekday:  usize,
	/// 0-based.
	yday:     i64,
	iso_year: i64,
	iso_week: i64,
	/// Seconds east of UTC.
	offset:   i64,
	zone:     String,
}

impl Tm {
	/// `localtime(3)` in `time_zone`; out-of-range times use the Epoch.
	fn new(seconds: i64, time_zone: &TimeZone) -> Self {
		let (epoch, timestamp) = match Timestamp::from_second(seconds) {
			Ok(timestamp) => (seconds, timestamp),
			Err(_) => (0, Timestamp::UNIX_EPOCH),
		};
		let zoned = timestamp.to_zoned(time_zone.clone());
		let iso = zoned.date().iso_week_date();
		Self {
			epoch,
			year: i64::from(zoned.year()),
			month: zoned.month() as usize,
			day: i64::from(zoned.day()),
			hour: i64::from(zoned.hour()),
			minute: i64::from(zoned.minute()),
			second: i64::from(zoned.second()),
			weekday: zoned.weekday().to_sunday_zero_offset() as usize,
			yday: i64::from(zoned.day_of_year()) - 1,
			iso_year: i64::from(iso.year()),
			iso_week: i64::from(iso.week()),
			offset: i64::from(zoned.offset().seconds()),
			zone: time_zone.to_offset_info(timestamp).abbreviation().to_owned(),
		}
	}
}

/// Padding flag of a `strftime` conversion (`%-d`, `%_d`, `%0d`).
#[derive(Clone, Copy, PartialEq, Eq)]
enum Pad {
	Default,
	Less,
	Space,
	Zero,
}

/// C-locale weekday names, Sunday first.
const WEEKDAYS: [&str; 7] = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
/// C-locale month names.
const MONTHS: [&str; 12] = [
	"January",
	"February",
	"March",
	"April",
	"May",
	"June",
	"July",
	"August",
	"September",
	"October",
	"November",
	"December",
];

/// macOS `strftime(3)` in the C locale of `seconds` in `time_zone`.
fn strftime(format: &[u8], seconds: i64, time_zone: &TimeZone) -> Vec<u8> {
	let mut out = Vec::with_capacity(32);
	strftime_into(format, &Tm::new(seconds, time_zone), &mut out);
	out
}

/// FreeBSD `_fmt`: an unknown conversion, or a modifier or flag given
/// twice or left dangling, prints its own character.
fn strftime_into(format: &[u8], tm: &Tm, out: &mut Vec<u8>) {
	let mut i = 0;
	'format: while i < format.len() {
		if format[i] == b'%' {
			let mut alternative = false;
			let mut pad = Pad::Default;
			loop {
				i += 1;
				let Some(&conversion) = format.get(i) else {
					i -= 1;
					break;
				};
				match conversion {
					b'E' | b'O' if !alternative => alternative = true,
					b'-' | b'_' | b'0' if pad == Pad::Default => {
						pad = match conversion {
							b'-' => Pad::Less,
							b'_' => Pad::Space,
							_ => Pad::Zero,
						};
					},
					_ if convert(conversion, pad, tm, out) => {
						i += 1;
						continue 'format;
					},
					_ => break,
				}
			}
		}
		out.push(format[i]);
		i += 1;
	}
}

/// Appends one `strftime` conversion; `false` when it is not one.
fn convert(conversion: u8, pad: Pad, tm: &Tm, out: &mut Vec<u8>) -> bool {
	let hour12 = if tm.hour % 12 == 0 { 12 } else { tm.hour % 12 };
	match conversion {
		b'A' => out.extend_from_slice(WEEKDAYS[tm.weekday].as_bytes()),
		b'a' => out.extend_from_slice(&WEEKDAYS[tm.weekday].as_bytes()[..3]),
		b'B' => out.extend_from_slice(MONTHS[tm.month - 1].as_bytes()),
		b'b' | b'h' => out.extend_from_slice(&MONTHS[tm.month - 1].as_bytes()[..3]),
		b'C' => year_parts(out, tm.year, true, false),
		b'c' => strftime_into(b"%a %b %e %H:%M:%S %Y", tm, out),
		b'D' | b'x' => strftime_into(b"%m/%d/%y", tm, out),
		b'd' => number(out, tm.day, 2, true, pad),
		b'e' => number(out, tm.day, 2, false, pad),
		b'F' => strftime_into(b"%Y-%m-%d", tm, out),
		b'G' => year_parts(out, tm.iso_year, true, true),
		b'g' => year_parts(out, tm.iso_year, false, true),
		b'H' => number(out, tm.hour, 2, true, pad),
		b'I' => number(out, hour12, 2, true, pad),
		b'j' => number(out, tm.yday + 1, 3, true, pad),
		b'k' => number(out, tm.hour, 2, false, pad),
		b'l' => number(out, hour12, 2, false, pad),
		b'M' => number(out, tm.minute, 2, true, pad),
		b'm' => number(out, tm.month as i64, 2, true, pad),
		b'n' => out.push(b'\n'),
		b'p' => out.extend_from_slice(if tm.hour >= 12 { b"PM" } else { b"AM" }),
		b'R' => strftime_into(b"%H:%M", tm, out),
		b'r' => strftime_into(b"%I:%M:%S %p", tm, out),
		b'S' => number(out, tm.second, 2, true, pad),
		b's' => out.extend_from_slice(tm.epoch.to_string().as_bytes()),
		b'T' | b'X' => strftime_into(b"%H:%M:%S", tm, out),
		b't' => out.push(b'\t'),
		b'U' => number(out, (tm.yday + 7 - tm.weekday as i64) / 7, 2, true, pad),
		b'u' => out.extend_from_slice((if tm.weekday == 0 { 7 } else { tm.weekday }).to_string().as_bytes()),
		b'V' => number(out, tm.iso_week, 2, true, pad),
		b'v' => strftime_into(b"%e-%b-%Y", tm, out),
		b'W' => {
			let monday_offset = if tm.weekday == 0 { 6 } else { tm.weekday as i64 - 1 };
			number(out, (tm.yday + 7 - monday_offset) / 7, 2, true, pad);
		},
		b'w' => out.extend_from_slice(tm.weekday.to_string().as_bytes()),
		b'Y' => year_parts(out, tm.year, true, true),
		b'y' => year_parts(out, tm.year, false, true),
		b'Z' => out.extend_from_slice(tm.zone.as_bytes()),
		b'z' => {
			out.push(if tm.offset < 0 { b'-' } else { b'+' });
			let minutes = tm.offset.abs() / 60;
			number(out, minutes / 60 * 100 + minutes % 60, 4, true, pad);
		},
		b'+' => strftime_into(b"%a %b %e %H:%M:%S %Z %Y", tm, out),
		_ => return false,
	}
	true
}

/// A padded `strftime` number: `width` digits, zero- or space-filled by
/// default, adjusted by the `-`/`_`/`0` flag.
fn number(out: &mut Vec<u8>, value: i64, width: usize, zero_default: bool, pad: Pad) {
	let _ = match pad {
		Pad::Less => write!(out, "{value}"),
		Pad::Zero => write!(out, "{value:0width$}"),
		Pad::Default if zero_default => write!(out, "{value:0width$}"),
		Pad::Default | Pad::Space => write!(out, "{value:width$}"),
	};
}

/// FreeBSD `_yconv`: the century (`top`) and/or the two-digit year (`yy`).
fn year_parts(out: &mut Vec<u8>, year: i64, top: bool, yy: bool) {
	let (a, b) = (year - 1900, 1900);
	let mut trail = a % 100 + b % 100;
	let mut lead = a / 100 + b / 100 + trail / 100;
	trail %= 100;
	if trail < 0 && lead > 0 {
		trail += 100;
		lead -= 1;
	} else if lead < 0 && trail > 0 {
		trail -= 100;
		lead += 1;
	}
	if top {
		if lead == 0 && trail < 0 {
			out.extend_from_slice(b"-0");
		} else {
			let _ = write!(out, "{lead:02}");
		}
	}
	if yy {
		let _ = write!(out, "{:02}", trail.abs());
	}
}
