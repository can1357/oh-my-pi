//! `date` builtin: print or set the system date and time.
//!
//! Ported from uutils coreutils 0.8.0.

use brush_core::{ShellExtensions, builtins::Registration};

use crate::host::{Host, Utility, format_usage, matches_parser, util};

mod format_modifiers {
	//! GNU date format modifier support
	//!
	//! This module implements GNU-compatible format modifiers for date formatting.
	//! These modifiers extend standard strftime format specifiers with optional
	//! width and flag modifiers.
	//!
	//! ## Syntax
	//!
	//! Format: `%[flags][width]specifier`
	//!
	//! ### Flags
	//! - `-`: Do not pad the field
	//! - `_`: Pad with spaces instead of zeros
	//! - `0`: Pad with zeros (default for numeric fields)
	//! - `^`: Convert to uppercase
	//! - `#`: Use opposite case (uppercase becomes lowercase and vice versa)
	//! - `+`: Force display of sign (+ for positive, - for negative)
	//!
	//! ### Width
	//! - One or more digits specifying minimum field width
	//! - Field will be padded to this width using the padding character
	//!
	//! ### Examples
	//! - `%10Y`: Year padded to 10 digits with zeros (0000001999)
	//! - `%_10m`: Month padded to 10 digits with spaces (        06)
	//! - `%-d`: Day without padding (1 instead of 01)
	//! - `%^B`: Month name in uppercase (JUNE)
	//! - `%+4C`: Century with sign, padded to 4 characters (+019)

	use std::{fmt, sync::LazyLock};

	use jiff::{
		Zoned,
		fmt::strtime::{BrokenDownTime, Config, PosixCustom},
	};
	use regex::Regex;

	/// Error type for format modifier operations
	#[derive(Debug)]
	pub enum FormatError {
		/// Error from the underlying jiff library
		JiffError(jiff::Error),
		/// Field width calculation overflowed or required allocation failed
		FieldWidthTooLarge { width: usize, specifier: String },
	}

