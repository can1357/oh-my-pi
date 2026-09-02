//! `ls` builtin: list directory contents.
//!
//! Ported from uutils coreutils 0.8.0.

#[cfg(unix)]
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::{
	borrow::Cow,
	cell::{Cell, OnceCell, RefCell},
	cmp::Reverse,
	ffi::{OsStr, OsString},
	fs::{self, DirEntry, FileType, Metadata, ReadDir},
	io::{ErrorKind, Write},
	ops::RangeInclusive,
	path::{Path, PathBuf},
	rc::Rc,
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use brush_core::{ShellExtensions, builtins::Registration, openfiles::OpenFile};
use clap::{
	Arg, ArgAction, ArgMatches, Command,
	builder::{NonEmptyStringValueParser, PossibleValue, ValueParser},
};
use lscolors::Colorable;
#[cfg(unix)]
use rustc_hash::FxHashMap;
use rustc_hash::FxHashSet;
use thiserror::Error;
#[cfg(unix)]
use uucore::libc::{S_IXGRP, S_IXOTH, S_IXUSR};
use uucore::{
	display::Quotable,
	fs::FileInformation,
	fsext::metadata_get_time,
	parser::shortcut_value_parser::ShortcutValueParser,
	version_cmp::version_cmp,
};

use crate::host::{Host, StreamWriter, Utility, format_usage, matches_parser, os_bytes_lossy, util};

mod colors {
//! Color handling for the `ls` builtin.
#[cfg(unix)]
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::{
	borrow::Cow,
	ffi::OsString,
	fs::{self, Metadata},
};

use lscolors::{Indicator, LsColors, Style};
use rustc_hash::FxHashMap;

use super::PathData;

/// ANSI CSI (Control Sequence Introducer)
const ANSI_CSI: &str = "\x1b[";
const ANSI_SGR_END: &str = "m";
const ANSI_RESET: &str = "\x1b[0m";
const ANSI_CLEAR_EOL: &str = "\x1b[K";
const EMPTY_STYLE: &str = "\x1b[m";

#[cfg(unix)]
mod mode {
	// Unix file mode bits
	pub const SETUID: u32 = 0o4000;
	pub const SETGID: u32 = 0o2000;
	pub const EXECUTABLE: u32 = 0o0111;
	pub const STICKY_OTHER_WRITABLE: u32 = 0o1002;
	pub const OTHER_WRITABLE: u32 = 0o0002;
	pub const STICKY: u32 = 0o1000;
}

enum RawIndicatorStyle {
	Empty,
	Code(Indicator),
}

/// We need this struct to be able to store the previous style.
/// This because we need to check the previous value in case we don't need
/// the reset
pub(crate) struct StyleManager<'a> {
	/// last style that is applied, if `None` that means reset is applied.
	pub(crate) current_style:         Option<Style>,
	/// `true` if the initial reset is applied
	pub(crate) initial_reset_is_done: bool,
	pub(crate) colors:                &'a LsColors,
	/// raw indicator codes as specified in LS_COLORS (if available)
	indicator_codes:                  FxHashMap<Indicator, String>,
	/// whether ln=target is active
	ln_color_from_target:             bool,
}

impl<'a> StyleManager<'a> {
	pub(crate) fn new(colors: &'a LsColors, ls_colors: Option<&str>) -> Self {
		let (indicator_codes, ln_color_from_target) = parse_indicator_codes(ls_colors);
		Self {
			initial_reset_is_done: false,
			current_style: None,
			colors,
			indicator_codes,
			ln_color_from_target,
		}
	}

	pub(crate) fn apply_style(
		&mut self,
		new_style: Option<&Style>,
		path: Option<&PathData>,
		name: OsString,
		wrap: bool,
	) -> OsString {
		let mut style_code = String::new();
		let mut force_suffix_reset: bool = false;
		let mut applied_raw_code = false;

		if self.is_reset()
			&& let Some(norm_sty) = self.get_normal_style().copied()
		{
			style_code.push_str(&self.get_style_code(&norm_sty));
		}

		if let Some(path) = path {
			// Fast-path: apply LS_COLORS raw SGR codes verbatim,
			// bypassing LsColors fallbacks so the entry from LS_COLORS
			// is honored exactly as specified.
			match self.raw_indicator_style_for_path(path) {
				Some(RawIndicatorStyle::Empty) => {
					// An explicit empty entry (e.g. "or=") disables coloring and
					// bypasses fallbacks, matching GNU ls behavior.
					return self.apply_empty_style(name, wrap);
				},
				Some(RawIndicatorStyle::Code(indicator)) => {
					self.append_raw_style_code_for_indicator(indicator, &mut style_code);
					applied_raw_code = true;
					self.current_style = None;
					force_suffix_reset = true;
				},
				None => {},
			}
		}

		if !applied_raw_code {
			self.append_style_code_for_style(new_style, &mut style_code, &mut force_suffix_reset);
		}

		// we need this clear to eol code in some terminals, for instance if the
		// text is in the last row of the terminal meaning the terminal need to
		// scroll up in order to print new text in this situation if the clear
		// to eol code is not present the background of the text would stretch
		// till the end of line
		let clear_to_eol = if wrap { ANSI_CLEAR_EOL } else { "" };

		let mut ret: OsString = style_code.into();
		ret.push(name);
		ret.push(self.reset(force_suffix_reset));
		ret.push(clear_to_eol);
		ret
	}

	fn raw_indicator_style_for_path(&self, path: &PathData) -> Option<RawIndicatorStyle> {
		let indicator = self.indicator_for_raw_code(path)?;
		let should_skip = indicator == Indicator::SymbolicLink
			&& self.ln_color_from_target
			&& path.fs_path.exists();

		if should_skip {
			return None;
		}

		let raw = self.indicator_codes.get(&indicator)?;
		if raw.is_empty() {
			Some(RawIndicatorStyle::Empty)
		} else {
			Some(RawIndicatorStyle::Code(indicator))
		}
	}

	// Append a raw SGR sequence for a validated LS_COLORS indicator.
	fn append_raw_style_code_for_indicator(
		&mut self,
		indicator: Indicator,
		style_code: &mut String,
	) {
		if let Some(raw) = self.indicator_codes.get(&indicator).cloned() {
			debug_assert!(!raw.is_empty());
			style_code.push_str(self.reset(!self.initial_reset_is_done));
			style_code.push_str(ANSI_CSI);
			style_code.push_str(&raw);
			style_code.push_str(ANSI_SGR_END);
		}
	}

	fn build_raw_style_code(&mut self, raw: &str) -> String {
		let mut style_code = String::new();
		style_code.push_str(self.reset(!self.initial_reset_is_done));
		style_code.push_str(ANSI_CSI);
		style_code.push_str(raw);
		style_code.push_str(ANSI_SGR_END);
		style_code
	}

	fn append_style_code_for_style(
		&mut self,
		new_style: Option<&Style>,
		style_code: &mut String,
		force_suffix_reset: &mut bool,
	) {
		if let Some(new_style) = new_style {
			// we only need to apply a new style if it's not the same as the current
			// style for example if normal is the current style and a file with
			// normal style is to be printed we could skip printing new color
			// codes
			if !self.is_current_style(new_style) {
				style_code.push_str(self.reset(!self.initial_reset_is_done));
				style_code.push_str(&self.get_style_code(new_style));
			}
		}
		// if new style is None and current style is Normal we should reset it
		else if matches!(self.get_normal_style().copied(), Some(norm_style) if self.is_current_style(&norm_style))
		{
			style_code.push_str(self.reset(false));
			// even though this is an unnecessary reset for gnu compatibility we allow it
			// here
			*force_suffix_reset = true;
		}
	}

	/// Resets the current style and returns the default ANSI reset code to
	/// reset all text formatting attributes. If `force` is true, the reset is
	/// done even if the reset has been applied before.
	pub(crate) fn reset(&mut self, force: bool) -> &'static str {
		// todo:
		// We need to use style from `Indicator::Reset` but as of now ls colors
		// uses a fallback mechanism and because of that if `Indicator::Reset`
		// is not specified it would fallback to `Indicator::Normal` which seems
		// to be non compatible with gnu
		if self.current_style.is_some() || force {
			self.initial_reset_is_done = true;
			self.current_style = None;
			return ANSI_RESET;
		}
		""
	}

	pub(crate) fn get_style_code(&mut self, new_style: &Style) -> String {
		self.current_style = Some(*new_style);
		let mut nu_a_style = new_style.to_nu_ansi_term_style();
		nu_a_style.prefix_with_reset = false;
		let mut ret = nu_a_style.paint("").to_string();
		// remove the suffix reset
		ret.truncate(ret.len() - 4);
		ret
	}

	pub(crate) fn is_current_style(&self, new_style: &Style) -> bool {
		matches!(&self.current_style, Some(style) if style == new_style)
	}

	pub(crate) fn is_reset(&self) -> bool {
		self.current_style.is_none()
	}

	pub(crate) fn get_normal_style(&self) -> Option<&Style> {
		self.colors.style_for_indicator(Indicator::Normal)
	}

	pub(crate) fn apply_normal(&mut self) -> String {
		if let Some(sty) = self.get_normal_style().copied() {
			return self.get_style_code(&sty);
		}
		String::new()
	}

	pub(crate) fn apply_style_based_on_metadata(
		&mut self,
		path: &PathData,
		md_option: Option<&Metadata>,
		name: OsString,
		wrap: bool,
	) -> OsString {
		let style = self
			.colors
			.style_for_path_with_metadata(&path.p_buf, md_option);
		self.apply_style(style, Some(path), name, wrap)
	}

	pub(crate) fn apply_style_for_path(
		&mut self,
		path: &PathData,
		name: OsString,
		wrap: bool,
	) -> OsString {
		let style = self.colors.style_for(path);
		self.apply_style(style, Some(path), name, wrap)
	}

	pub(crate) fn apply_indicator_style(
		&mut self,
		indicator: Indicator,
		name: OsString,
		wrap: bool,
	) -> OsString {
		if let Some(raw) = self.indicator_codes.get(&indicator).cloned() {
			if raw.is_empty() {
				return self.apply_empty_style(name, wrap);
			}

			let mut ret: OsString = self.build_raw_style_code(&raw).into();
			ret.push(name);
			ret.push(self.reset(true));
			if wrap {
				ret.push(ANSI_CLEAR_EOL);
			}
			ret
		} else {
			let style = self.colors.style_for_indicator(indicator);
			self.apply_style(style, None, name, wrap)
		}
	}

	pub(crate) fn has_indicator_style(&self, indicator: Indicator) -> bool {
		self.indicator_codes.contains_key(&indicator) || self.colors.has_explicit_style_for(indicator)
	}

	pub(crate) fn apply_orphan_link_style(&mut self, name: OsString, wrap: bool) -> OsString {
		if self.has_indicator_style(Indicator::OrphanedSymbolicLink) {
			self.apply_indicator_style(Indicator::OrphanedSymbolicLink, name, wrap)
		} else {
			self.apply_indicator_style(Indicator::MissingFile, name, wrap)
		}
	}

	pub(crate) fn apply_missing_target_style(&mut self, name: OsString, wrap: bool) -> OsString {
		if self.has_indicator_style(Indicator::MissingFile) {
			self.apply_indicator_style(Indicator::MissingFile, name, wrap)
		} else {
			self.apply_indicator_style(Indicator::OrphanedSymbolicLink, name, wrap)
		}
	}

	fn apply_empty_style(&mut self, name: OsString, wrap: bool) -> OsString {
		let mut style_code = String::new();
		style_code.push_str(self.reset(!self.initial_reset_is_done));
		style_code.push_str(EMPTY_STYLE);

		let mut ret: OsString = style_code.into();
		ret.push(name);
		ret.push(self.reset(true));
		if wrap {
			ret.push(ANSI_CLEAR_EOL);
		}
		ret
	}

	fn color_symlink_name(
		&mut self,
		path: &PathData,
		name: OsString,
		wrap: bool,
	) -> Option<OsString> {
		if !self.ln_color_from_target {
			return None;
		}
		if path.must_dereference && path.metadata().is_none() {
			return None;
		}
		let mut target = path.fs_path.read_link().ok()?;
		if target.is_relative()
			&& let Some(parent) = path.fs_path.parent()
		{
			target = parent.join(target);
		}

		match fs::metadata(&target) {
			Ok(metadata) => {
				let style = self
					.colors
					.style_for_path_with_metadata(&target, Some(&metadata));
				Some(self.apply_style(style, None, name, wrap))
			},
			Err(_) => {
				if self.has_indicator_style(Indicator::OrphanedSymbolicLink) {
					Some(self.apply_orphan_link_style(name, wrap))
				} else {
					None
				}
			},
		}
	}

	fn indicator_for_raw_code(&self, path: &PathData) -> Option<Indicator> {
		if self.indicator_codes.is_empty() {
			return None;
		}

		let mut existence_cache: Option<bool> = None;
		let mut entry_exists = || -> bool {
			*existence_cache.get_or_insert_with(|| path.fs_path.exists())
		};

		let Some(file_type) = path.file_type() else {
			if self.has_indicator_style(Indicator::MissingFile) && !entry_exists() {
				return Some(Indicator::MissingFile);
			}
			return None;
		};

		if file_type.is_symlink() {
			return self.indicator_for_symlink(&mut entry_exists);
		}

		if self.has_indicator_style(Indicator::MissingFile) && !entry_exists() {
			return Some(Indicator::MissingFile);
		}

		if file_type.is_file() {
			self.indicator_for_file(path)
		} else if file_type.is_dir() {
			self.indicator_for_directory(path)
		} else {
			self.indicator_for_special_file(*file_type)
		}
	}

	fn indicator_for_symlink(&self, entry_exists: &mut dyn FnMut() -> bool) -> Option<Indicator> {
		let orphan_enabled = self.has_indicator_style(Indicator::OrphanedSymbolicLink);
		let missing_enabled = self.has_indicator_style(Indicator::MissingFile);
		let needs_target_state = self.ln_color_from_target || orphan_enabled;
		let target_missing = needs_target_state && !entry_exists();

		if target_missing {
			let orphan_raw = self.indicator_codes.get(&Indicator::OrphanedSymbolicLink);
			let orphan_raw_is_empty = orphan_raw.is_some_and(String::is_empty);
			if orphan_enabled && (!orphan_raw_is_empty || self.ln_color_from_target) {
				return Some(Indicator::OrphanedSymbolicLink);
			}
			if self.ln_color_from_target && missing_enabled {
				return Some(Indicator::MissingFile);
			}
		}
		if self.has_indicator_style(Indicator::SymbolicLink) {
			return Some(Indicator::SymbolicLink);
		}
		None
	}

	#[cfg(unix)]
	fn indicator_for_file(&self, path: &PathData) -> Option<Indicator> {
		if self.needs_file_metadata()
			&& let Some(metadata) = path.metadata()
		{
			let mode = metadata.mode();
			if self.has_indicator_style(Indicator::Setuid) && mode & mode::SETUID != 0 {
				return Some(Indicator::Setuid);
			}
			if self.has_indicator_style(Indicator::Setgid) && mode & mode::SETGID != 0 {
				return Some(Indicator::Setgid);
			}
			if self.has_indicator_style(Indicator::ExecutableFile) && mode & mode::EXECUTABLE != 0 {
				return Some(Indicator::ExecutableFile);
			}
			if self.has_indicator_style(Indicator::MultipleHardLinks) && metadata.nlink() > 1 {
				return Some(Indicator::MultipleHardLinks);
			}
		}

		if self.has_indicator_style(Indicator::RegularFile) {
			Some(Indicator::RegularFile)
		} else {
			None
		}
	}

	#[cfg(not(unix))]
	fn indicator_for_file(&self, _path: &PathData) -> Option<Indicator> {
		if self.has_indicator_style(Indicator::RegularFile) {
			Some(Indicator::RegularFile)
		} else {
			None
		}
	}

	#[cfg(unix)]
	fn indicator_for_directory(&self, path: &PathData) -> Option<Indicator> {
		if self.needs_dir_metadata()
			&& let Some(metadata) = path.metadata()
		{
			let mode = metadata.mode();
			if self.has_indicator_style(Indicator::StickyAndOtherWritable)
				&& mode & mode::STICKY_OTHER_WRITABLE == mode::STICKY_OTHER_WRITABLE
			{
				return Some(Indicator::StickyAndOtherWritable);
			}
			if self.has_indicator_style(Indicator::OtherWritable) && mode & mode::OTHER_WRITABLE != 0 {
				return Some(Indicator::OtherWritable);
			}
			if self.has_indicator_style(Indicator::Sticky) && mode & mode::STICKY != 0 {
				return Some(Indicator::Sticky);
			}
		}

		if self.has_indicator_style(Indicator::Directory) {
			Some(Indicator::Directory)
		} else {
			None
		}
	}

	#[cfg(not(unix))]
	fn indicator_for_directory(&self, _path: &PathData) -> Option<Indicator> {
		if self.has_indicator_style(Indicator::Directory) {
			Some(Indicator::Directory)
		} else {
			None
		}
	}

	#[cfg(unix)]
	fn indicator_for_special_file(&self, file_type: fs::FileType) -> Option<Indicator> {
		if file_type.is_fifo() && self.has_indicator_style(Indicator::FIFO) {
			return Some(Indicator::FIFO);
		}
		if file_type.is_socket() && self.has_indicator_style(Indicator::Socket) {
			return Some(Indicator::Socket);
		}
		if file_type.is_block_device() && self.has_indicator_style(Indicator::BlockDevice) {
			return Some(Indicator::BlockDevice);
		}
		if file_type.is_char_device() && self.has_indicator_style(Indicator::CharacterDevice) {
			return Some(Indicator::CharacterDevice);
		}
		None
	}

	#[cfg(not(unix))]
	fn indicator_for_special_file(&self, _file_type: fs::FileType) -> Option<Indicator> {
		None
	}

	#[cfg(unix)]
	fn needs_file_metadata(&self) -> bool {
		self.has_indicator_style(Indicator::Setuid)
			|| self.has_indicator_style(Indicator::Setgid)
			|| self.has_indicator_style(Indicator::ExecutableFile)
			|| self.has_indicator_style(Indicator::MultipleHardLinks)
	}

	#[cfg(unix)]
	fn needs_dir_metadata(&self) -> bool {
		self.has_indicator_style(Indicator::StickyAndOtherWritable)
			|| self.has_indicator_style(Indicator::OtherWritable)
			|| self.has_indicator_style(Indicator::Sticky)
	}
}

