// This file is part of the uutils coreutils package.
//
// For the full copyright and license information, please view the LICENSE
// file that was distributed with this source code.
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
	pub(crate) fn new(colors: &'a LsColors) -> Self {
		let (indicator_codes, ln_color_from_target) = parse_indicator_codes();
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
			&& pi_uutils_ctx::resolve(path.path()).exists();

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
		let mut target = pi_uutils_ctx::resolve(path.path()).read_link().ok()?;
		if target.is_relative()
			&& let Some(parent) = path.path().parent()
		{
			target = parent.join(target);
		}

		match fs::metadata(pi_uutils_ctx::resolve(&target)) {
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
			*existence_cache.get_or_insert_with(|| pi_uutils_ctx::resolve(path.path()).exists())
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
		.or_else(|| pi_uutils_ctx::resolve(&path.p_buf).symlink_metadata().ok());

	style_manager.apply_style_based_on_metadata(path, md_option.as_ref(), name, wrap)
}

#[derive(Debug)]
pub(crate) enum LsColorsParseError {
	UnrecognizedPrefix(String),
	InvalidSyntax,
}

pub(crate) fn validate_ls_colors_env() -> Result<(), LsColorsParseError> {
	let Some(ls_colors) = pi_uutils_ctx::var("LS_COLORS") else {
		return Ok(());
	};

	if ls_colors.is_empty() {
		return Ok(());
	}

	validate_ls_colors(&ls_colors)
}

// GNU-like parser: ensure LS_COLORS has valid labels and well-formed escapes.
fn validate_ls_colors(ls_colors: &str) -> Result<(), LsColorsParseError> {
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

fn parse_indicator_codes() -> (FxHashMap<Indicator, String>, bool) {
	let mut indicator_codes = FxHashMap::default();
	let mut ln_color_from_target = false;

	// LS_COLORS validity is checked before enabling color output, so parse
	// entries directly here for raw indicator overrides.
	if let Some(ls_colors) = pi_uutils_ctx::var("LS_COLORS") {
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