	impl fmt::Display for FormatError {
		fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
			match self {
				Self::JiffError(e) => write!(f, "{e}"),
				// pi-uutils: literalized en-US translation of
				// `date-error-format-modifier-width-too-large`.
				Self::FieldWidthTooLarge { width, specifier } => {
					write!(f, "format modifier width '{width}' is too large for specifier '%{specifier}'")
				},
			}
		}
	}

	impl From<jiff::Error> for FormatError {
		fn from(e: jiff::Error) -> Self {
			Self::JiffError(e)
		}
	}

	/// Regex to match format specifiers with optional modifiers
	/// Pattern: % \[flags\] \[width\] specifier
	/// Flags: -, _, 0, ^, #, +
	/// Width: one or more digits
	/// Specifier: any letter or special sequence like :z, ::z, :::z
	// pi-uutils: `LazyLock` instead of upstream's function-local `OnceLock`.
	static FORMAT_SPEC_REGEX: LazyLock<Regex> =
		LazyLock::new(|| Regex::new(r"%([_0^#+-]*)(\d*)(:*[a-zA-Z])").unwrap());

	/// Check if format string contains any GNU modifiers and format if present.
	///
	/// This function combines modifier detection and formatting in a single pass
	/// for better performance. If no modifiers are found, returns None and the
	/// caller should use standard formatting. If modifiers are found, returns
	/// the formatted string.
	pub fn format_with_modifiers_if_present(
		date: &Zoned,
		format_string: &str,
		config: &Config<PosixCustom>,
	) -> Option<Result<String, FormatError>> {
		let re = &*FORMAT_SPEC_REGEX;

		// Quick check: does the string contain any modifiers?
		let has_modifiers = re.captures_iter(format_string).any(|cap| {
			let flags = cap.get(1).map_or("", |m| m.as_str());
			let width_str = cap.get(2).map_or("", |m| m.as_str());
			!flags.is_empty() || !width_str.is_empty()
		});

		if !has_modifiers {
			return None;
		}

		// If we have modifiers, format the string
		Some(format_with_modifiers(date, format_string, config))
	}

	/// Process a format string with GNU modifiers.
	///
	/// # Arguments
	/// * `date` - The date to format
	/// * `format_string` - Format string with GNU modifiers
	/// * `config` - Strftime configuration
	///
	/// # Returns
	/// Formatted string with modifiers applied
	///
	/// # Errors
	/// Returns `FormatError` if formatting fails
	fn format_with_modifiers(
		date: &Zoned,
		format_string: &str,
		config: &Config<PosixCustom>,
	) -> Result<String, FormatError> {
		// First, replace %% with a placeholder to avoid matching it
		let placeholder = "\x00PERCENT\x00";
		let temp_format = format_string.replace("%%", placeholder);

		let re = &*FORMAT_SPEC_REGEX;
		let mut result = String::new();
		let mut last_end = 0;

		let broken_down = BrokenDownTime::from(date);

		for cap in re.captures_iter(&temp_format) {
			let whole_match = cap.get(0).unwrap();
			let flags = cap.get(1).map_or("", |m| m.as_str());
			let width_str = cap.get(2).map_or("", |m| m.as_str());
			let spec = cap.get(3).unwrap().as_str();

			// Add text before this match
			result.push_str(&temp_format[last_end..whole_match.start()]);

			// Format the base specifier first
			let base_format = format!("%{spec}");
			let formatted = broken_down.to_string_with_config(config, &base_format)?;

			// Check if this specifier has modifiers
			if !flags.is_empty() || !width_str.is_empty() {
				// Apply modifiers to the formatted value
				let width: usize = width_str.parse().unwrap_or(0);
				let explicit_width = !width_str.is_empty();
				let modified = apply_modifiers(&formatted, flags, width, spec, explicit_width)?;
				result.push_str(&modified);
			} else {
				// No modifiers, use formatted value as-is
				result.push_str(&formatted);
			}

			last_end = whole_match.end();
		}

		// Add remaining text
		result.push_str(&temp_format[last_end..]);

		// Restore %% by converting placeholder to %
		let result = result.replace(placeholder, "%");

		Ok(result)
	}

	/// Returns true if the specifier produces text output (default pad is space)
	/// rather than numeric output (default pad is zero).
	fn is_text_specifier(specifier: &str) -> bool {
		matches!(specifier.chars().last(), Some('A' | 'a' | 'B' | 'b' | 'h' | 'Z' | 'p' | 'P'))
	}

	/// Returns true if the specifier defaults to space padding.
	/// This includes text specifiers and numeric specifiers like %e and %k
	/// that use blank-padding by default in GNU date.
	fn is_space_padded_specifier(specifier: &str) -> bool {
		matches!(
			specifier.chars().last(),
			Some('A' | 'a' | 'B' | 'b' | 'h' | 'Z' | 'p' | 'P' | 'e' | 'k' | 'l')
		)
	}

	/// Returns the default width for a specifier.
	/// This is used when a flag like `_` is used without an explicit width.
	fn get_default_width(specifier: &str) -> usize {
		match specifier.chars().last() {
			// Day of month: 2 digits (01-31)
			Some('d') | Some('e') => 2,
			// Month: 2 digits (01-12)
			Some('m') => 2,
			// Hour: 2 digits (00-23)
			Some('H') | Some('k') => 2,
			// Hour (12-hour): 2 digits (01-12)
			Some('I') | Some('l') => 2,
			// Minute: 2 digits (00-59)
			Some('M') => 2,
			// Second: 2 digits (00-60)
			Some('S') => 2,
			// Year (2-digit): 2 digits
			Some('y') => 2,
			// Day of year: 3 digits (001-366)
			Some('j') => 3,
			// Week number: 2 digits (00-53)
			Some('U') | Some('W') | Some('V') => 2,
			// Day of week: 1 digit (0-6 or 1-7)
			Some('w') | Some('u') => 1,
			// Century: 2 digits (00-99)
			Some('C') => 2,
			// Full year: 4 digits
			Some('Y') | Some('G') => 4,
			// ISO week year (2-digit): 2 digits
			Some('g') => 2,
			// Epoch seconds: typically 10 digits (but variable)
			Some('s') => 0,
			// Nanoseconds: 9 digits
			Some('N') => 9,
			// Quarter: 1 digit
			Some('q') => 1,
			// Timezone offset: varies
			Some('z') => 0,
			// Text specifiers have no default width
			_ => 0,
		}
	}

	/// Strip default padding (leading zeros or leading spaces) from a value,
	/// preserving at least one character.
	fn strip_default_padding(value: &str) -> String {
		if value.starts_with('0') && value.len() >= 2 {
			let stripped = value.trim_start_matches('0');
			if stripped.is_empty() {
				return "0".to_string();
			}
			if let Some(first_char) = stripped.chars().next()
				&& first_char.is_ascii_digit()
			{
				return stripped.to_string();
			}
		}
		if value.starts_with(' ') {
			let stripped = value.trim_start();
			if !stripped.is_empty() {
				return stripped.to_string();
			}
		}
		value.to_string()
	}

	/// Apply width and flag modifiers to a formatted value.
	///
	/// The `specifier` parameter is the format specifier (e.g., "d", "B", "Y")
	/// which determines the default padding character (space for text, zero for
	/// numeric). Flags are processed in order so that when conflicting flags
	/// appear, the last one takes precedence (e.g., `_+` means `+` wins for
	/// padding).
	///
	/// The `explicit_width` parameter indicates whether a width was explicitly
	/// specified in the format string (true) or if width is 0 (false).
	fn apply_modifiers(
		value: &str,
		flags: &str,
		width: usize,
		specifier: &str,
		explicit_width: bool,
	) -> Result<String, FormatError> {
		let mut result = value.to_string();

		// Determine default pad character based on specifier type
		// Determine default pad character based on specifier type.
		// Text specifiers (month names, etc.) and numeric specifiers like %e, %k, %l
		// default to space padding; other numeric specifiers default to zero padding.
		let default_pad = if is_space_padded_specifier(specifier) {
			' '
		} else {
			'0'
		};

		// Process flags in order - last conflicting flag wins
		let mut pad_char = default_pad;
		let mut no_pad = false;
		let mut uppercase = false;
		let mut swap_case = false;
		let mut force_sign = false;
		let mut underscore_flag = false;

		for flag in flags.chars() {
			match flag {
				'-' => {
					no_pad = true;
				},
				'_' => {
					no_pad = false;
					pad_char = ' ';
					underscore_flag = true;
				},
				'0' => {
					no_pad = false;
					pad_char = '0';
				},
				'^' => {
					uppercase = true;
					swap_case = false; // ^ overrides #
				},
				'#' if !uppercase => {
					// Only apply # if ^ hasn't been set
					swap_case = true;
				},
				'+' => {
					force_sign = true;
					no_pad = false;
					pad_char = '0';
				},
				_ => {},
			}
		}

		// Apply case modifications (uppercase takes precedence over swap_case)
		if uppercase {
			result = result.to_uppercase();
		} else if swap_case {
			if result
				.chars()
				.all(|c| !c.is_alphabetic() || c.is_uppercase())
			{
				result = result.to_lowercase();
			} else if !result
				.chars()
				.all(|c| !c.is_alphabetic() || c.is_lowercase())
			{
				result = result.to_uppercase();
			}
		}

		// If no_pad flag is active, suppress all padding and return
		if no_pad {
			return Ok(strip_default_padding(&result));
		}

		// Handle padding flag without explicit width: use default width
		// This applies when _ or 0 flag overrides the default padding character
		// and no explicit width is specified (e.g., %_m, %0e)
		let effective_width = if !explicit_width && (underscore_flag || pad_char != default_pad) {
			get_default_width(specifier)
		} else {
			width
		};

		// When the requested width is narrower than the default formatted width, GNU
		// first removes default padding and then reapplies the requested width.
		if effective_width > 0 && effective_width < result.len() {
			result = strip_default_padding(&result);
		}

		// Strip default padding when switching pad characters on numeric fields
		if !is_text_specifier(specifier) && result.len() >= 2 {
			if pad_char == ' ' && result.starts_with('0') {
				// Switching to space padding: strip leading zeros
				result = strip_default_padding(&result);
			} else if pad_char == '0' && result.starts_with(' ') {
				// Switching to zero padding: strip leading spaces
				result = strip_default_padding(&result);
			}
		}

		// Apply force sign for numeric values
		// GNU behavior: + only adds sign if:
		// 1. An explicit width is provided, OR
		// 2. The value exceeds the default width for that specifier (e.g., year > 4
		//    digits)
		if force_sign
			&& !result.starts_with('+')
			&& !result.starts_with('-')
			&& result.chars().next().is_some_and(|c| c.is_ascii_digit())
		{
			let default_w = get_default_width(specifier);
			// Add sign only if explicit width provided OR result exceeds default width
			if explicit_width || (default_w > 0 && result.len() > default_w) {
				result.insert(0, '+');
			}
		}

		// Apply width padding
		if effective_width > result.len() {
			let padding = effective_width - result.len();
			let has_sign = result.starts_with('+') || result.starts_with('-');

			if pad_char == '0' && has_sign {
				// Zero padding: sign first, then zeros (e.g., "-0022")
				let sign = result.chars().next().unwrap();
				let rest = &result[1..];
				let mut padded = try_alloc_padded(result.len(), padding, effective_width, specifier)?;
				padded.push(sign);
				padded.extend(std::iter::repeat_n('0', padding));
				padded.push_str(rest);
				result = padded;
			} else {
				// Default: pad on the left (e.g., "  -22" or "  1999")
				let mut padded = try_alloc_padded(result.len(), padding, effective_width, specifier)?;
				padded.extend(std::iter::repeat_n(pad_char, padding));
				padded.push_str(&result);
				result = padded;
			}
		}

		Ok(result)
	}

	/// Allocate a `String` with enough capacity for `current_len + padding`,
	/// returning `FieldWidthTooLarge` on arithmetic overflow or allocation failure.
	fn try_alloc_padded(
		current_len: usize,
		padding: usize,
		width: usize,
		specifier: &str,
	) -> Result<String, FormatError> {
		let target_len = current_len
			.checked_add(padding)
			.ok_or_else(|| FormatError::FieldWidthTooLarge { width, specifier: specifier.to_string() })?;
		let mut s = String::new();
		s.try_reserve(target_len)
			.map_err(|_| FormatError::FieldWidthTooLarge { width, specifier: specifier.to_string() })?;
		Ok(s)
	}

	#[cfg(test)]
	mod tests {
		use jiff::{civil, tz::TimeZone};

		use super::*;

		fn make_test_date(year: i16, month: i8, day: i8, hour: i8) -> Zoned {
			civil::date(year, month, day)
				.at(hour, 0, 0, 0)
				.to_zoned(TimeZone::UTC)
				.unwrap()
		}

		fn get_config() -> Config<PosixCustom> {
			Config::new().custom(PosixCustom::new()).lenient(true)
		}

		#[test]
		fn test_width_and_padding_modifiers() {
			let date = make_test_date(1999, 6, 1, 0);
			let config = get_config();

			// Test basic width with zero padding
			let result = format_with_modifiers(&date, "%10Y", &config).unwrap();
			assert_eq!(result, "0000001999");

			// Test large width
			let result = format_with_modifiers(&date, "%20Y", &config).unwrap();
			assert_eq!(result, "00000000000000001999");
			assert_eq!(result.len(), 20);

			// Test underscore (space) padding with month
			let result = format_with_modifiers(&date, "%_10m", &config).unwrap();
			assert_eq!(result, "         6");
			assert_eq!(result.len(), 10);

			// Test underscore padding with day
			let date_day5 = make_test_date(1999, 6, 5, 0);
			let result = format_with_modifiers(&date_day5, "%_10d", &config).unwrap();
			assert_eq!(result, "         5");
		}

		#[test]
		fn test_no_pad_and_case_flags() {
			let date = make_test_date(1999, 6, 1, 0);
			let config = get_config();

			// Test no-pad: %-10Y suppresses all padding (width ignored)
			let result = format_with_modifiers(&date, "%-10Y", &config).unwrap();
			assert_eq!(result, "1999");

			// Test no-pad: %-d strips default zero padding
			let result = format_with_modifiers(&date, "%-d", &config).unwrap();
			assert_eq!(result, "1");

			// Test uppercase: %^B should uppercase month name
			let result = format_with_modifiers(&date, "%^B", &config).unwrap();
			assert_eq!(result, "JUNE");

			// Test uppercase with width: %^10B should uppercase and space-pad (text
			// specifier)
			let result = format_with_modifiers(&date, "%^10B", &config).unwrap();
			assert_eq!(result, "      JUNE");
			assert_eq!(result.len(), 10);
		}

		#[test]
		fn test_sign_flags() {
			let date = make_test_date(1970, 1, 1, 0);
			let config = get_config();

			// Test force sign with century: %+4C
			let result = format_with_modifiers(&date, "%+4C", &config).unwrap();
			assert!(result.starts_with('+'));
			assert_eq!(result.len(), 4);

			// Test force sign with zero padding: %+6Y
			let result = format_with_modifiers(&date, "%+6Y", &config).unwrap();
			assert_eq!(result, "+01970");
		}

		#[test]
		fn test_combined_flags_underscore_and_sign() {
			let date = make_test_date(1970, 1, 1, 0);
			let config = get_config();
			// %_+6Y: _ sets space pad, then + overrides to zero pad with sign (last wins)
			let result = format_with_modifiers(&date, "%_+6Y", &config).unwrap();
			assert_eq!(result, "+01970");
		}

		#[test]
		fn test_combined_flags_no_pad_and_uppercase() {
			let date = make_test_date(1999, 6, 1, 0);
			let config = get_config();
			// %-^10B: uppercase + no-pad (- suppresses all padding, width ignored)
			let result = format_with_modifiers(&date, "%-^10B", &config).unwrap();
			assert_eq!(result, "JUNE");
		}

		#[test]
		fn test_swap_case_flag() {
			let date = make_test_date(1999, 6, 1, 0);
			let config = get_config();
			// %#B: swap case on "June" (mixed case) → uppercase
			let result = format_with_modifiers(&date, "%#B", &config).unwrap();
			assert_eq!(result, "JUNE");
		}

		#[test]
		fn test_width_smaller_than_result() {
			let date = make_test_date(1999, 6, 1, 0);
			let config = get_config();
			// %1d: width 1 < "01".len() → strip zero padding → "1"
			let result = format_with_modifiers(&date, "%1d", &config).unwrap();
			assert_eq!(result, "1");
		}

		#[test]
		fn test_edge_cases_and_special_formats() {
			let date = make_test_date(1999, 6, 1, 0);
			let config = get_config();

			// Test width zero (no effect)
			let result = format_with_modifiers(&date, "%Y", &config).unwrap();
			assert_eq!(result, "1999");

			// Test no modifiers (standard format)
			let result = format_with_modifiers(&date, "%Y-%m-%d", &config).unwrap();
			assert_eq!(result, "1999-06-01");

			// Test %% escape sequence
			let result = format_with_modifiers(&date, "%%Y=%Y", &config).unwrap();
			assert_eq!(result, "%Y=1999");

			// Test multiple modifiers in one format string
			// %-5d: no-pad suppresses all padding → "1" (width ignored)
			let result = format_with_modifiers(&date, "%10Y-%_5m-%-5d", &config).unwrap();
			assert_eq!(result, "0000001999-    6-1");
		}

		#[test]
		fn test_modifier_detection() {
			let date = make_test_date(1999, 6, 1, 0);
			let config = get_config();

			// Should detect modifiers
			let result = format_with_modifiers_if_present(&date, "%10Y", &config);
			assert!(result.is_some());

			// Should not detect modifiers
			let result = format_with_modifiers_if_present(&date, "%Y-%m-%d", &config);
			assert!(result.is_none());

			// Should detect flag without width
			let result = format_with_modifiers_if_present(&date, "%^B", &config);
			assert!(result.is_some());
		}

		#[test]
		fn test_negative_values_with_space_padding() {
			// Test case from GNU test: neg-secs2
			// Format: %_5s with value -22 should produce "  -22" (space-padded)
			use jiff::Timestamp;

			let ts = Timestamp::from_second(-22).unwrap();
			let date = ts.to_zoned(TimeZone::UTC);
			let config = get_config();

			let result = format_with_modifiers(&date, "%_5s", &config).unwrap();
			assert_eq!(result, "  -22", "Space padding should pad before the sign for negative numbers");
		}

		// Unit tests for apply_modifiers function
		#[test]
		fn test_apply_modifiers_basic() {
			// No modifiers (numeric specifier)
			assert_eq!(apply_modifiers("1999", "", 0, "Y", false).unwrap(), "1999");
			// Zero padding
			assert_eq!(apply_modifiers("1999", "0", 10, "Y", true).unwrap(), "0000001999");
			// Space padding (strips leading zeros)
			assert_eq!(apply_modifiers("06", "_", 5, "m", true).unwrap(), "    6");
			// No-pad (strips leading zeros, width ignored)
			assert_eq!(apply_modifiers("01", "-", 5, "d", true).unwrap(), "1");
			// Uppercase
			assert_eq!(apply_modifiers("june", "^", 0, "B", false).unwrap(), "JUNE");
			// Swap case: all uppercase → lowercase
			assert_eq!(apply_modifiers("UTC", "#", 0, "Z", false).unwrap(), "utc");
			// Swap case: mixed case → uppercase
			assert_eq!(apply_modifiers("June", "#", 0, "B", false).unwrap(), "JUNE");
		}

		#[test]
		fn test_apply_modifiers_signs() {
			// Force sign with explicit width
			assert_eq!(apply_modifiers("1970", "+", 6, "Y", true).unwrap(), "+01970");
			// Force sign without explicit width: should NOT add sign for 4-digit year
			assert_eq!(apply_modifiers("1999", "+", 0, "Y", false).unwrap(), "1999");
			// Force sign without explicit width: SHOULD add sign for year > 4 digits
			assert_eq!(apply_modifiers("12345", "+", 0, "Y", false).unwrap(), "+12345");
			// Negative with zero padding: sign first, then zeros
			assert_eq!(apply_modifiers("-22", "0", 5, "s", true).unwrap(), "-0022");
			// Negative with space padding: spaces first, then sign
			assert_eq!(apply_modifiers("-22", "_", 5, "s", true).unwrap(), "  -22");
			// Force sign (_+): + is last, overrides _ → zero pad with sign
			assert_eq!(apply_modifiers("5", "_+", 5, "s", true).unwrap(), "+0005");
			// No-pad + uppercase: no padding applied
			assert_eq!(apply_modifiers("june", "-^", 10, "B", true).unwrap(), "JUNE");
		}

		#[test]
		fn test_case_flag_precedence() {
			// Test that ^ (uppercase) overrides # (swap case)
			assert_eq!(apply_modifiers("June", "^#", 0, "B", false).unwrap(), "JUNE");
			assert_eq!(apply_modifiers("June", "#^", 0, "B", false).unwrap(), "JUNE");
			// Test # alone (swap case)
			assert_eq!(apply_modifiers("June", "#", 0, "B", false).unwrap(), "JUNE");
			assert_eq!(apply_modifiers("JUNE", "#", 0, "B", false).unwrap(), "june");
		}

		#[test]
		fn test_apply_modifiers_text_specifiers() {
			// Text specifiers default to space padding
			assert_eq!(apply_modifiers("June", "", 10, "B", true).unwrap(), "      June");
			assert_eq!(apply_modifiers("Mon", "", 10, "a", true).unwrap(), "       Mon");
			// Numeric specifiers default to zero padding
			assert_eq!(apply_modifiers("6", "", 10, "m", true).unwrap(), "0000000006");
		}

		#[test]
		fn test_apply_modifiers_width_smaller_than_result() {
			// Width smaller than result strips default padding
			assert_eq!(apply_modifiers("01", "", 1, "d", true).unwrap(), "1");
			assert_eq!(apply_modifiers("06", "", 1, "m", true).unwrap(), "6");
		}

		#[test]
		fn test_apply_modifiers_parametrized() {
			let test_cases = vec![
				("1", "0", 3, "Y", true, "001"),
				("1", "_", 3, "d", true, "  1"),
				("1", "-", 3, "d", true, "1"),       // no-pad: width ignored
				("abc", "^", 5, "B", true, "  ABC"), // text specifier: space pad
				("5", "+", 4, "s", true, "+005"),
				("5", "_+", 4, "s", true, "+005"), // + is last: zero pad with sign
				("-3", "0", 5, "s", true, "-0003"),
				("05", "_", 3, "d", true, "  5"),
				("09", "-", 4, "d", true, "9"),         // no-pad: width ignored
				("1970", "_+", 6, "Y", true, "+01970"), // + is last: zero pad with sign
			];

			for (value, flags, width, spec, explicit_width, expected) in test_cases {
				assert_eq!(
					apply_modifiers(value, flags, width, spec, explicit_width).unwrap(),
					expected,
					"value='{value}', flags='{flags}', width={width}, spec='{spec}', \
					 explicit_width={explicit_width}",
				);
			}
		}

		#[test]
		fn test_apply_modifiers_width_too_large() {
			let err = apply_modifiers("x", "", usize::MAX, "c", true).unwrap_err();
			assert!(matches!(
				err,
				FormatError::FieldWidthTooLarge { width, specifier }
				if width == usize::MAX && specifier == "c"
			));
		}

		#[test]
		fn test_underscore_flag_without_width() {
			// %_m should pad month to default width 2 with spaces
			assert_eq!(apply_modifiers("6", "_", 0, "m", false).unwrap(), " 6");
			// %_d should pad day to default width 2 with spaces
			assert_eq!(apply_modifiers("1", "_", 0, "d", false).unwrap(), " 1");
			// %_H should pad hour to default width 2 with spaces
			assert_eq!(apply_modifiers("5", "_", 0, "H", false).unwrap(), " 5");
			// %_Y should pad year to default width 4 with spaces
			assert_eq!(apply_modifiers("1999", "_", 0, "Y", false).unwrap(), "1999");
			// already at default width
		}

		#[test]
		fn test_plus_flag_without_width() {
			// %+Y without width should NOT add sign for 4-digit year
			assert_eq!(apply_modifiers("1999", "+", 0, "Y", false).unwrap(), "1999");
			// %+Y without width SHOULD add sign for year > 4 digits
			assert_eq!(apply_modifiers("12345", "+", 0, "Y", false).unwrap(), "+12345");
			// %+Y with explicit width should add sign
			assert_eq!(apply_modifiers("1999", "+", 6, "Y", true).unwrap(), "+01999");
		}

		#[test]
		fn test_zero_flag_on_space_padded_specifiers() {
			// GNU date: %0e should override space-padding with zero-padding
			// Verified: `date -d "2024-06-05" "+%0e"` → "05"
			let date = make_test_date(1999, 6, 5, 5);
			let config = get_config();

			// %0e: day-of-month (normally space-padded) with 0 flag → zero-padded
			let result = format_with_modifiers(&date, "%0e", &config).unwrap();
			assert_eq!(result, "05", "GNU: %0e should produce '05', not ' 5'");

			// %0k: hour (normally space-padded) with 0 flag → zero-padded
			let result = format_with_modifiers(&date, "%0k", &config).unwrap();
			assert_eq!(result, "05", "GNU: %0k should produce '05', not ' 5'");
		}

		#[test]
		fn test_underscore_century_default_width() {
			// GNU date: %C default width is 2, not 4
			// Verified: `date -d "2024-06-15" "+%_C"` → "20" (no extra padding)
			let date = make_test_date(1999, 6, 1, 0);
			let config = get_config();

			// %_C: century with underscore flag, no explicit width
			// Default width for %C should be 2 (century is 00-99)
			let result = format_with_modifiers(&date, "%_C", &config).unwrap();
			assert_eq!(
				result, "19",
				"GNU: %_C should produce '19', not '  19' (default width is 2, not 4)"
			);
		}
	}
}