/// Colors the provided name based on the style determined for the given path
pub(crate) fn color_name(
	name: OsString,
	path: &PathData,
	style_manager: &mut StyleManager,
	target_symlink: Option<&PathData>,
	wrap: bool,
) -> OsString {
	// Check if the file has capabilities
	#[cfg(all(unix, not(any(target_os = "android", target_os = "macos"))))]
	{
		// Skip checking capabilities if LS_COLORS=ca=:
		let has_capabilities = style_manager
			.colors
			.has_explicit_style_for(Indicator::Capabilities)
			&& uucore::fsxattr::has_security_cap_acl(&path.p_buf);

		// If the file has capabilities, use a specific style for `ca` (capabilities)
		if has_capabilities {
			let capabilities = style_manager
				.colors
				.style_for_indicator(Indicator::Capabilities);
			return style_manager.apply_style(capabilities, Some(path), name, wrap);
		}
	}

	if target_symlink.is_none()
		&& path.file_type().is_some_and(fs::FileType::is_symlink)
		&& let Some(colored) = style_manager.color_symlink_name(path, name.clone(), wrap)
	{
		return colored;
	}

	if let Some(target) = target_symlink {
		// use the optional target_symlink
		// Use fn symlink_metadata directly instead of get_metadata() here because ls
		// should not exit with an err, if we are unable to obtain the target_metadata
		return style_manager.apply_style_for_path(target, name, wrap);
	}

	if !path.must_dereference {
		// If we need to dereference (follow) a symlink, we will need to get the
		// metadata There is a DirEntry, we don't need to get the metadata for the
		// color
		return style_manager.apply_style_for_path(path, name, wrap);
	}

	let md_option: Option<Metadata> = path
		.metadata()
		.cloned()
		.or_else(|| path.fs_path.symlink_metadata().ok());

	style_manager.apply_style_based_on_metadata(path, md_option.as_ref(), name, wrap)
}

#[derive(Debug)]
pub(crate) enum LsColorsParseError {
	UnrecognizedPrefix(String),
	InvalidSyntax,
}

/// Validates the shell's `LS_COLORS` value before color output is enabled.
pub(crate) fn validate_ls_colors(ls_colors: &str) -> Result<(), LsColorsParseError> {
	if ls_colors.is_empty() {
		return Ok(());
	}
	let bytes = ls_colors.as_bytes();
	let mut idx = 0;

	while idx < bytes.len() {
		match bytes[idx] {
			b':' => {
				idx += 1;
			},
			b'*' => {
				idx += 1;
				idx = parse_funky_string(bytes, idx, true)?;
				if idx >= bytes.len() || bytes[idx] != b'=' {
					return Err(LsColorsParseError::InvalidSyntax);
				}
				idx += 1;
				idx = parse_funky_string(bytes, idx, false)?;
				if idx < bytes.len() && bytes[idx] == b':' {
					idx += 1;
				}
			},
			_ => {
				if idx + 1 >= bytes.len() {
					return Err(LsColorsParseError::InvalidSyntax);
				}
				let label = [bytes[idx], bytes[idx + 1]];
				idx += 2;
				if idx >= bytes.len() || bytes[idx] != b'=' {
					return Err(LsColorsParseError::InvalidSyntax);
				}
				if !is_valid_ls_colors_prefix(label) {
					let prefix = String::from_utf8_lossy(&label).into_owned();
					return Err(LsColorsParseError::UnrecognizedPrefix(prefix));
				}
				idx += 1;
				idx = parse_funky_string(bytes, idx, false)?;
				if idx < bytes.len() && bytes[idx] == b':' {
					idx += 1;
				}
			},
		}
	}

	Ok(())
}

// Parse a value with GNU-compatible escape sequences, returning the index of
// the terminator.
fn parse_funky_string(
	bytes: &[u8],
	mut idx: usize,
	equals_end: bool,
) -> Result<usize, LsColorsParseError> {
	enum State {
		Ground,
		Backslash,
		Octal(u8),
		Hex(u8),
		Caret,
	}

	let mut state = State::Ground;
	loop {
		let byte = if idx < bytes.len() { bytes[idx] } else { 0 };
		match state {
			State::Ground => match byte {
				b':' | 0 => return Ok(idx),
				b'=' if equals_end => return Ok(idx),
				b'\\' => {
					state = State::Backslash;
					idx += 1;
				},
				b'^' => {
					state = State::Caret;
					idx += 1;
				},
				_ => idx += 1,
			},
			State::Backslash => match byte {
				0 => return Err(LsColorsParseError::InvalidSyntax),
				b'0'..=b'7' => {
					state = State::Octal(byte - b'0');
					idx += 1;
				},
				b'x' | b'X' => {
					state = State::Hex(0);
					idx += 1;
				},
				b'a' | b'b' | b'e' | b'f' | b'n' | b'r' | b't' | b'v' | b'?' | b'_' => {
					state = State::Ground;
					idx += 1;
				},
				_ => {
					state = State::Ground;
					idx += 1;
				},
			},
			State::Octal(num) => match byte {
				b'0'..=b'7' => {
					state = State::Octal(num.wrapping_mul(8).wrapping_add(byte - b'0'));
					idx += 1;
				},
				_ => state = State::Ground,
			},
			State::Hex(num) => match byte {
				b'0'..=b'9' => {
					state = State::Hex(num.wrapping_mul(16).wrapping_add(byte - b'0'));
					idx += 1;
				},
				b'a'..=b'f' => {
					state = State::Hex(num.wrapping_mul(16).wrapping_add(byte - b'a' + 10));
					idx += 1;
				},
				b'A'..=b'F' => {
					state = State::Hex(num.wrapping_mul(16).wrapping_add(byte - b'A' + 10));
					idx += 1;
				},
				_ => state = State::Ground,
			},
			State::Caret => match byte {
				b'@'..=b'~' | b'?' => {
					state = State::Ground;
					idx += 1;
				},
				_ => return Err(LsColorsParseError::InvalidSyntax),
			},
		}
	}
}

