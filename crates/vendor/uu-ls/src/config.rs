// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.

// spell-checker:ignore (ToDO) somegroup nlink tabsize dired subdired dtype
// colorterm stringly spell-checker:ignore nohash strtime clocale

use std::{
	borrow::Cow,
	ffi::{OsStr, OsString},
	io::Write,
	num::IntErrorKind,
};

use glob::Pattern;
use lscolors::LsColors;
use term_grid::SPACES_IN_TAB;
use uucore::{
	display::Quotable,
	error::UResult,
	format::human::SizeFormat,
	fsext::MetadataTimeField,
	line_ending::LineEnding,
	parser::{parse_glob, parse_size::parse_size_non_zero_u64},
	quoting_style::QuotingStyle,
	time::format,
};

use crate::{
	LsError,
	colors::{LsColorsParseError, validate_ls_colors_env},
	dired::is_dired_arg_present,
	display::{Format, IndicatorStyle, LocaleQuoting, LongFormat},
	options::QUOTING_STYLE,
};

pub mod options {
	pub mod format {
		pub static ONE_LINE: &str = "1";
		pub static LONG: &str = "long";
		pub static COLUMNS: &str = "C";
		pub static ACROSS: &str = "x";
		pub static TAB_SIZE: &str = "tabsize";
		pub static COMMAS: &str = "m";
		pub static LONG_NO_OWNER: &str = "g";
		pub static LONG_NO_GROUP: &str = "o";
		pub static LONG_NUMERIC_UID_GID: &str = "numeric-uid-gid";
	}

	pub mod files {
		pub static ALL: &str = "all";
		pub static ALMOST_ALL: &str = "almost-all";
		pub static UNSORTED_ALL: &str = "f";
	}

	pub mod sort {
		pub static SIZE: &str = "S";
		pub static TIME: &str = "t";
		pub static NONE: &str = "U";
		pub static VERSION: &str = "v";
		pub static EXTENSION: &str = "X";
	}

	pub mod time {
		pub static ACCESS: &str = "u";
		pub static CHANGE: &str = "c";
	}

	pub mod size {
		pub static ALLOCATION_SIZE: &str = "size";
		pub static BLOCK_SIZE: &str = "block-size";
		pub static HUMAN_READABLE: &str = "human-readable";
		pub static SI: &str = "si";
		pub static KIBIBYTES: &str = "kibibytes";
	}

	pub mod quoting {
		pub static ESCAPE: &str = "escape";
		pub static LITERAL: &str = "literal";
		pub static C: &str = "quote-name";
	}

	pub mod indicator_style {
		pub static SLASH: &str = "p";
		pub static FILE_TYPE: &str = "file-type";
		pub static CLASSIFY: &str = "classify";
	}

	pub mod dereference {
		pub static ALL: &str = "dereference";
		pub static ARGS: &str = "dereference-command-line";
		pub static DIR_ARGS: &str = "dereference-command-line-symlink-to-dir";
	}

	pub static HELP: &str = "help";
	pub static QUOTING_STYLE: &str = "quoting-style";
	pub static HIDE_CONTROL_CHARS: &str = "hide-control-chars";
	pub static SHOW_CONTROL_CHARS: &str = "show-control-chars";
	pub static WIDTH: &str = "width";
	pub static AUTHOR: &str = "author";
	pub static NO_GROUP: &str = "no-group";
	pub static FORMAT: &str = "format";
	pub static SORT: &str = "sort";
	pub static TIME: &str = "time";
	pub static IGNORE_BACKUPS: &str = "ignore-backups";
	pub static DIRECTORY: &str = "directory";
	pub static INODE: &str = "inode";
	pub static REVERSE: &str = "reverse";
	pub static RECURSIVE: &str = "recursive";
	pub static COLOR: &str = "color";
	pub static PATHS: &str = "paths";
	pub static INDICATOR_STYLE: &str = "indicator-style";
	pub static TIME_STYLE: &str = "time-style";
	pub static FULL_TIME: &str = "full-time";
	pub static HIDE: &str = "hide";
	pub static IGNORE: &str = "ignore";
	pub static CONTEXT: &str = "context";
	pub static GROUP_DIRECTORIES_FIRST: &str = "group-directories-first";
	pub static ZERO: &str = "zero";
	pub static DIRED: &str = "dired";
	pub static HYPERLINK: &str = "hyperlink";
}

const DEFAULT_TERM_WIDTH: u16 = 80;
const POSIXLY_CORRECT_BLOCK_SIZE: u64 = 512;
const DEFAULT_BLOCK_SIZE: u64 = 1024;
const DEFAULT_FILE_SIZE_BLOCK_SIZE: u64 = 1;