use std::{
	borrow::Cow,
	collections::HashMap,
	ffi::OsString,
	fs::File,
	io::{BufRead, BufReader, Read, Write},
	path::{Path, PathBuf},
	sync::LazyLock,
};
#[cfg(any(
	target_os = "linux",
	target_vendor = "apple",
	target_os = "freebsd",
	target_os = "netbsd",
	target_os = "openbsd",
	target_os = "dragonfly",
))]
use std::ffi::{CStr, CString};


use clap::{Arg, ArgAction, ArgMatches, Command};
use jiff::{
	Span, Timestamp, Zoned,
	fmt::strtime::{self, BrokenDownTime, Config, PosixCustom},
	tz::{Offset, TimeZone, TimeZoneDatabase},
};
use uucore::{display::Quotable, parser::shortcut_value_parser::ShortcutValueParser};

// Options
const DATE: &str = "date";
const HOURS: &str = "hours";
const MINUTES: &str = "minutes";
const SECONDS: &str = "seconds";
const NS: &str = "ns";

const OPT_DATE: &str = "date";
const OPT_FORMAT: &str = "format";
const OPT_FILE: &str = "file";
const OPT_DEBUG: &str = "debug";
const OPT_ISO_8601: &str = "iso-8601";
const OPT_RESOLUTION: &str = "resolution";
const OPT_RFC_EMAIL: &str = "rfc-email";
const OPT_RFC_822: &str = "rfc-822";
const OPT_RFC_2822: &str = "rfc-2822";
const OPT_RFC_3339: &str = "rfc-3339";
const OPT_SET: &str = "set";
const OPT_REFERENCE: &str = "reference";
const OPT_UNIVERSAL: &str = "universal";
const OPT_UNIVERSAL_2: &str = "utc";
// BSD compatibility options (no GNU equivalents).
const OPT_BSD_ADJUST: &str = "bsd-adjust";
const OPT_BSD_PARSE_ONLY: &str = "bsd-parse-only";

/// Settings for this program, parsed from the command line
struct Settings {
	utc:         bool,
	format:      Format,
	date_source: DateSource,
	debug:       bool,
	default_format: String,
}

/// Options for parsing dates
#[derive(Clone, Copy)]
struct DebugOptions {
	/// Enable debug output
	debug:         bool,
	/// Warn when midnight is used without explicit time specification
	warn_midnight: bool,
}

impl DebugOptions {
	fn new(debug: bool, warn_midnight: bool) -> Self {
		Self { debug, warn_midnight }
	}
}

/// Various ways of displaying the date
enum Format {
	Iso8601(Iso8601Format),
	Rfc5322,
	Rfc3339(Rfc3339Format),
	Resolution,
	Custom(String),
	Default,
}

/// Various places that dates can come from
enum DateSource {
	Now,
	File(PathBuf),
	FileMtime(PathBuf),
	Stdin,
	Human(String),
	/// BSD `date -j -f FMT VALUE`: VALUE parsed with the strptime format FMT.
	Strptime { format: String, value: String },
	Resolution,
}

enum Iso8601Format {
	Date,
	Hours,
	Minutes,
	Seconds,
	Ns,
}

impl From<&str> for Iso8601Format {
	fn from(s: &str) -> Self {
		match s {
			HOURS => Self::Hours,
			MINUTES => Self::Minutes,
			SECONDS => Self::Seconds,
			NS => Self::Ns,
			DATE => Self::Date,
			// Note: This is caught by clap via `possible_values`
			_ => unreachable!(),
		}
	}
}

enum Rfc3339Format {
	Date,
	Seconds,
	Ns,
}

impl From<&str> for Rfc3339Format {
	fn from(s: &str) -> Self {
		match s {
			DATE => Self::Date,
			SECONDS => Self::Seconds,
			NS => Self::Ns,
			// Should be caught by clap
			_ => panic!("Invalid format: {s}"),
		}
	}
}

/// Indicates whether parsing a military timezone causes the date to remain the
/// same, roll back to the previous day, or advance to the next day.
/// This can occur when applying a military timezone with an optional hour
/// offset crosses midnight in either direction.
#[derive(PartialEq, Debug)]
enum DayDelta {
	/// The date does not change
	Same,
	/// The date rolls back to the previous day.
	Previous,
	/// The date advances to the next day.
	Next,
}

/// Escape invalid UTF-8 bytes in GNU-compatible octal notation.
///
/// Converts bytes to a string with printable ASCII characters preserved
/// and non-printable/invalid UTF-8 bytes escaped as `\NNN` octal sequences.
///
/// This matches GNU date's behavior for invalid input.
///
/// # Arguments
/// * `bytes` - The byte sequence to escape
///
/// # Returns
/// A string with invalid bytes escaped in octal notation
///
/// # Example
/// ```ignore
/// let invalid = b"\xb0";
/// assert_eq!(escape_invalid_bytes(invalid), "\\260");
/// ```
fn escape_invalid_bytes(bytes: &[u8]) -> String {
	let escaped = bytes
		.iter()
		.flat_map(|&b| {
			// Preserve printable ASCII except backslash
			if (0x20..0x7f).contains(&b) && b != b'\\' {
				vec![b]
			} else {
				// Escape as octal: \NNN
				format!("\\{b:03o}").into_bytes()
			}
		})
		.collect::<Vec<u8>>();
	String::from_utf8_lossy(&escaped).into_owned()
}

/// Strip parenthesized comments from a date string.
///
/// GNU date removes balanced parentheses and their content, treating them as
/// comments. If parentheses are unbalanced, everything from the unmatched '('
/// onwards is ignored.
///
/// Examples:
/// - "2026(comment)-01-05" -> "2026-01-05"
/// - "1(ignore comment to eol" -> "1"
/// - "(" -> ""
/// - "((foo)2026-01-05)" -> ""
fn strip_parenthesized_comments(input: &str) -> Cow<'_, str> {
	if !input.contains('(') {
		return Cow::Borrowed(input);
	}

	let mut result = String::with_capacity(input.len());
	let mut depth = 0;

	for c in input.chars() {
		match c {
			'(' => {
				depth += 1;
			},
			')' if depth > 0 => {
				depth -= 1;
			},
			_ if depth == 0 => {
				result.push(c);
			},
			_ => {},
		}
	}

	Cow::Owned(result)
}