fn is_valid_ls_colors_prefix(label: [u8; 2]) -> bool {
	matches!(
		label,
		[b'l', b'c']
			| [b'r', b'c']
			| [b'e', b'c']
			| [b'r', b's']
			| [b'n', b'o']
			| [b'f', b'i']
			| [b'd', b'i']
			| [b'l', b'n']
			| [b'p', b'i']
			| [b's', b'o']
			| [b'b', b'd']
			| [b'c', b'd']
			| [b'm', b'i']
			| [b'o', b'r']
			| [b'e', b'x']
			| [b'd', b'o']
			| [b's', b'u']
			| [b's', b'g']
			| [b's', b't']
			| [b'o', b'w']
			| [b't', b'w']
			| [b'c', b'a']
			| [b'm', b'h']
			| [b'c', b'l']
	)
}

fn parse_indicator_codes(ls_colors: Option<&str>) -> (FxHashMap<Indicator, String>, bool) {
	let mut indicator_codes = FxHashMap::default();
	let mut ln_color_from_target = false;

	// LS_COLORS validity is checked before enabling color output, so parse
	// entries directly here for raw indicator overrides.
	if let Some(ls_colors) = ls_colors {
		for entry in ls_colors.split(':') {
			if entry.is_empty() {
				continue;
			}
			let Some((key, value)) = entry.split_once('=') else {
				continue;
			};

			if let Some(indicator) = Indicator::from(key) {
				if indicator == Indicator::SymbolicLink && value == "target" {
					ln_color_from_target = true;
					continue;
				}
				if indicator_value_is_disabled(indicator, value) {
					if value.is_empty()
						&& matches!(indicator, Indicator::OrphanedSymbolicLink | Indicator::MissingFile)
					{
						indicator_codes.insert(indicator, String::new());
					}
					continue;
				}
				indicator_codes.insert(indicator, canonicalize_indicator_value(value).into_owned());
			}
		}
	}

	(indicator_codes, ln_color_from_target)
}

fn canonicalize_indicator_value(value: &str) -> Cow<'_, str> {
	if value.len() == 1 && value.as_bytes()[0].is_ascii_digit() {
		let mut canonical = String::with_capacity(2);
		canonical.push('0');
		canonical.push_str(value);
		Cow::Owned(canonical)
	} else {
		Cow::Borrowed(value)
	}
}