pub(crate) enum Dereference {
	None,
	DirArgs,
	Args,
	All,
}

#[derive(PartialEq, Eq)]
pub(crate) enum Sort {
	None,
	Name,
	Size,
	Time,
	Version,
	Extension,
	Width,
}

#[derive(PartialEq, Eq)]
pub(crate) enum Files {
	All,
	AlmostAll,
	Normal,
}

pub struct Config {
	// Dir and vdir needs access to this field
	pub format: Format,
	pub(crate) files: Files,
	pub(crate) sort: Sort,
	pub(crate) recursive: bool,
	pub(crate) reverse: bool,
	pub(crate) dereference: Dereference,
	pub(crate) ignore_patterns: Vec<Pattern>,
	pub(crate) size_format: SizeFormat,
	pub(crate) directory: bool,
	pub(crate) time: MetadataTimeField,
	#[cfg(unix)]
	pub(crate) inode: bool,
	pub(crate) color: Option<LsColors>,
	pub(crate) long: LongFormat,
	pub(crate) alloc_size: bool,
	pub(crate) file_size_block_size: u64,
	#[allow(dead_code)]
	pub(crate) block_size: u64, // is never read on Windows
	pub(crate) width: u16,
	// Dir and vdir needs access to this field
	pub quoting_style: QuotingStyle,
	pub(crate) locale_quoting: Option<LocaleQuoting>,
	pub(crate) indicator_style: IndicatorStyle,
	pub(crate) time_format_recent: String, // Time format for recent dates
	pub(crate) time_format_older: Option<String>, /* Time format for older dates (optional, if not
	                                        * present, time_format_recent is used) */
	pub(crate) context: bool,
	#[cfg(all(feature = "selinux", any(target_os = "linux", target_os = "android")))]
	pub(crate) selinux_supported: bool,
	#[cfg(all(feature = "smack", target_os = "linux"))]
	pub(crate) smack_supported: bool,
	pub(crate) group_directories_first: bool,
	pub(crate) line_ending: LineEnding,
	pub(crate) dired: bool,
	pub(crate) hyperlink: bool,
	pub(crate) tab_size: usize,
}

/// Extracts the format to display the information based on the options
/// provided.
///
/// # Returns
///
/// A tuple containing the Format variant and an Option containing a &'static
/// str which corresponds to the option used to define the format.
fn extract_format(options: &clap::ArgMatches) -> (Format, Option<&'static str>) {
	if let Some(format_) = options.get_one::<String>(options::FORMAT) {
		(
			match format_.as_str() {
				"long" | "verbose" => Format::Long,
				"single-column" => Format::OneLine,
				"columns" | "vertical" => Format::Columns,
				"across" | "horizontal" => Format::Across,
				"commas" => Format::Commas,
				// below should never happen as clap already restricts the values.
				_ => unreachable!("Invalid field for --format"),
			},
			Some(options::FORMAT),
		)
	} else if options.get_flag(options::format::LONG) {
		(Format::Long, Some(options::format::LONG))
	} else if options.get_flag(options::format::ACROSS) {
		(Format::Across, Some(options::format::ACROSS))
	} else if options.get_flag(options::format::COMMAS) {
		(Format::Commas, Some(options::format::COMMAS))
	} else if options.get_flag(options::format::COLUMNS) {
		(Format::Columns, Some(options::format::COLUMNS))
	} else if false {
		(Format::Columns, None)
	} else {
		(Format::OneLine, None)
	}
}

/// Extracts the type of files to display
///
/// # Returns
///
/// A Files variant representing the type of files to display.
fn extract_files(options: &clap::ArgMatches) -> Files {
	let get_last_index = |flag: &str| -> usize {
		if options.value_source(flag) == Some(clap::parser::ValueSource::CommandLine) {
			options.index_of(flag).unwrap_or(0)
		} else {
			0
		}
	};

	let all_index = get_last_index(options::files::ALL);
	let almost_all_index = get_last_index(options::files::ALMOST_ALL);
	let unsorted_all_index = get_last_index(options::files::UNSORTED_ALL);

	let max_index = all_index.max(almost_all_index).max(unsorted_all_index);

	if max_index == 0 {
		Files::Normal
	} else if max_index == almost_all_index {
		Files::AlmostAll
	} else {
		// Either -a or -f wins, both show all files
		Files::All
	}
}