/// Parse military timezone with optional hour offset.
/// Pattern: single letter (a-z except j) optionally followed by 1-2 digits.
/// Returns Some(total_hours_in_utc) or None if pattern doesn't match.
///
/// Military timezone mappings:
/// - A-I: UTC+1 to UTC+9 (J is skipped for local time)
/// - K-M: UTC+10 to UTC+12
/// - N-Y: UTC-1 to UTC-12
/// - Z: UTC+0
///
/// The hour offset from digits is added to the base military timezone offset.
/// Examples: "m" -> 12 (noon UTC), "m9" -> 21 (9pm UTC), "a5" -> 4 (4am UTC
/// next day)
fn parse_military_timezone_with_offset(s: &str) -> Option<(i32, DayDelta)> {
	if s.is_empty() || s.len() > 3 {
		return None;
	}

	let mut chars = s.chars();
	let letter = chars.next()?.to_ascii_lowercase();

	// Check if first character is a letter (a-z, except j which is handled
	// separately)
	if !letter.is_ascii_lowercase() || letter == 'j' {
		return None;
	}

	// Parse optional digits (1-2 digits for hour offset)
	let additional_hours: i32 = if let Some(rest) = chars.as_str().chars().next() {
		if !rest.is_ascii_digit() {
			return None;
		}
		chars.as_str().parse().ok()?
	} else {
		0
	};

	// Map military timezone letter to UTC offset
	let tz_offset = match letter {
		'a'..='i' => (letter as i32 - 'a' as i32) + 1, // A=+1, B=+2, ..., I=+9
		'k'..='m' => (letter as i32 - 'k' as i32) + 10, // K=+10, L=+11, M=+12
		'n'..='y' => -((letter as i32 - 'n' as i32) + 1), // N=-1, O=-2, ..., Y=-12
		'z' => 0,                                      // Z=+0
		_ => return None,
	};

	let day_delta = match additional_hours - tz_offset {
		h if h < 0 => DayDelta::Previous,
		h if h >= 24 => DayDelta::Next,
		_ => DayDelta::Same,
	};

	// Calculate total hours: midnight (0) + tz_offset + additional_hours
	// Midnight in timezone X converted to UTC
	let hours_from_midnight = (0 - tz_offset + additional_hours).rem_euclid(24);

	Some((hours_from_midnight, day_delta))
}
/// Rewrite `-I`/`--iso-8601` so the optional ISO precision only binds when it
/// is attached (`-Ihours`, `--iso-8601=hours`), matching GNU getopt. Without
/// this, clap's optional-value handling greedily consumes a following
/// `+FORMAT` operand (`date -I +%s`).
///
/// `argv[0]` is the command name. Scanning stops at `--`, and a token that is
/// the value of a preceding option is never rewritten.
fn rewrite_date_argv(argv: Vec<OsString>) -> Vec<OsString> {
	/// Long options that consume a separate value token.
	const VALUE_LONGS: &[&str] = &["date", "file", "reference", "set", "rfc-3339"];
	/// Long flags that take no value (`iso-8601` is handled separately).
	const FLAG_LONGS: &[&str] =
		&["debug", "resolution", "rfc-email", "rfc-2822", "rfc-822", "universal", "utc", "uct"];
	/// Short options that consume a value, attached or separate.
	const VALUE_SHORTS: &[char] = &['d', 'f', 'r', 's', 'v'];

	let mut out = Vec::with_capacity(argv.len());
	let mut argv = argv.into_iter();
	if let Some(name) = argv.next() {
		out.push(name);
	}
	let mut skip_value = false;
	let mut opts_ended = false;
	for arg in argv {
		if skip_value || opts_ended {
			skip_value = false;
			out.push(arg);
			continue;
		}
		let Some(token) = arg.to_str() else {
			out.push(arg);
			continue;
		};
		if token == "--" {
			opts_ended = true;
			out.push(arg);
		} else if let Some(long) = token.strip_prefix("--") {
			// `infer_long_args` is enabled, so any unambiguous prefix names
			// the option.
			let (name, value) = match long.split_once('=') {
				Some((name, value)) => (name, Some(value)),
				None => (long, None),
			};
			let ambiguous = VALUE_LONGS
				.iter()
				.chain(FLAG_LONGS)
				.any(|other| other.starts_with(name));
			if !name.is_empty() && "iso-8601".starts_with(name) && !ambiguous {
				out.push(format!("--iso-8601={}", value.unwrap_or(DATE)).into());
			} else {
				if value.is_none()
					&& VALUE_LONGS.iter().filter(|l| l.starts_with(name)).count() == 1
					&& !FLAG_LONGS.iter().any(|l| l.starts_with(name))
					&& !"iso-8601".starts_with(name)
				{
					skip_value = true;
				}
				out.push(arg);
			}
		} else if let Some(cluster) = token.strip_prefix('-').filter(|rest| !rest.is_empty()) {
			// Walk a short-option cluster (`-uI`, `-ud @0`, `-Ihours`).
			let mut rewrote = false;
			for (index, ch) in cluster.char_indices() {
				if ch == 'I' {
					let flags = &cluster[..index];
					let rest = &cluster[index + ch.len_utf8()..];
					if !flags.is_empty() {
						out.push(format!("-{flags}").into());
					}
					let spec = if rest.is_empty() { DATE } else { rest };
					out.push(format!("--iso-8601={spec}").into());
					rewrote = true;
					break;
				}
				if VALUE_SHORTS.contains(&ch) {
					// The remainder of the token (or the next token when the
					// remainder is empty) is this option's value.
					if cluster[index + ch.len_utf8()..].is_empty() {
						skip_value = true;
					}
					break;
				}
			}
			if !rewrote {
				out.push(arg);
			}
		} else {
			out.push(arg);
		}
	}
	out
}

/// Unit letter of a BSD `-v` adjustment.
#[derive(Clone, Copy)]
enum BsdAdjustUnit {
	Year,
	Month,
	Week,
	Day,
	Hour,
	Minute,
	Second,
}

/// One BSD `-v` adjustment: a relative offset (`+1d`, `-2m`) or an absolute
/// field set (`1d` sets the day of the month).
#[derive(Clone, Copy)]
enum BsdAdjustment {
	Offset(i64, BsdAdjustUnit),
	Set(i64, BsdAdjustUnit),
}

/// Parse one BSD `-v` argument of the form `[+|-]VAL[ymwdHMS]`.
///
/// BSD is case-sensitive only where it is ambiguous (`m` month vs `M`
/// minute); the unambiguous letters are accepted in either case. Weekday and
/// month names (`-vsun`, `-vjan`) are not supported.
fn parse_bsd_adjustment(spec: &str) -> Option<BsdAdjustment> {
	let (sign, rest) = match *spec.as_bytes().first()? {
		b'+' => (Some(1), &spec[1..]),
		b'-' => (Some(-1), &spec[1..]),
		_ => (None, spec),
	};
	let mut chars = rest.chars();
	let unit = match chars.next_back()? {
		'y' | 'Y' => BsdAdjustUnit::Year,
		'm' => BsdAdjustUnit::Month,
		'w' | 'W' => BsdAdjustUnit::Week,
		'd' | 'D' => BsdAdjustUnit::Day,
		'H' | 'h' => BsdAdjustUnit::Hour,
		'M' => BsdAdjustUnit::Minute,
		'S' | 's' => BsdAdjustUnit::Second,
		_ => return None,
	};
	let digits = chars.as_str();
	if digits.is_empty() || !digits.bytes().all(|b| b.is_ascii_digit()) {
		return None;
	}
	let value: i64 = digits.parse().ok()?;
	Some(match sign {
		Some(sign) => BsdAdjustment::Offset(sign * value, unit),
		None => BsdAdjustment::Set(value, unit),
	})
}

/// Apply BSD `-v` adjustments to `date` in command-line order.
fn apply_bsd_adjustments(mut date: Zoned, adjustments: &[BsdAdjustment]) -> Result<Zoned, String> {
	for adjustment in adjustments {
		date = match *adjustment {
			BsdAdjustment::Offset(value, unit) => {
				let span = Span::new();
				let span = match unit {
					BsdAdjustUnit::Year => span.try_years(value),
					BsdAdjustUnit::Month => span.try_months(value),
					BsdAdjustUnit::Week => span.try_weeks(value),
					BsdAdjustUnit::Day => span.try_days(value),
					BsdAdjustUnit::Hour => span.try_hours(value),
					BsdAdjustUnit::Minute => span.try_minutes(value),
					BsdAdjustUnit::Second => span.try_seconds(value),
				}
				.map_err(|error| format!("invalid adjustment ({error})"))?;
				date
					.checked_add(span)
					.map_err(|error| format!("cannot adjust date ({error})"))?
			},
			BsdAdjustment::Set(value, unit) => {
				let narrow = |unit: char| {
					i8::try_from(value).map_err(|_| format!("invalid adjustment: '{value}{unit}'"))
				};
				let with = date.with();
				let with = match unit {
					BsdAdjustUnit::Year => {
						// BSD windows two-digit years: 69-99 => 19xx, 0-68 => 20xx.
						let year = match value {
							0..=68 => value + 2000,
							69..=99 => value + 1900,
							_ => value,
						};
						let year = i16::try_from(year)
							.map_err(|_| format!("invalid adjustment: '{value}y'"))?;
						with.year(year)
					},
					BsdAdjustUnit::Month => with.month(narrow('m')?),
					BsdAdjustUnit::Week => {
						return Err(format!(
							"unsupported adjustment: '{value}w' (setting the week is not \
							 implemented; use an offset like '+{value}w')"
						));
					},
					BsdAdjustUnit::Day => with.day(narrow('d')?),
					BsdAdjustUnit::Hour => with.hour(narrow('H')?),
					BsdAdjustUnit::Minute => with.minute(narrow('M')?),
					BsdAdjustUnit::Second => with.second(narrow('S')?),
				};
				with
					.build()
					.map_err(|error| format!("cannot adjust date ({error})"))?
			},
		};
	}
	Ok(date)
}

/// BSD `date -j -f FMT VALUE`: parse VALUE with the strptime format FMT.
///
/// Fields the format does not mention keep the current date/time's values,
/// matching BSD `date`, which seeds the broken-down time from
/// `localtime(now)` before calling strptime(3).
fn parse_bsd_strptime(format: &str, value: &str, now: &Zoned) -> Result<Zoned, String> {
	let convert_error =
		|error: jiff::Error| format!("failed conversion of '{value}' using format '{format}' ({error})");
	let broken = BrokenDownTime::parse(format, value).map_err(convert_error)?;
	// `%s` (or a complete civil datetime plus an offset) pins an instant.
	if let Ok(timestamp) = broken.to_timestamp() {
		return Ok(timestamp.to_zoned(now.time_zone().clone()));
	}
	let base = now.datetime();
	let date = broken
		.to_date()
		.or_else(|_| {
			jiff::civil::Date::new(
				broken.year().unwrap_or(base.year()),
				broken.month().unwrap_or(base.month()),
				broken.day().unwrap_or(base.day()),
			)
		})
		.map_err(convert_error)?;
	let time = jiff::civil::Time::new(
		broken.hour().unwrap_or(base.hour()),
		broken.minute().unwrap_or(base.minute()),
		broken.second().unwrap_or(base.second()),
		broken.subsec_nanosecond().unwrap_or(base.subsec_nanosecond()),
	)
	.map_err(convert_error)?;
	date
		.to_datetime(time)
		.to_zoned(now.time_zone().clone())
		.map_err(convert_error)
}


/// Parsed `date` invocation.
pub(crate) struct Date {
	matches: ArgMatches,
}

matches_parser!(Date, uu_app);

#[derive(Debug)]
struct DateError {
	code:    i32,
	message: String,
}

impl DateError {
	fn new(code: i32, message: impl Into<String>) -> Self {
		Self { code, message: message.into() }
	}
}

impl From<std::io::Error> for DateError {
	fn from(error: std::io::Error) -> Self {
		Self::new(1, error.to_string())
	}
}

impl Utility for Date {
	const NAME: &'static str = "date";

	fn rewrite_argv(argv: Vec<OsString>) -> Result<Vec<OsString>, String> {
		Ok(rewrite_date_argv(argv))
	}

	fn run(self, host: &mut Host) -> i32 {
		match date_main(host, &self.matches) {
			Ok(()) => host.exit_code(),
			Err(error) => {
				host.error(error.message, error.code);
				host.exit_code()
			},
		}
	}
}
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
fn shell_locale(host: &Host) -> String {
	let locale = host
		.var("LC_ALL")
		.filter(|value| !value.is_empty())
		.or_else(|| host.var("LC_TIME").filter(|value| !value.is_empty()))
		.or_else(|| host.var("LANG").filter(|value| !value.is_empty()))
		.unwrap_or("C");
	locale_default_format(locale).unwrap_or_else(|| "%a %b %e %X %Z %Y".to_string())
}