fn indicator_value_is_disabled(indicator: Indicator, value: &str) -> bool {
	if value.is_empty() {
		!matches!(indicator, Indicator::OrphanedSymbolicLink | Indicator::MissingFile)
	} else {
		value.chars().all(|c| c == '0')
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	fn style_manager(
		colors: &LsColors,
		indicator_codes: FxHashMap<Indicator, String>,
	) -> StyleManager<'_> {
		StyleManager {
			current_style: None,
			initial_reset_is_done: false,
			colors,
			indicator_codes,
			ln_color_from_target: false,
		}
	}

	#[test]
	fn has_indicator_style_ignores_fallback_styles() {
		let colors = LsColors::from_string("ex=00:fi=32");
		let manager = style_manager(&colors, FxHashMap::default());
		assert!(!manager.has_indicator_style(Indicator::ExecutableFile));
	}

	#[test]
	fn has_indicator_style_detects_explicit_styles() {
		let colors = LsColors::from_string("ex=01;32");
		let manager = style_manager(&colors, FxHashMap::default());
		assert!(manager.has_indicator_style(Indicator::ExecutableFile));
	}

	#[test]
	fn has_indicator_style_detects_raw_codes() {
		let colors = LsColors::empty();
		let mut indicator_codes = FxHashMap::default();
		indicator_codes.insert(Indicator::Directory, "01;34".to_string());
		let manager = style_manager(&colors, indicator_codes);
		assert!(manager.has_indicator_style(Indicator::Directory));
	}
}
}
mod config {
//! Configuration parsing for the `ls` builtin.

use std::{
	borrow::Cow,
	ffi::{OsStr, OsString},
	io::Write,
	num::IntErrorKind,
	rc::Rc,
};

use glob::Pattern;
use lscolors::LsColors;
use jiff::tz::TimeZone;
use term_grid::SPACES_IN_TAB;
use uucore::{
	display::Quotable,
	format::human::SizeFormat,
	fsext::MetadataTimeField,
	line_ending::LineEnding,
	parser::{parse_glob, parse_size::parse_size_non_zero_u64},
	quoting_style::QuotingStyle,
	time::format,
};

use super::{
	Host, LsError, LsRuntime,
	colors::{LsColorsParseError, validate_ls_colors},
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
	pub static DIRED_SEEN: &str = "__dired-seen";
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
	pub(crate) ls_colors: Option<String>,
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
	pub(crate) time_zone: TimeZone,
	pub(crate) context: bool,
	pub(crate) group_directories_first: bool,
	pub(crate) line_ending: LineEnding,
	pub(crate) dired: bool,
	pub(crate) hyperlink: bool,
	pub(crate) tab_size: usize,
	pub(super) runtime: Rc<LsRuntime>,
}

/// Extracts the format to display the information based on the options
/// provided.
///
/// # Returns
///
/// A tuple containing the Format variant and an Option containing a &'static
/// str which corresponds to the option used to define the format.
fn extract_format(
	options: &clap::ArgMatches,
	stdout_is_terminal: bool,
) -> (Format, Option<&'static str>) {
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
	} else if stdout_is_terminal {
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
fn is_color_compatible_term(host: &Host) -> bool {
	let term = host.var("TERM").map(OsString::from);
	let colorterm = host.var("COLORTERM").map(OsString::from);

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
fn extract_color(options: &clap::ArgMatches, host: &Host) -> bool {
	if !is_color_compatible_term(host) {
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
			"auto" | "tty" | "if-tty" => host.stdout.is_terminal(),
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
fn extract_hyperlink(options: &clap::ArgMatches, stdout_is_terminal: bool) -> bool {
	let hyperlink = options
		.get_one::<String>(options::HYPERLINK)
		.unwrap()
		.as_str();

	match hyperlink {
		"always" | "yes" | "force" => true,
		"auto" | "tty" | "if-tty" => stdout_is_terminal,
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
	host: &Host,
	runtime: &LsRuntime,
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
		if let Some(style) = host.var("QUOTING_STYLE") {
			match match_quoting_style_name(style, show_control) {
				Some(pair) => return pair,
				None => {
					let _ = writeln!(
						runtime.stderr.borrow_mut(),
						"ls: Ignoring invalid value of environment variable QUOTING_STYLE: '{}'",
						style
					);
				},
			}
		}

		// By default, `ls` uses Shell escape quoting style when writing to a terminal
		// file descriptor and Literal otherwise.
		if host.stdout.is_terminal() {
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
fn extract_indicator_style(
	options: &clap::ArgMatches,
	stdout_is_terminal: bool,
) -> IndicatorStyle {
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
				if stdout_is_terminal {
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
fn parse_width(width_match: Option<&String>, host: &Host, runtime: &LsRuntime) -> Result<u16, LsError> {
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
				runtime.stderr.borrow_mut(),
				"ls: ignoring invalid width in environment variable COLUMNS: {}",
				columns.quote()
			);
			DEFAULT_TERM_WIDTH
		}
	};

	let calculate_term_size = || {
		#[cfg(unix)]
		{
			use std::os::fd::AsRawFd;
			if let Ok(fd) = host.stdout.try_borrow_as_fd() {
				let mut size = uucore::libc::winsize {
					ws_row: 0,
					ws_col: 0,
					ws_xpixel: 0,
					ws_ypixel: 0,
				};
				// SAFETY: `size` is valid for writes and `fd` remains borrowed
				// for the duration of the ioctl.
				if unsafe {
					uucore::libc::ioctl(fd.as_raw_fd(), uucore::libc::TIOCGWINSZ, &mut size)
				} == 0
					&& size.ws_col > 0
				{
					return size.ws_col;
				}
			}
		}
		DEFAULT_TERM_WIDTH
	};

	let ret = match width_match {
		Some(x) => parse_width_from_args(x)?,
		None => match host.var("COLUMNS").map(OsString::from) {
			Some(columns) => parse_width_from_env(columns),
			None => calculate_term_size(),
		},
	};

	Ok(ret)
}

impl Config {
	fn shell_time_zone(host: &Host) -> TimeZone {
		let Some(value) = host.var("TZ") else {
			return TimeZone::system();
		};
		let value = value.strip_prefix(':').unwrap_or(value);
		if value.is_empty() {
			return TimeZone::UTC;
		}
		TimeZone::get(value)
			.or_else(|_| TimeZone::posix(value))
			.unwrap_or(TimeZone::UTC)
	}

	#[allow(clippy::cognitive_complexity)]
	pub(super) fn from(
		options: &clap::ArgMatches,
		host: &Host,
		runtime: Rc<LsRuntime>,
	) -> Result<Self, LsError> {
		let context = options.get_flag(options::CONTEXT);
		let stdout_is_terminal = host.stdout.is_terminal();
		let (mut format, opt) = extract_format(options, stdout_is_terminal);
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
		let mut needs_color = extract_color(options, host);
		let hyperlink = extract_hyperlink(options, stdout_is_terminal);

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

		let env_var_blocksize = host.var("BLOCKSIZE").map(OsString::from);
		let env_var_block_size = host.var("BLOCK_SIZE").map(OsString::from);
		let env_var_ls_block_size = host.var("LS_BLOCK_SIZE").map(OsString::from);
		let env_var_posixly_correct = host.var("POSIXLY_CORRECT").map(OsString::from);
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
					return Err(LsError::BlockSizeParseError(invalid_block_size.clone()));
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
		let width = parse_width(options.get_one::<String>(options::WIDTH), host, &runtime)?;

		// pi-uutils: non-tty context, so SHOW_CONTROL_CHARS and the default both
		// enable control chars; only --hide-control-chars disables them.
		let mut show_control = !options.get_flag(options::HIDE_CONTROL_CHARS);

		let (mut quoting_style, mut locale_quoting) =
			extract_quoting_style(options, show_control, host, &runtime);
		let indicator_style = extract_indicator_style(options, stdout_is_terminal);
		// Only parse the value to "--time-style" if it will become relevant.
		let dired = options.get_flag(options::DIRED);
		let (time_format_recent, time_format_older) = if format == Format::Long || dired {
			parse_time_style(options, host)?
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
					runtime.stderr.borrow_mut(),
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
						runtime.stderr.borrow_mut(),
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

		if needs_color && let Some(ls_colors) = host.var("LS_COLORS")
			&& let Err(err) = validate_ls_colors(ls_colors)
		{
			if let LsColorsParseError::UnrecognizedPrefix(prefix) = &err {
				let _ = writeln!(
					runtime.stderr.borrow_mut(),
					"ls: warning: unrecognized prefix: {}",
					prefix.quote()
				);
			}
			let _ = writeln!(
				runtime.stderr.borrow_mut(),
				"ls: warning: unparsable value for LS_COLORS environment variable"
			);
			needs_color = false;
		}

		let color = if needs_color {
			Some(match host.var("LS_COLORS") {
				Some(s) => LsColors::from_string(s),
				None => LsColors::default(),
			})
		} else {
			None
		};

		if dired || options.get_flag(options::DIRED_SEEN) {
			format = Format::Long;
		}
		if dired && options.get_flag(options::ZERO) {
			return Err(LsError::DiredAndZeroAreIncompatible);
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
				.or_else(|| host.var("TABSIZE").and_then(|s| s.parse().ok()))
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
			ls_colors: host.var("LS_COLORS").map(str::to_owned),
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
			time_zone: Self::shell_time_zone(host),
			context,
			group_directories_first: options.get_flag(options::GROUP_DIRECTORIES_FIRST),
			line_ending: LineEnding::from_zero_flag(options.get_flag(options::ZERO)),
			dired,
			hyperlink,
			tab_size,
			runtime,
		})
	}
}

fn parse_time_style(
	options: &clap::ArgMatches,
	host: &Host,
) -> Result<(String, Option<String>), LsError> {
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
		.or_else(|| host.var("TIME_STYLE").map(Cow::from))
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
				if host.var("LC_TIME") == Some("POSIX") || host.var("LC_ALL") == Some("POSIX")
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
}
mod dired {
//! GNU dired position tracking for the `ls` builtin.

use std::{
	fmt,
	io::{self, Write},
};

/// `dired` Module Documentation
///
/// This module handles the --dired output format, representing file and
/// directory listings.
///
/// Key Mechanisms:
/// 1. **Position Tracking**:
///    - The module tracks byte positions for each file or directory entry.
///    - `BytePosition`: Represents a byte range with start and end positions.
///    - `DiredOutput`: Contains positions for DIRED and SUBDIRED outputs and
///      maintains a padding value.
///
/// 2. **Padding**:
///    - Padding is used when dealing with directory names or the "total" line.
///    - The module adjusts byte positions by adding padding for these cases.
///    - This ensures correct offset for subsequent files or directories.
///
/// 3. **Position Calculation**:
///    - Functions like `calculate_dired`, `calculate_subdired`, and
///      `calculate_and_update_positions` compute byte positions based on output
///      length, previous positions, and padding.
///
/// 4. **Output**:
///    - The module provides functions to print the DIRED output
///      (`print_dired_output`) based on calculated positions and configuration.
///    - Helpers like `print_positions` print positions with specific prefixes.
///
/// Overall, the module ensures each entry in the DIRED output has the correct
/// byte position, considering additional lines or padding affecting positions.
use super::Config;

#[derive(Debug, Clone, PartialEq)]
pub struct BytePosition {
	pub start: usize,
	pub end:   usize,
}

/// Represents the output structure for DIRED, containing positions for both
/// DIRED and SUBDIRED.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct DiredOutput {
	pub dired_positions:    Vec<BytePosition>,
	pub subdired_positions: Vec<BytePosition>,
	pub padding:            usize,
	pub line_offset:        usize,
}

impl fmt::Display for BytePosition {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		write!(f, "{} {}", self.start, self.end)
	}
}

// When --dired is used, all lines starts with 2 spaces
static DIRED_TRAILING_OFFSET: usize = 2;

/// Calculates the byte positions for DIRED
pub fn calculate_dired(
	dired: &DiredOutput,
	output_display_len: usize,
	dfn_len: usize,
) -> (usize, usize) {
	let offset_from_previous_line = dired.line_offset;

	let start = output_display_len + offset_from_previous_line;
	let end = start + dfn_len;
	(start, end)
}

pub fn indent<W: Write>(out: &mut W) -> io::Result<()> {
	write!(out, "  ")?;
	Ok(())
}

pub fn calculate_subdired(dired: &mut DiredOutput, path_len: usize) {
	let offset_from_previous_line = dired.line_offset + dired.padding;
	let start = offset_from_previous_line + DIRED_TRAILING_OFFSET;
	let end = start + path_len;
	dired.subdired_positions.push(BytePosition { start, end });
}

/// Prints the dired output based on the given configuration and dired
/// structure.
pub fn print_dired_output<W: Write>(
	config: &Config,
	dired: &DiredOutput,
	out: &mut W,
) -> io::Result<()> {
	out.flush()?;
	if !dired.dired_positions.is_empty() {
		print_positions(out, "//DIRED//", &dired.dired_positions)?;
	}
	// SUBDIRED is needed whenever directory headings are printed (multiple args or
	// -R), so don't gate it on config.recursive.
	if !dired.subdired_positions.is_empty() {
		print_positions(out, "//SUBDIRED//", &dired.subdired_positions)?;
	}
	writeln!(out, "//DIRED-OPTIONS// --quoting-style={}", config.quoting_style)?;
	Ok(())
}

/// Helper function to print positions with a given prefix.
fn print_positions<W: Write>(
	out: &mut W,
	prefix: &str,
	positions: &[BytePosition],
) -> io::Result<()> {
	write!(out, "{prefix}")?;
	for c in positions {
		write!(out, " {c}")?;
	}
	writeln!(out)?;
	Ok(())
}

pub fn add_total(dired: &mut DiredOutput, total_len: usize) {
	dired.padding += total_len + DIRED_TRAILING_OFFSET;
}

// when using -R, we have the dirname. we need to add it to the padding
pub fn add_dir_name(dired: &mut DiredOutput, dir_len: usize) {
	// "  dirname:\n"
	dired.padding += dir_len + DIRED_TRAILING_OFFSET + 2;
}

/// Calculates byte positions and updates the dired structure.
pub fn calculate_and_update_positions(
	dired: &mut DiredOutput,
	output_display_len: usize,
	dfn_len: usize,
	line_len: usize,
) {
	let (start, end) = calculate_dired(dired, output_display_len, dfn_len);
	update_positions(dired, start, end, line_len);
}

/// Updates the dired positions based on the given start and end positions.
/// update when it is the first element in the list (to manage "total X")
/// insert when it isn't the about total
pub fn update_positions(dired: &mut DiredOutput, start: usize, end: usize, line_len: usize) {
	// padding can be 0 but as it doesn't matter
	let padding = dired.padding;
	dired
		.dired_positions
		.push(BytePosition { start: start + padding, end: end + padding });
	dired.line_offset += padding + line_len;
	// Remove the previous padding
	dired.padding = 0;
}


#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn test_calculate_dired() {
		let output_display = "sample_output".to_string();
		let dfn = "sample_file".to_string();
		let dired = DiredOutput {
			dired_positions:    vec![BytePosition { start: 5, end: 10 }],
			subdired_positions: vec![],
			padding:            0,
			line_offset:        11,
		};
		let (start, end) = calculate_dired(&dired, output_display.len(), dfn.len());

		assert_eq!(start, 24);
		assert_eq!(end, 35);
	}

	#[test]
	fn test_calculate_subdired() {
		let mut dired = DiredOutput {
			dired_positions:    vec![
				BytePosition { start: 0, end: 3 },
				BytePosition { start: 4, end: 7 },
				BytePosition { start: 8, end: 11 },
			],
			subdired_positions: vec![],
			padding:            0,
			line_offset:        12,
		};
		let path_len = 5;
		calculate_subdired(&mut dired, path_len);
		assert_eq!(dired.subdired_positions, vec![BytePosition { start: 14, end: 19 }],);
	}

	#[test]
	fn test_add_dir_name() {
		let mut dired = DiredOutput {
			dired_positions:    vec![
				BytePosition { start: 0, end: 3 },
				BytePosition { start: 4, end: 7 },
				BytePosition { start: 8, end: 11 },
			],
			subdired_positions: vec![],
			padding:            0,
			line_offset:        0,
		};
		let dir_len = 5;
		add_dir_name(&mut dired, dir_len);
		assert_eq!(dired, DiredOutput {
			dired_positions:    vec![
				BytePosition { start: 0, end: 3 },
				BytePosition { start: 4, end: 7 },
				BytePosition { start: 8, end: 11 },
			],
			subdired_positions: vec![],
			// 9 = 5 for dir_len + 2 for "  " + 1 for : + 1 for \n
			padding:            9,
			line_offset:        0,
		});
	}

	#[test]
	fn test_add_total() {
		let mut dired = DiredOutput {
			dired_positions:    vec![
				BytePosition { start: 0, end: 3 },
				BytePosition { start: 4, end: 7 },
				BytePosition { start: 8, end: 11 },
			],
			subdired_positions: vec![],
			padding:            0,
			line_offset:        12,
		};
		// if we have "total: 2"
		let total_len = 8;
		add_total(&mut dired, total_len);
		// 10 = 8 (len) + 2 ("  ")
		assert_eq!(dired.padding, 10);
	}

	#[test]
	fn test_add_dir_name_and_total() {
		// test when we have
		//   dirname:
		//   total 0
		//   -rw-r--r-- 1 sylvestre sylvestre 0 Sep 30 09:41 ab

		let mut dired = DiredOutput {
			dired_positions:    vec![
				BytePosition { start: 0, end: 3 },
				BytePosition { start: 4, end: 7 },
				BytePosition { start: 8, end: 11 },
			],
			subdired_positions: vec![],
			padding:            0,
			line_offset:        12,
		};
		let dir_len = 5;
		add_dir_name(&mut dired, dir_len);
		// 9 = 2 ("  ") + 1 (\n) + 5 + 1 (: of dirname)
		assert_eq!(dired.padding, 9);

		let total_len = 8;
		add_total(&mut dired, total_len);
		assert_eq!(dired.padding, 19);
	}

	#[test]
	fn test_dired_update_positions() {
		let mut dired = DiredOutput {
			dired_positions:    vec![BytePosition { start: 5, end: 10 }],
			subdired_positions: vec![],
			padding:            10,
			line_offset:        0,
		};

		// Test with adjust = true
		update_positions(&mut dired, 15, 20, 1);
		let last_position = dired.dired_positions.last().unwrap();
		assert_eq!(last_position.start, 25); // 15 + 10 (end of the previous position)
		assert_eq!(last_position.end, 30); // 20 + 10 (end of the previous position)

		// Test with adjust = false
		update_positions(&mut dired, 30, 35, 1);
		let last_position = dired.dired_positions.last().unwrap();
		assert_eq!(last_position.start, 30);
		assert_eq!(last_position.end, 35);
	}

	#[test]
	fn test_calculate_and_update_positions() {
		let mut dired = DiredOutput {
			dired_positions:    vec![
				BytePosition { start: 0, end: 3 },
				BytePosition { start: 4, end: 7 },
				BytePosition { start: 8, end: 11 },
			],
			subdired_positions: vec![],
			padding:            5,
			line_offset:        12,
		};
		let output_display_len = 15;
		let dfn_len = 5;
		calculate_and_update_positions(&mut dired, output_display_len, dfn_len, 20);
		assert_eq!(dired.dired_positions, vec![
			BytePosition { start: 0, end: 3 },
			BytePosition { start: 4, end: 7 },
			BytePosition { start: 8, end: 11 },
			BytePosition { start: 32, end: 37 },
		]);
		assert_eq!(dired.padding, 0);
	}
}
}
mod display {
//! Output formatting for the `ls` builtin.

use core::ops::RangeInclusive;
#[cfg(unix)]
use std::fmt::Display;
#[cfg(unix)]
use std::os::unix::fs::{FileTypeExt, MetadataExt};
#[cfg(windows)]
use std::os::windows::fs::MetadataExt;
/// Show the directory name in the case where several arguments are given to ls
use std::{
	borrow::Cow,
	cell::LazyCell,
	ffi::{OsStr, OsString},
	fmt::Write as FmtWrite,
	fs::{self, DirEntry, FileType, Metadata},
	io::Write,
	iter,
	sync::LazyLock,
	time::SystemTime,
};

use ansi_width::ansi_width;
use glob::MatchOptions;

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
	format::human::human_readable,
	fs::display_permissions,
	fsext::metadata_get_time,
	quoting_style::{QuotingStyle, locale_aware_escape_dir_name, locale_aware_escape_name},
	time::system_time_to_sec,
};
use jiff::{
	Zoned,
	fmt::{StdIoWrite, strtime::{BrokenDownTime, Config as TimeFormatConfig}},
};

use super::{
	Config, ListState, LsError, PathData,
	colors::{StyleManager, color_name},
	config::Files,
	dired::{self, DiredOutput},
	get_block_size,
};
use crate::host::os_bytes_lossy;

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
pub fn show_dir_name<W: Write>(
	path_data: &PathData,
	out: &mut W,
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
	let bytes = os_bytes_lossy(name);
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
) -> std::io::Result<()> {
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

fn display_grid<W: Write>(
	names: impl Iterator<Item = OsString>,
	width: u16,
	direction: Direction,
	out: &mut W,
	quoted: bool,
	tab_size: usize,
) -> std::io::Result<()> {
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
) -> std::io::Result<()> {
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
) -> std::io::Result<()> {
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

	let Ok(timestamp) = jiff::Timestamp::try_from(time) else {
		out.extend(system_time_to_sec(time).0.to_string().as_bytes());
		return Ok(());
	};
	let zoned = Zoned::new(timestamp, config.time_zone.clone());
	let broken_down = BrokenDownTime::from(&zoned);
	let mut writer = StdIoWrite(out);
	broken_down
		.format_with_config(&TimeFormatConfig::new().lenient(true), fmt, &mut writer)
		.map_err(|err| std::io::Error::other(err.to_string()))
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
		match path.fs_path.read_link() {
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

					match fs::canonicalize(config.runtime.resolve(absolute_target)) {
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
				config.runtime.error(LsError::IOErrorContext(
					path.path().to_path_buf(),
					err,
					false,
					path.fs_path.is_dir(),
				));
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

/// This writes to `state.out` a single string of the output of `ls -l`.
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
) -> std::io::Result<()> {
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

	let absolute_path = fs::canonicalize(&path.fs_path).unwrap_or_default();
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
	os_bytes_lossy(haystack).starts_with(needle)
}

fn write_os_str<W: Write>(writer: &mut W, string: &OsStr) -> std::io::Result<()> {
	writer.write_all(&os_bytes_lossy(string))
}
}

use colors::StyleManager;
pub use config::{Config, options};
use config::{Dereference, Files, Sort, options::QUOTING_STYLE};
use dired::DiredOutput;
pub use display::Format;
use display::{display_items, display_size, should_display, show_dir_name};

#[derive(Error, Debug)]
enum LsError {
	#[error("invalid line width: '{0}'")]
	InvalidLineWidth(String),

	#[error("general io error: {0}")]
	IOError(#[from] std::io::Error),

	#[error("{}", match .1.kind() {
		ErrorKind::NotADirectory => format!("cannot access {}: Not a directory", .0.quote()),
		ErrorKind::NotFound => format!("cannot access {}: No such file or directory", .0.quote()),
		ErrorKind::PermissionDenied => match .1.raw_os_error().unwrap_or(1) {
			1 => format!("cannot access {}: Operation not permitted", .0.quote()),
			_ => if *.3 {
				format!("cannot open directory {}: Permission denied", .0.quote())
			} else {
				format!("cannot open file {}: Permission denied", .0.quote())
			},
		},
		_ => if 9 == .1.raw_os_error().unwrap_or(1) {
			format!("cannot open directory {}: Bad file descriptor", .0.quote())
		} else {
			format!("unknown io error: {}, '{:?}'", .0.quote(), .1)
		},
	})]
	IOErrorContext(PathBuf, std::io::Error, bool, bool),

	#[error("invalid --block-size argument '{0}'")]
	BlockSizeParseError(String),

	#[error("--dired and --zero are incompatible")]
	DiredAndZeroAreIncompatible,

	#[error("{}: not listing already-listed directory", .0.maybe_quote())]
	AlreadyListedError(PathBuf),

	#[error("invalid --time-style argument {}\nPossible values are:\n  - [posix-]full-iso\n  - [posix-]long-iso\n  - [posix-]iso\n  - [posix-]locale\n  - +FORMAT (e.g., +%H:%M) for a 'date'-style format\n\nFor more information try --help", .0.quote())]
	TimeStyleParseError(String),
}

impl LsError {
	fn code(&self) -> i32 {
		match self {
			Self::InvalidLineWidth(_) => 2,
			Self::IOError(_) => 1,
			Self::IOErrorContext(_, _, false, _) => 1,
			Self::IOErrorContext(_, _, true, _) => 2,
			Self::BlockSizeParseError(_) => 2,
			Self::DiredAndZeroAreIncompatible => 2,
			Self::AlreadyListedError(_) => 2,
			Self::TimeStyleParseError(_) => 2,
		}
	}
}

struct LsRuntime {
	cwd:     PathBuf,
	stderr:  RefCell<OpenFile>,
	status:  Cell<i32>,
}

impl LsRuntime {
	fn resolve(&self, path: impl AsRef<Path>) -> PathBuf {
		let normalized_path = brush_core::sys::fs::normalize_shell_path(path.as_ref());
		let path = normalized_path.as_ref();
		if path.is_absolute() { path.to_path_buf() } else { self.cwd.join(path) }
	}

	fn error(&self, err: LsError) {
		self.status.set(err.code());
		let _ = writeln!(self.stderr.borrow_mut(), "ls: {err}");
	}
}

/// Parsed `ls` invocation.
pub(crate) struct Ls {
	matches: ArgMatches,
}

matches_parser!(Ls, uu_app);

impl Utility for Ls {
	const NAME: &'static str = "ls";
	const USAGE_ERROR: u8 = 2;

	fn rewrite_argv(mut argv: Vec<OsString>) -> Result<Vec<OsString>, String> {
		if argv
			.iter()
			.any(|arg| matches!(arg.to_str(), Some("--dired" | "-D")))
		{
			argv.push("--__dired-seen".into());
		}
		Ok(argv)
	}

	fn run(self, host: &mut Host) -> i32 {
		let runtime = Rc::new(LsRuntime {
			cwd: host.cwd().to_path_buf(),
			stderr: RefCell::new(host.stderr_clone()),
			status: Cell::new(0),
		});
		let config = match Config::from(&self.matches, host, Rc::clone(&runtime)) {
			Ok(config) => config,
			Err(err) => {
				host.error(&err, err.code());
				return err.code();
			},
		};
		let locs = self
			.matches
			.get_many::<OsString>(options::PATHS)
			.map_or_else(|| vec![Path::new(".")], |v| v.map(Path::new).collect());
		match list(locs, &config, host.stdout_clone()) {
			Ok(()) => runtime.status.get(),
			Err(err) => {
				host.error(&err, 1);
				1
			},
		}
	}
}


pub fn uu_app() -> Command {
	Command::new("ls")
		.version("0.8.0")
		.override_usage(format_usage("ls [OPTION]... [FILE]..."))
		.about(
			"List directory contents.\nIgnore files and directories starting with a '.' by default",
		)
		.color(clap::ColorChoice::Never)
		.infer_long_args(true)
		.disable_help_flag(true)
		.args_override_self(true)
		.arg(
			Arg::new(options::HELP)
				.long(options::HELP)
				.help("Print help information.")
				.action(ArgAction::Help),
		)
		// Format arguments
		.arg(
			Arg::new(options::FORMAT)
				.long(options::FORMAT)
				.help("Set the display format.")
				.value_parser(ShortcutValueParser::new([
					"long",
					"verbose",
					"single-column",
					"columns",
					"vertical",
					"across",
					"horizontal",
					"commas",
				]))
				.hide_possible_values(true)
				.require_equals(true)
				.overrides_with_all([
					options::FORMAT,
					options::format::COLUMNS,
					options::format::LONG,
					options::format::ACROSS,
					options::format::COLUMNS,
					options::DIRED,
				]),
		)
		.arg(
			Arg::new(options::format::COLUMNS)
				.short('C')
				.help("Display the files in columns.")
				.overrides_with_all([
					options::FORMAT,
					options::format::COLUMNS,
					options::format::LONG,
					options::format::ACROSS,
					options::format::COLUMNS,
				])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::format::LONG)
				.short('l')
				.long(options::format::LONG)
				.help("Display detailed information.")
				.overrides_with_all([
					options::FORMAT,
					options::format::COLUMNS,
					options::format::LONG,
					options::format::ACROSS,
					options::format::COLUMNS,
				])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::format::ACROSS)
				.short('x')
				.help("List entries in rows instead of in columns.")
				.overrides_with_all([
					options::FORMAT,
					options::format::COLUMNS,
					options::format::LONG,
					options::format::ACROSS,
					options::format::COLUMNS,
				])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::format::TAB_SIZE)
				.short('T')
				.long(options::format::TAB_SIZE)
				.value_name("COLS")
				.help("Assume tab stops at each COLS instead of 8"),
		)
		.arg(
			Arg::new(options::format::COMMAS)
				.short('m')
				.help("List entries separated by commas.")
				.overrides_with_all([
					options::FORMAT,
					options::format::COLUMNS,
					options::format::LONG,
					options::format::ACROSS,
					options::format::COLUMNS,
				])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::ZERO)
				.long(options::ZERO)
				.overrides_with(options::ZERO)
				.help("List entries separated by ASCII NUL characters.")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::DIRED)
				.long(options::DIRED)
				.short('D')
				.help("generate output designed for Emacs' dired (Directory Editor) mode")
				.action(ArgAction::SetTrue)
				.overrides_with(options::HYPERLINK),
		)
		.arg(
			Arg::new(options::HYPERLINK)
				.long(options::HYPERLINK)
				.help("hyperlink file names WHEN")
				.value_parser(ShortcutValueParser::new([
					PossibleValue::new("always").alias("yes").alias("force"),
					PossibleValue::new("auto").alias("tty").alias("if-tty"),
					PossibleValue::new("never").alias("no").alias("none"),
				]))
				.require_equals(true)
				.num_args(0..=1)
				.default_missing_value("always")
				.default_value("never")
				.value_name("WHEN")
				.overrides_with(options::DIRED),
		)
		// The next four arguments do not override with the other format
		// options, see the comment in Config::from for the reason.
		// Ideally, they would use Arg::override_with, with their own name
		// but that doesn't seem to work in all cases. Example:
		// ls -1g1
		// even though `ls -11` and `ls -1 -g -1` work.
		.arg(
			Arg::new(options::format::ONE_LINE)
				.short('1')
				.help("List one file per line.")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::format::LONG_NO_GROUP)
				.short('o')
				.help(
					"Long format without group information.\nIdentical to --format=long with \
					 --no-group.",
				)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::format::LONG_NO_OWNER)
				.short('g')
				.help("Long format without owner information.")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::format::LONG_NUMERIC_UID_GID)
				.short('n')
				.long(options::format::LONG_NUMERIC_UID_GID)
				.help("-l with numeric UIDs and GIDs.")
				.action(ArgAction::SetTrue),
		)
		// Quoting style
		.arg(
			Arg::new(QUOTING_STYLE)
				.long(QUOTING_STYLE)
				.help("Set quoting style.")
				.value_parser(ShortcutValueParser::new([
					PossibleValue::new("literal"),
					PossibleValue::new("locale"),
					PossibleValue::new("shell"),
					PossibleValue::new("shell-escape"),
					PossibleValue::new("shell-always"),
					PossibleValue::new("shell-escape-always"),
					PossibleValue::new("clocale"),
					PossibleValue::new("c").alias("c-maybe"),
					PossibleValue::new("escape"),
				]))
				.overrides_with_all([
					QUOTING_STYLE,
					options::quoting::LITERAL,
					options::quoting::ESCAPE,
					options::quoting::C,
				]),
		)
		.arg(
			Arg::new(options::quoting::LITERAL)
				.short('N')
				.long(options::quoting::LITERAL)
				.alias("l")
				.help("Use literal quoting style. Equivalent to `--quoting-style=literal`")
				.overrides_with_all([
					QUOTING_STYLE,
					options::quoting::LITERAL,
					options::quoting::ESCAPE,
					options::quoting::C,
				])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::quoting::ESCAPE)
				.short('b')
				.long(options::quoting::ESCAPE)
				.help("Use escape quoting style. Equivalent to `--quoting-style=escape`")
				.overrides_with_all([
					QUOTING_STYLE,
					options::quoting::LITERAL,
					options::quoting::ESCAPE,
					options::quoting::C,
				])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::quoting::C)
				.short('Q')
				.long(options::quoting::C)
				.help("Use C quoting style. Equivalent to `--quoting-style=c`")
				.overrides_with_all([
					QUOTING_STYLE,
					options::quoting::LITERAL,
					options::quoting::ESCAPE,
					options::quoting::C,
				])
				.action(ArgAction::SetTrue),
		)
		// Control characters
		.arg(
			Arg::new(options::HIDE_CONTROL_CHARS)
				.short('q')
				.long(options::HIDE_CONTROL_CHARS)
				.help("Replace control characters with '?' if they are not escaped.")
				.overrides_with_all([options::HIDE_CONTROL_CHARS, options::SHOW_CONTROL_CHARS])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::SHOW_CONTROL_CHARS)
				.long(options::SHOW_CONTROL_CHARS)
				.help("Show control characters 'as is' if they are not escaped.")
				.overrides_with_all([options::HIDE_CONTROL_CHARS, options::SHOW_CONTROL_CHARS])
				.action(ArgAction::SetTrue),
		)
		// Time arguments
		.arg(
			Arg::new(options::TIME)
				.long(options::TIME)
				.help(
					"Show time in `<field>`:\naccess time (-u): atime, access, use;\nchange time (-t): \
					 ctime, status.\nmodification time: mtime, modification.\nbirth time: birth, \
					 creation;",
				)
				.value_name("field")
				.value_parser(ShortcutValueParser::new([
					PossibleValue::new("atime").alias("access").alias("use"),
					PossibleValue::new("ctime").alias("status"),
					PossibleValue::new("mtime").alias("modification"),
					PossibleValue::new("birth").alias("creation"),
				]))
				.hide_possible_values(true)
				.require_equals(true)
				.overrides_with_all([options::TIME, options::time::ACCESS, options::time::CHANGE]),
		)
		.arg(
			Arg::new(options::time::CHANGE)
				.short('c')
				.help(
					"If the long listing format (e.g., -l, -o) is being used, print the\nstatus change \
					 time (the 'ctime' in the inode) instead of the modification\ntime. When \
					 explicitly sorting by time (--sort=time or -t) or when not\nusing a long listing \
					 format, sort according to the status change time.",
				)
				.overrides_with_all([options::TIME, options::time::ACCESS, options::time::CHANGE])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::time::ACCESS)
				.short('u')
				.help(
					"If the long listing format (e.g., -l, -o) is being used, print the\nstatus access \
					 time instead of the modification time. When explicitly\nsorting by time \
					 (--sort=time or -t) or when not using a long listing\nformat, sort according to \
					 the access time.",
				)
				.overrides_with_all([options::TIME, options::time::ACCESS, options::time::CHANGE])
				.action(ArgAction::SetTrue),
		)
		// Hide and ignore
		.arg(
			Arg::new(options::HIDE)
				.long(options::HIDE)
				.action(ArgAction::Append)
				.value_name("PATTERN")
				.help("do not list implied entries matching shell PATTERN (overridden by -a or -A)"),
		)
		.arg(
			Arg::new(options::IGNORE)
				.short('I')
				.long(options::IGNORE)
				.action(ArgAction::Append)
				.value_name("PATTERN")
				.help("do not list implied entries matching shell PATTERN"),
		)
		.arg(
			Arg::new(options::IGNORE_BACKUPS)
				.short('B')
				.long(options::IGNORE_BACKUPS)
				.help("Ignore entries which end with ~.")
				.action(ArgAction::SetTrue),
		)
		// Sort arguments
		.arg(
			Arg::new(options::SORT)
				.long(options::SORT)
				.help(
					"Sort by `<field>`: name, none (-U), time (-t), size (-S), extension (-X) or width",
				)
				.value_name("field")
				.value_parser(ShortcutValueParser::new([
					"name",
					"none",
					"time",
					"size",
					"version",
					"extension",
					"width",
				]))
				.require_equals(true)
				.overrides_with_all([
					options::SORT,
					options::sort::SIZE,
					options::sort::TIME,
					options::sort::NONE,
					options::sort::VERSION,
					options::sort::EXTENSION,
				]),
		)
		.arg(
			Arg::new(options::sort::SIZE)
				.short('S')
				.help("Sort by file size, largest first.")
				.overrides_with_all([
					options::SORT,
					options::sort::SIZE,
					options::sort::TIME,
					options::sort::NONE,
					options::sort::VERSION,
					options::sort::EXTENSION,
				])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::sort::TIME)
				.short('t')
				.help("Sort by modification time (the 'mtime' in the inode), newest first.")
				.overrides_with_all([
					options::SORT,
					options::sort::SIZE,
					options::sort::TIME,
					options::sort::NONE,
					options::sort::VERSION,
					options::sort::EXTENSION,
				])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::sort::VERSION)
				.short('v')
				.help("Natural sort of (version) numbers in the filenames.")
				.overrides_with_all([
					options::SORT,
					options::sort::SIZE,
					options::sort::TIME,
					options::sort::NONE,
					options::sort::VERSION,
					options::sort::EXTENSION,
				])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::sort::EXTENSION)
				.short('X')
				.help("Sort alphabetically by entry extension.")
				.overrides_with_all([
					options::SORT,
					options::sort::SIZE,
					options::sort::TIME,
					options::sort::NONE,
					options::sort::VERSION,
					options::sort::EXTENSION,
				])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::sort::NONE)
				.short('U')
				.help(
					"Do not sort; list the files in whatever order they are stored in the\ndirectory.  \
					 This is especially useful when listing very large directories,\nsince not doing \
					 any sorting can be noticeably faster.",
				)
				.overrides_with_all([
					options::SORT,
					options::sort::SIZE,
					options::sort::TIME,
					options::sort::NONE,
					options::sort::VERSION,
					options::sort::EXTENSION,
				])
				.action(ArgAction::SetTrue),
		)
		// Dereferencing
		.arg(
			Arg::new(options::dereference::ALL)
				.short('L')
				.long(options::dereference::ALL)
				.help(
					"When showing file information for a symbolic link, show information for the\nfile \
					 the link references rather than the link itself.",
				)
				.overrides_with_all([
					options::dereference::ALL,
					options::dereference::DIR_ARGS,
					options::dereference::ARGS,
				])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::dereference::DIR_ARGS)
				.long(options::dereference::DIR_ARGS)
				.help(
					"Do not follow symlinks except when they link to directories and are\ngiven as \
					 command line arguments.",
				)
				.overrides_with_all([
					options::dereference::ALL,
					options::dereference::DIR_ARGS,
					options::dereference::ARGS,
				])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::dereference::ARGS)
				.short('H')
				.long(options::dereference::ARGS)
				.help("Do not follow symlinks except when given as command line arguments.")
				.overrides_with_all([
					options::dereference::ALL,
					options::dereference::DIR_ARGS,
					options::dereference::ARGS,
				])
				.action(ArgAction::SetTrue),
		)
		// Long format options
		.arg(
			Arg::new(options::NO_GROUP)
				.long(options::NO_GROUP)
				.short('G')
				.help("Do not show group in long format.")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::AUTHOR)
				.long(options::AUTHOR)
				.help(
					"Show author in long format. On the supported platforms,\nthe author always \
					 matches the file owner.",
				)
				.action(ArgAction::SetTrue),
		)
		// Other Flags
		.arg(
			Arg::new(options::files::ALL)
				.short('a')
				.long(options::files::ALL)
				// Overrides -A (as the order matters)
				.overrides_with_all([options::files::ALL, options::files::ALMOST_ALL])
				.help("Do not ignore hidden files (files with names that start with '.').")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::files::ALMOST_ALL)
				.short('A')
				.long(options::files::ALMOST_ALL)
				// Overrides -a (as the order matters)
				.overrides_with_all([options::files::ALL, options::files::ALMOST_ALL])
				.help(
					"In a directory, do not ignore all file names that start with '.',\nonly ignore \
					 '.' and '..'.",
				)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::files::UNSORTED_ALL)
				.short('f')
				.help(
					"List all files in directory order, unsorted. Equivalent to -aU. Disables --color \
					 unless explicitly specified.",
				)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::DIRECTORY)
				.short('d')
				.long(options::DIRECTORY)
				.help(
					"Only list the names of directories, rather than listing directory contents.\nThis \
					 will not follow symbolic links unless one of `--dereference-command-line\n(-H)`, \
					 `--dereference (-L)`, or `--dereference-command-line-symlink-to-dir` \
					 is\nspecified.",
				)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::size::HUMAN_READABLE)
				.short('h')
				.long(options::size::HUMAN_READABLE)
				.help("Print human readable file sizes (e.g. 1K 234M 56G).")
				.overrides_with_all([options::size::BLOCK_SIZE, options::size::SI])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::size::KIBIBYTES)
				.short('k')
				.long(options::size::KIBIBYTES)
				.help(
					"default to 1024-byte blocks for file system usage; used only with -s and \
					 per\ndirectory totals",
				)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::size::SI)
				.long(options::size::SI)
				.help("Print human readable file sizes using powers of 1000 instead of 1024.")
				.overrides_with_all([options::size::BLOCK_SIZE, options::size::HUMAN_READABLE])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::size::BLOCK_SIZE)
				.long(options::size::BLOCK_SIZE)
				.require_equals(true)
				.value_name("BLOCK_SIZE")
				.help("scale sizes by BLOCK_SIZE when printing them")
				.overrides_with_all([options::size::SI, options::size::HUMAN_READABLE]),
		)
		.arg(
			Arg::new(options::INODE)
				.short('i')
				.long(options::INODE)
				.help("print the index number of each file")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::REVERSE)
				.short('r')
				.long(options::REVERSE)
				.help(
					"Reverse whatever the sorting method is e.g., list files in reverse\nalphabetical \
					 order, youngest first, smallest first, or whatever.",
				)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::RECURSIVE)
				.short('R')
				.long(options::RECURSIVE)
				.help("List the contents of all directories recursively.")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::WIDTH)
				.long(options::WIDTH)
				.short('w')
				.help("Assume that the terminal is COLS columns wide.")
				.value_name("COLS"),
		)
		.arg(
			Arg::new(options::size::ALLOCATION_SIZE)
				.short('s')
				.long(options::size::ALLOCATION_SIZE)
				.help("print the allocated size of each file, in blocks")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::COLOR)
				.long(options::COLOR)
				.help("Color output based on file type.")
				.value_parser(ShortcutValueParser::new([
					PossibleValue::new("always").alias("yes").alias("force"),
					PossibleValue::new("auto").alias("tty").alias("if-tty"),
					PossibleValue::new("never").alias("no").alias("none"),
				]))
				.require_equals(true)
				.num_args(0..=1),
		)
		.arg(
			Arg::new(options::INDICATOR_STYLE)
				.long(options::INDICATOR_STYLE)
				.help(
					"Append indicator with style WORD to entry names:\nnone (default),  slash (-p), \
					 file-type (--file-type), classify (-F)",
				)
				.value_parser(ShortcutValueParser::new(["none", "slash", "file-type", "classify"]))
				.overrides_with_all([
					options::indicator_style::FILE_TYPE,
					options::indicator_style::SLASH,
					options::indicator_style::CLASSIFY,
					options::INDICATOR_STYLE,
				]),
		)
		.arg(
			// The --classify flag can take an optional when argument to
			// control its behavior from version 9 of GNU coreutils.
			// There is currently an inconsistency where GNU coreutils allows only
			// the long form of the flag to take the argument while we allow it
			// for both the long and short form of the flag.
			Arg::new(options::indicator_style::CLASSIFY)
				.short('F')
				.long(options::indicator_style::CLASSIFY)
				.help(
					"Append a character to each file name indicating the file type. Also, for\nregular \
					 files that are executable, append '*'. The file type indicators are\n'/' for \
					 directories, '@' for symbolic links, '|' for FIFOs, '=' for sockets,\n'>' for \
					 doors, and nothing for regular files. when may be omitted, or one of:\n    none - \
					 Do not classify. This is the default.\n    auto - Only classify if standard \
					 output is a terminal.\n    always - Always classify.\nSpecifying --classify and \
					 no when is equivalent to --classify=always. This will\nnot follow symbolic links \
					 listed on the command line unless the\n--dereference-command-line (-H), \
					 --dereference (-L), or\n--dereference-command-line-symlink-to-dir options are \
					 specified.",
				)
				.value_name("when")
				.value_parser(ShortcutValueParser::new([
					PossibleValue::new("always").alias("yes").alias("force"),
					PossibleValue::new("auto").alias("tty").alias("if-tty"),
					PossibleValue::new("never").alias("no").alias("none"),
				]))
				.default_missing_value("always")
				.require_equals(true)
				.num_args(0..=1)
				.overrides_with_all([
					options::indicator_style::FILE_TYPE,
					options::indicator_style::SLASH,
					options::indicator_style::CLASSIFY,
					options::INDICATOR_STYLE,
				]),
		)
		.arg(
			Arg::new(options::indicator_style::FILE_TYPE)
				.long(options::indicator_style::FILE_TYPE)
				.help("Same as --classify, but do not append '*'")
				.overrides_with_all([
					options::indicator_style::FILE_TYPE,
					options::indicator_style::SLASH,
					options::indicator_style::CLASSIFY,
					options::INDICATOR_STYLE,
				])
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::indicator_style::SLASH)
				.short('p')
				.help("Append / indicator to directories.")
				.overrides_with_all([
					options::indicator_style::FILE_TYPE,
					options::indicator_style::SLASH,
					options::indicator_style::CLASSIFY,
					options::INDICATOR_STYLE,
				])
				.action(ArgAction::SetTrue),
		)
		.arg(
			//This still needs support for posix-*
			Arg::new(options::TIME_STYLE)
				.long(options::TIME_STYLE)
				.help("time/date format with -l; see TIME_STYLE below")
				.value_name("TIME_STYLE")
				.value_parser(NonEmptyStringValueParser::new())
				.overrides_with_all([options::TIME_STYLE]),
		)
		.arg(
			Arg::new(options::FULL_TIME)
				.long(options::FULL_TIME)
				.overrides_with(options::FULL_TIME)
				.help("like -l --time-style=full-iso")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::CONTEXT)
				.short('Z')
				.long(options::CONTEXT)
				.help("print any security context of each file")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::GROUP_DIRECTORIES_FIRST)
				.long(options::GROUP_DIRECTORIES_FIRST)
				.help(
					"group directories before files; can be augmented with\na --sort option, but any \
					 use of --sort=none (-U) disables grouping",
				)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(options::DIRED_SEEN)
				.long("__dired-seen")
				.hide(true)
				.action(ArgAction::SetTrue),
		)
		// Positional arguments
		.arg(
			Arg::new(options::PATHS)
				.action(ArgAction::Append)
				.value_hint(clap::ValueHint::AnyPath)
				.value_parser(ValueParser::os_string()),
		)
		.after_help(
			"The TIME_STYLE argument can be full-iso, long-iso, iso, locale or +FORMAT. FORMAT is \
			 interpreted like in date. Also the TIME_STYLE environment variable sets the default \
			 style to use.",
		)
}