/// Extracts the sorting method to use based on the options provided.
///
/// # Returns
///
/// A Sort variant representing the sorting method to use.
fn extract_sort(options: &clap::ArgMatches) -> Sort {
	let get_last_index = |flag: &str| -> usize {
		if options.value_source(flag) == Some(clap::parser::ValueSource::CommandLine) {
			options.index_of(flag).unwrap_or(0)
		} else {
			0
		}
	};

	let sort_index = options
		.get_one::<String>(options::SORT)
		.and_then(|_| options.indices_of(options::SORT))
		.map_or(0, |mut indices| indices.next_back().unwrap_or(0));
	let time_index = get_last_index(options::sort::TIME);
	let size_index = get_last_index(options::sort::SIZE);
	let none_index = get_last_index(options::sort::NONE);
	let version_index = get_last_index(options::sort::VERSION);
	let extension_index = get_last_index(options::sort::EXTENSION);
	let unsorted_all_index = get_last_index(options::files::UNSORTED_ALL);

	let max_sort_index = sort_index
		.max(time_index)
		.max(size_index)
		.max(none_index)
		.max(version_index)
		.max(extension_index)
		.max(unsorted_all_index);

	match max_sort_index {
		0 => {
			// No sort flags specified, use default behavior
			if !options.get_flag(options::format::LONG)
				&& (options.get_flag(options::time::ACCESS)
					|| options.get_flag(options::time::CHANGE)
					|| options.get_one::<String>(options::TIME).is_some())
			{
				Sort::Time
			} else {
				Sort::Name
			}
		},
		idx if idx == unsorted_all_index || idx == none_index => Sort::None,
		idx if idx == sort_index => {
			if let Some(field) = options.get_one::<String>(options::SORT) {
				match field.as_str() {
					"none" => Sort::None,
					"name" => Sort::Name,
					"time" => Sort::Time,
					"size" => Sort::Size,
					"version" => Sort::Version,
					"extension" => Sort::Extension,
					"width" => Sort::Width,
					_ => unreachable!("Invalid field for --sort"),
				}
			} else {
				Sort::Name
			}
		},
		idx if idx == time_index => Sort::Time,
		idx if idx == size_index => Sort::Size,
		idx if idx == version_index => Sort::Version,
		idx if idx == extension_index => Sort::Extension,
		_ => Sort::Name,
	}
}

/// Extracts the time to use based on the options provided.
///
/// # Returns
///
/// A `MetadataTimeField` variant representing the time to use.
fn extract_time(options: &clap::ArgMatches) -> MetadataTimeField {
	if let Some(field) = options.get_one::<String>(options::TIME) {
		field.as_str().into()
	} else if options.get_flag(options::time::ACCESS) {
		MetadataTimeField::Access
	} else if options.get_flag(options::time::CHANGE) {
		MetadataTimeField::Change
	} else {
		MetadataTimeField::Modification
	}
}

/// Some env variables can be passed
/// For now, we are only verifying if empty or not and known for `TERM`
fn is_color_compatible_term() -> bool {
	let term = pi_uutils_ctx::var("TERM").map(OsString::from);
	let colorterm = pi_uutils_ctx::var("COLORTERM").map(OsString::from);

	// Search function in the TERM struct to manage the wildcards
	let term_matches = |term: &OsStr| -> bool {
		uucore::colors::TERMS.iter().any(|&pattern| {
			term == pattern
				|| (pattern.ends_with('*')
					&& term
						.as_encoded_bytes()
						.starts_with(&pattern.as_bytes()[..pattern.len() - 1]))
		})
	};

	match (term, colorterm) {
		(Some(t), Some(c)) if t.is_empty() && c.is_empty() => false,
		(Some(t), _) if !t.is_empty() => term_matches(&t),
		_ => true,
	}
}

/// Extracts the color option to use based on the options provided.
///
/// # Returns
///
/// A boolean representing whether or not to use color.
fn extract_color(options: &clap::ArgMatches) -> bool {
	if !is_color_compatible_term() {
		return false;
	}

	let get_last_index = |flag: &str| -> usize {
		if options.value_source(flag) == Some(clap::parser::ValueSource::CommandLine) {
			options.index_of(flag).unwrap_or(0)
		} else {
			0
		}
	};

	let color_index = options
		.get_one::<String>(options::COLOR)
		.and_then(|_| options.indices_of(options::COLOR))
		.map_or(0, |mut indices| indices.next_back().unwrap_or(0));
	let unsorted_all_index = get_last_index(options::files::UNSORTED_ALL);

	let color_enabled = match options.get_one::<String>(options::COLOR) {
		None => options.contains_id(options::COLOR),
		Some(val) => match val.as_str() {
			"" | "always" | "yes" | "force" => true,
			"auto" | "tty" | "if-tty" => false,
			/* "never" | "no" | "none" | */ _ => false,
		},
	};

	// If --color was explicitly specified, always honor it regardless of -f
	// Otherwise, if -f is present without explicit color, disable color
	if color_index > 0 {
		// Color was explicitly specified
		color_enabled
	} else if unsorted_all_index > 0 {
		// -f present without explicit color, disable implicit color
		false
	} else {
		color_enabled
	}
}

