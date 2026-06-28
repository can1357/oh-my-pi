// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

// spell-checker:ignore (ToDO) somegroup nlink tabsize dired subdired dtype
// colorterm stringly spell-checker:ignore nohash strtime clocale ilog

use core::ops::RangeInclusive;
#[cfg(unix)]
use std::fmt::Display;
#[cfg(unix)]
use std::os::unix::fs::{FileTypeExt, MetadataExt};
#[cfg(windows)]
use std::os::windows::fs::MetadataExt;
/// Show the directory name in the case where several arguments are given to ls
use std::{borrow::Cow, iter};
use std::{
	cell::LazyCell,
	ffi::{OsStr, OsString},
	fmt::Write as FmtWrite,
	fs::{self, DirEntry, FileType, Metadata},
	io::{BufWriter, Write},
	sync::LazyLock,
	time::SystemTime,
};

use ansi_width::ansi_width;
use glob::MatchOptions;
use pi_uutils_ctx::CtxStdout;
#[cfg(unix)]
use rustc_hash::FxHashMap;
use term_grid::{DEFAULT_SEPARATOR_SIZE, Direction, Filling, Grid, GridOptions};
#[cfg(unix)]
use uucore::entries;
#[cfg(all(unix, not(any(target_os = "android", target_os = "macos"))))]
use uucore::fsxattr::has_acl;
#[cfg(any(
	target_os = "linux",
	target_os = "macos",
	target_os = "android",
	target_os = "ios",
	target_os = "freebsd",
	target_os = "dragonfly",
	target_os = "netbsd",
	target_os = "openbsd",
	target_os = "illumos",
	target_os = "solaris"
))]
use uucore::libc::{dev_t, major, minor};
use uucore::{
	error::UResult,
	format::human::human_readable,
	fs::display_permissions,
	fsext::metadata_get_time,
	os_str_as_bytes_lossy,
	quoting_style::{QuotingStyle, locale_aware_escape_dir_name, locale_aware_escape_name},
	time::{FormatSystemTimeFallback, format_system_time},
};

use crate::{
	Config, ListState, LsError, PathData,
	colors::{StyleManager, color_name},
	config::Files,
	dired::{self, DiredOutput},
	get_block_size,
};

// Fields that can be removed or added to the long format
pub(crate) struct LongFormat {
	pub(crate) author:          bool,
	pub(crate) group:           bool,
	pub(crate) owner:           bool,
	#[cfg(unix)]
	pub(crate) numeric_uid_gid: bool,
}

pub(crate) struct PaddingCollection {
	#[cfg(unix)]
	pub(crate) inode:      usize,
	pub(crate) link_count: usize,
	pub(crate) uname:      usize,
	pub(crate) group:      usize,
	pub(crate) context:    usize,
	pub(crate) size:       usize,
	#[cfg(unix)]
	pub(crate) major:      usize,
	#[cfg(unix)]
	pub(crate) minor:      usize,
	pub(crate) block_size: usize,
}

pub(crate) struct DisplayItemName {
	pub(crate) displayed:      OsString,
	pub(crate) dired_name_len: usize,
}

#[derive(PartialEq, Eq)]
pub(crate) enum IndicatorStyle {
	None,
	Slash,
	FileType,
	Classify,
}

#[derive(Clone, Copy, PartialEq, Eq)]
pub(crate) enum LocaleQuoting {
	Single,
	Double,
}

#[derive(PartialEq, Eq, Debug)]
pub enum Format {
	Columns,
	Long,
	OneLine,
	Across,
	Commas,
}

#[allow(dead_code)]
enum SizeOrDeviceId {
	Size(String),
	Device(String, String),
}

/// or the recursive flag is passed.
///
/// ```no-exec
/// $ ls -R
/// .:                  <- This is printed by this function
/// dir1 file1 file2
///
/// dir1:               <- This as well
/// file11
/// ```
pub fn show_dir_name(
	path_data: &PathData,
	out: &mut BufWriter<CtxStdout>,
	config: &Config,
) -> std::io::Result<()> {
	let escaped_name = escape_dir_name_with_locale(path_data.path().as_os_str(), config);

	let name = if config.hyperlink && !config.dired {
		create_hyperlink(&escaped_name, path_data)
	} else {
		escaped_name
	};

	write_os_str(out, &name)?;
	write!(out, ":")
}

fn escape_with_locale<F>(name: &OsStr, config: &Config, fallback: F) -> OsString
where
	F: FnOnce(&OsStr, QuotingStyle) -> OsString,
{
	if let Some(locale) = config.locale_quoting {
		locale_quote(name, locale)
	} else {
		fallback(name, config.quoting_style)
	}
}

fn escape_dir_name_with_locale(name: &OsStr, config: &Config) -> OsString {
	escape_with_locale(name, config, locale_aware_escape_dir_name)
}

fn escape_name_with_locale(name: &OsStr, config: &Config) -> OsString {
	escape_with_locale(name, config, locale_aware_escape_name)
}