/// Creates the `ls` builtin registration.
pub(crate) fn ls_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Ls, SE>()
}

/// Represents the possible values of [`PathData::display_name`]. The reason
/// this is a separate enum is to avoid a self-referential struct, as it is
/// moved in hot loops.
#[derive(Debug)]
enum PathDataDisplayName<'a> {
	SelfReferential,
	Custom(Cow<'a, OsStr>),
}

/// Represents a Path along with it's associated data.
/// Any data that will be reused several times makes sense to be added to this
/// structure. Caching data here helps eliminate redundant syscalls to fetch
/// same information.
struct PathData<'a> {
	// Result<MetaData> got from symlink_metadata() or metadata() based on config
	md:               OnceCell<Option<Metadata>>,
	ft:               OnceCell<Option<FileType>>,
	// can be used to avoid reading the filetype. Can be also called d_type:
	// https://www.gnu.org/software/libc/manual/html_node/Directory-Entries.html
	de:               RefCell<Option<DirEntry>>,
	security_context: OnceCell<Box<str>>,
	// Name of the file - will be empty for . or ..
	display_name:     PathDataDisplayName<'a>,
	// PathBuf that all above data corresponds to
	p_buf:            Cow<'a, Path>,
	fs_path:          PathBuf,
	runtime:          Rc<LsRuntime>,
	must_dereference: bool,
	command_line:     bool,
}

