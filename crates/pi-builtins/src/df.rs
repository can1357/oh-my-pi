//! `df` builtin: report file system space usage.
//!
//! Reports file system space usage: mount deduplication, FILE operands
//! resolved to the mount holding them, the column set and table layout. Block
//! sizes come from
//! the shared [`crate::block_size`], the mount table from `uucore::fsext`,
//! and usage figures from `statfs` through the shell's filesystem.

use std::{
	collections::HashMap,
	ffi::{OsStr, OsString},
	io::{self, Write},
	path::{Path, PathBuf},
};

use brush_core::{ShellExtensions, builtins::Registration};
use clap::{Arg, ArgAction, ArgMatches, Command, builder::ValueParser};
use uucore::{
	display::Quotable,
	format::human::{SizeFormat, human_readable},
	fsext::FsUsage,
};

use crate::{
	block_size::{BlockSize, Scale},
	host::{Host, Utility, format_usage, matches_parser, os_bytes_lossy, strip_errno, util},
	locale::{NumericSymbols, ctype_is_utf8, numeric_symbols},
};

mod options {
	pub const ALL: &str = "all";
	pub const BLOCK_SIZE: &str = "blocksize";
	pub const EXCLUDE_TYPE: &str = "exclude-type";
	pub const HELP: &str = "help";
	pub const HUMAN_READABLE: &str = "human-readable";
	pub const INODES: &str = "inodes";
	pub const KILO: &str = "kilo";
	pub const LOCAL: &str = "local";
	pub const MEGA: &str = "mega";
	pub const NO_SYNC: &str = "no-sync";
	pub const OUTPUT: &str = "output";
	pub const PATHS: &str = "paths";
	pub const PORTABILITY: &str = "portability";
	pub const PRINT_TYPE: &str = "print-type";
	pub const SI: &str = "si";
	pub const SYNC: &str = "sync";
	pub const TOTAL: &str = "total";
	pub const TYPE: &str = "type";
	pub const TYPE_SOLARIS: &str = "type-solaris";
	pub const IGNORED: &str = "ignored";
}

const OUTPUT_FIELDS: [&str; 12] = [
	"source", "fstype", "itotal", "iused", "iavail", "ipcent", "size", "used", "avail", "pcent",
	"file", "target",
];

/// Parsed `df` invocation.
pub(crate) struct Df {
	matches: ArgMatches,
}

matches_parser!(Df, app);

impl Utility for Df {
	const NAME: &'static str = "df";

	fn run(self, host: &mut Host) -> i32 {
		match run_df(host, &self.matches) {
			Ok(()) => host.exit_code(),
			Err(Early::Exit(code)) => code,
		}
	}
}

fn app() -> Command {
	Command::new("df")
		.version("0.8.0")
		.about(
			"Show information about the file system on which each FILE resides,\nor all file systems \
			 by default.",
		)
		.override_usage(format_usage("df [OPTION]... [FILE]..."))
		.after_help(
			"Display values are in units of the first available SIZE from --block-size,\nand the \
			 DF_BLOCK_SIZE, BLOCK_SIZE and BLOCKSIZE environment variables.\nOtherwise, units \
			 default to 1024 bytes (or 512 if POSIXLY_CORRECT is set).\n\nSIZE is an integer and \
			 optional unit (example: 10M is 10*1024*1024).\nUnits are K, M, G, T, P, E, Z, Y (powers \
			 of 1024) or KB, MB,... (powers\nof 1000).\n\nFIELD_LIST is a comma-separated list of \
			 columns to be included.  Valid\nfield names are: 'source', 'fstype', 'itotal', 'iused', \
			 'iavail', 'ipcent',\n'size', 'used', 'avail', 'pcent', 'file' and 'target' (see info \
			 page).",
		)
		.infer_long_args(true)
		.args_override_self(true)
		.disable_help_flag(true)
		.arg(
			Arg::new(options::HELP)
				.long(options::HELP)
				.help("Print help information.")
				.action(ArgAction::Help),
		)
		.arg(
			Arg::new(options::ALL)
				.short('a')
				.long("all")
				.help("include pseudo, duplicate, inaccessible file systems")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::BLOCK_SIZE)
				.short('B')
				.long("block-size")
				.value_name("SIZE")
				.help(
					"scale sizes by SIZE before printing them; e.g. '-BM' prints sizes in units of \
					 1,048,576 bytes",
				),
		)
		.arg(
			Arg::new(options::TOTAL)
				.long("total")
				.help("elide all entries insignificant to available space, and produce a grand total")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::HUMAN_READABLE)
				.short('h')
				.long("human-readable")
				.help("print sizes in powers of 1024 (e.g., 1023M)")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::SI)
				.short('H')
				.long("si")
				.help("print sizes in powers of 1000 (e.g., 1.1G)")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::INODES)
				.short('i')
				.long("inodes")
				.help("list inode information instead of block usage")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::KILO)
				.short('k')
				.help("like --block-size=1K")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::MEGA)
				.short('m')
				.hide(true)
				.help("like --block-size=1M")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::LOCAL)
				.short('l')
				.long("local")
				.help("limit listing to local file systems")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::NO_SYNC)
				.long("no-sync")
				.overrides_with_all([options::SYNC, options::NO_SYNC])
				.help("do not invoke sync before getting usage info (default)")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::OUTPUT)
				.long("output")
				.value_name("FIELD_LIST")
				.action(ArgAction::Append)
				.num_args(0..)
				.require_equals(true)
				.use_value_delimiter(true)
				.value_parser(OUTPUT_FIELDS)
				.conflicts_with_all([options::INODES, options::PORTABILITY, options::PRINT_TYPE])
				.help(
					"use the output format defined by FIELD_LIST, or print all fields if FIELD_LIST is \
					 omitted",
				),
		)
		.arg(
			Arg::new(options::PORTABILITY)
				.short('P')
				.long("portability")
				.help("use the POSIX output format")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::SYNC)
				.long("sync")
				.overrides_with_all([options::NO_SYNC, options::SYNC])
				.help("invoke sync before getting usage info")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::TYPE)
				.short('t')
				.long("type")
				.value_parser(ValueParser::os_string())
				.value_name("TYPE")
				.action(ArgAction::Append)
				.help("limit listing to file systems of type TYPE"),
		)
		.arg(
			// Solaris spelling of `-t`.
			Arg::new(options::TYPE_SOLARIS)
				.short('F')
				.hide(true)
				.value_parser(ValueParser::os_string())
				.value_name("TYPE")
				.action(ArgAction::Append),
		)
		.arg(
			Arg::new(options::PRINT_TYPE)
				.short('T')
				.long("print-type")
				.help("print file system type")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::EXCLUDE_TYPE)
				.short('x')
				.long("exclude-type")
				.action(ArgAction::Append)
				.value_parser(ValueParser::os_string())
				.value_name("TYPE")
				.help("limit listing to file systems not of type TYPE"),
		)
		.arg(
			// SysV compatibility.
			Arg::new(options::IGNORED)
				.short('v')
				.help("(ignored)")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::PATHS)
				.action(ArgAction::Append)
				.value_parser(ValueParser::os_string())
				.value_hint(clap::ValueHint::AnyPath),
		)
}

/// Creates the `df` builtin registration.
pub(crate) fn df_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Df, SE>()
}

/// The values of a repeatable option with their command-line positions.
fn indexed<'m, T: Clone + Send + Sync + 'static>(
	matches: &'m ArgMatches,
	id: &str,
) -> impl Iterator<Item = (usize, &'m T)> {
	matches
		.indices_of(id)
		.into_iter()
		.flatten()
		.zip(matches.get_many::<T>(id).into_iter().flatten())
}

/// The scaling options, the last one given winning.
const SCALES: [(&str, Scale); 5] = [
	(options::BLOCK_SIZE, Scale::Spec),
	(options::HUMAN_READABLE, Scale::Human),
	(options::SI, Scale::Si),
	(options::KILO, Scale::Kilo),
	(options::MEGA, Scale::Mega),
];