fn locale_quote(name: &OsStr, style: LocaleQuoting) -> OsString {
	let bytes = os_str_as_bytes_lossy(name);
	let mut quoted = String::with_capacity(name.len() + 2);
	match style {
		LocaleQuoting::Single => quoted.push('\''),
		LocaleQuoting::Double => quoted.push('"'),
	}
	for &byte in bytes.as_ref() {
		push_locale_byte(&mut quoted, byte, style);
	}
	match style {
		LocaleQuoting::Single => quoted.push('\''),
		LocaleQuoting::Double => quoted.push('"'),
	}
	OsString::from(quoted)
}

fn push_locale_byte(buf: &mut String, byte: u8, style: LocaleQuoting) {
	match (style, byte) {
		(LocaleQuoting::Single, b'\'') => buf.push_str("'\\''"),
		(LocaleQuoting::Double, b'"') => buf.push_str("\\\""),
		(_, b'\\') => buf.push_str("\\\\"),
		_ => push_basic_escape(buf, byte),
	}
}

fn push_basic_escape(buf: &mut String, byte: u8) {
	match byte {
		b'\x07' => buf.push_str("\\a"),
		b'\x08' => buf.push_str("\\b"),
		b'\t' => buf.push_str("\\t"),
		b'\n' => buf.push_str("\\n"),
		b'\x0b' => buf.push_str("\\v"),
		b'\x0c' => buf.push_str("\\f"),
		b'\r' => buf.push_str("\\r"),
		b'\x1b' => buf.push_str("\\e"),
		b'"' => buf.push('"'),
		b'\'' => buf.push('\''),
		b if (0x20..=0x7e).contains(&b) => buf.push(b as char),
		_ => {
			let _ = write!(buf, "\\{byte:03o}");
		},
	}
}

pub fn should_display(entry: &DirEntry, config: &Config) -> bool {
	// check if hidden
	if config.files == Files::Normal && is_hidden(entry) {
		return false;
	}

	// check if it is among ignore_patterns
	let options = MatchOptions {
		// setting require_literal_leading_dot to match behavior in GNU ls
		require_literal_leading_dot: true,
		require_literal_separator:   false,
		case_sensitive:              true,
	};

	let file_name = entry.file_name();
	// If the decoding fails, still match best we can
	// FIXME: use OsStrings or Paths once we have a glob crate that supports it:
	// https://github.com/rust-lang/glob/issues/23
	// https://github.com/rust-lang/glob/issues/78
	// https://github.com/BurntSushi/ripgrep/issues/1250

	let file_name = match file_name.to_str() {
		Some(s) => Cow::Borrowed(s),
		None => file_name.to_string_lossy(),
	};

	!config
		.ignore_patterns
		.iter()
		.any(|p| p.matches_with(&file_name, options))
}

fn display_dir_entry_size(
	entry: &PathData,
	config: &Config,
	state: &mut ListState,
) -> (usize, usize, usize, usize, usize, usize) {
	// TODO: Cache/memorize the display_* results so we don't have to recalculate
	// them.
	if let Some(md) = entry.metadata() {
		let (size_len, major_len, minor_len) = match display_len_or_rdev(md, config) {
			SizeOrDeviceId::Device(major, minor) => {
				(major.len() + minor.len() + 2usize, major.len(), minor.len())
			},
			SizeOrDeviceId::Size(size) => (size.len(), 0usize, 0usize),
		};
		#[cfg(unix)]
		let nlink_len = digits(md.nlink());
		#[cfg(not(unix))]
		let nlink_len = display_symlink_count(md).len();
		(
			nlink_len,
			display_uname(md, config, &mut state.uid_cache).len(),
			display_group(md, config, &mut state.gid_cache).len(),
			size_len,
			major_len,
			minor_len,
		)
	} else {
		(0, 0, 0, 0, 0, 0)
	}
}

#[cfg(unix)]
fn digits(num: u64) -> usize {
	(num.checked_ilog10().unwrap_or(0) + 1) as usize
}

// A simple, performant, ExtendPad trait to add a string to a Vec<u8>, padding
// with spaces on the left or right, without making additional copies, or using
// formatting functions.
pub trait ExtendPad {
	fn extend_pad_left(&mut self, string: &str, count: usize);
	fn extend_pad_right(&mut self, string: &str, count: usize);
}

impl ExtendPad for Vec<u8> {
	fn extend_pad_left(&mut self, string: &str, count: usize) {
		if string.len() < count {
			self.extend(iter::repeat_n(b' ', count - string.len()));
		}
		self.extend(string.as_bytes());
	}

	fn extend_pad_right(&mut self, string: &str, count: usize) {
		self.extend(string.as_bytes());
		if string.len() < count {
			self.extend(iter::repeat_n(b' ', count - string.len()));
		}
	}
}

// TODO: Consider converting callers to use ExtendPad instead, as it avoids
// additional copies.
fn pad_left(string: &str, count: usize) -> String {
	format!("{string:>count$}")
}

