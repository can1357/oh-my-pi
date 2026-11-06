//! Perl-compatible regular expressions for zsh/pcre, through PCRE2
//! (`pcre2-sys`).
//!
//! zsh 5.9 is written against the PCRE1 API (`pcre_compile`, `pcre_exec`);
//! [`Pcre`] keeps its contract on PCRE2: the compile options zsh passes,
//! `pcre_exec`'s return value (the number of the highest group set, plus
//! one), PCRE1's compile error texts ([`CompileError::message`]) and
//! PCRE1's negative match error codes ([`Pcre::exec`]).

use core::{ops::Range, ptr::NonNull};

use pcre2_sys as ffi;

/// `PCRE_ANCHORED`.
pub const ANCHORED: u32 = ffi::PCRE2_ANCHORED;
/// `PCRE_CASELESS`.
pub const CASELESS: u32 = ffi::PCRE2_CASELESS;
/// `PCRE_MULTILINE`.
pub const MULTILINE: u32 = ffi::PCRE2_MULTILINE;
/// `PCRE_EXTENDED`.
pub const EXTENDED: u32 = ffi::PCRE2_EXTENDED;
/// `PCRE_DOTALL`.
pub const DOTALL: u32 = ffi::PCRE2_DOTALL;
/// `PCRE_UTF8`.
pub const UTF8: u32 = ffi::PCRE2_UTF;

/// A compiled pattern (`pcre *`).
#[derive(Debug)]
pub struct Pcre {
	code:     NonNull<ffi::pcre2_code_8>,
	/// `PCRE_INFO_CAPTURECOUNT`.
	captures: usize,
}

// SAFETY: a compiled PCRE2 pattern is read-only; PCRE2 documents matching
// one from several threads at once (each with its own match data).
unsafe impl Send for Pcre {}
// SAFETY: as above.
unsafe impl Sync for Pcre {}

impl Drop for Pcre {
	fn drop(&mut self) {
		// SAFETY: `code` came from `pcre2_compile_8` and is freed once.
		unsafe { ffi::pcre2_code_free_8(self.code.as_ptr()) };
	}
}

/// A pattern PCRE rejected.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct CompileError {
	/// PCRE2's error code (100 and up; negative for invalid UTF-8).
	pub code:   i32,
	/// Byte offset of the error in the pattern.
	pub offset: usize,
}

impl CompileError {
	/// PCRE1's text for the error (`pcre_compile`'s `errptr`), PCRE2's own
	/// for errors PCRE1 does not have.
	pub fn message(&self) -> String {
		if (ffi::PCRE2_ERROR_UTF8_ERR21..=ffi::PCRE2_ERROR_UTF8_ERR1).contains(&self.code) {
			return PCRE1_ERRORS[44].to_owned();
		}
		if let Some(n) = pcre1_compile_error(self.code) {
			return PCRE1_ERRORS[n].to_owned();
		}
		let mut buf = [0u8; 256];
		// SAFETY: `buf` holds `buf.len()` writable code units.
		let n = unsafe { ffi::pcre2_get_error_message_8(self.code, buf.as_mut_ptr(), buf.len()) };
		usize::try_from(n).map_or_else(
			|_| format!("internal error: unknown error code {}", self.code),
			|n| String::from_utf8_lossy(&buf[..n.min(buf.len())]).into_owned(),
		)
	}
}

impl Pcre {
	/// `pcre_compile(pattern, options)`; `options` are this module's
	/// `ANCHORED`… constants. The pattern ends at its first NUL byte, as
	/// a C string does.
	///
	/// # Errors
	/// The pattern does not compile.
	pub fn compile(pattern: &[u8], options: u32) -> Result<Self, CompileError> {
		let pattern = pattern
			.iter()
			.position(|&c| c == 0)
			.map_or(pattern, |n| &pattern[..n]);
		let mut code = 0;
		let mut offset = 0usize;
		// SAFETY: `pattern` is readable for its length; the out-pointers
		// are valid; a null compile context selects the defaults.
		let raw = unsafe {
			ffi::pcre2_compile_8(
				pattern.as_ptr(),
				pattern.len(),
				options,
				&raw mut code,
				&raw mut offset,
				core::ptr::null_mut(),
			)
		};
		let Some(code_ptr) = NonNull::new(raw) else {
			return Err(CompileError { code, offset });
		};
		let mut count: u32 = 0;
		// SAFETY: `code_ptr` is a compiled pattern; CAPTURECOUNT writes a
		// `uint32_t`.
		unsafe {
			ffi::pcre2_pattern_info_8(
				code_ptr.as_ptr(),
				ffi::PCRE2_INFO_CAPTURECOUNT,
				(&raw mut count).cast(),
			);
		}
		Ok(Self { code: code_ptr, captures: count as usize })
	}