#[cfg(any(
	target_os = "linux",
	target_vendor = "apple",
	target_os = "freebsd",
	target_os = "netbsd",
	target_os = "openbsd",
	target_os = "dragonfly",
))]
fn locale_default_format(locale: &str) -> Option<String> {
	let locale = CString::new(locale).ok()?;
	// SAFETY: the locale name is a live NUL-terminated string, the returned
	// locale object is installed only for this blocking utility thread, and it
	// is restored before the object is freed.
	unsafe {
		let locale_object =
			libc::newlocale(libc::LC_TIME_MASK, locale.as_ptr(), std::ptr::null_mut());
		if locale_object.is_null() {
			return None;
		}
		let previous = libc::uselocale(locale_object);
		let format_ptr = libc::nl_langinfo(libc::D_T_FMT);
		let format = (!format_ptr.is_null())
			.then(|| CStr::from_ptr(format_ptr).to_string_lossy().into_owned())
			.filter(|format| !format.is_empty());
		libc::uselocale(previous);
		libc::freelocale(locale_object);

		format.map(|mut format| {
			if !format.contains("%Z") && !format.contains("%z") {
				if let Some(position) = format.find("%Y").or_else(|| format.find("%y")) {
					format.insert_str(position, "%Z ");
				} else {
					format.push_str(" %Z");
				}
			}
			format
		})
	}
}

#[cfg(not(any(
	target_os = "linux",
	target_vendor = "apple",
	target_os = "freebsd",
	target_os = "netbsd",
	target_os = "openbsd",
	target_os = "dragonfly",
)))]
fn locale_default_format(_locale: &str) -> Option<String> {
	None
}



#[allow(clippy::cognitive_complexity)]
fn date_main(host: &mut Host, matches: &ArgMatches) -> Result<(), DateError> {
	let bsd_parse_only = matches.get_flag(OPT_BSD_PARSE_ONLY);
	let adjustments: Vec<BsdAdjustment> = matches
		.get_many::<String>(OPT_BSD_ADJUST)
		.into_iter()
		.flatten()
		.map(|spec| {
			parse_bsd_adjustment(spec)
				.ok_or_else(|| DateError::new(1, format!("invalid adjustment: '{spec}'")))
		})
		.collect::<Result<_, _>>()?;

	// Positional operands: at most one `+FORMAT`, plus (in the BSD `-j -f`
	// form) the date value to parse.
	let mut operands: Vec<&String> = matches
		.get_many::<String>(OPT_FORMAT)
		.map(Iterator::collect)
		.unwrap_or_default();

	// BSD: with `-j`, `-f` is the strptime(3) input format for the date
	// operand rather than GNU's `--file=DATEFILE`.
	let strptime_format = if bsd_parse_only {
		matches.get_one::<String>(OPT_FILE)
	} else {
		None
	};
	let strptime_value = if strptime_format.is_some() {
		if operands.first().is_some_and(|operand| !operand.starts_with('+')) {
			Some(operands.remove(0))
		} else {
			return Err(DateError::new(1, "'-j -f FORMAT' requires a date operand to parse"));
		}
	} else {
		None
	};

	let date_source = if let (Some(format), Some(value)) = (strptime_format, strptime_value) {
		DateSource::Strptime { format: format.clone(), value: value.clone() }
	} else if let Some(date_os) = matches.get_one::<OsString>(OPT_DATE) {
		// Convert OsString to String, handling invalid UTF-8 with GNU-compatible error
		let date = date_os.to_str().ok_or_else(|| {
			let bytes = date_os.as_encoded_bytes();
			let escaped_str = escape_invalid_bytes(bytes);
			DateError::new(1, format!("invalid date '{escaped_str}'"))
		})?;
		DateSource::Human(date.into())
	} else if let Some(file) = matches.get_one::<String>(OPT_FILE) {
		match file.as_ref() {
			"-" => DateSource::Stdin,
			_ => DateSource::File(file.into()),
		}
	} else if let Some(reference) = matches.get_one::<String>(OPT_REFERENCE) {
		// `-r` doubles as GNU `--reference=FILE` and BSD `-r SECONDS`.
		// Precedence: an existing file always wins (GNU semantics are
		// primary); a purely numeric operand naming no existing file is
		// seconds since the epoch (BSD), i.e. GNU `-d @SECONDS`.
		let digits = reference.strip_prefix('-').unwrap_or(reference);
		let numeric = !digits.is_empty() && digits.bytes().all(|b| b.is_ascii_digit());
		if numeric && !host.resolve(Path::new(reference)).exists() {
			DateSource::Human(format!("@{reference}"))
		} else {
			DateSource::FileMtime(reference.into())
		}
	} else if matches.get_flag(OPT_RESOLUTION) {
		DateSource::Resolution
	} else {
		DateSource::Now
	};

	// Check for extra operands (multiple positional arguments)
	if operands.len() > 1 {
		return Err(DateError::new(1, format!("extra operand '{}'", operands[1])));
	}

	let format = if let Some(form) = operands.first() {
		if !form.starts_with('+') {
			// if an optional Format String was found but the user has not provided an input
			// date GNU prints an invalid date Error
			if !matches!(date_source, DateSource::Human(_) | DateSource::Strptime { .. }) {
				return Err(DateError::new(1, format!("invalid date '{form}'")));
			}
			// If the user did provide an input date with the --date flag and the Format
			// String is not starting with '+' GNU prints the missing '+' error message
			return Err(DateError::new(
				1,
				format!(
					"the argument {form} lacks a leading '+';\nwhen using an option to specify \
					 date(s), any non-option\nargument must be a format string beginning with '+'"
				),
			));
		}
		Format::Custom(form[1..].to_string())
	} else if let Some(fmt) = matches
		.get_many::<String>(OPT_ISO_8601)
		.map(|mut iter| iter.next().unwrap_or(&DATE.to_string()).as_str().into())
	{
		Format::Iso8601(fmt)
	} else if matches.get_flag(OPT_RFC_EMAIL) {
		Format::Rfc5322
	} else if let Some(fmt) = matches
		.get_one::<String>(OPT_RFC_3339)
		.map(|s| s.as_str().into())
	{
		Format::Rfc3339(fmt)
	} else if matches.get_flag(OPT_RESOLUTION) {
		Format::Resolution
	} else {
		Format::Default
	};

	let utc = matches.get_flag(OPT_UNIVERSAL);
	let debug_mode = matches.get_flag(OPT_DEBUG);

	// The shell environment is isolated from the host process environment.
	let local_time_zone = shell_time_zone(host);
	let now = Timestamp::now().to_zoned(if utc {
		TimeZone::UTC
	} else {
		local_time_zone.clone()
	});
	if let Some(input) = matches.get_one::<String>(OPT_SET) {
		let mut error = host.stderr_clone();
		let date = parse_date(
			input,
			&now,
			DebugOptions::new(debug_mode, true),
			&mut error,
		)
		.map_err(|(input, _)| DateError::new(1, format!("invalid date '{input}'")))?;
		return set_system_datetime(date);
	}

	let default_format = shell_locale(host);

	let settings = Settings { utc, format, date_source, debug: debug_mode, default_format };

	// Iterate over all dates - whether it's a single date or a file.
	let cancel = host.cancel_flag();
	let mut had_error = false;
	let mut debug_stderr = host.stderr_clone();
	let mut stdout = host.stdout_writer();
	let reader_stderr = host.stderr_clone();
	let dates: Box<dyn Iterator<Item = _>> = match &settings.date_source {
		DateSource::Human(input) => {
			// GNU compatibility (Comments in parentheses)
			let input = strip_parenthesized_comments(input);
			let input = input.trim();

			// GNU compatibility (Empty string):
			// An empty string (or whitespace-only) should be treated as midnight today.
			let is_empty_or_whitespace = input.is_empty();

			// GNU compatibility (Military timezone 'J'):
			// 'J' is reserved for local time in military timezones.
			// GNU date accepts it and treats it as midnight today (00:00:00).
			let is_military_j = input.eq_ignore_ascii_case("j");

			// GNU compatibility (Military timezone with optional hour offset):
			// Single letter (a-z except j) optionally followed by 1-2 digits.
			// Letter represents midnight in that military timezone (UTC offset).
			// Digits represent additional hours to add.
			// Examples: "m" -> noon UTC (12:00); "m9" -> 21:00 UTC; "a5" -> 04:00 UTC
			let military_tz_with_offset = parse_military_timezone_with_offset(input);

			// GNU compatibility (Pure numbers in date strings):
			// - Manual: https://www.gnu.org/software/coreutils/manual/html_node/Pure-numbers-in-date-strings.html
			// - Semantics: a pure decimal number denotes today's time-of-day (HH or HHMM).
			//   Examples: "0"/"00" => 00:00 today; "7"/"07" => 07:00 today; "0700" => 07:00
			//   today.
			// For all other forms, fall back to the general parser.
			let is_pure_digits =
				!input.is_empty() && input.len() <= 4 && input.chars().all(|c| c.is_ascii_digit());

			let date = if is_empty_or_whitespace || is_military_j {
				// Treat empty string or 'J' as midnight today (00:00:00) in local time
				let date_part =
					strtime::format("%F", &now).unwrap_or_else(|_| String::from("1970-01-01"));
				let offset = if settings.utc {
					String::from("+00:00")
				} else {
					strtime::format("%:z", &now).unwrap_or_default()
				};
				let composed = if offset.is_empty() {
					format!("{date_part} 00:00")
				} else {
					format!("{date_part} 00:00 {offset}")
				};
				if settings.debug {
					let _ = writeln!(
						host.stderr,
						"date: warning: using midnight as starting time: 00:00:00"
					);
				}
				parse_date(
					composed,
					&now,
					DebugOptions::new(settings.debug, false),
					&mut debug_stderr,
				)
			} else if let Some((total_hours, day_delta)) = military_tz_with_offset {
				// Military timezone with optional hour offset
				// Convert to UTC time: midnight + military_tz_offset + additional_hours

				// When calculating a military timezone with an optional hour offset, midnight
				// may be crossed in either direction. `day_delta` indicates whether the
				// date remains the same, moves to the previous day, or advances to the next
				// day. Changing day can result in error, this closure will help handle
				// these errors gracefully.
				let format_date_with_epoch_fallback = |date: Result<Zoned, _>| -> String {
					date
						.and_then(|d| strtime::format("%F", &d))
						.unwrap_or_else(|_| String::from("1970-01-01"))
				};
				let date_part = match day_delta {
					DayDelta::Same => format_date_with_epoch_fallback(Ok(now.clone())),
					DayDelta::Next => format_date_with_epoch_fallback(now.tomorrow()),
					DayDelta::Previous => format_date_with_epoch_fallback(now.yesterday()),
				};
				let composed = format!("{date_part} {total_hours:02}:00:00 +00:00");
				parse_date(
					composed,
					&now,
					DebugOptions::new(settings.debug, false),
					&mut debug_stderr,
				)
			} else if is_pure_digits {
				// Derive HH and MM from the input
				let (hh_opt, mm_opt) = if input.len() <= 2 {
					(input.parse::<u32>().ok(), Some(0u32))
				} else {
					let (h, m) = input.split_at(input.len() - 2);
					(h.parse::<u32>().ok(), m.parse::<u32>().ok())
				};

				if let (Some(hh), Some(mm)) = (hh_opt, mm_opt) {
					// Compose a concrete datetime string for today with zone offset.
					// Use the already-determined 'now' and settings.utc to select offset.
					let date_part =
						strtime::format("%F", &now).unwrap_or_else(|_| String::from("1970-01-01"));
					// If -u, force +00:00; otherwise use the local offset of 'now'.
					let offset = if settings.utc {
						String::from("+00:00")
					} else {
						strtime::format("%:z", &now).unwrap_or_default()
					};
					let composed = if offset.is_empty() {
						format!("{date_part} {hh:02}:{mm:02}")
					} else {
						format!("{date_part} {hh:02}:{mm:02} {offset}")
					};
					parse_date(
						composed,
						&now,
						DebugOptions::new(settings.debug, false),
						&mut debug_stderr,
					)
				} else {
					// Fallback on parse failure of digits
					parse_date(
						input,
						&now,
						DebugOptions::new(settings.debug, true),
						&mut debug_stderr,
					)
				}
			} else {
				parse_date(
					input,
					&now,
					DebugOptions::new(settings.debug, true),
					&mut debug_stderr,
				)
			};

			let iter = std::iter::once(date);
			Box::new(iter)
		},
		DateSource::Stdin => parse_dates_from_reader(
			&mut host.stdin,
			&now,
			DebugOptions::new(settings.debug, true),
			reader_stderr.clone(),
		),
		DateSource::File(path) => {
			// directory; `path` is kept for display.
			let resolved = host.resolve(path);
			if resolved.is_dir() {
				return Err(DateError::new(
					2,
					format!("expected file, got directory {}", path.quote()),
				));
			}
			let file = File::open(&resolved).map_err(|error| {
				DateError::new(1, format!("{}: {error}", path.as_os_str().maybe_quote()))
			})?;
			parse_dates_from_reader(
				file,
				&now,
				DebugOptions::new(settings.debug, true),
				reader_stderr,
			)
		},
		DateSource::FileMtime(path) => {
			// directory; `path` is kept for display.
			let metadata = std::fs::metadata(host.resolve(path)).map_err(|error| {
				DateError::new(1, format!("{}: {error}", path.as_os_str().maybe_quote()))
			})?;
			let mtime = metadata.modified()?;
			let ts = Timestamp::try_from(mtime)
				.map_err(|_| DateError::new(1, "cannot set date".to_string()))?;
			let date = ts.to_zoned(local_time_zone.clone());
			let iter = std::iter::once(Ok(date));
			Box::new(iter)
		},
		DateSource::Resolution => {
			let resolution = get_clock_resolution();
			let date = resolution.to_zoned(local_time_zone.clone());
			let iter = std::iter::once(Ok(date));
			Box::new(iter)
		},
		DateSource::Strptime { format, value } => {
			let date = parse_bsd_strptime(format, value, &now)
				.map_err(|message| DateError::new(1, message))?;
			Box::new(std::iter::once(Ok(date)))
		},
		DateSource::Now => {
			let iter = std::iter::once(Ok(now.clone()));
			Box::new(iter)
		},
	};

	let format_string = make_format_string(&settings);

	// Format all the dates
	let config = Config::new().custom(PosixCustom::new()).lenient(true);
	for date in dates {
		// host cancellation between lines.
		if cancel.load(std::sync::atomic::Ordering::Relaxed) {
			break;
		}
		match date {
			Ok(date) => {
				// BSD `-v` adjustments apply to the base date in argv order.
				let date = if adjustments.is_empty() {
					date
				} else {
					match apply_bsd_adjustments(date, &adjustments) {
						Ok(date) => date,
						Err(message) => {
							let _ = stdout.flush();
							return Err(DateError::new(1, message));
						},
					}
				};
				let date = if settings.utc {
					date.with_time_zone(TimeZone::UTC)
				} else {
					date
				};
				match format_date(&date, format_string, &config) {
					Ok(s) => writeln!(stdout, "{s}")
						.map_err(|e| DateError::new(1, format!("write error: {e}")))?,
					Err(e) => {
						let _ = stdout.flush();
						return Err(DateError::new(
							1,
							format!("invalid format '{format_string}' ({e})"),
						));
					},
				}
			},
			Err((input, _err)) => {
				let _ = stdout.flush();
				// context stderr, record the failure exit code, and keep
				// processing the remaining lines.
				let _ = writeln!(host.stderr, "date: invalid date '{input}'");
				had_error = true;
			},
		}
	}

	stdout
		.flush()
		.map_err(|e| DateError::new(1, format!("write error: {e}")))?;
	drop(stdout);

	if had_error {
		host.fail(1);
	}
	Ok(())
}
fn uu_app() -> Command {
	Command::new("date")
		.version("0.8.0")
		.about("Print or set the system date and time")
		// `after_help` below; the usage proper is just the two command lines.
		.override_usage(format_usage(
			"date [OPTION]... [+FORMAT]...\ndate [OPTION]... [MMDDhhmm[[CC]YY][.ss]]",
		))
		.after_help(FORMAT_HELP)
		.infer_long_args(true)
		.arg(
			Arg::new(OPT_DATE)
				.short('d')
				.long(OPT_DATE)
				.value_name("STRING")
				.allow_hyphen_values(true)
				.overrides_with(OPT_DATE)
				.value_parser(clap::value_parser!(OsString))
				.help("display time described by STRING, not 'now'"),
		)
		.arg(
			Arg::new(OPT_FILE)
				.short('f')
				.long(OPT_FILE)
				.value_name("DATEFILE")
				.value_hint(clap::ValueHint::FilePath)
				.conflicts_with(OPT_DATE)
				.help(
					"like --date; once for each line of DATEFILE\n(BSD: with -j, the strptime(3) \
					 input format for the date operand)",
				),
		)
		.arg(
			Arg::new(OPT_ISO_8601)
				.short('I')
				.long(OPT_ISO_8601)
				.value_name("FMT")
				.value_parser(ShortcutValueParser::new([DATE, HOURS, MINUTES, SECONDS, NS]))
				// The optional precision binds only when attached (`-Ihours`,
				// `--iso-8601=hours`): `rewrite_date_argv` normalizes every
				// spelling to the `=` form, so a following `+FORMAT` operand
				// is never consumed as the value (GNU getopt behavior).
				.num_args(0..=1)
				.require_equals(true)
				.default_missing_value(OPT_DATE)
				.help(
					"output date/time in ISO 8601 format.\nFMT='date' for date only (the \
					 default),\n'hours', 'minutes', 'seconds', or 'ns'\nfor date and time to the \
					 indicated precision.\nExample: 2006-08-14T02:34:56-06:00",
				),
		)
		.arg(
			Arg::new(OPT_RESOLUTION)
				.long(OPT_RESOLUTION)
				.conflicts_with_all([OPT_DATE, OPT_FILE])
				.overrides_with(OPT_RESOLUTION)
				.help("output the available resolution of timestamps\nExample: 0.000000001")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_RFC_EMAIL)
				.short('R')
				.long(OPT_RFC_EMAIL)
				.alias(OPT_RFC_2822)
				.alias(OPT_RFC_822)
				.overrides_with(OPT_RFC_EMAIL)
				.help(
					"output date and time in RFC 5322 format.\nExample: Mon, 14 Aug 2006 02:34:56 -0600",
				)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_RFC_3339)
				.long(OPT_RFC_3339)
				.value_name("FMT")
				.value_parser(ShortcutValueParser::new([DATE, SECONDS, NS]))
				.help(
					"output date/time in RFC 3339 format.\nFMT='date', 'seconds', or 'ns'\nfor date \
					 and time to the indicated precision.\nExample: 2006-08-14 02:34:56-06:00",
				),
		)
		.arg(
			Arg::new(OPT_DEBUG)
				.long(OPT_DEBUG)
				.help("annotate the parsed date, and warn about questionable usage to stderr")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_REFERENCE)
				.short('r')
				.long(OPT_REFERENCE)
				.value_name("FILE")
				.value_hint(clap::ValueHint::AnyPath)
				.allow_hyphen_values(true)
				.conflicts_with_all([OPT_DATE, OPT_FILE, OPT_RESOLUTION])
				.help(
					"display the last modification time of FILE\n(BSD: when FILE is numeric and \
					 no such file exists,\ndisplay the date at that many seconds since the epoch)",
				),
		)
		.arg(
			Arg::new(OPT_SET)
				.short('s')
				.long(OPT_SET)
				.value_name("STRING")
				.allow_hyphen_values(true)
				.help("set time described by STRING"),
		)
		.arg(
			Arg::new(OPT_UNIVERSAL)
				.short('u')
				.long(OPT_UNIVERSAL)
				.visible_alias(OPT_UNIVERSAL_2)
				.alias("uct")
				.overrides_with(OPT_UNIVERSAL)
				.help("print or set Coordinated Universal Time (UTC)")
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_BSD_PARSE_ONLY)
				.short('j')
				.help(
					"BSD compatibility: do not try to set the system clock;\nwith -f, parse the \
					 date operand using the strptime(3)\nformat given to -f",
				)
				.action(ArgAction::SetTrue),
		)
		.arg(
			Arg::new(OPT_BSD_ADJUST)
				.short('v')
				.value_name("[+|-]VAL[ymwdHMS]")
				.allow_hyphen_values(true)
				.action(ArgAction::Append)
				.help(
					"BSD compatibility: adjust ('+'/'-') or set (no sign) the\ndisplayed date; \
					 may be given multiple times, applied in order",
				),
		)
		.arg(Arg::new(OPT_FORMAT).num_args(0..))
}