#[allow(clippy::cognitive_complexity)]
pub fn display_items(
	items: &[PathData],
	config: &Config,
	state: &mut ListState,
	dired: &mut DiredOutput,
) -> UResult<()> {
	// `-Z`, `--context`:
	// Display the SELinux security context or '?' if none is found. When used with
	// the `-l` option, print the security context to the left of the size column.

	let quoted = items.iter().any(|item| {
		let name = escape_name_with_locale(item.display_name(), config);
		os_str_starts_with(&name, b"'")
	});

	if config.format == Format::Long {
		let padding_collection = calculate_padding_collection(items, config, state);

		for item in items {
			#[cfg(unix)]
			let should_display_leading_info = config.inode || config.alloc_size;
			#[cfg(not(unix))]
			let should_display_leading_info = config.alloc_size;

			if should_display_leading_info {
				display_additional_leading_info(item, &padding_collection, config, &mut state.out)?;
			}

			display_item_long(item, &padding_collection, config, state, dired, quoted)?;
		}
	} else {
		let mut longest_context_len = 1;
		let prefix_context = if config.context {
			for item in items {
				let context_len = item.security_context(config).len();
				longest_context_len = context_len.max(longest_context_len);
			}
			Some(longest_context_len)
		} else {
			None
		};

		let padding = calculate_padding_collection(items, config, state);

		// we need to apply normal color to non filename output
		if let Some(style_manager) = &mut state.style_manager {
			write!(state.out, "{}", style_manager.apply_normal())?;
		}

		let mut names_vec = Vec::with_capacity(items.len());

		#[cfg(unix)]
		let should_display_leading_info = config.inode || config.alloc_size;
		#[cfg(not(unix))]
		let should_display_leading_info = config.alloc_size;

		for i in items {
			let more_info = if should_display_leading_info {
				let mut s = Vec::new();
				display_additional_leading_info(i, &padding, config, &mut s)?;
				Some(String::from_utf8(s).unwrap()) // Should always be UTF-8
			} else {
				None
			};
			// it's okay to set current column to zero which is used to decide
			// whether text will wrap or not, because when format is grid or
			// column ls will try to place the item name in a new line if it
			// wraps.
			let cell = display_item_name(
				i,
				config,
				prefix_context,
				more_info,
				state.style_manager.as_mut(),
				LazyCell::new(|| 0),
			);

			names_vec.push(cell.displayed);
		}

		let mut names = names_vec.into_iter();

		match config.format {
			Format::Columns => {
				display_grid(
					names,
					config.width,
					Direction::TopToBottom,
					&mut state.out,
					quoted,
					config.tab_size,
				)?;
			},
			Format::Across => {
				display_grid(
					names,
					config.width,
					Direction::LeftToRight,
					&mut state.out,
					quoted,
					config.tab_size,
				)?;
			},
			Format::Commas => {
				let mut current_col = 0;
				if let Some(name) = names.next() {
					write_os_str(&mut state.out, &name)?;
					current_col = ansi_width(&name.to_string_lossy()) as u16 + 2;
				}
				for name in names {
					let name_width = ansi_width(&name.to_string_lossy()) as u16;
					// If the width is 0 we print one single line
					if config.width != 0 && current_col + name_width + 1 > config.width {
						current_col = name_width + 2;
						writeln!(state.out, ",")?;
					} else {
						current_col += name_width + 2;
						write!(state.out, ", ")?;
					}
					write_os_str(&mut state.out, &name)?;
				}
				// Current col is never zero again if names have been printed.
				// So we print a newline.
				if current_col > 0 {
					write!(state.out, "{}", config.line_ending)?;
				}
			},
			_ => {
				for name in names {
					write_os_str(&mut state.out, &name)?;
					write!(state.out, "{}", config.line_ending)?;
				}
			},
		}
	}

	Ok(())
}

fn display_grid(
	names: impl Iterator<Item = OsString>,
	width: u16,
	direction: Direction,
	out: &mut BufWriter<CtxStdout>,
	quoted: bool,
	tab_size: usize,
) -> UResult<()> {
	if width == 0 {
		// If the width is 0 we print one single line
		let mut printed_something = false;
		for name in names {
			if printed_something {
				write!(out, "  ")?;
			}
			printed_something = true;
			write_os_str(out, &name)?;
		}
		if printed_something {
			writeln!(out)?;
		}
	} else {
		let names: Vec<String> = {
			let mut buf = Vec::new();
			names
				.map(|n| {
					// In case some names are quoted, GNU adds a space before each
					// entry that does not start with a quote to make it prettier
					// on multiline.
					//
					// Example:
					// ```
					// $ ls
					// 'a\nb'   bar
					//  foo     baz
					// ^       ^
					// These spaces is added
					// ```
					// FIXME: the Grid crate only supports &str, so can't display raw bytes
					buf.clear();
					if quoted && !os_str_starts_with(&n, b"'") && !os_str_starts_with(&n, b"\"") {
						buf.push(b' ');
					}
					buf.extend(n.as_encoded_bytes());
					String::from_utf8_lossy(&buf).into_owned()
				})
				.collect()
		};

		// Since tab_size=0 means no \t, use Spaces separator for optimization.
		let filling = match tab_size {
			0 => Filling::Spaces(DEFAULT_SEPARATOR_SIZE),
			_ => Filling::Tabs { spaces: DEFAULT_SEPARATOR_SIZE, tab_size },
		};

		let grid = Grid::new(names, GridOptions { filling, direction, width: width as usize });
		write!(out, "{grid}")?;
	}
	Ok(())
}