/// The `<SIZE>-blocks` header number for plain `bytes`-byte blocks: GNU
/// autoscales it in the base that divides it more evenly, drops a `.0`, and
/// spells powers of 1000 with `B` (`1K`, `1.6kB`, `512B`).
fn block_header(bytes: u64, symbols: NumericSymbols) -> String {
	let (mut q1000, mut q1024) = (bytes, bytes);
	let (mut by_1000, mut by_1024);
	loop {
		by_1000 = q1000 % 1000 == 0;
		q1000 /= 1000;
		by_1024 = q1024 % 1024 == 0;
		q1024 /= 1024;
		if !(by_1000 && by_1024) {
			break;
		}
	}
	let binary = by_1024 && !by_1000;
	let format = if binary {
		SizeFormat::Binary
	} else {
		SizeFormat::Decimal
	};
	let mut text = human_readable(bytes, format);
	if let Some(point) = text.find(".0") {
		text.replace_range(point..point + 2, "");
	}
	if !binary {
		text.push('B');
	}
	if symbols.decimal_point != b'.' {
		text = text.replace('.', char::from(symbols.decimal_point).encode_utf8(&mut [0; 4]));
	}
	text
}

/// GNU `known_value`: all-ones (and AIX's all-ones minus one) mean unknown.
const fn known(n: u64) -> bool {
	n < u64::MAX - 1
}