/// Extracts the hyperlink option to use based on the options provided.
///
/// # Returns
///
/// A boolean representing whether to hyperlink files.
fn extract_hyperlink(options: &clap::ArgMatches) -> bool {
	let hyperlink = options
		.get_one::<String>(options::HYPERLINK)
		.unwrap()
		.as_str();

	match hyperlink {
		"always" | "yes" | "force" => true,
		"auto" | "tty" | "if-tty" => false,
		"never" | "no" | "none" => false,
		_ => unreachable!("should be handled by clap"),
	}
}

/// Match the argument given to --quoting-style or the [`QUOTING_STYLE`] env
/// variable.
///
/// # Arguments
///
/// * `style`: the actual argument string
/// * `show_control` - A boolean value representing whether to show control
///   characters.
///
/// # Returns
///
/// * An option with None if the style string is invalid, or a `QuotingStyle`
///   wrapped in `Some`.
struct QuotingStyleSpec {
	style:         QuotingStyle,
	fixed_control: bool,
	locale:        Option<LocaleQuoting>,
}

impl QuotingStyleSpec {
	fn new(style: QuotingStyle) -> Self {
		Self { style, fixed_control: false, locale: None }
	}

	fn with_locale(style: QuotingStyle, locale: LocaleQuoting) -> Self {
		Self { style, fixed_control: true, locale: Some(locale) }
	}
}
fn match_quoting_style_name(
	style: &str,
	show_control: bool,
) -> Option<(QuotingStyle, Option<LocaleQuoting>)> {
	let spec = match style {
		"literal" => QuotingStyleSpec::new(QuotingStyle::Literal { show_control: false }),
		"shell" => QuotingStyleSpec::new(QuotingStyle::SHELL),
		"shell-always" => QuotingStyleSpec::new(QuotingStyle::SHELL_QUOTE),
		"shell-escape" => QuotingStyleSpec::new(QuotingStyle::SHELL_ESCAPE),
		"shell-escape-always" => QuotingStyleSpec::new(QuotingStyle::SHELL_ESCAPE_QUOTE),
		"c" => QuotingStyleSpec::new(QuotingStyle::C_DOUBLE),
		"escape" => QuotingStyleSpec::new(QuotingStyle::C_NO_QUOTES),
		"locale" => QuotingStyleSpec {
			style:         QuotingStyle::Literal { show_control: false },
			fixed_control: true,
			locale:        Some(LocaleQuoting::Single),
		},
		"clocale" => QuotingStyleSpec::with_locale(QuotingStyle::C_DOUBLE, LocaleQuoting::Double),
		_ => return None,
	};

	let style = if spec.fixed_control {
		spec.style
	} else {
		spec.style.show_control(show_control)
	};

	Some((style, spec.locale))
}

/// Extracts the quoting style to use based on the options provided.
/// If no options are given, it looks if a default quoting style is provided
/// through the [`QUOTING_STYLE`] environment variable.
///
/// # Arguments
///
/// * `options` - A reference to a [`clap::ArgMatches`] object containing
///   command line arguments.
/// * `show_control` - A boolean value representing whether or not to show
///   control characters.
///
/// # Returns
///
/// A [`QuotingStyle`] variant representing the quoting style to use.
fn extract_quoting_style(
	options: &clap::ArgMatches,
	show_control: bool,
) -> (QuotingStyle, Option<LocaleQuoting>) {
	let opt_quoting_style = options.get_one::<String>(QUOTING_STYLE);

	if let Some(style) = opt_quoting_style {
		match match_quoting_style_name(style, show_control) {
			Some(pair) => pair,
			None => unreachable!("Should have been caught by Clap"),
		}
	} else if options.get_flag(options::quoting::LITERAL) {
		(QuotingStyle::Literal { show_control }, None)
	} else if options.get_flag(options::quoting::ESCAPE) {
		(QuotingStyle::C_NO_QUOTES, None)
	} else if options.get_flag(options::quoting::C) {
		(QuotingStyle::C_DOUBLE, None)
	} else if options.get_flag(options::DIRED) {
		(QuotingStyle::Literal { show_control }, None)
	} else {
		// If set, the QUOTING_STYLE environment variable specifies a default style.
		if let Some(style) = pi_uutils_ctx::var("QUOTING_STYLE") {
			match match_quoting_style_name(style.as_str(), show_control) {
				Some(pair) => return pair,
				None => {
					let _ = writeln!(
						pi_uutils_ctx::stderr(),
						"ls: Ignoring invalid value of environment variable QUOTING_STYLE: '{}'",
						style
					);
				},
			}
		}

		// By default, `ls` uses Shell escape quoting style when writing to a terminal
		// file descriptor and Literal otherwise.
		if false {
			(QuotingStyle::SHELL_ESCAPE.show_control(show_control), None)
		} else {
			(QuotingStyle::Literal { show_control }, None)
		}
	}
}