fn display_additional_leading_info(
	item: &PathData,
	padding: &PaddingCollection,
	config: &Config,
	out: &mut impl Write,
) -> UResult<()> {
	#[cfg(unix)]
	{
		if config.inode {
			let inode = padding.inode;
			if let Some(md) = item.metadata() {
				write!(out, "{:>inode$} ", display_inode(md))?;
			} else {
				write!(out, "{:>inode$} ", '?')?;
			}
		}
	}

	if config.alloc_size {
		let s: Cow<'_, str> = if let Some(md) = item.metadata() {
			display_size(get_block_size(md, config), config).into()
		} else {
			"?".into()
		};
		// extra space is insert to align the sizes, as needed for all formats, except
		// for the comma format.
		if config.format == Format::Commas {
			out.write_all(s.as_bytes())?;
			out.write_all(b" ")?;
		} else {
			let block_size = padding.block_size;
			write!(out, "{s:>block_size$} ")?;
		}
	}

	Ok(())
}

// Currently getpwuid is `linux` target only. If it's broken state.out into
// a posix-compliant attribute this can be updated...
#[cfg(unix)]
fn display_uname<'a>(
	metadata: &Metadata,
	config: &Config,
	uid_cache: &'a mut FxHashMap<u32, String>,
) -> &'a String {
	let uid = metadata.uid();

	uid_cache.entry(uid).or_insert_with(|| {
		if config.long.numeric_uid_gid {
			uid.to_string()
		} else {
			entries::uid2usr(uid).unwrap_or_else(|_| uid.to_string())
		}
	})
}

#[cfg(unix)]
fn display_group<'a>(
	metadata: &Metadata,
	config: &Config,
	gid_cache: &'a mut FxHashMap<u32, String>,
) -> &'a String {
	let gid = metadata.gid();
	gid_cache.entry(gid).or_insert_with(|| {
		if config.long.numeric_uid_gid {
			gid.to_string()
		} else {
			entries::gid2grp(gid).unwrap_or_else(|_| gid.to_string())
		}
	})
}

#[cfg(not(unix))]
fn display_uname(_metadata: &Metadata, _config: &Config, _uid_cache: &mut ()) -> &'static str {
	"somebody"
}

#[cfg(not(unix))]
fn display_group(_metadata: &Metadata, _config: &Config, _gid_cache: &mut ()) -> &'static str {
	"somegroup"
}

fn display_date(
	metadata: &Metadata,
	config: &Config,
	recent_time_range: &RangeInclusive<SystemTime>,
	out: &mut Vec<u8>,
) -> UResult<()> {
	let Some(time) = metadata_get_time(metadata, config.time) else {
		out.extend(b"???");
		return Ok(());
	};

	// Use "recent" format if the given date is considered recent (i.e., in the last
	// 6 months), or if no "older" format is available.
	let fmt = match &config.time_format_older {
		Some(time_format_older) if !recent_time_range.contains(&time) => time_format_older,
		_ => &config.time_format_recent,
	};

	format_system_time(out, time, fmt, FormatSystemTimeFallback::Integer)
}

fn display_len_or_rdev(metadata: &Metadata, config: &Config) -> SizeOrDeviceId {
	#[cfg(any(
		target_os = "linux",
		target_os = "macos",
		target_os = "android",
		target_os = "ios",
		target_os = "freebsd",
		target_os = "dragonfly",
		target_os = "netbsd",
		target_os = "openbsd",
		target_os = "illumos",
		target_os = "solaris"
	))]
	{
		let ft = metadata.file_type();
		if ft.is_char_device() || ft.is_block_device() {
			// A type cast is needed here as the `dev_t` type varies across OSes.
			let dev = metadata.rdev() as dev_t;
			let major = major(dev);
			let minor = minor(dev);
			return SizeOrDeviceId::Device(major.to_string(), minor.to_string());
		}
	}
	let len_adjusted = {
		let d = metadata.len() / config.file_size_block_size;
		let r = metadata.len() % config.file_size_block_size;
		if r == 0 { d } else { d + 1 }
	};
	SizeOrDeviceId::Size(display_size(len_adjusted, config))
}

pub fn display_size(size: u64, config: &Config) -> String {
	human_readable(size, config.size_format)
}