// blob, rendered as plain text for clap's after_help.
const FORMAT_HELP: &str = "\
FORMAT controls the output.  Interpreted sequences are:
  %%     a literal %
  %a     locale's abbreviated weekday name (e.g., Sun)
  %A     locale's full weekday name (e.g., Sunday)
  %b     locale's abbreviated month name (e.g., Jan)
  %B     locale's full month name (e.g., January)
  %c     locale's date and time (e.g., Thu Mar  3 23:05:25 2005)
  %C     century; like %Y, except omit last two digits (e.g., 20)
  %d     day of month (e.g., 01)
  %D     date; same as %m/%d/%y
  %e     day of month, space padded; same as %_d
  %F     full date; same as %Y-%m-%d
  %g     last two digits of year of ISO week number (see %G)
  %G     year of ISO week number (see %V); normally useful only with %V
  %h     same as %b
  %H     hour (00..23)
  %I     hour (01..12)
  %j     day of year (001..366)
  %k     hour, space padded ( 0..23); same as %_H
  %l     hour, space padded ( 1..12); same as %_I
  %m     month (01..12)
  %M     minute (00..59)
  %n     a newline
  %N     nanoseconds (000000000..999999999)
  %p     locale's equivalent of either AM or PM; blank if not known
  %P     like %p, but lower case
  %q     quarter of year (1..4)
  %r     locale's 12-hour clock time (e.g., 11:11:04 PM)
  %R     24-hour hour and minute; same as %H:%M
  %s     seconds since 1970-01-01 00:00:00 UTC
  %S     second (00..60)
  %t     a tab
  %T     time; same as %H:%M:%S
  %u     day of week (1..7); 1 is Monday
  %U     week number of year, with Sunday as first day of week (00..53)
  %V     ISO week number, with Monday as first day of week (01..53)
  %w     day of week (0..6); 0 is Sunday
  %W     week number of year, with Monday as first day of week (00..53)
  %x     locale's date representation (e.g., 03/03/2005)
  %X     locale's time representation (e.g., 23:30:30)
  %y     last two digits of year (00..99)
  %Y     year
  %z     +hhmm numeric time zone (e.g., -0400)
  %:z    +hh:mm numeric time zone (e.g., -04:00)
  %::z   +hh:mm:ss numeric time zone (e.g., -04:00:00)
  %:::z  numeric time zone with : to necessary precision (e.g., -04, +05:30)
  %Z     alphabetic time zone abbreviation (e.g., EDT)