	/// `PCRE_INFO_CAPTURECOUNT`: the number of capturing groups.
	pub const fn capture_count(&self) -> usize {
		self.captures
	}

	/// `pcre_exec(subject, start)`: `Ok(None)` when it does not match,
	/// else one entry per group up to the highest one set (`pcre_exec`'s
	/// return value), the whole match first; `None` for a group left
	/// unset below it.
	///
	/// # Errors
	/// PCRE1's negative `pcre_exec` code for any other failure
	/// (`PCRE_ERROR_BADUTF8` -10, `PCRE_ERROR_BADUTF8_OFFSET` -11, …).
	pub fn exec(
		&self,
		subject: &[u8],
		start: usize,
	) -> Result<Option<Vec<Option<Range<usize>>>>, i32> {
		// SAFETY: `code` is a compiled pattern; a null general context
		// selects malloc.
		let md = unsafe {
			ffi::pcre2_match_data_create_from_pattern_8(self.code.as_ptr(), core::ptr::null_mut())
		};
		let Some(md) = NonNull::new(md) else {
			return Err(PCRE_ERROR_NOMEMORY);
		};
		let md = MatchData(md);
		// SAFETY: `subject` is readable for its length, `md` was made for
		// this pattern; a null match context selects the defaults.
		let rc = unsafe {
			ffi::pcre2_match_8(
				self.code.as_ptr(),
				subject.as_ptr(),
				subject.len(),
				start,
				0,
				md.0.as_ptr(),
				core::ptr::null_mut(),
			)
		};
		if rc == ffi::PCRE2_ERROR_NOMATCH {
			return Ok(None);
		}
		if rc < 0 {
			return Err(pcre1_exec_error(rc));
		}
		// `rc == 0` (the vector too small) cannot happen with match data
		// sized from the pattern.
		let pairs = usize::try_from(rc).unwrap_or(0);
		// SAFETY: `md` holds at least `rc` offset pairs after a match.
		let ov = unsafe {
			core::slice::from_raw_parts(ffi::pcre2_get_ovector_pointer_8(md.0.as_ptr()), 2 * pairs)
		};
		Ok(Some(
			ov.as_chunks::<2>()
				.0
				.iter()
				.map(|p| (p[0] != ffi::PCRE2_UNSET && p[1] != ffi::PCRE2_UNSET).then(|| p[0]..p[1]))
				.collect(),
		))
	}
}

/// Match data, freed on drop.
struct MatchData(NonNull<ffi::pcre2_match_data_8>);

impl Drop for MatchData {
	fn drop(&mut self) {
		// SAFETY: made by `pcre2_match_data_create_from_pattern_8`, freed
		// once.
		unsafe { ffi::pcre2_match_data_free_8(self.0.as_ptr()) };
	}
}

/// `PCRE_ERROR_NOMEMORY`.
const PCRE_ERROR_NOMEMORY: i32 = -6;

/// PCRE1's `pcre_exec` code for PCRE2 match error `rc`.
const fn pcre1_exec_error(rc: i32) -> i32 {
	match rc {
		// Any malformed UTF-8: PCRE_ERROR_BADUTF8.
		ffi::PCRE2_ERROR_UTF8_ERR21..=ffi::PCRE2_ERROR_UTF8_ERR1 => -10,
		ffi::PCRE2_ERROR_BADUTFOFFSET => -11,
		ffi::PCRE2_ERROR_BADOFFSET => -24,
		ffi::PCRE2_ERROR_MATCHLIMIT => -8,
		ffi::PCRE2_ERROR_DEPTHLIMIT | ffi::PCRE2_ERROR_HEAPLIMIT => -21,
		ffi::PCRE2_ERROR_NOMEMORY => PCRE_ERROR_NOMEMORY,
		ffi::PCRE2_ERROR_CALLOUT => -9,
		// PCRE_ERROR_INTERNAL.
		_ => -14,
	}
}