/// Takes a [`PathData`] struct and returns a cell with a name ready for
/// displaying.
///
/// This function relies on the following parameters in the provided `&Config`:
/// * `config.quoting_style` to decide how we will escape `name` using
///   [`locale_aware_escape_name`].
/// * `config.inode` decides whether to display inode numbers beside names using
///   [`display_inode`].
/// * `config.color` decides whether it's going to color `name` using
///   [`color_name`].
/// * `config.indicator_style` to append specific characters to `name` using
///   [`classify_file`].
/// * `config.format` to display symlink targets if `Format::Long`. This
///   function is also responsible for coloring symlink target names if
///   `config.color` is specified.
/// * `config.context` to prepend security context to `name` if compiled with
///   `feat_selinux`.
/// * `config.hyperlink` decides whether to hyperlink the item
///
/// Note that non-unicode sequences in symlink targets are dealt with using
/// [`std::path::Path::to_string_lossy`].
#[allow(clippy::cognitive_complexity)]
fn display_item_name(
	path: &PathData,
	config: &Config,
	prefix_context: Option<usize>,
	more_info: Option<String>,
	mut style_manager: Option<&mut StyleManager>,
	current_column: LazyCell<usize, impl FnOnce() -> usize>,
) -> DisplayItemName {
	// This is our return value. We start by `&path.display_name` and modify it
	// along the way.
	let mut name = escape_name_with_locale(path.display_name(), config);

	let is_wrap =
		|namelen: usize| config.width != 0 && *current_column + namelen > config.width.into();

	if config.hyperlink {
		name = create_hyperlink(&name, path);
	}

	if let Some(style_manager) = style_manager.as_mut() {
		let len = name.len();
		name = color_name(name, path, style_manager, None, is_wrap(len));
	}

	if config.format != Format::Long
		&& let Some(info) = more_info
	{
		let old_name = name;
		name = info.into();
		name.push(&old_name);
	}

	if config.indicator_style != IndicatorStyle::None {
		let sym = classify_file(path);

		let char_opt = match config.indicator_style {
			IndicatorStyle::Classify => sym,
			IndicatorStyle::FileType => {
				// Don't append an asterisk.
				match sym {
					Some('*') => None,
					_ => sym,
				}
			},
			IndicatorStyle::Slash => {
				// Append only a slash.
				match sym {
					Some('/') => Some('/'),
					_ => None,
				}
			},
			IndicatorStyle::None => None,
		};

		if let Some(c) = char_opt {
			let _ = name.write_char(c);
		}
	}

	let dired_name_len = if config.dired { name.len() } else { 0 };

	if config.format == Format::Long
		&& path.file_type().is_some_and(FileType::is_symlink)
		&& !path.must_dereference
	{
		match pi_uutils_ctx::resolve(path.path()).read_link() {
			Ok(target_path) => {
				name.push(" -> ");

				// We might as well color the symlink output after the arrow.
				// This makes extra system calls, but provides important information that
				// people run `ls -l --color` are very interested in.
				if let Some(style_manager) = &mut style_manager {
					let escaped_target = escape_name_with_locale(target_path.as_os_str(), config);
					// We get the absolute path to be able to construct PathData with valid
					// Metadata. This is because relative symlinks will fail to get_metadata.
					let absolute_target = if target_path.is_relative() {
						match path.path().parent() {
							Some(p) => &p.join(&target_path),
							None => &target_path,
						}
					} else {
						&target_path
					};

					match fs::canonicalize(pi_uutils_ctx::resolve(absolute_target)) {
						Ok(resolved_target) => {
							let target_data = PathData::new(
								resolved_target.as_path().into(),
								None,
								target_path.file_name().map(Cow::Borrowed),
								config,
								false,
							);

							// Check if the target actually needs coloring
							let md_option: Option<Metadata> = target_data
								.metadata()
								.cloned()
								.or_else(|| target_data.p_buf.symlink_metadata().ok());
							let style = style_manager
								.colors
								.style_for_path_with_metadata(&target_data.p_buf, md_option.as_ref());

							if style.is_some() {
								// Only apply coloring if there's actually a style
								name.push(color_name(
									escaped_target,
									&target_data,
									style_manager,
									None,
									is_wrap(name.len()),
								));
							} else {
								// For regular files with no coloring, just use plain text
								name.push(escaped_target);
							}
						},
						Err(_) => {
							name.push(
								style_manager
									.apply_missing_target_style(escaped_target, is_wrap(name.len())),
							);
						},
					}
				} else {
					// If no coloring is required, we just use target as is.
					// Apply the right quoting
					name.push(escape_name_with_locale(target_path.as_os_str(), config));
				}
			},
			Err(err) => {
				crate::show_ls_error(LsError::IOErrorContext(path.path().to_path_buf(), err, false));
			},
		}
	}

	// Prepend the security context to the `name` and adjust `width` in order
	// to get correct alignment from later calls to`display_grid()`.
	if config.context
		&& let Some(pad_count) = prefix_context
	{
		let security_context: Cow<'_, str> = if matches!(config.format, Format::Commas) {
			path.security_context(config).into()
		} else {
			pad_left(path.security_context(config), pad_count).into()
		};

		let old_name = name;
		name = OsString::with_capacity(security_context.len() + 1 + old_name.len());
		name.push(security_context.as_ref());
		name.push(" ");
		name.push(old_name);
	}

	DisplayItemName { displayed: name, dired_name_len }
}