impl<'a> PathData<'a> {
	fn new(
		p_buf: Cow<'a, Path>,
		dir_entry: Option<DirEntry>,
		file_name: Option<Cow<'a, OsStr>>,
		config: &Config,
		command_line: bool,
	) -> Self {
		// We cannot use `Path::ends_with` or `Path::Components`, because they remove
		// occurrences of '.' For '..', the filename is None
		let display_name = if let Some(name) = file_name {
			PathDataDisplayName::Custom(name)
		} else if command_line {
			PathDataDisplayName::SelfReferential
		} else {
			PathDataDisplayName::Custom(
				dir_entry
					.as_ref()
					.map(DirEntry::file_name)
					.unwrap_or_default()
					.into(),
			)
		};

		let fs_path = config.runtime.resolve(&p_buf);
		let must_dereference = match &config.dereference {
			Dereference::All => true,
			Dereference::Args => command_line,
			Dereference::DirArgs => {
				if command_line {
					if let Ok(md) = fs_path.metadata() {
						md.is_dir()
					} else {
						false
					}
				} else {
					false
				}
			},
			Dereference::None => false,
		};

		// Why prefer to check the DirEntry file_type()?  B/c the call is
		// nearly free compared to a metadata() call on a Path
		let ft: OnceCell<Option<FileType>> = OnceCell::new();
		let md: OnceCell<Option<Metadata>> = OnceCell::new();
		let security_context: OnceCell<Box<str>> = OnceCell::new();

		let de: RefCell<Option<DirEntry>> = if let Some(de) = dir_entry {
			if must_dereference && let Ok(md_pb) = fs_path.metadata() {
				ft.get_or_init(|| Some(md_pb.file_type()));
				md.get_or_init(|| Some(md_pb));
			}

			if let Ok(ft_de) = de.file_type() {
				ft.get_or_init(|| Some(ft_de));
			}

			RefCell::new(Some(de))
		} else {
			RefCell::new(None)
		};

		Self {
			md,
			ft,
			de,
			security_context,
			display_name,
			p_buf,
			fs_path,
			runtime: Rc::clone(&config.runtime),
			must_dereference,
			command_line,
		}
	}