/// The PCRE1 error number of PCRE2 compile error `code`, where PCRE1 has
/// one.
const fn pcre1_compile_error(code: i32) -> Option<usize> {
	Some(match code {
		101..=109 => (code - 100) as usize,
		110 => 11,
		111 => 12,
		112 => 13,
		113 => 31,
		114 => 14,
		115 => 15,
		116 => 16,
		117 => 17,
		118 => 18,
		119 => 82,
		120 => 20,
		121 => 21,
		122 => 22,
		123 | 164 => 23,
		124 => 26,
		125 | 135 | 189 | 202 => 25,
		126 => 58,
		127 => 27,
		128 => 28,
		129 => 63,
		130 => 30,
		132 => 32,
		133 => 85,
		134 => 34,
		136 => 36,
		137 => 37,
		138 => 38,
		139 => 39,
		140 | 161 => 60,
		141 => 41,
		142 => 42,
		143 => 43,
		144 => 84,
		145 => 45,
		146 => 46,
		147 => 47,
		148 => 48,
		149 => 49,
		150 => 83,
		151 => 51,
		152 => 52,
		153 => 53,
		154 => 54,
		155 => 81,
		156 => 56,
		157 => 57,
		158 => 29,
		159 => 59,
		162 => 61,
		163 => 62,
		165 => 80,
		166 => 65,
		167 => 66,
		168 => 79,
		169 | 170 => 68,
		171 => 69,
		173 => 71,
		175 => 73,
		176 => 78,
		178 => 75,
		179 => 76,
		180 => 86,
		188 => 87,
		_ => return None,
	})
}

/// PCRE 8.x `error_texts`, by PCRE1 error number.
const PCRE1_ERRORS: [&str; 88] = [
	"no error",
	"\\ at end of pattern",
	"\\c at end of pattern",
	"unrecognized character follows \\",
	"numbers out of order in {} quantifier",
	"number too big in {} quantifier",
	"missing terminating ] for character class",
	"invalid escape sequence in character class",
	"range out of order in character class",
	"nothing to repeat",
	"internal error: invalid forward reference offset",
	"internal error: unexpected repeat",
	"unrecognized character after (? or (?-",
	"POSIX named classes are supported only within a class",
	"missing )",
	"reference to non-existent subpattern",
	"erroffset passed as NULL",
	"unknown option bit(s) set",
	"missing ) after comment",
	"parentheses nested too deeply",
	"regular expression is too large",
	"failed to get memory",
	"unmatched parentheses",
	"internal error: code overflow",
	"unrecognized character after (?<",
	"lookbehind assertion is not fixed length",
	"malformed number or name after (?(",
	"conditional group contains more than two branches",
	"assertion expected after (?( or (?(?C)",
	"(?R or (?[+-]digits must be followed by )",
	"unknown POSIX class name",
	"POSIX collating elements are not supported",
	"this version of PCRE is compiled without UTF support",
	"spare error",
	"character value in \\x{} or \\o{} is too large",
	"invalid condition (?(0)",
	"\\C not allowed in lookbehind assertion",
	"PCRE does not support \\L, \\l, \\N{name}, \\U, or \\u",
	"number after (?C is > 255",
	"closing ) for (?C expected",
	"recursive call could loop indefinitely",
	"unrecognized character after (?P",
	"syntax error in subpattern name (missing terminator)",
	"two named subpatterns have the same name",
	"invalid UTF-8 string",
	"support for \\P, \\p, and \\X has not been compiled",
	"malformed \\P or \\p sequence",
	"unknown property name after \\P or \\p",
	"subpattern name is too long (maximum 32 characters)",
	"too many named subpatterns (maximum 10000)",
	"repeated subpattern is too long",
	"octal value is greater than \\377 in 8-bit non-UTF-8 mode",
	"internal error: overran compiling workspace",
	"internal error: previously-checked referenced subpattern not found",
	"DEFINE group contains more than one branch",
	"repeating a DEFINE group is not allowed",
	"inconsistent NEWLINE options",
	"\\g is not followed by a braced, angle-bracketed, or quoted name/number or by a plain number",
	"a numbered reference must not be zero",
	"an argument is not allowed for (*ACCEPT), (*FAIL), or (*COMMIT)",
	"(*VERB) not recognized or malformed",
	"number is too big",
	"subpattern name expected",
	"digit expected after (?+",
	"] is an invalid data character in JavaScript compatibility mode",
	"different names for subpatterns of the same number are not allowed",
	"(*MARK) must have an argument",
	"this version of PCRE is not compiled with Unicode property support",
	"\\c must be followed by an ASCII character",
	"\\k is not followed by a braced, angle-bracketed, or quoted name",
	"internal error: unknown opcode in find_fixedlength()",
	"\\N is not supported in a class",
	"too many forward references",
	"disallowed Unicode code point (>= 0xd800 && <= 0xdfff)",
	"invalid UTF-16 string",
	"name is too long in (*MARK), (*PRUNE), (*SKIP), or (*THEN)",
	"character value in \\u.... sequence is too large",
	"invalid UTF-32 string",
	"setting UTF is disabled by the application",
	"non-hex character in \\x{} (closing brace missing?)",
	"non-octal character in \\o{} (closing brace missing?)",
	"missing opening brace after \\o",
	"parentheses are too deeply nested",
	"invalid range in character class",
	"group name must start with a non-digit",
	"parentheses are too deeply nested (stack check)",
	"digits missing in \\x{} or \\o{}",
	"regular expression is too complicated",
];