// ---------------------------------------------------------------------------
// Columns.
// ---------------------------------------------------------------------------

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum Field {
	Source,
	Fstype,
	Size,
	Used,
	Avail,
	Pcent,
	Itotal,
	Iused,
	Iavail,
	Ipcent,
	Target,
	File,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Kind {
	Block,
	Inode,
	Other,
}

struct FieldData {
	field:       Field,
	arg:         &'static str,
	kind:        Kind,
	caption:     &'static str,
	width:       usize,
	align_right: bool,
	used:        bool,
}

/// GNU `field_data`: names, captions, minimum widths, and alignment.
fn field_table() -> Vec<FieldData> {
	let field = |field, arg, kind, caption, width, align_right| FieldData {
		field,
		arg,
		kind,
		caption,
		width,
		align_right,
		used: false,
	};
	vec![
		field(Field::Source, "source", Kind::Other, "Filesystem", 14, false),
		field(Field::Fstype, "fstype", Kind::Other, "Type", 4, false),
		field(Field::Size, "size", Kind::Block, "blocks", 5, true),
		field(Field::Used, "used", Kind::Block, "Used", 5, true),
		field(Field::Avail, "avail", Kind::Block, "Available", 5, true),
		field(Field::Pcent, "pcent", Kind::Block, "Use%", 4, true),
		field(Field::Itotal, "itotal", Kind::Inode, "Inodes", 5, true),
		field(Field::Iused, "iused", Kind::Inode, "IUsed", 5, true),
		field(Field::Iavail, "iavail", Kind::Inode, "IFree", 5, true),
		field(Field::Ipcent, "ipcent", Kind::Inode, "IUse%", 4, true),
		field(Field::Target, "target", Kind::Other, "Mounted on", 0, false),
		field(Field::File, "file", Kind::Other, "File", 0, false),
	]
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum HeaderMode {
	Default,
	Inodes,
	Human,
	Posix,
	Output,
}

// ---------------------------------------------------------------------------
// Mount table.
// ---------------------------------------------------------------------------

/// Device number of a mount directory, filled lazily like GNU's `me_dev`.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Dev {
	Unknown,
	Known(u64),
	Failed,
}

struct Mount {
	devname:  String,
	mountdir: OsString,
	mntroot:  Option<OsString>,
	fstype:   String,
	dummy:    bool,
	remote:   bool,
	dev:      Dev,
}

/// gnulib `ME_DUMMY_0` types.
#[cfg(unix)]
const DUMMY_TYPES: [&str; 12] = [
	"autofs",
	"proc",
	"subfs",
	"debugfs",
	"devpts",
	"fusectl",
	"fuse.portal",
	"mqueue",
	"rpc_pipefs",
	"sysfs",
	"devfs",
	"kernfs",
];

/// gnulib `is_remote_fs_type_name`.
#[cfg(unix)]
const REMOTE_TYPES: [&str; 30] = [
	"acfs",
	"afs",
	"autofs",
	"auristorfs",
	"cachefs",
	"ceph",
	"cifs",
	"coda",
	"fhgfs",
	"gfs",
	"gfs2",
	"gpfs",
	"ibrix",
	"lustre",
	"ncpfs",
	"netfs",
	"nfs",
	"nfs3",
	"nfs4",
	"ocfs2",
	"panfs",
	"smb",
	"smb2",
	"smb3",
	"smbfs",
	"snfs",
	"stnfs",
	"userlandfs",
	"vxfs",
	"websearchfs",
];

/// Decodes the `\NNN` octal escapes of `/proc/self/mountinfo` (gnulib
/// `unescape_tab`).
#[cfg(any(target_os = "linux", target_os = "android"))]
fn unescape_octal(text: &str) -> String {
	let bytes = text.as_bytes();
	let mut out = Vec::with_capacity(bytes.len());
	let mut i = 0;
	while i < bytes.len() {
		if bytes[i] == b'\\'
			&& i + 4 <= bytes.len()
			&& bytes[i + 1..i + 4]
				.iter()
				.all(|b| (b'0'..=b'7').contains(b))
		{
			let value = bytes[i + 1..i + 4]
				.iter()
				.fold(0u32, |acc, b| acc * 8 + u32::from(b - b'0'));
			out.push(value as u8);
			i += 4;
		} else {
			out.push(bytes[i]);
			i += 1;
		}
	}
	String::from_utf8_lossy(&out).into_owned()
}

/// Reads the mount table; `Err` carries the error text, if any, for GNU's
/// "cannot read table of mounted file systems" diagnostic. An empty table
/// counts as unreadable, as in GNU.
fn read_mounts() -> Result<Vec<Mount>, Option<String>> {
	#[cfg(not(target_os = "wasi"))]
	let list = uucore::fsext::read_fs_list().map_err(|error| {
		let mut text = error.to_string();
		if let Some(position) = text.find(" (os error ") {
			text.truncate(position);
		}
		Some(text)
	})?;
	#[cfg(target_os = "wasi")]
	let list = uucore::fsext::read_fs_list();
	if list.is_empty() {
		return Err(None);
	}
	Ok(list
		.into_iter()
		.map(|info| {
			// Windows volumes report their path as the mount root.
			let (mountdir, mntroot) = if info.mount_dir.is_empty() {
				(info.mount_root.clone(), None)
			} else {
				let root = (!info.mount_root.is_empty()).then(|| info.mount_root.clone());
				(info.mount_dir.clone(), root)
			};
			#[cfg(any(target_os = "linux", target_os = "android"))]
			let devname = unescape_octal(&info.dev_name);
			#[cfg(not(any(target_os = "linux", target_os = "android")))]
			let devname = info.dev_name.clone();
			#[cfg(unix)]
			let (dummy, remote) = {
				// Only static mtab entries carry a usable "bind" option.
				let bind =
					mntroot.is_none() && info.mount_option.split(',').any(|option| option == "bind");
				let fstype = info.fs_type.as_str();
				(
					DUMMY_TYPES.contains(&fstype) || (fstype == "none" && !bind),
					devname.contains(':') || devname == "-hosts" || REMOTE_TYPES.contains(&fstype),
				)
			};
			#[cfg(not(unix))]
			let (dummy, remote) = (info.dummy, info.remote);
			Mount {
				devname,
				mountdir,
				mntroot,
				fstype: info.fs_type,
				dummy,
				remote,
				dev: Dev::Unknown,
			}
		})
		.collect())
}

/// GNU's `devlist`: the surviving mount per device, with chains of earlier
/// entries for the same device.
#[derive(Default)]
struct DevList {
	/// `(mount index, previous entry for the same device)`.
	entries: Vec<(usize, Option<usize>)>,
	/// Latest entry per device (`seen_last`).
	last:    HashMap<Option<u64>, usize>,
}

// ---------------------------------------------------------------------------
// Running.
// ---------------------------------------------------------------------------

/// What `stat` reported for an operand or directory.
#[derive(Clone, Copy)]
struct Stat {
	dev:    u64,
	ino:    u64,
	is_dir: bool,
	is_dev: bool,
}

fn stat_path(host: &Host, path: &Path) -> io::Result<Stat> {
	let meta = host.fs().metadata(path)?;
	let file_type = meta.file_type();
	Ok(Stat {
		dev:    meta.dev().unwrap_or(0),
		ino:    meta.ino().unwrap_or(0),
		is_dir: meta.is_dir(),
		is_dev: file_type.is_block_device() || file_type.is_char_device(),
	})
}

/// Whether `error` is `errno` (Unix) or of `kind` (elsewhere).
fn is_errno(error: &io::Error, kind: io::ErrorKind, errno: i32) -> bool {
	if cfg!(unix) {
		error.raw_os_error() == Some(errno)
	} else {
		error.kind() == kind
	}
}

#[cfg(unix)]
const EACCES: i32 = libc::EACCES;
#[cfg(not(unix))]
const EACCES: i32 = 0;
#[cfg(unix)]
const ENOENT: i32 = libc::ENOENT;
#[cfg(not(unix))]
const ENOENT: i32 = 0;

/// Usage of the file system holding `path`, as gnulib `get_fs_usage`.
fn fs_usage(host: &Host, path: &Path) -> io::Result<FsUsage> {
	let stats = host.fs().stat_fs(path)?;
	// gnulib uses `statvfs` (fragment size) except on Darwin, where it uses
	// `statfs` because `statvfs` truncates block counts to 32 bits.
	#[cfg(all(unix, not(target_vendor = "apple")))]
	let blocksize = if stats.io_size != 0 {
		stats.io_size
	} else {
		stats.block_size
	};
	#[cfg(not(all(unix, not(target_vendor = "apple"))))]
	let blocksize = stats.block_size;
	Ok(FsUsage {
		blocksize,
		blocks: stats.blocks,
		bfree: stats.blocks_free,
		bavail: stats.blocks_available,
		bavail_top_bit_set: stats.blocks_available >> 63 != 0,
		files: stats.files,
		ffree: stats.files_free,
	})
}

const fn unknown_usage() -> FsUsage {
	FsUsage {
		blocksize:          u64::MAX,
		blocks:             u64::MAX,
		bfree:              u64::MAX,
		bavail:             u64::MAX,
		bavail_top_bit_set: false,
		files:              u64::MAX,
		ffree:              u64::MAX,
	}
}

/// `strerror` text for `error`. Errors from virtual filesystem providers
/// carry no errno; they get the text of the errno their kind stands for.
fn error_text(error: &io::Error) -> String {
	if error.raw_os_error().is_none() {
		match error.kind() {
			io::ErrorKind::NotFound => return "No such file or directory".to_owned(),
			io::ErrorKind::PermissionDenied => return "Permission denied".to_owned(),
			io::ErrorKind::Unsupported => return "Operation not supported".to_owned(),
			_ => {},
		}
	}
	strip_errno(error)
}

fn is_absolute(path: &OsStr) -> bool {
	Path::new(path).is_absolute()
}

fn is_separator(byte: u8) -> bool {
	byte == b'/' || (cfg!(windows) && byte == b'\\')
}

/// GNU `has_uuid_suffix`.
fn has_uuid_suffix(name: &str) -> bool {
	let bytes = name.as_bytes();
	bytes.len() > 36
		&& bytes[bytes.len() - 36..]
			.iter()
			.all(|b| b.is_ascii_hexdigit() || *b == b'-')
}

/// GNU's `field_values_t`.
struct Values {
	/// Bytes per counted unit (1 for inodes).
	units:             u64,
	total:             u64,
	available:         u64,
	negate_available:  bool,
	available_to_root: u64,
	used:              u64,
	negate_used:       bool,
}

/// GNU `get_field_values`: `(blocks, inodes)`.
fn field_values(fsu: &FsUsage) -> (Values, Values) {
	let used = |total: u64, root: u64| {
		if known(total) && known(root) {
			(total.wrapping_sub(root), total < root)
		} else {
			(u64::MAX, false)
		}
	};
	let (iused, inegate) = used(fsu.files, fsu.ffree);
	let inodes = Values {
		units:             1,
		total:             fsu.files,
		available:         fsu.ffree,
		negate_available:  false,
		available_to_root: fsu.ffree,
		used:              iused,
		negate_used:       inegate,
	};
	let (bused, bnegate) = used(fsu.blocks, fsu.bfree);
	let blocks = Values {
		units:             fsu.blocksize,
		total:             fsu.blocks,
		available:         fsu.bavail,
		negate_available:  fsu.bavail_top_bit_set && known(fsu.bavail),
		available_to_root: fsu.bfree,
		used:              bused,
		negate_used:       bnegate,
	};
	(blocks, inodes)
}

/// GNU `add_uint_with_neg_flag`.
fn add_with_neg_flag(dest: &mut u64, dest_neg: &mut bool, mut src: u64, src_neg: bool) {
	if *dest_neg == src_neg {
		*dest = dest.wrapping_add(src);
		return;
	}
	if *dest_neg {
		*dest = dest.wrapping_neg();
	}
	if src_neg {
		src = src.wrapping_neg();
	}
	if src < *dest {
		*dest -= src;
	} else {
		*dest = src - *dest;
		*dest_neg = src_neg;
	}
	if *dest_neg {
		*dest = dest.wrapping_neg();
	}
}

/// GNU's percentage column: used / (used + available), rounded up.
fn percent(v: &Values) -> Vec<u8> {
	let mut pct = -1.0f64;
	let sum = v.used.wrapping_add(v.available);
	if !known(v.used) || !known(v.available) {
	} else if !v.negate_used
		&& v.used <= u64::MAX / 100
		&& sum != 0
		&& (sum < v.used) == v.negate_available
	{
		let u100 = v.used * 100;
		pct = (u100 / sum + u64::from(u100 % sum != 0)) as f64;
	} else {
		let u = if v.negate_used {
			-(v.used.wrapping_neg() as f64)
		} else {
			v.used as f64
		};
		let a = if v.negate_available {
			-(v.available.wrapping_neg() as f64)
		} else {
			v.available as f64
		};
		let nonroot_total = u + a;
		if nonroot_total != 0.0 {
			pct = u * 100.0 / nonroot_total;
			let ipct = (pct as i64) as f64;
			if ipct - 1.0 < pct && pct <= ipct + 1.0 {
				pct = ipct + f64::from(u8::from(ipct < pct));
			}
		}
	}
	if pct < 0.0 {
		b"-".to_vec()
	} else {
		format!("{pct:.0}%").into_bytes()
	}
}

/// GNU `replace_problematic_chars`: on a terminal, invalid or control
/// characters become `?`; otherwise only ASCII control bytes do. `utf8` is
/// whether the LC_CTYPE locale is UTF-8; elsewhere non-ASCII bytes do not
/// decode.
fn replace_problematic(cell: &[u8], tty: bool, utf8: bool) -> Vec<u8> {
	if !tty || !utf8 {
		return cell
			.iter()
			.map(|&b| {
				if b < 0x20 || b == 0x7f || (tty && b >= 0x80) {
					b'?'
				} else {
					b
				}
			})
			.collect();
	}
	let mut out = Vec::with_capacity(cell.len());
	for chunk in cell.utf8_chunks() {
		for c in chunk.valid().chars() {
			if c.is_control() {
				out.push(b'?');
			} else {
				let mut buf = [0; 4];
				out.extend_from_slice(c.encode_utf8(&mut buf).as_bytes());
			}
		}
		out.extend(std::iter::repeat_n(b'?', chunk.invalid().len()));
	}
	out
}

/// gnulib `mbswidth` with `MBSW_REJECT_INVALID | MBSW_REJECT_UNPRINTABLE`:
/// `None` when the cell holds invalid or unprintable characters, which then
/// neither widen their column nor get padded.
fn mbswidth(cell: &[u8], utf8: bool) -> Option<usize> {
	if !utf8 {
		return cell
			.iter()
			.all(|&b| (0x20..0x7f).contains(&b))
			.then_some(cell.len());
	}
	let mut width = 0;
	for chunk in cell.utf8_chunks() {
		if !chunk.invalid().is_empty() {
			return None;
		}
		for c in chunk.valid().chars() {
			if c.is_control() {
				return None;
			}
			width += xutf::width_char(c);
		}
	}
	Some(width)
}

/// Arguments of GNU `get_dev`.
struct DevArgs {
	device:      Option<String>,
	mount_point: OsString,
	file:        Option<OsString>,
	/// `stat_file`: the name for diagnostics and the resolved path to query.
	stat_file:   Option<(OsString, PathBuf)>,
	fstype:      Option<String>,
	dummy:       bool,
	remote:      bool,
}

struct DfState {
	show_all:     bool,
	show_local:   bool,
	show_listed:  bool,
	block_size:   BlockSize,
	print_type:   bool,
	print_total:  bool,
	require_sync: bool,
	header_mode:  HeaderMode,
	select:       Vec<Vec<u8>>,
	exclude:      Vec<Vec<u8>>,
	fields:       Vec<FieldData>,
	columns:      Vec<usize>,
	table:        Vec<Vec<Vec<u8>>>,
	mounts:       Vec<Mount>,
	devlist:      Option<DevList>,
	processed:    bool,
	grand:        FsUsage,
	tty:          bool,
	utf8:         bool,
	symbols:      NumericSymbols,
}

/// How option parsing ended when it did not reach the operands.
enum Early {
	Exit(i32),
}

impl DfState {
	fn new(host: &Host) -> Self {
		Self {
			show_all:     false,
			show_local:   false,
			show_listed:  false,
			block_size:   BlockSize::default_for(host),
			print_type:   false,
			print_total:  false,
			require_sync: false,
			header_mode:  HeaderMode::Default,
			select:       Vec::new(),
			exclude:      Vec::new(),
			fields:       field_table(),
			columns:      Vec::new(),
			table:        Vec::new(),
			mounts:       Vec::new(),
			devlist:      None,
			processed:    false,
			grand:        FsUsage {
				blocksize:          1,
				blocks:             0,
				bfree:              0,
				bavail:             0,
				bavail_top_bit_set: false,
				files:              0,
				ffree:              0,
			},
			tty:          host.stdout.is_terminal(),
			utf8:         ctype_is_utf8(host),
			symbols:      numeric_symbols(host),
		}
	}

	fn field_index(&self, field: Field) -> usize {
		self
			.fields
			.iter()
			.position(|data| data.field == field)
			.unwrap_or(0)
	}

	fn alloc_field(&mut self, field: Field, caption: Option<&'static str>) {
		let index = self.field_index(field);
		if let Some(caption) = caption {
			self.fields[index].caption = caption;
		}
		self.fields[index].used = true;
		self.columns.push(index);
	}

	/// Adds one `--output` field; GNU rejects a field named twice.
	fn add_output_field(&mut self, host: &mut Host, name: &str) -> Result<(), Early> {
		let Some(index) = self.fields.iter().position(|data| data.arg == name) else {
			return Ok(());
		};
		if self.fields[index].used {
			let message = format!("option --output: field {} used more than once", name.quote());
			return Err(Early::Exit(host.usage_error(message, 1)));
		}
		let field = self.fields[index].field;
		let caption = match field {
			Field::Size => Some("Size"),
			Field::Avail => Some("Avail"),
			_ => None,
		};
		self.alloc_field(field, caption);
		Ok(())
	}

	/// GNU `get_field_list`.
	fn field_list(&mut self, host: &mut Host) -> Result<(), Early> {
		let type_field = |state: &mut Self| {
			if state.print_type {
				state.alloc_field(Field::Fstype, None);
			}
		};
		match self.header_mode {
			HeaderMode::Default | HeaderMode::Human | HeaderMode::Posix => {
				let human = self.header_mode == HeaderMode::Human;
				let posix = self.header_mode == HeaderMode::Posix;
				self.alloc_field(Field::Source, None);
				type_field(self);
				self.alloc_field(Field::Size, human.then_some("Size"));
				self.alloc_field(Field::Used, None);
				self.alloc_field(Field::Avail, human.then_some("Avail"));
				self.alloc_field(Field::Pcent, posix.then_some("Capacity"));
				self.alloc_field(Field::Target, None);
			},
			HeaderMode::Inodes => {
				self.alloc_field(Field::Source, None);
				type_field(self);
				self.alloc_field(Field::Itotal, None);
				self.alloc_field(Field::Iused, None);
				self.alloc_field(Field::Iavail, None);
				self.alloc_field(Field::Ipcent, None);
				self.alloc_field(Field::Target, None);
			},
			HeaderMode::Output => {
				if self.columns.is_empty() {
					for name in OUTPUT_FIELDS {
						self.add_output_field(host, name)?;
					}
				}
			},
		}
		Ok(())
	}

	/// GNU `get_header`.
	fn header(&mut self) {
		let mut row = Vec::with_capacity(self.columns.len());
		for &index in &self.columns {
			let data = &self.fields[index];
			let cell = if data.field == Field::Size
				&& (self.header_mode == HeaderMode::Default
					|| (self.header_mode == HeaderMode::Output && !self.block_size.is_human()))
			{
				// A unit-only spec (`-BKiB`) names its unit; otherwise autoscale.
				let size = self.block_size;
				let unit = size.format(size.bytes(), self.symbols);
				let mut cell = if unit == "1" {
					block_header(size.bytes(), self.symbols)
				} else {
					unit
				}
				.into_bytes();
				cell.extend_from_slice(b"-blocks");
				cell
			} else if self.header_mode == HeaderMode::Posix && data.field == Field::Size {
				format!("{}-{}", self.block_size.bytes(), data.caption).into_bytes()
			} else {
				data.caption.as_bytes().to_vec()
			};
			let cell = replace_problematic(&cell, self.tty, self.utf8);
			if let Some(width) = mbswidth(&cell, self.utf8) {
				self.fields[index].width = self.fields[index].width.max(width);
			}
			row.push(cell);
		}
		self.table.push(row);
	}

	fn selected(&self, fstype: Option<&str>) -> bool {
		match fstype {
			Some(fstype) if !self.select.is_empty() => self
				.select
				.iter()
				.any(|name| name.as_slice() == fstype.as_bytes()),
			_ => true,
		}
	}

	fn excluded(&self, fstype: Option<&str>) -> bool {
		fstype.is_some_and(|fstype| {
			self
				.exclude
				.iter()
				.any(|name| name.as_slice() == fstype.as_bytes())
		})
	}

	/// Device number of `mount`'s directory, statting it on first use.
	fn mount_dev(&mut self, host: &mut Host, index: usize, report_eio: bool) -> Dev {
		if self.mounts[index].dev == Dev::Unknown {
			let path = PathBuf::from(&self.mounts[index].mountdir);
			self.mounts[index].dev = match stat_path(host, &path) {
				Ok(stat) => Dev::Known(stat.dev),
				Err(error) => {
					// Only I/O errors: others are typically shadowed mounts.
					#[cfg(unix)]
					if report_eio && error.raw_os_error() == Some(libc::EIO) {
						host.error(
							format!(
								"{}: {}",
								self.mounts[index].mountdir.maybe_quote(),
								error_text(&error)
							),
							1,
						);
					}
					#[cfg(not(unix))]
					let _ = (report_eio, error);
					Dev::Failed
				},
			};
		}
		self.mounts[index].dev
	}

	/// GNU `filter_mount_list`: returns the mount order to list. With
	/// `devices_only` (`-a`) every mount stays and the device table is kept
	/// for `me_for_dev`.
	fn filter_mount_list(&mut self, host: &mut Host, devices_only: bool) -> Vec<usize> {
		let mut list = DevList::default();
		for index in 0..self.mounts.len() {
			let me = &self.mounts[index];
			let filtered = (me.remote && self.show_local)
				|| (me.dummy && !self.show_all && !self.show_listed)
				|| !self.selected(Some(&me.fstype))
				|| self.excluded(Some(&me.fstype));
			let stat = if filtered {
				None
			} else {
				stat_path(host, Path::new(&me.mountdir)).ok()
			};
			let mut discard = false;
			let (dev, last_seen) = match stat {
				None => {
					let dev = match me.dev {
						Dev::Known(dev) => Some(dev),
						_ => None,
					};
					(dev, None)
				},
				Some(stat) => {
					let last_seen = list.last.get(&Some(stat.dev)).copied();
					let mut seen = last_seen;
					while let Some(slot) = seen
						&& !discard
					{
						let (seen_index, next_same) = list.entries[slot];
						let seen_me = &self.mounts[seen_index];
						let me = &self.mounts[index];
						let target_nearer_root = seen_me.mountdir.len() > me.mountdir.len();
						let source_below_root = match (&seen_me.mntroot, &me.mntroot) {
							(Some(seen_root), Some(root)) => seen_root.len() < root.len(),
							_ => false,
						};
						if !self.print_total
							&& me.remote && seen_me.remote
							&& seen_me.devname != me.devname
						{
							// Remote entries with different locations stay.
						} else if (me.devname.contains('/') && !seen_me.devname.contains('/'))
							|| (target_nearer_root && !source_below_root)
							|| (seen_me.devname != me.devname && me.mountdir == seen_me.mountdir)
						{
							// This entry replaces the one seen for the device.
							list.entries[slot].0 = index;
							discard = true;
						} else {
							discard = true;
						}
						seen = next_same;
					}
					(Some(stat.dev), last_seen)
				},
			};
			if !discard {
				list.entries.push((index, last_seen));
				list.last.insert(dev, list.entries.len() - 1);
			}
		}
		if devices_only {
			let order = (0..self.mounts.len()).collect();
			self.devlist = Some(list);
			order
		} else {
			list.entries.iter().map(|&(index, _)| index).collect()
		}
	}

	/// GNU `me_for_dev`.
	fn me_for_dev(&self, dev: u64) -> Option<&Mount> {
		let list = self.devlist.as_ref()?;
		let &slot = list.last.get(&Some(dev))?;
		Some(&self.mounts[list.entries[slot].0])
	}

	/// GNU `get_dev`.
	fn get_dev(
		&mut self,
		host: &mut Host,
		args: DevArgs,
		force: Option<FsUsage>,
		process_all: bool,
	) {
		if args.remote && self.show_local {
			return;
		}
		if args.dummy && !self.show_all && !self.show_listed {
			return;
		}
		if !self.selected(args.fstype.as_deref()) || self.excluded(args.fstype.as_deref()) {
			return;
		}
		if force.is_none() && !is_absolute(&args.mount_point) {
			return;
		}
		let (stat_name, stat_file) = args
			.stat_file
			.clone()
			.unwrap_or_else(|| (args.mount_point.clone(), PathBuf::from(&args.mount_point)));
		let mut fstype = args.fstype.clone();
		let forced = force.is_some();
		let fsu = match force {
			Some(fsu) => fsu,
			None => match fs_usage(host, &stat_file) {
				Ok(fsu) => {
					let mut fsu = fsu;
					if process_all && self.show_all {
						// Discard stats of over-mounted directories.
						if let Ok(stat) = stat_path(host, &stat_file)
							&& let Some(dev_me) = self.me_for_dev(stat.dev)
							&& Some(dev_me.devname.as_str()) != args.device.as_deref()
							&& (!dev_me.remote || !args.remote)
						{
							fstype = Some("-".to_owned());
							fsu = unknown_usage();
						}
					}
					fsu
				},
				Err(error) => {
					if process_all
						&& (is_errno(&error, io::ErrorKind::PermissionDenied, EACCES)
							|| is_errno(&error, io::ErrorKind::NotFound, ENOENT))
					{
						if !self.show_all {
							return;
						}
						fstype = Some("-".to_owned());
						unknown_usage()
					} else {
						host.error(format!("{}: {}", stat_name.maybe_quote(), error_text(&error)), 1);
						return;
					}
				},
			},
		};
		if fsu.blocks == 0 && !self.show_all && !self.show_listed {
			return;
		}
		if !forced {
			self.processed = true;
		}

		let mut dev_name = args
			.device
			.clone()
			.unwrap_or_else(|| "-".to_owned())
			.into_bytes();
		if process_all
			&& has_uuid_suffix(&String::from_utf8_lossy(&dev_name))
			&& let Ok(resolved) = host
				.fs()
				.canonicalize(host.resolve(OsStr::new(&*String::from_utf8_lossy(&dev_name))))
		{
			dev_name = os_bytes_lossy(resolved.as_os_str()).into_owned();
		}
		let fstype = fstype.unwrap_or_else(|| "-".to_owned());
		let file = args.file.clone().unwrap_or_else(|| OsString::from("-"));

		let (blocks, inodes) = field_values(&fsu);
		if self.print_total && !forced {
			self.add_to_grand_total(&blocks, &inodes);
		}

		let mut row = Vec::with_capacity(self.columns.len());
		for col in 0..self.columns.len() {
			let index = self.columns[col];
			let values = match self.fields[index].kind {
				Kind::Block => Some(&blocks),
				Kind::Inode => Some(&inodes),
				Kind::Other => None,
			};
			let readable = |negative: bool, n: u64| -> Vec<u8> {
				let v = values.expect("numeric column");
				if !known(n) && !negative {
					return b"-".to_vec();
				}
				let magnitude = if negative { n.wrapping_neg() } else { n };
				let mut cell = if negative { b"-".to_vec() } else { Vec::new() };
				// Inode counts are scaled only by -h/-H.
				let size = if self.fields[index].kind == Kind::Inode {
					self.block_size.with_bytes(1)
				} else {
					self.block_size
				};
				cell.extend(
					size
						.format(magnitude.saturating_mul(v.units), self.symbols)
						.into_bytes(),
				);
				cell
			};
			let cell = match self.fields[index].field {
				Field::Source => dev_name.clone(),
				Field::Fstype => fstype.clone().into_bytes(),
				Field::Size | Field::Itotal => readable(false, values.map_or(0, |v| v.total)),
				Field::Used | Field::Iused => {
					let v = values.expect("numeric column");
					readable(v.negate_used, v.used)
				},
				Field::Avail | Field::Iavail => {
					let v = values.expect("numeric column");
					readable(v.negate_available, v.available)
				},
				Field::Pcent | Field::Ipcent => percent(values.expect("numeric column")),
				Field::File => os_bytes_lossy(&file).into_owned(),
				Field::Target => os_bytes_lossy(&args.mount_point).into_owned(),
			};
			let cell = replace_problematic(&cell, self.tty, self.utf8);
			if let Some(width) = mbswidth(&cell, self.utf8) {
				self.fields[index].width = self.fields[index].width.max(width);
			}
			row.push(cell);
		}
		self.table.push(row);
	}

	/// GNU `add_to_grand_total`.
	fn add_to_grand_total(&mut self, blocks: &Values, inodes: &Values) {
		let grand = &mut self.grand;
		if known(inodes.total) {
			grand.files = grand.files.wrapping_add(inodes.total);
		}
		if known(inodes.available) {
			grand.ffree = grand.ffree.wrapping_add(inodes.available);
		}
		if known(blocks.total) {
			grand.blocks = grand
				.blocks
				.wrapping_add(blocks.units.wrapping_mul(blocks.total));
		}
		if known(blocks.available_to_root) {
			grand.bfree = grand
				.bfree
				.wrapping_add(blocks.units.wrapping_mul(blocks.available_to_root));
		}
		if known(blocks.available) {
			add_with_neg_flag(
				&mut grand.bavail,
				&mut grand.bavail_top_bit_set,
				blocks.units.wrapping_mul(blocks.available),
				blocks.negate_available,
			);
		}
	}

	fn mount_args(&self, index: usize) -> DevArgs {
		let me = &self.mounts[index];
		DevArgs {
			device:      Some(me.devname.clone()),
			mount_point: me.mountdir.clone(),
			file:        None,
			stat_file:   None,
			fstype:      Some(me.fstype.clone()),
			dummy:       me.dummy,
			remote:      me.remote,
		}
	}

	/// GNU `get_all_entries`.
	fn all_entries(&mut self, host: &mut Host) {
		let order = self.filter_mount_list(host, self.show_all);
		for index in order {
			if host.is_cancelled() {
				return;
			}
			let args = self.mount_args(index);
			self.get_dev(host, args, None, true);
		}
	}

	/// `canonicalize_file_name` of each mount's device name, kept only when
	/// absolute.
	fn canonical_devnames(&self, host: &Host) -> Vec<Vec<u8>> {
		self
			.mounts
			.iter()
			.map(|me| match host.fs().canonicalize(host.resolve(&me.devname)) {
				Ok(canonical) if canonical.is_absolute() => {
					os_bytes_lossy(canonical.as_os_str()).into_owned()
				},
				_ => me.devname.as_bytes().to_vec(),
			})
			.collect()
	}

	/// GNU `get_device`: lists the mount of device node `name`, if mounted.
	fn get_device(&mut self, host: &mut Host, name: &OsStr, resolved: &Path) -> bool {
		let device = match host.fs().canonicalize(resolved) {
			Ok(canonical) if canonical.is_absolute() => canonical,
			_ => resolved.to_path_buf(),
		};
		let device = os_bytes_lossy(device.as_os_str()).into_owned();
		let canonical = self.canonical_devnames(host);
		let mut best = None;
		let mut best_accessible = false;
		let mut eclipsed = false;
		let mut best_len = usize::MAX;
		for index in 0..self.mounts.len() {
			if canonical[index] != device {
				continue;
			}
			let mountdir = &self.mounts[index].mountdir;
			let last = self.mounts.iter().rposition(|me| &me.mountdir == mountdir);
			eclipsed = last.is_some_and(|last| canonical[last] != canonical[index]);
			let len = mountdir.len();
			if !eclipsed && (!best_accessible || len < best_len) {
				let accessible = stat_path(host, Path::new(mountdir)).is_ok();
				if accessible {
					best_accessible = true;
				}
				if accessible || (!best_accessible && len < best_len) {
					best = Some(index);
					if len == 1 {
						break;
					}
					best_len = len;
				}
			}
		}
		if let Some(index) = best {
			let mut args = self.mount_args(index);
			args.file = Some(name.to_os_string());
			self.get_dev(host, args, None, false);
			true
		} else if eclipsed {
			host.error(format!("cannot access {}: over-mounted by another device", name.quote()), 1);
			true
		} else {
			false
		}
	}

	/// GNU `get_point`: lists the mount holding `name`.
	fn get_point(&mut self, host: &mut Host, name: &OsStr, resolved: &Path, stat: Stat) {
		let mut best: Option<usize> = None;
		if let Ok(canonical) = host.fs().canonicalize(resolved)
			&& canonical.is_absolute()
		{
			let canonical = os_bytes_lossy(canonical.as_os_str()).into_owned();
			let mut best_len = 0;
			for (index, me) in self.mounts.iter().enumerate() {
				if me.fstype == "lofs" || !(best.is_none_or(|b| self.mounts[b].dummy) || !me.dummy) {
					continue;
				}
				let dir = os_bytes_lossy(&me.mountdir);
				let len = dir.len();
				if best_len <= len
					&& len <= canonical.len()
					&& (len == 1
						|| ((len == canonical.len() || is_separator(canonical[len]))
							&& canonical[..len] == dir[..]))
				{
					best = Some(index);
					best_len = len;
				}
			}
		}
		if let Some(index) = best
			&& stat_path(host, Path::new(&self.mounts[index].mountdir))
				.map(|s| s.dev)
				.ok() != Some(stat.dev)
		{
			best = None;
		}
		if best.is_none() {
			for index in 0..self.mounts.len() {
				let dev = self.mount_dev(host, index, true);
				let me = &self.mounts[index];
				if dev == Dev::Known(stat.dev)
					&& me.fstype != "lofs"
					&& (best.is_none_or(|b| self.mounts[b].dummy) || !me.dummy)
				{
					// Skip bogus mtab entries.
					match stat_path(host, Path::new(&me.mountdir)) {
						Ok(s) if Dev::Known(s.dev) == dev => best = Some(index),
						_ => self.mounts[index].dev = Dev::Failed,
					}
				}
			}
		}
		if let Some(index) = best {
			let mut args = self.mount_args(index);
			args.file = Some(name.to_os_string());
			args.stat_file = Some((name.to_os_string(), resolved.to_path_buf()));
			self.get_dev(host, args, None, false);
		} else if let Some(mount_point) = find_mount_point(host, name, resolved, stat) {
			let args = DevArgs {
				device:      None,
				mount_point: mount_point.into_os_string(),
				file:        Some(name.to_os_string()),
				stat_file:   None,
				fstype:      None,
				dummy:       false,
				remote:      false,
			};
			self.get_dev(host, args, None, false);
		}
	}

	/// GNU `print_table`.
	fn print_table(&self, out: &mut impl Write) -> io::Result<()> {
		for row in &self.table {
			let mut line = Vec::new();
			for (col, cell) in row.iter().enumerate() {
				let data = &self.fields[self.columns[col]];
				if col != 0 {
					line.push(b' ');
				}
				let mut fill =
					mbswidth(cell, self.utf8).map_or(0, |width| data.width.saturating_sub(width));
				if data.align_right {
					line.extend(std::iter::repeat_n(b' ', fill));
					fill = 0;
				}
				line.extend_from_slice(cell);
				if col + 1 < row.len() {
					line.extend(std::iter::repeat_n(b' ', fill));
				}
			}
			line.push(b'\n');
			out.write_all(&line)?;
		}
		Ok(())
	}
}

/// gnulib `find_mount_point`: walks up from `name` (or its directory) while
/// the device stays the same.
fn find_mount_point(host: &mut Host, name: &OsStr, resolved: &Path, stat: Stat) -> Option<PathBuf> {
	let (start, last) = if stat.is_dir {
		match host.fs().canonicalize(resolved) {
			Ok(dir) => (dir, stat),
			Err(error) => {
				host.error(
					format!("cannot change to directory {}: {}", name.quote(), error_text(&error)),
					1,
				);
				return None;
			},
		}
	} else {
		let parent = resolved.parent().unwrap_or(resolved);
		let dir = host.fs().canonicalize(parent).and_then(|dir| {
			let stat = stat_path(host, &dir)?;
			Ok((dir, stat))
		});
		match dir {
			Ok(found) => found,
			Err(error) => {
				host.error(
					format!(
						"cannot change to directory {}: {}",
						parent.as_os_str().quote(),
						error_text(&error)
					),
					1,
				);
				return None;
			},
		}
	};
	let mut current = start;
	let mut last = last;
	loop {
		let parent = current.parent().unwrap_or(&current).to_path_buf();
		let parent_stat = match stat_path(host, &parent) {
			Ok(stat) => stat,
			Err(error) => {
				host.error(format!("cannot stat {}: {}", "..".quote(), error_text(&error)), 1);
				return None;
			},
		};
		if parent_stat.dev != last.dev || parent_stat.ino == last.ino {
			return Some(current);
		}
		current = parent;
		last = parent_stat;
	}
}

/// The body of `df`, following GNU `main`.
fn run_df(host: &mut Host, matches: &ArgMatches) -> Result<(), Early> {
	let mut state = DfState::new(host);
	state.show_all = matches.get_flag(options::ALL);
	state.show_local = matches.get_flag(options::LOCAL);
	state.print_type = matches.get_flag(options::PRINT_TYPE);
	state.print_total = matches.get_flag(options::TOTAL);
	state.require_sync = matches.get_flag(options::SYNC);
	let posix_format = matches.get_flag(options::PORTABILITY);
	let bytes = |value: &OsString| os_bytes_lossy(value).into_owned();
	// `-t` and `-F` share one list, kept in command-line order.
	let mut select: Vec<(usize, &OsString)> = indexed(matches, options::TYPE)
		.chain(indexed(matches, options::TYPE_SOLARIS))
		.collect();
	select.sort_by_key(|(index, _)| *index);
	state.select = select.into_iter().map(|(_, name)| bytes(name)).collect();
	state.exclude = matches
		.get_many::<OsString>(options::EXCLUDE_TYPE)
		.into_iter()
		.flatten()
		.map(bytes)
		.collect();

	if matches.get_flag(options::INODES) {
		state.header_mode = HeaderMode::Inodes;
	}
	if matches.contains_id(options::OUTPUT) {
		state.header_mode = HeaderMode::Output;
		let fields: Vec<&String> = matches
			.get_many::<String>(options::OUTPUT)
			.into_iter()
			.flatten()
			.collect();
		for field in fields {
			state.add_output_field(host, field)?;
		}
	}

	let scaled = SCALES
		.iter()
		.any(|(id, _)| matches.value_source(id) == Some(clap::parser::ValueSource::CommandLine));
	state.block_size = if posix_format && !scaled {
		BlockSize::default_for(host)
	} else {
		match BlockSize::from_matches(matches, &SCALES, host, "DF_BLOCK_SIZE") {
			Ok(size) => size,
			Err((error, spec)) => {
				host.error(error.message("--block-size", &spec), 1);
				return Err(Early::Exit(1));
			},
		}
	};
	let operands: Vec<OsString> = matches
		.get_many::<OsString>(options::PATHS)
		.into_iter()
		.flatten()
		.cloned()
		.collect();

	if matches!(state.header_mode, HeaderMode::Inodes | HeaderMode::Output) {
	} else if state.block_size.is_human() {
		state.header_mode = HeaderMode::Human;
	} else if posix_format {
		state.header_mode = HeaderMode::Posix;
	}

	// GNU keeps both lists newest first.
	let mut both = false;
	for included in state.select.iter().rev() {
		if state
			.exclude
			.iter()
			.rev()
			.any(|excluded| excluded == included)
		{
			let name = String::from_utf8_lossy(included);
			host.error(format!("file system type {} both selected and excluded", name.quote()), 1);
			both = true;
		}
	}
	if both {
		return Err(Early::Exit(1));
	}

	// Stat every operand first, reporting failures in order.
	let mut entries = Vec::with_capacity(operands.len());
	for name in &operands {
		match stat_operand(host, name) {
			Ok((resolved, stat)) => entries.push(Some((name.clone(), resolved, stat))),
			Err(error) => {
				host.error(format!("{}: {}", name.maybe_quote(), error_text(&error)), 1);
				entries.push(None);
			},
		}
	}

	match read_mounts() {
		Ok(mounts) => state.mounts = mounts,
		Err(error) => {
			let fatal = operands.is_empty()
				|| state.show_all
				|| state.show_local
				|| !state.select.is_empty()
				|| !state.exclude.is_empty();
			let prefix = if fatal { "" } else { "Warning: " };
			let suffix = error.map(|text| format!(": {text}")).unwrap_or_default();
			host.error(format!("{prefix}cannot read table of mounted file systems{suffix}"), 1);
			if fatal {
				return Err(Early::Exit(1));
			}
			// A warning does not change the exit status.
			host.fail(0);
		},
	}

	if state.require_sync {
		#[cfg(unix)]
		// SAFETY: `sync` takes no arguments and only schedules writeback.
		unsafe {
			libc::sync();
		}
	}

	state.field_list(host)?;
	state.header();

	if operands.is_empty() {
		state.all_entries(host);
	} else {
		state.show_listed = true;
		for (name, resolved, stat) in entries.into_iter().flatten() {
			if host.is_cancelled() {
				break;
			}
			if !(stat.is_dev && state.get_device(host, &name, &resolved)) {
				state.get_point(host, &name, &resolved, stat);
			}
		}
	}

	if state.processed {
		if state.print_total {
			let source_used = state.fields[state.field_index(Field::Source)].used;
			let args = DevArgs {
				device:      Some("total".to_owned()),
				mount_point: OsString::from(if source_used { "-" } else { "total" }),
				file:        None,
				stat_file:   None,
				fstype:      None,
				dummy:       false,
				remote:      false,
			};
			let grand = state.grand.clone();
			state.get_dev(host, args, Some(grand), false);
		}
		let mut out = io::BufWriter::new(host.stdout_writer());
		if let Err(error) = state.print_table(&mut out).and_then(|()| out.flush()) {
			drop(out);
			host.error(format!("write error: {}", error_text(&error)), 1);
		}
	} else if host.exit_code() == 0 {
		host.error("no file systems processed", 1);
	}
	Ok(())
}

/// GNU `automount_stat_err` against the shell's filesystem. Virtual
/// (`scheme://`) paths have no mount table entry or `statfs`, so they are
/// rejected rather than reported against an unrelated host file system.
fn stat_operand(host: &Host, name: &OsStr) -> io::Result<(PathBuf, Stat)> {
	if name.is_empty() {
		#[cfg(unix)]
		return Err(io::Error::from_raw_os_error(libc::ENOENT));
		#[cfg(not(unix))]
		return Err(io::Error::new(io::ErrorKind::NotFound, "No such file or directory"));
	}
	let resolved = host.resolve(name);
	let stat = stat_path(host, &resolved)?;
	if !host.fs().is_native_local(&resolved) {
		return Err(io::Error::new(io::ErrorKind::Unsupported, "Operation not supported"));
	}
	Ok((resolved, stat))
}

#[cfg(test)]
mod tests {
	use clap::Parser;

	use super::*;

	/// Runs `df` with `args` and exported `env`, from the repository's
	/// crate directory. Returns `(status, stdout, stderr)`.
	fn run(env: &[(&str, &str)], args: &[&str]) -> (i32, String, String) {
		let (mut host, capture) = Host::for_test("df", "", env!("CARGO_MANIFEST_DIR"));
		for (key, value) in env {
			host.set_test_var(key, value);
		}
		let argv: Vec<OsString> = std::iter::once("df")
			.chain(args.iter().copied())
			.map(OsString::from)
			.collect();
		let code = match Df::try_parse_from(argv) {
			Ok(parsed) => crate::host::run_caught::<Df>(parsed, &mut host),
			Err(error) => {
				let _ = write!(host.stderr, "{error}");
				i32::from(Df::USAGE_ERROR)
			},
		};
		(code, capture.out(), capture.err())
	}

	fn usage(message: &str) -> String {
		format!("df: {message}\nTry 'df --help' for more information.\n")
	}

	#[test]
	fn usage_errors_exit_one() {
		for args in [
			&["--output=size,bogus"][..],
			&["-i", "--output"],
			&["--output", "-T"],
			&["-P", "--output"],
			&["--bogus"],
			&["-B"],
			&["--total=1"],
		] {
			let (code, out, err) = run(&[], args);
			assert_eq!((code, out.as_str()), (1, ""), "{args:?}");
			assert!(err.starts_with("error: "), "{args:?}: {err}");
		}
	}

	#[test]
	fn output_field_named_twice_is_rejected() {
		assert_eq!(
			run(&[], &["--output=size", "--output=used,size"]),
			(1, String::new(), usage("option --output: field 'size' used more than once"))
		);
	}

	#[test]
	fn bare_output_lists_every_field() {
		let (code, out, err) = run(&[], &["--output", "/"]);
		assert_eq!((code, err.as_str()), (0, ""));
		let header: Vec<&str> = out.lines().next().unwrap().split_whitespace().collect();
		assert_eq!(header, [
			"Filesystem",
			"Type",
			"Inodes",
			"IUsed",
			"IFree",
			"IUse%",
			"1K-blocks",
			"Used",
			"Avail",
			"Use%",
			"File",
			"Mounted",
			"on"
		]);
	}

	#[test]
	fn block_size_errors() {
		let cases: [(&[&str], &str); 4] = [
			(&["-B", "0"], "invalid --block-size argument '0'"),
			(&["--block-size=x"], "invalid --block-size argument 'x'"),
			(&["-B1KiBx"], "invalid suffix in --block-size argument '1KiBx'"),
			(&["-B", "1Y"], "--block-size argument '1Y' too large"),
		];
		for (args, message) in cases {
			assert_eq!(
				run(&[], args),
				(1, String::new(), format!("df: {message}\n")),
				"args: {args:?}"
			);
		}
	}

	#[test]
	fn fs_type_both_selected_and_excluded_reports_each_newest_first() {
		assert_eq!(
			run(&[], &["-t", "a", "-t", "b", "-x", "b", "-x", "a"]),
			(
				1,
				String::new(),
				"df: file system type 'b' both selected and excluded\ndf: file system type 'a' both \
				 selected and excluded\n"
					.into()
			)
		);
	}

	#[test]
	fn missing_operand_is_reported_without_no_file_systems_message() {
		assert_eq!(
			run(&[], &["/nonexistent-df-operand"]),
			(1, String::new(), "df: /nonexistent-df-operand: No such file or directory\n".into())
		);
		assert_eq!(run(&[], &[""]), (1, String::new(), "df: '': No such file or directory\n".into()));
	}

	#[test]
	fn a_failing_operand_does_not_hide_the_others() {
		let (code, out, err) = run(&[], &["--output=target", "/nonexistent-df-operand", "/"]);
		assert_eq!(code, 1);
		assert_eq!(err, "df: /nonexistent-df-operand: No such file or directory\n");
		assert_eq!(out, "Mounted on\n/\n");
	}

	#[test]
	fn virtual_operands_are_rejected_rather_than_misreported() {
		assert_eq!(
			run(&[], &["mem://df-probe"]),
			(1, String::new(), "df: mem://df-probe: No such file or directory\n".into())
		);
	}

	#[test]
	fn no_matching_file_system_is_an_error() {
		assert_eq!(
			run(&[], &["-t", "no-such-fs-type"]),
			(1, String::new(), "df: no file systems processed\n".into())
		);
	}

	#[test]
	fn operand_selects_the_mount_holding_it() {
		let (code, out, err) = run(&[], &["--output=file,target", "src", "/"]);
		assert_eq!((code, err.as_str()), (0, ""));
		let lines: Vec<&str> = out.lines().collect();
		assert_eq!(lines.len(), 3, "{out}");
		assert!(lines[0].starts_with("File Mounted on"), "{out}");
		// Relative operands resolve against the shell's directory and print
		// as given.
		assert!(lines[1].starts_with("src  /"), "{out}");
		assert_eq!(lines[2], "/    /");
	}

	#[test]
	fn posix_format_uses_capacity_and_posixly_correct_block_size() {
		let (code, out, _) = run(&[("POSIXLY_CORRECT", "1")], &["-P", "/"]);
		assert_eq!(code, 0);
		let header = out.lines().next().expect("header line");
		let words: Vec<&str> = header.split_whitespace().collect();
		assert_eq!(words, [
			"Filesystem",
			"512-blocks",
			"Used",
			"Available",
			"Capacity",
			"Mounted",
			"on"
		]);

		let (_, out, _) = run(&[], &["-P", "/"]);
		assert!(out.lines().next().unwrap().contains(" 1024-blocks "), "{out}");
	}

	#[test]
	fn block_size_comes_from_options_then_environment() {
		let header = |env: &[(&str, &str)], args: &[&str]| {
			let (code, out, err) = run(env, args);
			assert_eq!((code, err.as_str()), (0, ""), "{env:?} {args:?}");
			out.lines()
				.next()
				.unwrap()
				.split_whitespace()
				.nth(1)
				.unwrap()
				.to_owned()
		};
		assert_eq!(header(&[], &["/"]), "1K-blocks");
		assert_eq!(header(&[("DF_BLOCK_SIZE", "1M")], &["/"]), "1M-blocks");
		assert_eq!(header(&[("BLOCK_SIZE", "2K")], &["/"]), "2K-blocks");
		assert_eq!(header(&[("BLOCKSIZE", "1000")], &["/"]), "1kB-blocks");
		// An unusable DF_BLOCK_SIZE falls back to the default.
		assert_eq!(header(&[("DF_BLOCK_SIZE", "0")], &["/"]), "1K-blocks");
		assert_eq!(header(&[("DF_BLOCK_SIZE", "1M")], &["-k", "/"]), "1K-blocks");
		// The last scaling option wins.
		assert_eq!(header(&[], &["-k", "-h", "/"]), "Size");
		assert_eq!(header(&[], &["-h", "-k", "/"]), "1K-blocks");
		assert_eq!(header(&[], &["-B", "1536", "/"]), "1.6kB-blocks");
		assert_eq!(header(&[], &["-B", "1KB", "/"]), "1kB-blocks");
		assert_eq!(header(&[], &["-B", "1KiB", "/"]), "1K-blocks");
		assert_eq!(header(&[], &["-B", "0x10", "/"]), "16B-blocks");
	}

	#[test]
	fn unit_only_block_size_also_suffixes_values() {
		let (code, out, _) = run(&[], &["--output=size", "-B", "KiB", "/"]);
		assert_eq!(code, 0);
		let lines: Vec<&str> = out.lines().collect();
		assert_eq!(lines[0].trim(), "1KiB-blocks");
		assert!(lines[1].trim().ends_with("KiB"), "{out}");
	}

	#[test]
	fn total_row_names_target_dash_when_source_is_shown() {
		let (code, out, _) = run(&[], &["--total", "--output=source,target", "/"]);
		assert_eq!(code, 0);
		assert_eq!(out.lines().last(), Some("total          -"));
		let (_, out, _) = run(&[], &["--total", "--output=target", "/"]);
		assert_eq!(out, "Mounted on\n/\ntotal\n");
	}

	#[test]
	fn block_header_prefers_the_exact_base() {
		let header = |bytes| block_header(bytes, NumericSymbols::C);
		assert_eq!(header(1024), "1K");
		assert_eq!(header(1 << 20), "1M");
		assert_eq!(header(1000), "1kB");
		assert_eq!(header(1536), "1.6kB");
		assert_eq!(header(512), "512B");
		assert_eq!(header(16), "16B");
		// Divisible by both at first, then by neither: a tie goes to 1000.
		assert_eq!(header(1_024_000), "1.1MB");
	}

	#[test]
	fn percent_rounds_up_and_marks_unknown_values() {
		let values = |used: u64, available: u64| Values {
			units: 1,
			total: used + available,
			available,
			negate_available: false,
			available_to_root: available,
			used,
			negate_used: false,
		};
		assert_eq!(percent(&values(1, 199)), b"1%");
		assert_eq!(percent(&values(0, 10)), b"0%");
		assert_eq!(percent(&values(10, 0)), b"100%");
		assert_eq!(percent(&values(0, 0)), b"-");
		assert_eq!(percent(&values(u64::MAX, 0)), b"-");
	}

	#[test]
	fn cells_replace_control_characters() {
		assert_eq!(replace_problematic(b"a\tb\x7f\xc3\xa9", false, true), b"a?b?\xc3\xa9");
		assert_eq!(replace_problematic(b"a\xff\xc3\xa9", true, true), b"a?\xc3\xa9");
		assert_eq!(replace_problematic(b"a\xc3\xa9", true, false), b"a??");
		assert_eq!(mbswidth("é字".as_bytes(), true), Some(3));
		assert_eq!(mbswidth("é".as_bytes(), false), None);
		assert_eq!(mbswidth(b"\xff", true), None);
	}

	#[test]
	fn duplicate_devices_keep_the_entry_nearest_the_root_in_place() {
		let dir = tempfile::tempdir().unwrap();
		let child = dir.path().join("child");
		std::fs::create_dir(&child).unwrap();
		let (mut host, _capture) = Host::for_test("df", "", dir.path());
		let mut state = DfState::new(&host);
		let mount = |devname: &str, dir: &Path| Mount {
			devname:  devname.to_owned(),
			mountdir: dir.as_os_str().to_owned(),
			mntroot:  None,
			fstype:   "test".to_owned(),
			dummy:    false,
			remote:   false,
			dev:      Dev::Unknown,
		};
		state.mounts =
			vec![mount("/dev/one", &child), mount("tmpfs", dir.path()), mount("/dev/one", dir.path())];
		// A real device name beats a pseudo one; then the shorter mount point
		// wins, taking the slot of the entry it replaces.
		assert_eq!(state.filter_mount_list(&mut host, false), vec![2]);
		// -a keeps every entry.
		assert_eq!(state.filter_mount_list(&mut host, true), vec![0, 1, 2]);
	}
}