/// Extracts the indicator style to use based on the options provided.
///
/// # Returns
///
/// An [`IndicatorStyle`] variant representing the indicator style to use.
fn extract_indicator_style(options: &clap::ArgMatches) -> IndicatorStyle {
	if let Some(field) = options.get_one::<String>(options::INDICATOR_STYLE) {
		match field.as_str() {
			"none" => IndicatorStyle::None,
			"file-type" => IndicatorStyle::FileType,
			"classify" => IndicatorStyle::Classify,
			"slash" => IndicatorStyle::Slash,
			&_ => IndicatorStyle::None,
		}
	} else if let Some(field) = options.get_one::<String>(options::indicator_style::CLASSIFY) {
		match field.as_str() {
			"never" | "no" | "none" => IndicatorStyle::None,
			"always" | "yes" | "force" => IndicatorStyle::Classify,
			"auto" | "tty" | "if-tty" => {
				if false {
					IndicatorStyle::Classify
				} else {
					IndicatorStyle::None
				}
			},
			&_ => IndicatorStyle::None,
		}
	} else if options.get_flag(options::indicator_style::SLASH) {
		IndicatorStyle::Slash
	} else if options.get_flag(options::indicator_style::FILE_TYPE) {
		IndicatorStyle::FileType
	} else {
		IndicatorStyle::None
	}
}

/// Parses the width value from either the command line arguments or the
/// environment variables.
fn parse_width(width_match: Option<&String>) -> Result<u16, LsError> {
	let parse_width_from_args = |s: &str| -> Result<u16, LsError> {
		let radix = if s.starts_with('0') && s.len() > 1 {
			8
		} else {
			10
		};
		match u16::from_str_radix(s, radix) {
			Ok(x) => Ok(x),
			Err(e) => match e.kind() {
				IntErrorKind::PosOverflow => Ok(u16::MAX),
				_ => Err(LsError::InvalidLineWidth(s.into())),
			},
		}
	};

	let parse_width_from_env = |columns: OsString| {
		if let Some(columns) = columns.to_str().and_then(|s| s.parse().ok()) {
			columns
		} else {
			let _ = writeln!(
				pi_uutils_ctx::stderr(),
				"ls: ignoring invalid width in environment variable COLUMNS: {}",
				columns.quote()
			);
			DEFAULT_TERM_WIDTH
		}
	};

	let calculate_term_size = || DEFAULT_TERM_WIDTH;

	let ret = match width_match {
		Some(x) => parse_width_from_args(x)?,
		None => match pi_uutils_ctx::var("COLUMNS").map(OsString::from) {
			Some(columns) => parse_width_from_env(columns),
			None => calculate_term_size(),
		},
	};

	Ok(ret)
}