	fn metadata(&self) -> Option<&Metadata> {
		self
			.md
			.get_or_init(|| {
				if !self.must_dereference
					&& let Some(dir_entry) = RefCell::take(&self.de)
				{
					return dir_entry.metadata().ok();
				}

				match get_metadata_with_deref_opt(&self.fs_path, self.must_dereference) {
					Err(err) => {
						let errno = err.raw_os_error().unwrap_or(1i32);
						// a bad fd will throw an error when dereferenced,
						// but GNU will not throw an error until a bad fd "dir"
						// is entered, here we match that GNU behavior, by handing
						// back the non-dereferenced metadata upon an EBADF
						if self.must_dereference
							&& errno == 9i32
							&& let Ok(file) = self.fs_path.read_link()
						{
							return file.symlink_metadata().ok();
						}
						self.runtime().error(LsError::IOErrorContext(
							self.path().to_path_buf(),
							err,
							self.command_line,
							self.fs_path.is_dir(),
						));
						None
					},
					Ok(md) => Some(md),
				}
			})
			.as_ref()
	}

	fn file_type(&self) -> Option<&FileType> {
		self
			.ft
			.get_or_init(|| self.metadata().map(Metadata::file_type))
			.as_ref()
	}

	fn is_dangling_link(&self) -> bool {
		// deref enabled, self is real dir entry, self has metadata associated with
		// link, but not with target
		self.must_dereference && self.file_type().is_none() && self.metadata().is_none()
	}

	#[cfg(unix)]
	fn is_executable_file(&self) -> bool {
		self.file_type().is_some_and(FileType::is_file)
			&& self.metadata().is_some_and(file_is_executable)
	}

	fn security_context(&self, config: &Config) -> &str {
		self
			.security_context
			.get_or_init(|| get_security_context(&self.p_buf, self.must_dereference, config).into())
	}

	fn path(&self) -> &Path {
		&self.p_buf
	}

	fn runtime(&self) -> &LsRuntime {
		&self.runtime
	}

	fn display_name(&self) -> &OsStr {
		match self.display_name {
			PathDataDisplayName::SelfReferential => self.p_buf.as_os_str(),
			PathDataDisplayName::Custom(ref cow) => cow,
		}
	}
}

impl Colorable for PathData<'_> {
	fn file_name(&self) -> OsString {
		self.display_name().to_os_string()
	}

	fn file_type(&self) -> Option<FileType> {
		self.file_type().copied()
	}

	fn metadata(&self) -> Option<Metadata> {
		self.metadata().cloned()
	}

	fn path(&self) -> PathBuf {
		self.path().to_path_buf()
	}
}

type DirData = (PathBuf, bool);

// A struct to encapsulate state that is passed around from `list` functions.
#[cfg_attr(not(unix), allow(dead_code))]
struct ListState<'a> {
	out:               StreamWriter,
	style_manager:     Option<StyleManager<'a>>,
	// TODO: More benchmarking with different use cases is required here.
	// From experiments, BTreeMap may be faster than HashMap, especially as the
	// number of users/groups is very limited. It seems like nohash::IntMap
	// performance was equivalent to BTreeMap.
	// It's possible a simple vector linear(binary?) search implementation would be even faster.
	#[cfg(unix)]
	uid_cache:         FxHashMap<u32, String>,
	#[cfg(unix)]
	gid_cache:         FxHashMap<u32, String>,
	#[cfg(not(unix))]
	uid_cache:         (),
	#[cfg(not(unix))]
	gid_cache:         (),
	recent_time_range: RangeInclusive<SystemTime>,
	stack:             Vec<DirData>,
	listed_ancestors:  FxHashSet<FileInformation>,
	initial_locs_len:  usize,
	display_buf:       Vec<u8>,
}

#[allow(clippy::cognitive_complexity)]
pub fn list(locs: Vec<&Path>, config: &Config, stdout: OpenFile) -> std::io::Result<()> {
	let mut files = Vec::<PathData>::new();
	let mut dirs = Vec::<PathData>::new();
	let mut dired = DiredOutput::default();
	let initial_locs_len = locs.len();
	let now = SystemTime::now();

	let mut state = ListState {
		out: StreamWriter::new(stdout),
		style_manager: config
			.color
			.as_ref()
			.map(|colors| StyleManager::new(colors, config.ls_colors.as_deref())),
		#[cfg(unix)]
		uid_cache: FxHashMap::default(),
		#[cfg(unix)]
		gid_cache: FxHashMap::default(),
		#[cfg(not(unix))]
		uid_cache: (),
		#[cfg(not(unix))]
		gid_cache: (),
		// Time range for which to use the "recent" format. Anything from 0.5 year in the past to now
		// (files with modification time in the future use "old" format).
		// According to GNU a Gregorian year has 365.2425 * 24 * 60 * 60 == 31556952 seconds on the
		// average.
		recent_time_range: (now - Duration::new(31_556_952 / 2, 0))..=now,
		stack: Vec::new(),
		listed_ancestors: FxHashSet::default(),
		initial_locs_len,
		display_buf: Vec::with_capacity(if config.format == Format::Long {
			128
		} else {
			0
		}),
	};

	for loc in locs {
		let path_data = PathData::new(loc.into(), None, None, config, true);

		// Getting metadata here is no big deal as it's just the CWD
		// and we really just want to know if the strings exist as files/dirs
		//
		// Proper GNU handling is don't show if dereferenced symlink DNE
		// but only for the base dir, for a child dir show, and print ?s
		// in long format
		if path_data.metadata().is_none() {
			continue;
		}

		let show_dir_contents = if let Some(ft) = path_data.file_type() {
			!config.directory && ft.is_dir()
		} else {
			config.runtime.status.set(1);
			false
		};

		if show_dir_contents {
			dirs.push(path_data);
		} else {
			files.push(path_data);
		}
	}

	sort_entries(&mut files, config);
	sort_entries(&mut dirs, config);

	if let Some(style_manager) = state.style_manager.as_mut() {
		// ls will try to write a reset before anything is written if normal
		// color is given
		if style_manager.get_normal_style().is_some() {
			let to_write = style_manager.reset(true);
			write!(state.out, "{to_write}")?;
		}
	}

	display_items(&files, config, &mut state, &mut dired)?;

	for (pos, path_data) in dirs.iter().enumerate() {
		let needs_blank_line = pos != 0 || !files.is_empty();
		// Do read_dir call here to match GNU semantics by printing
		// read_dir errors before directory headings, names and totals
		let read_dir = match fs::read_dir(&path_data.fs_path) {
			Err(err) => {
				// flush stdout buffer before the error to preserve formatting and order
				state.out.flush()?;
				config.runtime.error(LsError::IOErrorContext(
					path_data.path().to_path_buf(),
					err,
					path_data.command_line,
					path_data.fs_path.is_dir(),
				));
				continue;
			},
			Ok(rd) => rd,
		};

		state.listed_ancestors.insert(FileInformation::from_path(
			&path_data.fs_path,
			path_data.must_dereference,
		)?);

		// List each of the arguments to ls first.
		depth_first_list(
			(path_data.path().to_path_buf(), needs_blank_line),
			read_dir,
			config,
			&mut state,
			&mut dired,
			true,
		)?;

		// Only runs if it must list recursively.
		while let Some(dir_data) = state.stack.pop() {
			let resolved_dir = config.runtime.resolve(&dir_data.0);
			let read_dir = match fs::read_dir(&resolved_dir) {
				Err(err) => {
					// flush stdout buffer before the error to preserve formatting and order
					state.out.flush()?;
					config.runtime.error(LsError::IOErrorContext(
						path_data.path().to_path_buf(),
						err,
						path_data.command_line,
						resolved_dir.is_dir(),
					));
					continue;
				},
				Ok(rd) => rd,
			};

			depth_first_list(dir_data, read_dir, config, &mut state, &mut dired, false)?;

			// Heuristic to ensure stack does not keep its capacity forever if there is
			// combinatorial explosion; we decrease it logarithmically here.
			let (cap, len) = (state.stack.capacity(), state.stack.len());
			if cap > (len + 4) * 2 {
				state.stack.shrink_to(len + (cap - len) / 2);
			}
		}

		// No need to clear state.buf since [`enter_directory`] drains it.
		state.listed_ancestors.clear();
	}
	if config.dired && !config.hyperlink {
		dired::print_dired_output(config, &dired, &mut state.out)?;
	}
	Ok(())
}