/// This writes to the [`BufWriter`] `state.out` a single string of the output
/// of `ls -l`.
///
/// It writes the following keys, in order:
/// * `inode` ([`display_inode`], config-optional)
/// * `permissions` ([`display_permissions`])
/// * `symlink_count` ([`display_symlink_count`])
/// * `owner` ([`display_uname`], config-optional)
/// * `group` ([`display_group`], config-optional)
/// * `author` ([`display_uname`], config-optional)
/// * `size / rdev` ([`display_len_or_rdev`])
/// * `system_time` ([`display_date`])
/// * `item_name` ([`display_item_name`])
///
/// This function needs to display information in columns:
/// * permissions and `system_time` are already guaranteed to be pre-formatted
///   in fixed length.
/// * `item_name` is the last column and is left-aligned.
/// * Everything else needs to be padded using [`pad_left`].
///
/// That's why we have the parameters:
/// ```txt
///    longest_link_count_len: usize,
///    longest_uname_len: usize,
///    longest_group_len: usize,
///    longest_context_len: usize,
///    longest_size_len: usize,
/// ```
/// that decide the maximum possible character count of each field.
#[allow(clippy::write_literal)]
#[allow(clippy::cognitive_complexity)]
fn display_item_long(
	item: &PathData,
	padding: &PaddingCollection,
	config: &Config,
	state: &mut ListState,
	dired: &mut DiredOutput,
	quoted: bool,
) -> UResult<()> {
	// apply normal color to non filename outputs
	if let Some(style_manager) = &mut state.style_manager {
		state
			.display_buf
			.extend(style_manager.apply_normal().as_bytes());
	}
	if config.dired {
		state.display_buf.extend(b"  ");
	}
	if let Some(md) = item.metadata() {
		#[cfg(any(not(unix), target_os = "android", target_os = "macos"))]
		// TODO: See how Mac should work here
		let is_acl_set = false;
		#[cfg(all(unix, not(any(target_os = "android", target_os = "macos"))))]
		let is_acl_set = has_acl(item.path());
		state
			.display_buf
			.extend(display_permissions(md, true).as_bytes());
		if item.security_context(config).len() > 1 {
			// GNU `ls` uses a "." character to indicate a file with a security context,
			// but not other alternate access method.
			state.display_buf.push(b'.');
		} else if is_acl_set {
			state.display_buf.push(b'+');
		} else {
			state.display_buf.push(b' ');
		}

		state
			.display_buf
			.extend_pad_left(&display_symlink_count(md), padding.link_count);

		if config.long.owner {
			state.display_buf.push(b' ');
			state
				.display_buf
				.extend_pad_right(display_uname(md, config, &mut state.uid_cache), padding.uname);
		}

		if config.long.group {
			state.display_buf.push(b' ');
			state
				.display_buf
				.extend_pad_right(display_group(md, config, &mut state.gid_cache), padding.group);
		}

		if config.context {
			state.display_buf.push(b' ');
			state
				.display_buf
				.extend_pad_right(item.security_context(config), padding.context);
		}

		// Author is only different from owner on GNU/Hurd, so we reuse
		// the owner, since GNU/Hurd is not currently supported by Rust.
		if config.long.author {
			state.display_buf.push(b' ');
			state
				.display_buf
				.extend_pad_right(display_uname(md, config, &mut state.uid_cache), padding.uname);
		}

		match display_len_or_rdev(md, config) {
			SizeOrDeviceId::Size(size) => {
				state.display_buf.push(b' ');
				state.display_buf.extend_pad_left(&size, padding.size);
			},
			SizeOrDeviceId::Device(major, minor) => {
				state.display_buf.push(b' ');
				state.display_buf.extend_pad_left(
					&major,
					#[cfg(not(unix))]
					0usize,
					#[cfg(unix)]
					padding.major.max(
						padding
							.size
							.saturating_sub(padding.minor.saturating_add(2usize)),
					),
				);
				state.display_buf.extend(b", ");
				state.display_buf.extend_pad_left(
					&minor,
					#[cfg(not(unix))]
					0usize,
					#[cfg(unix)]
					padding.minor,
				);
			},
		}

		state.display_buf.push(b' ');
		display_date(md, config, &state.recent_time_range, &mut state.display_buf)?;
		state.display_buf.push(b' ');

		let item_display = display_item_name(
			item,
			config,
			None,
			None,
			state.style_manager.as_mut(),
			LazyCell::new(|| ansi_width(&String::from_utf8_lossy(&state.display_buf))),
		);

		let needs_space = quoted && !os_str_starts_with(&item_display.displayed, b"'");

		if config.dired {
			let mut dired_name_len = item_display.dired_name_len;
			if needs_space {
				dired_name_len += 1;
			}
			let displayed_len = item_display.displayed.len() + usize::from(needs_space);
			update_dired_for_item(dired, state.display_buf.len(), displayed_len, dired_name_len);
		}

		let item_name = item_display.displayed;
		let displayed_item = if needs_space {
			let mut ret = OsString::with_capacity(item_name.len() + 1);
			let _ = ret.write_char(' ');
			ret.push(&item_name);
			ret
		} else {
			item_name
		};

		write_os_str(&mut state.display_buf, &displayed_item)?;
		state.display_buf.push(config.line_ending as u8);
	} else {
		#[cfg(unix)]
		let leading_char = {
			if let Some(ft) = item.file_type() {
				if ft.is_char_device() {
					'c'
				} else if ft.is_block_device() {
					'b'
				} else if ft.is_symlink() {
					'l'
				} else if ft.is_dir() {
					'd'
				} else {
					'-'
				}
			} else if item.is_dangling_link() {
				'l'
			} else {
				'-'
			}
		};
		#[cfg(not(unix))]
		let leading_char = {
			if let Some(ft) = item.file_type() {
				if ft.is_symlink() {
					'l'
				} else if ft.is_dir() {
					'd'
				} else {
					'-'
				}
			} else if item.is_dangling_link() {
				'l'
			} else {
				'-'
			}
		};

		state.display_buf.push(leading_char as u8);
		state.display_buf.extend(b"?????????");
		if item.security_context(config).len() > 1 {
			// GNU `ls` uses a "." character to indicate a file with a security context,
			// but not other alternate access method.
			state.display_buf.push(b'.');
		}
		state.display_buf.push(b' ');
		state.display_buf.extend_pad_left("?", padding.link_count);

		if config.long.owner {
			state.display_buf.push(b' ');
			state.display_buf.extend_pad_right("?", padding.uname);
		}

		if config.long.group {
			state.display_buf.push(b' ');
			state.display_buf.extend_pad_right("?", padding.group);
		}

		if config.context {
			state.display_buf.push(b' ');
			state
				.display_buf
				.extend_pad_right(item.security_context(config), padding.context);
		}

		// Author is only different from owner on GNU/Hurd, so we reuse
		// the owner, since GNU/Hurd is not currently supported by Rust.
		if config.long.author {
			state.display_buf.push(b' ');
			state.display_buf.extend_pad_right("?", padding.uname);
		}

		let displayed_item = display_item_name(
			item,
			config,
			None,
			None,
			state.style_manager.as_mut(),
			LazyCell::new(|| ansi_width(&String::from_utf8_lossy(&state.display_buf))),
		);
		let date_len = 12;

		state.display_buf.push(b' ');
		state.display_buf.extend_pad_left("?", padding.size);
		state.display_buf.push(b' ');
		state.display_buf.extend_pad_left("?", date_len);
		state.display_buf.push(b' ');

		if config.dired {
			update_dired_for_item(
				dired,
				state.display_buf.len(),
				displayed_item.displayed.len(),
				displayed_item.dired_name_len,
			);
		}
		let displayed_item = displayed_item.displayed;
		write_os_str(&mut state.display_buf, &displayed_item)?;
		state.display_buf.push(config.line_ending as u8);
	}
	state.out.write_all(&state.display_buf)?;
	state.display_buf.clear();

	Ok(())
}