impl Config {
	#[allow(clippy::cognitive_complexity)]
	pub fn from(options: &clap::ArgMatches) -> UResult<Self> {
		let context = options.get_flag(options::CONTEXT);
		let (mut format, opt) = extract_format(options);
		let files = extract_files(options);

		// The -o, -n and -g options are tricky. They cannot override with each
		// other because it's possible to combine them. For example, the option
		// -og should hide both owner and group. Furthermore, they are not
		// reset if -l or --format=long is used. So these should just show the
		// group: -gl or "-g --format=long". Finally, they are also not reset
		// when switching to a different format option in-between like this:
		// -ogCl or "-og --format=vertical --format=long".
		//
		// -1 has a similar issue: it does nothing if the format is long. This
		// actually makes it distinct from the --format=singe-column option,
		// which always applies.
		//
		// The idea here is to not let these options override with the other
		// options, but manually whether they have an index that's greater than
		// the other format options. If so, we set the appropriate format.
		if format != Format::Long {
			let idx = opt
				.and_then(|opt| options.indices_of(opt).map(|x| x.max().unwrap()))
				.unwrap_or(0);
			if [
				options::format::LONG_NO_OWNER,
				options::format::LONG_NO_GROUP,
				options::format::LONG_NUMERIC_UID_GID,
				options::FULL_TIME,
			]
			.iter()
			.filter_map(|opt| {
				if options.value_source(opt) == Some(clap::parser::ValueSource::CommandLine) {
					options.indices_of(opt)
				} else {
					None
				}
			})
			.flatten()
			.any(|i| i >= idx)
			{
				format = Format::Long;
			} else if let Some(mut indices) = options.indices_of(options::format::ONE_LINE)
				&& options.value_source(options::format::ONE_LINE)
					== Some(clap::parser::ValueSource::CommandLine)
				&& indices.any(|i| i > idx)
			{
				format = Format::OneLine;
			}
		}

		let sort = extract_sort(options);
		let time = extract_time(options);
		let mut needs_color = extract_color(options);
		let hyperlink = extract_hyperlink(options);

		let opt_block_size = options.get_one::<String>(options::size::BLOCK_SIZE);
		let opt_si = opt_block_size.is_some_and(|x| x == options::size::SI)
			|| options.get_flag(options::size::SI);
		let opt_hr = opt_block_size.is_some_and(|x| x == options::size::HUMAN_READABLE)
			|| options.get_flag(options::size::HUMAN_READABLE);
		let opt_kb = options.get_flag(options::size::KIBIBYTES);

		let size_format = if opt_si {
			SizeFormat::Decimal
		} else if opt_hr {
			SizeFormat::Binary
		} else {
			SizeFormat::Bytes
		};

		let env_var_blocksize = pi_uutils_ctx::var("BLOCKSIZE").map(OsString::from);
		let env_var_block_size = pi_uutils_ctx::var("BLOCK_SIZE").map(OsString::from);
		let env_var_ls_block_size = pi_uutils_ctx::var("LS_BLOCK_SIZE").map(OsString::from);
		let env_var_posixly_correct = pi_uutils_ctx::var("POSIXLY_CORRECT").map(OsString::from);
		let mut is_env_var_blocksize = false;

		let raw_block_size = if let Some(opt_block_size) = opt_block_size {
			OsString::from(opt_block_size)
		} else if let Some(env_var_ls_block_size) = env_var_ls_block_size {
			env_var_ls_block_size
		} else if let Some(env_var_block_size) = env_var_block_size {
			env_var_block_size
		} else if let Some(env_var_blocksize) = env_var_blocksize {
			is_env_var_blocksize = true;
			env_var_blocksize
		} else {
			OsString::from("")
		};

		let (file_size_block_size, block_size) = if !opt_si && !opt_hr && !raw_block_size.is_empty() {
			if let Ok(size) = parse_size_non_zero_u64(&raw_block_size.to_string_lossy()) {
				match (is_env_var_blocksize, opt_kb) {
					(true, true) => (DEFAULT_FILE_SIZE_BLOCK_SIZE, DEFAULT_BLOCK_SIZE),
					(true, false) => (DEFAULT_FILE_SIZE_BLOCK_SIZE, size),
					(false, true) => {
						// --block-size overrides -k
						if opt_block_size.is_some() {
							(size, size)
						} else {
							(size, DEFAULT_BLOCK_SIZE)
						}
					},
					(false, false) => (size, size),
				}
			} else {
				// only fail if invalid block size was specified with --block-size,
				// ignore invalid block size from env vars
				if let Some(invalid_block_size) = opt_block_size {
					return Err(Box::new(LsError::BlockSizeParseError(invalid_block_size.clone())));
				}
				if is_env_var_blocksize {
					(DEFAULT_FILE_SIZE_BLOCK_SIZE, DEFAULT_BLOCK_SIZE)
				} else {
					(DEFAULT_BLOCK_SIZE, DEFAULT_BLOCK_SIZE)
				}
			}
		} else if env_var_posixly_correct.is_some() {
			if opt_kb {
				(DEFAULT_FILE_SIZE_BLOCK_SIZE, DEFAULT_BLOCK_SIZE)
			} else {
				(DEFAULT_FILE_SIZE_BLOCK_SIZE, POSIXLY_CORRECT_BLOCK_SIZE)
			}
		} else if opt_si {
			(DEFAULT_FILE_SIZE_BLOCK_SIZE, 1000)
		} else {
			(DEFAULT_FILE_SIZE_BLOCK_SIZE, DEFAULT_BLOCK_SIZE)
		};

		let long = {
			let author = options.get_flag(options::AUTHOR);
			let group = !options.get_flag(options::NO_GROUP)
				&& !options.get_flag(options::format::LONG_NO_GROUP);
			let owner = !options.get_flag(options::format::LONG_NO_OWNER);
			#[cfg(unix)]
			let numeric_uid_gid = options.get_flag(options::format::LONG_NUMERIC_UID_GID);
			LongFormat {
				author,
				group,
				owner,
				#[cfg(unix)]
				numeric_uid_gid,
			}
		};
		let width = parse_width(options.get_one::<String>(options::WIDTH))?;

		// pi-uutils: non-tty context, so SHOW_CONTROL_CHARS and the default both
		// enable control chars; only --hide-control-chars disables them.
		let mut show_control = !options.get_flag(options::HIDE_CONTROL_CHARS);

		let (mut quoting_style, mut locale_quoting) = extract_quoting_style(options, show_control);
		let indicator_style = extract_indicator_style(options);
		// Only parse the value to "--time-style" if it will become relevant.
		let dired = options.get_flag(options::DIRED);
		let (time_format_recent, time_format_older) = if format == Format::Long || dired {
			parse_time_style(options)?
		} else {
			Default::default()
		};

		let mut ignore_patterns: Vec<Pattern> = Vec::new();

		if options.get_flag(options::IGNORE_BACKUPS) {
			ignore_patterns.push(Pattern::new("*~").unwrap());
			ignore_patterns.push(Pattern::new(".*~").unwrap());
		}

		for pattern in options
			.get_many::<String>(options::IGNORE)
			.into_iter()
			.flatten()
		{
			if let Ok(p) = parse_glob::from_str(pattern) {
				ignore_patterns.push(p);
			} else {
				let _ = writeln!(
					pi_uutils_ctx::stderr(),
					"ls: warning: Invalid pattern for ignore: {}",
					pattern.quote()
				);
			}
		}

		if files == Files::Normal {
			for pattern in options
				.get_many::<String>(options::HIDE)
				.into_iter()
				.flatten()
			{
				if let Ok(p) = parse_glob::from_str(pattern) {
					ignore_patterns.push(p);
				} else {
					let _ = writeln!(
						pi_uutils_ctx::stderr(),
						"ls: warning: Invalid pattern for hide: {}",
						pattern.quote()
					);
				}
			}
		}

		// According to ls info page, `--zero` implies the following flags:
		//  - `--show-control-chars`
		//  - `--format=single-column`
		//  - `--color=none`
		//  - `--quoting-style=literal`
		// Current GNU ls implementation allows `--zero` Behavior to be
		// overridden by later flags.
		let zero_formats_opts = [
			options::format::ACROSS,
			options::format::COLUMNS,
			options::format::COMMAS,
			options::format::LONG,
			options::format::LONG_NO_GROUP,
			options::format::LONG_NO_OWNER,
			options::format::LONG_NUMERIC_UID_GID,
			options::format::ONE_LINE,
			options::FORMAT,
		];
		let zero_colors_opts = [options::COLOR];
		let zero_show_control_opts = [options::HIDE_CONTROL_CHARS, options::SHOW_CONTROL_CHARS];
		let zero_quoting_style_opts =
			[QUOTING_STYLE, options::quoting::C, options::quoting::ESCAPE, options::quoting::LITERAL];
		let get_last = |flag: &str| -> usize {
			if options.value_source(flag) == Some(clap::parser::ValueSource::CommandLine) {
				options.index_of(flag).unwrap_or(0)
			} else {
				0
			}
		};
		if get_last(options::ZERO)
			> zero_formats_opts
				.into_iter()
				.map(get_last)
				.max()
				.unwrap_or(0)
		{
			format = if format == Format::Long {
				format
			} else {
				Format::OneLine
			};
		}
		if get_last(options::ZERO)
			> zero_colors_opts
				.into_iter()
				.map(get_last)
				.max()
				.unwrap_or(0)
		{
			needs_color = false;
		}
		if get_last(options::ZERO)
			> zero_show_control_opts
				.into_iter()
				.map(get_last)
				.max()
				.unwrap_or(0)
		{
			show_control = true;
		}
		if get_last(options::ZERO)
			> zero_quoting_style_opts
				.into_iter()
				.map(get_last)
				.max()
				.unwrap_or(0)
		{
			quoting_style = QuotingStyle::Literal { show_control };
			locale_quoting = None;
		}

		if needs_color && let Err(err) = validate_ls_colors_env() {
			if let LsColorsParseError::UnrecognizedPrefix(prefix) = &err {
				let _ = writeln!(
					pi_uutils_ctx::stderr(),
					"ls: warning: unrecognized prefix: {}",
					prefix.quote()
				);
			}
			let _ = writeln!(
				pi_uutils_ctx::stderr(),
				"ls: warning: unparsable value for LS_COLORS environment variable"
			);
			needs_color = false;
		}

		let color = if needs_color {
			Some(match pi_uutils_ctx::var("LS_COLORS") {
				Some(s) => LsColors::from_string(&s),
				None => LsColors::default(),
			})
		} else {
			None
		};

		if dired || is_dired_arg_present() {
			// --dired implies --format=long
			// if we have --dired --hyperlink, we don't show dired but we still want to see
			// the long format
			format = Format::Long;
		}
		if dired && options.get_flag(options::ZERO) {
			return Err(Box::new(LsError::DiredAndZeroAreIncompatible));
		}

		let dereference = if options.get_flag(options::dereference::ALL) {
			Dereference::All
		} else if options.get_flag(options::dereference::ARGS) {
			Dereference::Args
		} else if options.get_flag(options::dereference::DIR_ARGS) {
			Dereference::DirArgs
		} else if options.get_flag(options::DIRECTORY)
			|| indicator_style == IndicatorStyle::Classify
			|| format == Format::Long
		{
			Dereference::None
		} else {
			Dereference::DirArgs
		};

		let tab_size = if needs_color {
			Some(0)
		} else {
			options
				.get_one::<String>(options::format::TAB_SIZE)
				.and_then(|size| size.parse::<usize>().ok())
				.or_else(|| pi_uutils_ctx::var("TABSIZE").and_then(|s| s.parse().ok()))
		}
		.unwrap_or(SPACES_IN_TAB);

		Ok(Self {
			format,
			files,
			sort,
			recursive: options.get_flag(options::RECURSIVE),
			reverse: options.get_flag(options::REVERSE),
			dereference,
			ignore_patterns,
			size_format,
			directory: options.get_flag(options::DIRECTORY),
			time,
			color,
			#[cfg(unix)]
			inode: options.get_flag(options::INODE),
			long,
			alloc_size: options.get_flag(options::size::ALLOCATION_SIZE),
			file_size_block_size,
			block_size,
			width,
			quoting_style,
			locale_quoting,
			indicator_style,
			time_format_recent,
			time_format_older,
			context,
			#[cfg(all(feature = "selinux", any(target_os = "linux", target_os = "android")))]
			selinux_supported: uucore::selinux::is_selinux_enabled(),
			#[cfg(all(feature = "smack", target_os = "linux"))]
			smack_supported: uucore::smack::is_smack_enabled(),
			group_directories_first: options.get_flag(options::GROUP_DIRECTORIES_FIRST),
			line_ending: LineEnding::from_zero_flag(options.get_flag(options::ZERO)),
			dired,
			hyperlink,
			tab_size,
		})
	}
}