fn sort_entries(entries: &mut [PathData], config: &Config) {
	match config.sort {
		Sort::Time => entries.sort_unstable_by_key(|k| {
			Reverse(
				k.metadata()
					.and_then(|md| metadata_get_time(md, config.time))
					.unwrap_or(UNIX_EPOCH),
			)
		}),
		Sort::Size => {
			entries.sort_unstable_by_key(|k| Reverse(k.metadata().map_or(0, Metadata::len)));
		},
		// The default sort in GNU ls is case insensitive
		Sort::Name => entries.sort_unstable_by(|a, b| a.display_name().cmp(b.display_name())),
		Sort::Version => entries.sort_unstable_by(|a, b| {
			version_cmp(
				os_bytes_lossy(a.path().as_os_str()).as_ref(),
				os_bytes_lossy(b.path().as_os_str()).as_ref(),
			)
			.then(a.path().cmp(b.path()))
		}),
		Sort::Extension => entries.sort_unstable_by(|a, b| {
			a.path()
				.extension()
				.cmp(&b.path().extension())
				.then(a.path().file_stem().cmp(&b.path().file_stem()))
		}),
		Sort::Width => entries.sort_unstable_by(|a, b| {
			a.display_name()
				.len()
				.cmp(&b.display_name().len())
				.then(a.display_name().cmp(b.display_name()))
		}),
		Sort::None => {},
	}

	if config.reverse {
		entries.reverse();
	}

	if config.group_directories_first && config.sort != Sort::None {
		entries.sort_unstable_by_key(|p| {
			let ft = {
				// We will always try to deref symlinks to group directories, so PathData.md
				// is not always useful.
				if p.must_dereference {
					p.file_type()
				} else {
					None
				}
			};

			!match ft {
				None => {
					// If it metadata cannot be determined, treat as a file.
					get_metadata_with_deref_opt(&p.fs_path, true).map_or_else(|_| false, |m| m.is_dir())
				},
				Some(ft) => ft.is_dir(),
			}
		});
	}
}

fn depth_first_list(
	(dir_path, needs_blank_line): DirData,
	mut read_dir: ReadDir,
	config: &Config,
	state: &mut ListState,
	dired: &mut DiredOutput,
	is_top_level: bool,
) -> std::io::Result<()> {
	let path_data = PathData::new(dir_path.as_path().into(), None, None, config, false);

	// Print dir heading - name... 'total' comes after error display
	if state.initial_locs_len > 1 || config.recursive {
		if is_top_level {
			if needs_blank_line {
				writeln!(state.out)?;
				if config.dired {
					dired.padding += 1;
				}
			}
			if config.dired {
				dired::indent(&mut state.out)?;
			}
			show_dir_name(&path_data, &mut state.out, config)?;
			writeln!(state.out)?;
			if config.dired {
				let dir_len = path_data.path().as_os_str().len();
				// add the //SUBDIRED// coordinates
				dired::calculate_subdired(dired, dir_len);
				// Add the padding for the dir name
				dired::add_dir_name(dired, dir_len);
			}
		} else {
			writeln!(state.out)?;
			if config.dired {
				dired.padding += 1;
				dired::indent(&mut state.out)?;
				let dir_name_size = path_data.path().as_os_str().len();
				dired::calculate_subdired(dired, dir_name_size);
				dired::add_dir_name(dired, dir_name_size);
			}
			show_dir_name(&path_data, &mut state.out, config)?;
			writeln!(state.out)?;
		}
	}

	// Append entries with initial dot files and record their existence
	let (ref mut buf, trim) = if config.files == Files::All {
		const DOT_DIRECTORIES: usize = 2;
		let v = vec![
			PathData::new(path_data.path().into(), None, Some(OsStr::new(".").into()), config, false),
			PathData::new(
				// On WASI the sandbox may block access to ".." at the
				// preopened root.  Fall back to "." so the entry still
				// appears with valid metadata instead of an error.
				{
					let dotdot = path_data.path().join("..");
					#[cfg(target_os = "wasi")]
					let dotdot = if dotdot.metadata().is_err() {
						path_data.path().into()
					} else {
						dotdot
					};
					dotdot.into()
				},
				None,
				Some(OsStr::new("..").into()),
				config,
				false,
			),
		];
		(v, DOT_DIRECTORIES)
	} else {
		(Vec::new(), 0)
	};

	// Convert those entries to the PathData struct
	for raw_entry in read_dir.by_ref() {
		match raw_entry {
			Ok(dir_entry) => {
				if should_display(&dir_entry, config) {
					buf.push(PathData::new(
						path_data.path().join(dir_entry.file_name()).into(),
						Some(dir_entry),
						None,
						config,
						false,
					));
				}
			},
			Err(err) => {
				state.out.flush()?;
				config.runtime.error(LsError::IOError(err));
			},
		}
	}
	// Relinquish unused space since we won't need it anymore.
	buf.shrink_to_fit();

	sort_entries(buf, config);

	if config.format == Format::Long || config.alloc_size {
		let total = write_total(buf, config, &mut state.out)?;
		if config.dired {
			dired::add_total(dired, total);
		}
	}

	display_items(buf, config, state, dired)?;

	if config.recursive {
		for e in buf
			.iter()
			.skip(trim)
			.filter(|p| p.file_type().is_some_and(FileType::is_dir))
			.rev()
		{
			// Try to open only to report any errors in order to match GNU semantics.
			if let Err(err) = fs::read_dir(&e.fs_path) {
				state.out.flush()?;
				config.runtime.error(LsError::IOErrorContext(
					e.path().to_path_buf(),
					err,
					e.command_line,
					e.fs_path.is_dir(),
				));
			} else {
				let fi = FileInformation::from_path(&e.fs_path, e.must_dereference)?;
				if state.listed_ancestors.insert(fi) {
					// Push to stack, but with a less aggressive growth curve.
					let (cap, len) = (state.stack.capacity(), state.stack.len());
					if cap == len {
						state.stack.reserve_exact(len / 4 + 4);
					}
					state.stack.push((e.path().to_path_buf(), true));
				} else {
					state.out.flush()?;
					config.runtime.error(LsError::AlreadyListedError(e.path().to_path_buf()));
				}
			}
		}
	}
	Ok(())
}

fn get_metadata_with_deref_opt(path: &Path, dereference: bool) -> std::io::Result<Metadata> {
	if dereference {
		path.metadata()
	} else {
		path.symlink_metadata()
	}
}

fn write_total<W: Write>(
	items: &[PathData],
	config: &Config,
	out: &mut W,
) -> std::io::Result<usize> {
	let mut total_size = 0;
	for item in items {
		total_size += item
			.metadata()
			.as_ref()
			.map_or(0, |md| get_block_size(md, config));
	}
	if config.dired {
		dired::indent(out)?;
	}
	let total = format!("total {}", display_size(total_size, config));
	out.write_all(total.as_bytes())?;
	out.write_all(&[config.line_ending as u8])?;
	Ok(total.len() + 1)
}

#[allow(unused_variables)]
fn get_block_size(md: &Metadata, config: &Config) -> u64 {
	/* GNU ls will display sizes in terms of block size
		md.len() will differ from this value when the file has some holes
	*/
	#[cfg(unix)]
	{
		use uucore::format::human::SizeFormat;

		let raw_blocks = if md.file_type().is_char_device() || md.file_type().is_block_device() {
			0u64
		} else {
			md.blocks() * 512
		};
		match config.size_format {
			SizeFormat::Binary | SizeFormat::Decimal => raw_blocks,
			SizeFormat::Bytes => raw_blocks / config.block_size,
		}
	}
	#[cfg(not(unix))]
	{
		// no way to get block size for windows, fall-back to file size
		md.len()
	}
}

#[cfg(unix)]
fn file_is_executable(md: &Metadata) -> bool {
	// Mode always returns u32, but the flags might not be, based on the platform
	// e.g. linux has u32, mac has u16.
	// S_IXUSR -> user has execute permission
	// S_IXGRP -> group has execute permission
	// S_IXOTH -> other users have execute permission
	#[allow(clippy::unnecessary_cast)]
	return md.mode() & ((S_IXUSR | S_IXGRP | S_IXOTH) as u32) != 0;
}

/// This returns the `SELinux` security context as UTF8 `String`.
/// In the long term this should be changed to [`OsStr`], see discussions at
/// #2621/#2656
fn get_security_context<'a>(
	path: &'a Path,
	must_dereference: bool,
	config: &'a Config,
) -> Cow<'a, str> {
	static SUBSTITUTE_STRING: &str = "?";

	// If we must dereference, ensure that the symlink is actually valid even if the
	// system does not support SELinux.
	// Conforms to the GNU coreutils where a dangling symlink results in exit code
	// 1.
	if must_dereference
		&& let Err(err) =
			get_metadata_with_deref_opt(&config.runtime.resolve(path), must_dereference)
	{
		// The Path couldn't be dereferenced, so return early and set exit code 1
		// to indicate a minor error
		// Only show error when context display is requested to avoid duplicate messages
		if config.context {
			config.runtime.error(LsError::IOErrorContext(
				path.to_path_buf(),
				err,
				false,
				config.runtime.resolve(path).is_dir(),
			));
		}
		return Cow::Borrowed(SUBSTITUTE_STRING);
	}


	Cow::Borrowed(SUBSTITUTE_STRING)
}

#[cfg(test)]
mod integration_tests {
	use std::{
		fs::{File, FileTimes},
		time::UNIX_EPOCH,
	};

	use clap::Parser;

	use super::{Ls, Utility};
	use crate::host::{Host, run_util};

	#[test]
	fn resolves_operands_against_the_shell_working_directory() {
		let dir = tempfile::tempdir().unwrap();
		File::create(dir.path().join("visible-name")).unwrap();
		let (code, capture) = run_util::<Ls>(&["visible-name"], "", dir.path());
		assert_eq!(code, 0);
		assert_eq!(capture.out(), "visible-name\n");
	}

	#[cfg(windows)]
	#[test]
	fn resolves_msys_drive_alias_operands() {
		let dir = tempfile::tempdir().unwrap();
		File::create(dir.path().join("visible-name")).unwrap();
		let native = dir.path().to_string_lossy().replace('\\', "/");
		let (drive, tail) = native
			.split_once(":/")
			.unwrap_or_else(|| panic!("expected drive-qualified temp path, got {native:?}"));
		let alias = format!("/{}/{}", drive.to_ascii_lowercase(), tail);

		let (code, capture) = run_util::<Ls>(&[&alias], "", dir.path());

		assert_eq!(code, 0);
		assert_eq!(capture.out(), "visible-name\n");
	}

	#[test]
	fn reads_quoting_style_from_the_shell_environment() {
		let dir = tempfile::tempdir().unwrap();
		let (mut host, capture) = Host::for_test("ls", "", dir.path());
		host.set_test_var("QUOTING_STYLE", "not-a-style");
		let ls = Ls::try_parse_from(["ls"]).unwrap();
		assert_eq!(ls.run(&mut host), 0);
		assert!(capture.err().contains("Ignoring invalid value of environment variable"));
	}

	#[test]
	fn formats_times_in_the_shell_timezone() {
		let dir = tempfile::tempdir().unwrap();
		let file = File::create(dir.path().join("epoch")).unwrap();
		file.set_times(FileTimes::new().set_modified(UNIX_EPOCH)).unwrap();
		let (mut host, capture) = Host::for_test("ls", "", dir.path());
		host.set_test_var("TZ", "America/Los_Angeles");
		let ls = Ls::try_parse_from(["ls", "-l", "--full-time", "epoch"]).unwrap();
		assert_eq!(ls.run(&mut host), 0);
		assert!(capture.out().contains("1969-12-31 16:00:00.000000000 -0800"));
	}
}