fn classify_file(path: &PathData) -> Option<char> {
	let file_type = path.file_type()?;

	if file_type.is_dir() {
		Some('/')
	} else if file_type.is_symlink() {
		Some('@')
	} else {
		#[cfg(unix)]
		{
			if file_type.is_socket() {
				Some('=')
			} else if file_type.is_fifo() {
				Some('|')
				// Safe unwrapping if the file was removed between listing and
				// display See https://github.com/uutils/coreutils/issues/5371
			} else if path.is_executable_file() {
				Some('*')
			} else {
				None
			}
		}
		#[cfg(not(unix))]
		None
	}
}

fn create_hyperlink(name: &OsStr, path: &PathData) -> OsString {
	// The `hostname` crate does not support WASI (no OS-level hostname API),
	// so we use an empty string for hyperlinks on WASI.
	#[cfg(not(target_os = "wasi"))]
	static HOSTNAME: LazyLock<OsString> = LazyLock::new(|| hostname::get().unwrap_or_default());
	#[cfg(target_os = "wasi")]
	static HOSTNAME: LazyLock<OsString> = LazyLock::new(OsString::new);

	// OSC 8 hyperlink format: \x1b]8;;URL\x1b\\TEXT\x1b]8;;\x1b\\
	// \x1b = ESC, \x1b\\ = ESC backslash
	// FIXME: switch to constants once OsStr::new() is const-stable and over our
	// MSRV.
	let osc_8_head = OsStr::new("\x1b]8;;file://");
	let osc_8_tail = OsStr::new("\x1b]8;;\x1b\\");
	let esc_bl = OsStr::new("\x1b\\");

	let absolute_path = fs::canonicalize(pi_uutils_ctx::resolve(path.path())).unwrap_or_default();
	let mut ret = OsString::with_capacity(
		osc_8_head.len()
			+ osc_8_tail.len()
			+ HOSTNAME.len()
			+ esc_bl.len()
			+ absolute_path.as_os_str().len(),
	);
	ret.push(osc_8_head);
	ret.push(HOSTNAME.as_os_str());

	// a set of safe ASCII bytes that don't need encoding
	#[cfg(not(target_os = "windows"))]
	let unencoded = |c| matches!(c, '_' | '-' | '.' | '~' | '/');
	#[cfg(target_os = "windows")]
	let unencoded = |c| matches!(c, '_' | '-' | '.' | '~' | '/' | '\\' | ':');

	for &b in absolute_path.as_os_str().as_encoded_bytes() {
		if b.is_ascii_alphanumeric() || unencoded(b as char) {
			let _ = ret.write_char(b as char);
		} else {
			let _ = write!(ret, "%{b:02x}");
		}
	}

	ret.push(esc_bl);
	ret.push(name);
	ret.push(osc_8_tail);

	ret
}