By default, date pads numeric fields with zeroes.
The following optional flags may follow '%':
  - (hyphen) do not pad the field
  _ (underscore) pad with spaces
  0 (zero) pad with zeros
  ^ use upper case if possible
  # use opposite case if possible
After any flags comes an optional field width, as a decimal number;
then an optional modifier, which is either
  E to use the locale's alternate representations if available, or
  O to use the locale's alternate numeric symbols if available.

Examples:
  Convert seconds since the epoch (1970-01-01 UTC) to a date
    date --date='@2147483647'
  Show the time on the west coast of the US (use tzselect(1) to find TZ)
    TZ='America/Los_Angeles' date";

/// optional icu locale-aware month/day name substitution (the i18n-datetime
/// feature is not vendored, so no localization ever applies).
fn format_date(
	date: &Zoned,
	format_string: &str,
	config: &Config<PosixCustom>,
) -> Result<String, String> {
	// Check if format string has GNU modifiers (width/flags) and format if present
	if let Some(result) =
		format_modifiers::format_with_modifiers_if_present(date, format_string, config)
	{
		return result.map_err(|e| e.to_string());
	}

	let broken_down = BrokenDownTime::from(date);
	broken_down
		.to_string_with_config(config, format_string)
		.map_err(|e| e.to_string())
}

/// Return the appropriate format string for the given settings.
fn make_format_string(settings: &Settings) -> &str {
	match &settings.format {
		Format::Iso8601(fmt) => match fmt {
			Iso8601Format::Date => "%F",
			Iso8601Format::Hours => "%FT%H%:z",
			Iso8601Format::Minutes => "%FT%H:%M%:z",
			Iso8601Format::Seconds => "%FT%T%:z",
			Iso8601Format::Ns => "%FT%T,%N%:z",
		},
		Format::Rfc5322 => "%a, %d %h %Y %T %z",
		Format::Rfc3339(fmt) => match fmt {
			Rfc3339Format::Date => "%F",
			Rfc3339Format::Seconds => "%F %T%:z",
			Rfc3339Format::Ns => "%F %T.%N%:z",
		},
		Format::Resolution => "%s.%N",
		Format::Custom(fmt) => fmt,
		Format::Default => &settings.default_format,
	}
}

/// Timezone abbreviations with known fixed UTC offsets.
/// Checked first because the abbreviation encodes the exact offset
/// (e.g., EDT always means UTC-4, even in winter when New York observes EST).
/// Offset is in seconds to support half-hour zones like IST (UTC+5:30).
/// All other timezones (JST, CET, etc.) are dynamically resolved from IANA
/// database.
static FIXED_OFFSET_ABBREVIATIONS: &[(&str, i32)] = &[
	("UTC", 0),
	("GMT", 0),
	("MEST", 7200), // UTC+2 Middle European Summer Time
	// US timezones (GNU compatible)
	("PST", -28800), // UTC-8
	("PDT", -25200), // UTC-7
	("MST", -25200), // UTC-7
	("MDT", -21600), // UTC-6
	("CST", -21600), // UTC-6 (Ambiguous: US Central, not China/Cuba)
	("CDT", -18000), // UTC-5
	("EST", -18000), // UTC-5
	("EDT", -14400), // UTC-4
	// Indian Standard Time (Ambiguous: India vs Israel vs Ireland)
	("IST", 19800), // UTC+5:30
	// Australian timezones
	("AWST", 28800), // UTC+8
	("ACST", 34200), // UTC+9:30
	("ACDT", 37800), // UTC+10:30
	("AEST", 36000), // UTC+10
	("AEDT", 39600), // UTC+11
	// German timezones
	("MEZ", 3600),  // UTC+1
	("MESZ", 7200), // UTC+2
	// Asian timezones
	("KST", 32400), // UTC+9 Korean Standard Time
];

/// Lazy-loaded timezone abbreviation lookup map built from IANA database.
static TZ_ABBREV_CACHE: LazyLock<HashMap<String, String>> = LazyLock::new(build_tz_abbrev_map);

/// Build timezone abbreviation lookup map from IANA database.
/// This is a fallback for abbreviations not covered by
/// FIXED_OFFSET_ABBREVIATIONS.
fn build_tz_abbrev_map() -> HashMap<String, String> {
	let mut map = HashMap::new();
	let tzdb = TimeZoneDatabase::bundled();

	for tz_name in tzdb.available() {
		let tz_str = tz_name.as_str();
		// Use last component as potential abbreviation
		// e.g., "Pacific/Fiji" could map to "FIJI"
		if let Some(last_part) = tz_str.split('/').next_back() {
			let potential_abbrev = last_part.to_uppercase();
			// Only add if it looks like an abbreviation (2-5 uppercase chars)
			if potential_abbrev.len() >= 2
				&& potential_abbrev.len() <= 5
				&& potential_abbrev.chars().all(|c| c.is_ascii_uppercase())
			{
				map.entry(potential_abbrev)
					.or_insert_with(|| tz_str.to_string());
			}
		}
	}

	map
}

/// Get IANA timezone name for a given abbreviation.
/// Uses lazy-loaded cache with preferred mappings for disambiguation.
fn tz_abbrev_to_iana(abbrev: &str) -> Option<&str> {
	TZ_ABBREV_CACHE.get(abbrev).map(String::as_str)
}

/// Attempts to parse a date string that contains a timezone abbreviation (e.g.
/// "EST").
///
/// If an abbreviation is found and the date is parsable, returns `Some(Zoned)`.
/// Returns `None` if no abbreviation is detected or if parsing fails,
/// indicating that standard parsing should be attempted.
fn try_parse_with_abbreviation<S: AsRef<str>>(date_str: S, now: &Zoned) -> Option<Zoned> {
	let s = date_str.as_ref();

	// Look for timezone abbreviation at the end of the string
	// Pattern: ends with uppercase letters (2-5 chars)
	if let Some(last_word) = s.split_whitespace().last() {
		// Check if it's a potential timezone abbreviation (all uppercase, 2-5 chars)
		if last_word.len() >= 2
			&& last_word.len() <= 5
			&& last_word.chars().all(|c| c.is_ascii_uppercase())
		{
			let tz = if let Some(&(_, offset_secs)) = FIXED_OFFSET_ABBREVIATIONS
				.iter()
				.find(|(abbr, _)| *abbr == last_word)
			{
				Offset::from_seconds(offset_secs).ok().map(TimeZone::fixed)
			} else {
				tz_abbrev_to_iana(last_word).and_then(|name| TimeZone::get(name).ok())
			};

			if let Some(tz) = tz {
				let date_part = s.trim_end_matches(last_word).trim();
				// Parse in the target timezone so "10:30 EDT" means 10:30 in EDT
				if let Ok(parsed) = parse_datetime::parse_datetime_at_date(now.clone(), date_part) {
					let dt = parsed.datetime();
					if let Ok(zoned) = dt.to_zoned(tz) {
						return Some(zoned);
					}
				}
			}
		}
	}

	// No abbreviation found or couldn't resolve, return original
	None
}

/// Helper function to parse dates from a line-based reader (stdin or file)
///
/// Takes any `Read` source, reads it line by line, and parses each line as a
/// date. Returns a boxed iterator over the parse results.
fn parse_dates_from_reader<'a, R: Read + 'a, W: Write + 'a>(
	reader: R,
	now: &'a Zoned,
	dbg_opts: DebugOptions,
	mut error: W,
) -> Box<dyn Iterator<Item = Result<Zoned, (String, parse_datetime::ParseDateTimeError)>> + 'a> {
	let lines = BufReader::new(reader).lines();
	Box::new(
		lines
			.map_while(Result::ok)
			.map(move |s| parse_date(s, now, dbg_opts, &mut error)),
	)
}

/// Parse a `String` into a `DateTime`.
/// If it fails, return a tuple of the `String` along with its `ParseError`.
fn parse_date<S: AsRef<str> + Clone>(
	s: S,
	now: &Zoned,
	dbg_opts: DebugOptions,
	error: &mut dyn Write,
) -> Result<Zoned, (String, parse_datetime::ParseDateTimeError)> {
	let input_str = s.as_ref();

	if dbg_opts.debug {
		let _ = writeln!(error, "date: input string: {input_str}");
	}

	// First, try to parse any timezone abbreviations
	if let Some(zoned) = try_parse_with_abbreviation(input_str, now) {
		if dbg_opts.debug {
			let err = &mut *error;
			let _ = writeln!(
				err,
				"date: parsed date part: (Y-M-D) {}",
				strtime::format("%Y-%m-%d", &zoned).unwrap_or_default()
			);
			let _ = writeln!(
				err,
				"date: parsed time part: {}",
				strtime::format("%H:%M:%S", &zoned).unwrap_or_default()
			);
			let tz_display = zoned.time_zone().iana_name().unwrap_or("system default");
			let _ = writeln!(err, "date: input timezone: {tz_display}");
		}
		return Ok(zoned);
	}

	match parse_datetime::parse_datetime_at_date(now.clone(), input_str) {
		// Convert to system timezone for display
		// (parse_datetime returns Zoned in the input's timezone)
		Ok(date) => {
			let result = date.timestamp().to_zoned(now.time_zone().clone());
			if dbg_opts.debug {
				// Show final parsed date and time
				let err = &mut *error;
				let _ = writeln!(
					err,
					"date: parsed date part: (Y-M-D) {}",
					strtime::format("%Y-%m-%d", &result).unwrap_or_default()
				);
				let _ = writeln!(
					err,
					"date: parsed time part: {}",
					strtime::format("%H:%M:%S", &result).unwrap_or_default()
				);

				// Show timezone information
				let _ = writeln!(err, "date: input timezone: system default");

				// Check if time component was specified, if not warn about midnight usage
				// Only warn for date-only inputs (no time specified), but not for epoch formats
				// (@N) or inputs that explicitly specify a time (containing ':')
				if dbg_opts.warn_midnight && !input_str.contains(':') && !input_str.contains('@') {
					// Input likely didn't specify a time, so midnight was assumed
					let time_str = strtime::format("%H:%M:%S", &result).unwrap_or_default();
					if time_str == "00:00:00" {
						let _ = writeln!(err, "date: warning: using midnight as starting time: 00:00:00");
					}
				}
			}
			Ok(result)
		},
		Err(e) => Err((input_str.into(), e)),
	}
}

#[cfg(test)]
mod tests {

	use super::*;
	use crate::host::{Host, run_util};

	#[test]
	fn formats_an_explicit_timestamp_in_utc() {
		let (code, capture) =
			run_util::<Date>(&["-u", "--date", "@0", "+%F %T %z"], "", "/");

		assert_eq!(code, 0);
		assert_eq!(capture.out(), "1970-01-01 00:00:00 +0000\n");
		assert_eq!(capture.err(), "");
	}

	#[test]
	fn reads_datefile_from_host_stdin() {
		let (code, capture) = run_util::<Date>(&["-u", "-f", "-", "+%F"], "@0\n@86400\n", "/");

		assert_eq!(code, 0);
		assert_eq!(capture.out(), "1970-01-01\n1970-01-02\n");
		assert_eq!(capture.err(), "");
	}

	#[test]
	fn uses_shell_timezone_instead_of_process_environment() {
		let matches = uu_app()
			.try_get_matches_from(["date", "--date", "@0", "+%F %T %z"])
			.unwrap();
		let (mut host, capture) = Host::for_test("date", "", "/");
		host.set_test_var("TZ", "America/New_York");

		let code = Date { matches }.run(&mut host);

		assert_eq!(code, 0);
		assert_eq!(capture.out(), "1969-12-31 19:00:00 -0500\n");
		assert_eq!(capture.err(), "");
	}