fn parse_time_style(options: &clap::ArgMatches) -> Result<(String, Option<String>), LsError> {
	// TODO: Using correct locale string is not implemented.
	const LOCALE_FORMAT: (&str, Option<&str>) = ("%b %e %H:%M", Some("%b %e  %Y"));

	// Convert time_styles references to owned String/option.
	#[expect(clippy::unnecessary_wraps, reason = "internal result helper")]
	fn ok((recent, older): (&str, Option<&str>)) -> Result<(String, Option<String>), LsError> {
		Ok((recent.to_string(), older.map(String::from)))
	}

	if let Some(field) = options
		.get_one::<String>(options::TIME_STYLE)
		.map(Cow::from)
		.or_else(|| pi_uutils_ctx::var("TIME_STYLE").map(Cow::from))
	{
		//If both FULL_TIME and TIME_STYLE are present
		//The one added last is dominant
		if options.get_flag(options::FULL_TIME)
			&& options.indices_of(options::FULL_TIME).unwrap().next_back()
				> options.indices_of(options::TIME_STYLE).unwrap().next_back()
		{
			ok((format::FULL_ISO, None))
		} else {
			let field = if let Some(field) = field.strip_prefix("posix-") {
				// See GNU documentation, set format to "locale" if LC_TIME="POSIX",
				// else just strip the prefix and continue (even "posix+FORMAT" is
				// supported).
				// TODO: This needs to be moved to uucore and handled by icu?
				if pi_uutils_ctx::var("LC_TIME").as_deref() == Some("POSIX")
					|| pi_uutils_ctx::var("LC_ALL").as_deref() == Some("POSIX")
				{
					return ok(LOCALE_FORMAT);
				}
				field
			} else {
				&field
			};

			match field {
				"full-iso" => ok((format::FULL_ISO, None)),
				"long-iso" => ok((format::LONG_ISO, None)),
				// ISO older format needs extra padding.
				"iso" => Ok(("%m-%d %H:%M".to_string(), Some(format::ISO.to_string() + " "))),
				"locale" => ok(LOCALE_FORMAT),
				_ => match field.chars().next().unwrap() {
					'+' => {
						// recent/older formats are (optionally) separated by a newline
						let mut it = field[1..].split('\n');
						let recent = it.next().unwrap_or_default();
						let older = it.next();
						match it.next() {
							None => ok((recent, older)),
							Some(_) => Err(LsError::TimeStyleParseError(String::from(field))),
						}
					},
					_ => Err(LsError::TimeStyleParseError(String::from(field))),
				},
			}
		}
	} else if options.get_flag(options::FULL_TIME) {
		ok((format::FULL_ISO, None))
	} else {
		ok(LOCALE_FORMAT)
	}
}