fn is_hidden(file_path: &DirEntry) -> bool {
	#[cfg(windows)]
	{
		let metadata = file_path.metadata().unwrap();
		let attr = metadata.file_attributes();
		(attr & 0x2) > 0
	}
	#[cfg(not(windows))]
	{
		file_path.file_name().as_encoded_bytes().starts_with(b".")
	}
}

fn update_dired_for_item(
	dired: &mut DiredOutput,
	output_display_len: usize,
	displayed_len: usize,
	dired_name_len: usize,
) {
	let line_len = output_display_len + displayed_len + 1; // +1 for line ending
	dired::calculate_and_update_positions(dired, output_display_len, dired_name_len, line_len);
}

#[cfg(unix)]
fn display_symlink_count(metadata: &Metadata) -> String {
	metadata.nlink().to_string()
}

#[cfg(unix)]
fn display_inode(metadata: &Metadata) -> impl Display {
	metadata.ino().to_string()
}

#[cfg(unix)]
fn calculate_padding_collection(
	items: &[PathData],
	config: &Config,
	state: &mut ListState,
) -> PaddingCollection {
	let mut padding_collections = PaddingCollection {
		inode:      1,
		link_count: 1,
		uname:      1,
		group:      1,
		context:    1,
		size:       1,
		major:      1,
		minor:      1,
		block_size: 1,
	};

	for item in items {
		#[cfg(unix)]
		if config.inode {
			let inode_len = if let Some(md) = item.metadata() {
				digits(md.ino())
			} else {
				continue;
			};
			padding_collections.inode = inode_len.max(padding_collections.inode);
		}

		if config.alloc_size
			&& let Some(md) = item.metadata()
		{
			let block_size_len = display_size(get_block_size(md, config), config).len();
			padding_collections.block_size = block_size_len.max(padding_collections.block_size);
		}

		if config.format == Format::Long {
			let context_len = item.security_context(config).len();
			let (link_count_len, uname_len, group_len, size_len, major_len, minor_len) =
				display_dir_entry_size(item, config, state);
			padding_collections.link_count = link_count_len.max(padding_collections.link_count);
			padding_collections.uname = uname_len.max(padding_collections.uname);
			padding_collections.group = group_len.max(padding_collections.group);
			if config.context {
				padding_collections.context = context_len.max(padding_collections.context);
			}

			// correctly align columns when some files have capabilities/ACLs and others do
			// not
			{
				#[cfg(any(not(unix), target_os = "android", target_os = "macos"))]
				// TODO: See how Mac should work here
				let is_acl_set = false;
				#[cfg(all(unix, not(any(target_os = "android", target_os = "macos"))))]
				let is_acl_set = has_acl(item.display_name());
				if context_len > 1 || is_acl_set {
					padding_collections.link_count += 1;
				}
			}

			if items.len() == 1usize {
				padding_collections.size = 0usize;
				padding_collections.major = 0usize;
				padding_collections.minor = 0usize;
			} else {
				padding_collections.major = major_len.max(padding_collections.major);
				padding_collections.minor = minor_len.max(padding_collections.minor);
				padding_collections.size = size_len
					.max(padding_collections.size)
					.max(padding_collections.major);
			}
		}
	}

	padding_collections
}

#[cfg(not(unix))]
fn display_symlink_count(_metadata: &Metadata) -> String {
	// Currently not sure of how to get this on Windows, so I'm punting.
	// Git Bash looks like it may do the same thing.
	String::from("1")
}

#[cfg(not(unix))]
fn calculate_padding_collection(
	items: &[PathData],
	config: &Config,
	state: &mut ListState,
) -> PaddingCollection {
	let mut padding_collections = PaddingCollection {
		link_count: 1,
		uname:      1,
		group:      1,
		context:    1,
		size:       1,
		block_size: 1,
	};

	for item in items {
		if config.alloc_size {
			if let Some(md) = item.metadata() {
				let block_size_len = display_size(get_block_size(md, config), config).len();
				padding_collections.block_size = block_size_len.max(padding_collections.block_size);
			}
		}

		let context_len = item.security_context(config).len();
		let (link_count_len, uname_len, group_len, size_len, _major_len, _minor_len) =
			display_dir_entry_size(item, config, state);
		padding_collections.link_count = link_count_len.max(padding_collections.link_count);
		padding_collections.uname = uname_len.max(padding_collections.uname);
		padding_collections.group = group_len.max(padding_collections.group);
		if config.context {
			padding_collections.context = context_len.max(padding_collections.context);
		}
		padding_collections.size = size_len.max(padding_collections.size);
	}

	padding_collections
}

fn os_str_starts_with(haystack: &OsStr, needle: &[u8]) -> bool {
	os_str_as_bytes_lossy(haystack).starts_with(needle)
}

fn write_os_str<W: Write>(writer: &mut W, string: &OsStr) -> std::io::Result<()> {
	writer.write_all(&os_str_as_bytes_lossy(string))
}