	#[test]
	fn parses_relative_abbreviation_against_pinned_now() {
		let now = "2025-03-15T20:00:00+00:00[UTC]".parse::<Zoned>().unwrap();
		let mut error = Vec::new();
		let result = parse_date(
			"yesterday 10:00 GMT",
			&now,
			DebugOptions::new(false, false),
			&mut error,
		)
		.unwrap();


		assert_eq!(result.date(), jiff::civil::date(2025, 3, 14));
		assert!(error.is_empty());
	}
	#[test]
	fn uses_shell_locale_for_default_format() {
		let matches = uu_app().try_get_matches_from(["date", "--date", "@0"]).unwrap();
		let (mut host, capture) = Host::for_test("date", "", "/");
		host.set_test_var("TZ", "UTC");
		host.set_test_var("LC_ALL", "C");

		let code = Date { matches }.run(&mut host);

		assert_eq!(code, 0);
		assert_eq!(capture.out(), "Thu Jan  1 00:00:00 UTC 1970\n");
		assert_eq!(capture.err(), "");
	}

	#[test]
	fn strips_parenthesized_comments() {
		assert_eq!(strip_parenthesized_comments("2026(comment)-01-05"), "2026-01-05");
		assert_eq!(strip_parenthesized_comments("a(b(c)d)e"), "ae");
		assert_eq!(strip_parenthesized_comments("a(b)c(d"), "ac");
	}

	/// Defends: BSD `-r <epoch>` must print that instant, not fail trying to
	/// open `./<epoch>` as a reference file.
	#[test]
	fn bsd_reference_epoch_when_no_such_file() {
		let (code, capture) =
			run_util::<Date>(&["-u", "-r", "1700000000", "+%Y-%m-%dT%H:%M:%S"], "", "/");

		assert_eq!(code, 0);
		assert_eq!(capture.out(), "2023-11-14T22:13:20\n");
		assert_eq!(capture.err(), "");
	}

	/// Defends: an existing file always wins over the BSD numeric-epoch
	/// reading of `-r` (GNU `--reference` semantics are primary).
	#[test]
	fn reference_prefers_existing_file_over_epoch() {
		let dir = std::env::temp_dir().join(format!("pi-date-r-{}", std::process::id()));
		std::fs::create_dir_all(&dir).unwrap();
		let file = dir.join("1700000000");
		std::fs::write(&file, b"x").unwrap();

		let (code, capture) = run_util::<Date>(
			&["-u", "-r", "1700000000", "+%s"],
			"",
			dir.to_str().unwrap(),
		);
		let mtime = std::fs::metadata(&file).unwrap().modified().unwrap();
		let expected = Timestamp::try_from(mtime).unwrap().as_second();
		std::fs::remove_dir_all(&dir).unwrap();

		assert_eq!(code, 0);
		assert_eq!(capture.out(), format!("{expected}\n"));
	}

	/// Defends: BSD `-v` offsets (`+1d`, `-2m`) must parse and apply in argv
	/// order instead of being rejected as unknown options.
	#[test]
	fn bsd_adjustments_apply_in_order() {
		let (code, capture) = run_util::<Date>(
			&["-u", "-r", "1700000000", "-v+1d", "-v-2m", "+%F %T"],
			"",
			"/",
		);

		assert_eq!(code, 0);
		assert_eq!(capture.out(), "2023-09-15 22:13:20\n");
		assert_eq!(capture.err(), "");
	}

	/// Defends: the unsigned `-v` form sets a field absolutely (`-v1d` = first
	/// of the month) rather than offsetting.
	#[test]
	fn bsd_adjustment_sets_fields_absolutely() {
		let (code, capture) = run_util::<Date>(
			&["-u", "-r", "1700000000", "-v1d", "-v5H", "+%F %T"],
			"",
			"/",
		);

		assert_eq!(code, 0);
		assert_eq!(capture.out(), "2023-11-01 05:13:20\n");
		assert_eq!(capture.err(), "");
	}

	/// Defends: a malformed `-v` argument is a clean diagnostic, not a panic
	/// or a silently ignored adjustment.
	#[test]
	fn bsd_adjustment_rejects_unknown_unit() {
		let (code, capture) = run_util::<Date>(&["-v+1x", "+%F"], "", "/");

		assert_eq!(code, 1);
		assert!(capture.err().contains("invalid adjustment"), "stderr: {}", capture.err());
	}

	/// Defends: with `-j`, `-f` is the BSD strptime input format for the date
	/// operand, not GNU `--file=DATEFILE`.
	#[test]
	fn bsd_j_f_parses_with_strptime_format() {
		let (code, capture) = run_util::<Date>(
			&["-u", "-j", "-f", "%Y-%m-%d %H:%M:%S", "2026-01-01 00:00:00", "+%s"],
			"",
			"/",
		);

		assert_eq!(code, 0);
		assert_eq!(capture.out(), "1767225600\n");
		assert_eq!(capture.err(), "");
	}

	/// Defends: fields missing from the `-j -f` format are seeded from "now"
	/// (BSD strptime semantics), so a date-only format keeps the given date.
	#[test]
	fn bsd_j_f_fills_missing_fields_from_now() {
		let (code, capture) =
			run_util::<Date>(&["-u", "-j", "-f", "%Y-%m-%d", "2026-01-01", "+%F"], "", "/");

		assert_eq!(code, 0);
		assert_eq!(capture.out(), "2026-01-01\n");
		assert_eq!(capture.err(), "");
	}

	/// Defends: `-j -f` without a date operand is a diagnostic, not a silent
	/// fallback to GNU `--file` behavior.
	#[test]
	fn bsd_j_f_requires_date_operand() {
		let (code, capture) = run_util::<Date>(&["-j", "-f", "%Y", "+%F"], "", "/");

		assert_eq!(code, 1);
		assert!(
			capture.err().contains("requires a date operand"),
			"stderr: {}",
			capture.err()
		);
	}

	/// Defends: bare `-j` parses as a no-op (never sets the clock) instead of
	/// being rejected, and `-f` keeps GNU file semantics without `-j`.
	#[test]
	fn bsd_j_alone_is_a_no_op() {
		let (code, capture) = run_util::<Date>(&["-u", "-j", "-r", "0", "+%F"], "", "/");

		assert_eq!(code, 0);
		assert_eq!(capture.out(), "1970-01-01\n");
		assert_eq!(capture.err(), "");
	}

	/// Defends: `date -I +%s` must treat `+%s` as the output format instead of
	/// greedily consuming it as the ISO precision value.
	#[test]
	fn iso_flag_does_not_consume_format_operand() {
		let (code, capture) = run_util::<Date>(&["-u", "-d", "@0", "-I", "+%s"], "", "/");

		assert_eq!(code, 0);
		assert_eq!(capture.out(), "0\n");
		assert_eq!(capture.err(), "");
	}

	/// Defends: bare `-I` still defaults to date precision after the
	/// non-greedy rewrite.
	#[test]
	fn iso_flag_defaults_to_date_precision() {
		let (code, capture) = run_util::<Date>(&["-u", "-d", "@0", "-I"], "", "/");

		assert_eq!(code, 0);
		assert_eq!(capture.out(), "1970-01-01\n");
		assert_eq!(capture.err(), "");
	}

	/// Defends: the attached form `-Ihours` keeps binding the precision.
	#[test]
	fn iso_flag_accepts_attached_precision() {
		let (code, capture) = run_util::<Date>(&["-u", "-d", "@0", "-Ihours"], "", "/");

		assert_eq!(code, 0);
		assert_eq!(capture.out(), "1970-01-01T00+00:00\n");
		assert_eq!(capture.err(), "");
	}

	/// Defends: the argv rewrite only touches genuine `-I`/`--iso-8601`
	/// options — never option values, post-`--` operands, or other flags.
	#[test]
	fn rewrites_iso_argv_forms_conservatively() {
		let argv = |args: &[&str]| -> Vec<OsString> { args.iter().map(OsString::from).collect() };

		assert_eq!(
			rewrite_date_argv(argv(&["date", "-I", "+%s"])),
			argv(&["date", "--iso-8601=date", "+%s"])
		);
		assert_eq!(rewrite_date_argv(argv(&["date", "-Ihours"])), argv(&["date", "--iso-8601=hours"]));
		assert_eq!(
			rewrite_date_argv(argv(&["date", "--iso-8601", "+%s"])),
			argv(&["date", "--iso-8601=date", "+%s"])
		);
		assert_eq!(
			rewrite_date_argv(argv(&["date", "--iso", "-u"])),
			argv(&["date", "--iso-8601=date", "-u"])
		);
		// `-I` as the value of another option is untouched.
		assert_eq!(rewrite_date_argv(argv(&["date", "-d", "-I"])), argv(&["date", "-d", "-I"]));
		// Everything after `--` is an operand.
		assert_eq!(rewrite_date_argv(argv(&["date", "--", "-I"])), argv(&["date", "--", "-I"]));
		// Clustered flags before `-I` are preserved.
		assert_eq!(
			rewrite_date_argv(argv(&["date", "-uI"])),
			argv(&["date", "-u", "--iso-8601=date"])
		);
	}
}

#[cfg(not(any(unix, windows)))]
fn get_clock_resolution() -> Timestamp {
	unimplemented!("getting clock resolution not implemented (unsupported target)");
}

#[cfg(all(unix, not(target_os = "redox")))]
/// Returns the resolution of the system’s realtime clock.
///
/// # Panics
///
/// Panics if `clock_getres` fails. On a POSIX-compliant system this should not
/// occur, as `CLOCK_REALTIME` is required to be supported.
/// Failure would indicate a non-conforming or otherwise broken implementation.
fn get_clock_resolution() -> Timestamp {
	use rustix::time::{ClockId, clock_getres};

	let timespec = clock_getres(ClockId::Realtime);

	#[allow(clippy::unnecessary_cast, reason = "needed for 32 bit target")]
	Timestamp::constant(timespec.tv_sec as _, timespec.tv_nsec as _)
}
#[cfg(unix)]
fn set_system_datetime(date: Zoned) -> Result<(), DateError> {
	use rustix::time::{ClockId, Timespec, clock_settime};

	let timestamp = date.timestamp();
	let timespec = Timespec {
		tv_sec:  timestamp.as_second() as _,
		tv_nsec: timestamp.subsec_nanosecond() as _,
	};
	clock_settime(ClockId::Realtime, timespec)
		.map_err(std::io::Error::from)
		.map_err(|error| DateError::new(1, format!("cannot set date: {error}")))
}

#[cfg(not(unix))]
fn set_system_datetime(_date: Zoned) -> Result<(), DateError> {
	Err(DateError::new(
		1,
		"--set is not supported by the in-process builtin",
	))
}


#[cfg(all(unix, target_os = "redox"))]
fn get_clock_resolution() -> Timestamp {
	// Redox OS does not support the posix clock_getres function, however
	// internally it uses a resolution of 1ns to represent timestamps.
	// https://gitlab.redox-os.org/redox-os/kernel/-/blob/master/src/time.rs
	Timestamp::constant(0, 1)
}

#[cfg(windows)]
fn get_clock_resolution() -> Timestamp {
	// Windows does not expose a system call for getting the resolution of the
	// clock, however the FILETIME struct returned by GetSystemTimeAsFileTime,
	// and GetSystemTimePreciseAsFileTime has a resolution of 100ns.
	// https://learn.microsoft.com/en-us/windows/win32/api/minwinbase/ns-minwinbase-filetime
	Timestamp::constant(0, 100)
}


/// Creates the `date` builtin registration.
pub(crate) fn date_builtin<SE: ShellExtensions>() -> Registration<SE> {
	util::<Date, SE>()
}
