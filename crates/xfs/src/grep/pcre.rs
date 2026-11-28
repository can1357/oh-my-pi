//! A PCRE2-backed [`Matcher`] for the subset of `grep-pcre2` that
//! `omp-xfs` and `omp-builtins` use.
//!
//! Ported from `grep-pcre2` 0.1.10 and `pcre2` 0.2.11, both dual-licensed
//! `Unlicense OR MIT`; this port is distributed under the Unlicense. It
//! talks to the 8-bit `pcre2-sys` FFI directly instead of depending on
//! those crates, and keeps the same builder method names, matching
//! semantics (UTF, UCP, `MATCH_INVALID_UTF`, JIT), and error message text.
//!
//! The matcher is `Send + Sync` and takes `&self` for every search: PCRE2
//! needs a mutable match-data block per search, so one is taken from a
//! small pool and returned when the search finishes.

use std::{collections::HashMap, ffi::c_void, ptr, slice, sync::Arc};

use grep_matcher::{Captures, Match, Matcher};
use parking_lot::Mutex;
use pcre2_sys::{
	PCRE2_CASELESS, PCRE2_DOTALL, PCRE2_ERROR_NOMATCH, PCRE2_EXTRA_ASCII_BSD,
	PCRE2_INFO_CAPTURECOUNT, PCRE2_INFO_NAMECOUNT, PCRE2_INFO_NAMEENTRYSIZE, PCRE2_INFO_NAMETABLE,
	PCRE2_JIT_COMPLETE, PCRE2_MATCH_INVALID_UTF, PCRE2_MULTILINE, PCRE2_NEWLINE_ANYCRLF, PCRE2_UCP,
	PCRE2_UNSET, PCRE2_UTF, pcre2_code_8, pcre2_code_free_8, pcre2_compile_8,
	pcre2_compile_context_8, pcre2_compile_context_create_8, pcre2_compile_context_free_8,
	pcre2_get_error_message_8, pcre2_get_ovector_count_8, pcre2_get_ovector_pointer_8,
	pcre2_jit_compile_8, pcre2_match_8, pcre2_match_data_8, pcre2_match_data_create_from_pattern_8,
	pcre2_match_data_free_8, pcre2_pattern_info_8, pcre2_set_compile_extra_options_8,
	pcre2_set_newline_8,
};

/// A PCRE2 error.
///
/// An error can occur while compiling a pattern or while matching one. Its
/// [`Display`](std::fmt::Display) text is identical to `grep-pcre2`'s, so
/// messages passed on to callers do not change.
#[derive(Clone, Debug)]
pub struct Error {
	/// What operation failed.
	kind:   ErrorKind,
	/// The raw PCRE2 error code.
	code:   i32,
	/// The pattern offset of a compile error, when one was reported.
	offset: Option<usize>,
}

/// The operation that produced an [`Error`].
#[derive(Clone, Copy, Debug)]
enum ErrorKind {
	/// Compiling the pattern failed.
	Compile,
	/// JIT-compiling the pattern failed.
	Jit,
	/// Matching failed (for example a match limit).
	Match,
	/// Querying the compiled pattern failed.
	Info,
	/// Setting a compile option failed.
	Option,
}

impl Error {
	/// A pattern compilation failure at `offset` with PCRE2 code `code`.
	const fn compile(code: i32, offset: usize) -> Self {
		Self { kind: ErrorKind::Compile, code, offset: Some(offset) }
	}

	/// A JIT compilation failure with PCRE2 code `code`.
	const fn jit(code: i32) -> Self {
		Self { kind: ErrorKind::Jit, code, offset: None }
	}

	/// A match failure with PCRE2 code `code`.
	const fn matching(code: i32) -> Self {
		Self { kind: ErrorKind::Match, code, offset: None }
	}

	/// A pattern-info query failure with PCRE2 code `code`.
	const fn info(code: i32) -> Self {
		Self { kind: ErrorKind::Info, code, offset: None }
	}

	/// A compile-option failure with PCRE2 code `code`.
	const fn option(code: i32) -> Self {
		Self { kind: ErrorKind::Option, code, offset: None }
	}

	/// The PCRE2 message for this error's code.
	fn error_message(&self) -> String {
		// PCRE2 documents 120 bytes as enough; double it for safety.
		let mut buf = [0u8; 240];
		// SAFETY: `buf` is a valid, writable buffer of the given length, and
		// `self.code` always comes from PCRE2.
		let rc = unsafe { pcre2_get_error_message_8(self.code, buf.as_mut_ptr(), buf.len()) };
		assert!(rc >= 0, "expected a non-negative PCRE2 error message length, got {rc}");
		String::from_utf8(buf[..rc as usize].to_vec()).expect("PCRE2 error messages are UTF-8")
	}
}

impl std::fmt::Display for Error {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		let msg = self.error_message();
		match self.kind {
			ErrorKind::Compile => match self.offset {
				None => write!(f, "PCRE2: error compiling pattern: {msg}"),
				Some(offset) => {
					write!(f, "PCRE2: error compiling pattern at offset {offset}: {msg}")
				},
			},
			ErrorKind::Jit => write!(f, "PCRE2: error JIT compiling pattern: {msg}"),
			ErrorKind::Match => write!(f, "PCRE2: error matching: {msg}"),
			ErrorKind::Info => write!(f, "PCRE2: error getting info: {msg}"),
			ErrorKind::Option => write!(f, "PCRE2: error setting option: {msg}"),
		}
	}
}

impl std::error::Error for Error {}

/// Escapes every PCRE2 meta character in `pattern` so it matches literally.
fn escape(pattern: &str) -> String {
	const fn is_meta_character(c: char) -> bool {
		matches!(
			c,
			'\\'
				| '.'
				| '+'
				| '*'
				| '?'
				| '('
				| ')'
				| '|'
				| '['
				| ']'
				| '{'
				| '}'
				| '^'
				| '$'
				| '#'
				| '-'
		)
	}

	let mut quoted = String::with_capacity(pattern.len());
	for c in pattern.chars() {
		if is_meta_character(c) {
			quoted.push('\\');
		}
		quoted.push(c);
	}
	quoted
}

/// Whether `pattern` holds an uppercase literal (ignoring escaped
/// characters), which disables smart-case folding.
fn has_uppercase_literal(pattern: &str) -> bool {
	let mut chars = pattern.chars();
	while let Some(c) = chars.next() {
		if c == '\\' {
			chars.next();
		} else if c.is_uppercase() {
			return true;
		}
	}
	false
}

/// A compiled PCRE2 code object.
struct Code {
	/// The raw compiled pattern.
	code: *mut pcre2_code_8,
	/// The context that compiled it, kept alive so any tables it owns stay
	/// valid for the lifetime of `code`.
	_ctx: CompileContext,
}

// SAFETY: a compiled PCRE2 code object is immutable once built and PCRE2
// documents it as safe to use from several threads at once. JIT compilation
// mutates the object, but it happens once, before the object is shared.
unsafe impl Send for Code {}
// SAFETY: see the `Send` impl above.
unsafe impl Sync for Code {}

impl Drop for Code {
	fn drop(&mut self) {
		// SAFETY: `self.code` was returned by `pcre2_compile_8` and is freed
		// exactly once, here.
		unsafe { pcre2_code_free_8(self.code) }
	}
}

impl Code {
	/// Compiles `pattern` with `options` and `ctx`, or reports a compile
	/// error.
	fn new(pattern: &str, options: u32, ctx: CompileContext) -> Result<Self, Error> {
		let (mut error_code, mut error_offset) = (0, 0);
		// SAFETY: `pattern` is a valid UTF-8 string, `ctx` is a valid compile
		// context, and both out-pointers point to live locals.
		let code = unsafe {
			pcre2_compile_8(
				pattern.as_ptr(),
				pattern.len(),
				options,
				&mut error_code,
				&mut error_offset,
				ctx.as_mut_ptr(),
			)
		};
		if code.is_null() {
			Err(Error::compile(error_code, error_offset))
		} else {
			Ok(Self { code, _ctx: ctx })
		}
	}

	/// JIT-compiles the pattern, or reports a JIT error.
	fn jit_compile(&mut self) -> Result<(), Error> {
		// SAFETY: `self.code` is a valid compiled pattern.
		let rc = unsafe { pcre2_jit_compile_8(self.code, PCRE2_JIT_COMPLETE) };
		if rc == 0 { Ok(()) } else { Err(Error::jit(rc)) }
	}

	/// The capture group names in order, `None` for unnamed groups.
	fn capture_names(&self) -> Result<Vec<Option<String>>, Error> {
		let name_count = self.name_count()?;
		let mut names = vec![None; self.capture_count()?];
		if name_count == 0 {
			return Ok(names);
		}
		let size = self.name_entry_size()?;
		// SAFETY: with at least one name, the name table is a valid array of
		// `name_count * size` bytes, as reported by PCRE2.
		let table = unsafe { slice::from_raw_parts(self.raw_name_table()?, name_count * size) };
		for i in 0..name_count {
			let entry = &table[i * size..(i + 1) * size];
			// Each entry is two big-endian index bytes, the name, and a NUL.
			let name = &entry[2..];
			let nulat = name
				.iter()
				.position(|&b| b == 0)
				.expect("a NUL in name table entry");
			let index = (entry[0] as usize) << 8 | (entry[1] as usize);
			names[index] =
				Some(String::from_utf8(name[..nulat].to_vec()).expect("valid UTF-8 for capture name"));
		}
		Ok(names)
	}

	/// The raw name table pointer.
	fn raw_name_table(&self) -> Result<*const u8, Error> {
		let mut bytes: *const u8 = ptr::null();
		// SAFETY: `self.code` is a valid compiled pattern and `bytes` is a
		// live out-pointer.
		let rc = unsafe {
			pcre2_pattern_info_8(
				self.code,
				PCRE2_INFO_NAMETABLE,
				&mut bytes as *mut *const u8 as *mut c_void,
			)
		};
		if rc != 0 {
			Err(Error::info(rc))
		} else {
			Ok(bytes)
		}
	}

	/// The number of named capture groups.
	fn name_count(&self) -> Result<usize, Error> {
		let mut count: u32 = 0;
		// SAFETY: `self.code` is valid and `count` is a live out-pointer.
		let rc = unsafe {
			pcre2_pattern_info_8(
				self.code,
				PCRE2_INFO_NAMECOUNT,
				&mut count as *mut u32 as *mut c_void,
			)
		};
		if rc != 0 {
			Err(Error::info(rc))
		} else {
			Ok(count as usize)
		}
	}

	/// The byte size of one name-table entry.
	fn name_entry_size(&self) -> Result<usize, Error> {
		let mut size: u32 = 0;
		// SAFETY: `self.code` is valid and `size` is a live out-pointer.
		let rc = unsafe {
			pcre2_pattern_info_8(
				self.code,
				PCRE2_INFO_NAMEENTRYSIZE,
				&mut size as *mut u32 as *mut c_void,
			)
		};
		if rc != 0 {
			Err(Error::info(rc))
		} else {
			Ok(size as usize)
		}
	}

	/// The capture count including the implicit whole-match group.
	fn capture_count(&self) -> Result<usize, Error> {
		let mut count: u32 = 0;
		// SAFETY: `self.code` is valid and `count` is a live out-pointer.
		let rc = unsafe {
			pcre2_pattern_info_8(
				self.code,
				PCRE2_INFO_CAPTURECOUNT,
				&mut count as *mut u32 as *mut c_void,
			)
		};
		if rc != 0 {
			Err(Error::info(rc))
		} else {
			Ok(1 + count as usize)
		}
	}
}

/// PCRE2's compilation context.
struct CompileContext(*mut pcre2_compile_context_8);

// SAFETY: a compile context has no interior mutability and is safe to read
// from several threads at once.
unsafe impl Send for CompileContext {}
// SAFETY: see the `Send` impl above.
unsafe impl Sync for CompileContext {}

impl Drop for CompileContext {
	fn drop(&mut self) {
		// SAFETY: `self.0` was returned by `pcre2_compile_context_create_8`
		// and is freed exactly once, here.
		unsafe { pcre2_compile_context_free_8(self.0) }
	}
}

impl CompileContext {
	/// Creates an empty compile context.
	fn new() -> Self {
		// SAFETY: a null general context asks PCRE2 to use its defaults.
		let ctx = unsafe { pcre2_compile_context_create_8(ptr::null_mut()) };
		assert!(!ctx.is_null(), "could not allocate compile context");
		Self(ctx)
	}

	/// Sets the newline convention, or reports an option error.
	fn set_newline(&mut self, value: u32) -> Result<(), Error> {
		// SAFETY: `self.0` is a valid compile context.
		let rc = unsafe { pcre2_set_newline_8(self.0, value) };
		if rc == 0 {
			Ok(())
		} else {
			Err(Error::option(rc))
		}
	}

	/// Sets the extra compile options, or reports an option error.
	fn set_extra_options(&mut self, value: u32) -> Result<(), Error> {
		// SAFETY: `self.0` is a valid compile context.
		let rc = unsafe { pcre2_set_compile_extra_options_8(self.0, value) };
		if rc == 0 {
			Ok(())
		} else {
			Err(Error::option(rc))
		}
	}

	/// The raw context pointer.
	const fn as_mut_ptr(&self) -> *mut pcre2_compile_context_8 {
		self.0
	}
}

/// A PCRE2 match-data block: the scratch space one search needs.
struct MatchData {
	/// The raw match-data block.
	data:          *mut pcre2_match_data_8,
	/// PCRE2's offset vector for `data`.
	ovector_ptr:   *const usize,
	/// The number of offset pairs in `ovector_ptr`.
	ovector_count: u32,
}

// SAFETY: a match-data block can be moved between threads. It must not be
// used by two threads at once, which the pool and the `&mut self` search
// methods guarantee.
unsafe impl Send for MatchData {}
// SAFETY: reading a match-data block from several threads at once is safe;
// searching needs `&mut self`, which statically prevents aliasing.
unsafe impl Sync for MatchData {}

impl Drop for MatchData {
	fn drop(&mut self) {
		// SAFETY: `self.data` was returned by
		// `pcre2_match_data_create_from_pattern_8` and is freed exactly once.
		unsafe { pcre2_match_data_free_8(self.data) }
	}
}

impl MatchData {
	/// Allocates a match-data block sized for `code`.
	fn new(code: &Code) -> Self {
		// SAFETY: `code` is a valid compiled pattern and a null general
		// context asks PCRE2 to use its defaults.
		let data = unsafe { pcre2_match_data_create_from_pattern_8(code.code, ptr::null_mut()) };
		assert!(!data.is_null(), "failed to allocate match data block");
		// SAFETY: `data` is a valid match-data block.
		let ovector_ptr = unsafe { pcre2_get_ovector_pointer_8(data) };
		assert!(!ovector_ptr.is_null(), "got NULL ovector pointer");
		// SAFETY: `data` is a valid match-data block.
		let ovector_count = unsafe { pcre2_get_ovector_count_8(data) };
		Self { data, ovector_ptr, ovector_count }
	}

	/// Runs a match of `code` on `subject` starting at `start`.
	fn find(&mut self, code: &Code, subject: &[u8], start: usize) -> Result<Option<Match>, Error> {
		assert!(
			start <= subject.len(),
			"start ({start}) must be <= subject.len() ({})",
			subject.len()
		);

		// PCRE2 dereferences the subject pointer even for a zero-length
		// subject in some versions, so hand it a non-empty, valid pointer.
		static SINGLETON: &[u8] = &[0];
		let len = subject.len();
		let ptr = if subject.is_empty() {
			SINGLETON.as_ptr()
		} else {
			subject.as_ptr()
		};

		// SAFETY: `code` is valid, `ptr`/`len` describe a readable buffer,
		// `self.data` is valid, and a null match context asks PCRE2 to use
		// its defaults. No dangerous options are passed.
		let rc = unsafe { pcre2_match_8(code.code, ptr, len, start, 0, self.data, ptr::null_mut()) };
		if rc == PCRE2_ERROR_NOMATCH {
			return Ok(None);
		}
		if rc <= 0 {
			// The match-data block is created from the pattern, so its
			// offset vector is always big enough (rc == 0).
			assert!(rc != 0, "ovector should never be too small");
			return Err(Error::matching(rc));
		}
		let ov = self.ovector();
		Ok(Some(Match::new(ov[0], ov[1])))
	}

	/// The offset pairs left in the block by the last match.
	const fn ovector(&self) -> &[usize] {
		// SAFETY: pointer and count come from a valid match-data block and
		// stay valid until the block is freed.
		unsafe { slice::from_raw_parts(self.ovector_ptr, self.ovector_count as usize * 2) }
	}

	/// The offset of capture group `i` from the last match, if it matched.
	fn get(&self, i: usize) -> Option<(usize, usize)> {
		let start_index = i.checked_mul(2)?;
		let end_index = start_index.checked_add(1)?;
		let ovec = self.ovector();
		let start = *ovec.get(start_index)?;
		let end = *ovec.get(end_index)?;
		if start == PCRE2_UNSET || end == PCRE2_UNSET {
			return None;
		}
		Some((start, end))
	}
}

/// A pool of match-data blocks shared by the searches of one matcher.
struct MatchDataPool {
	/// The compiled pattern the blocks are sized for.
	code: Arc<Code>,
	/// Idle blocks, returned after each search.
	free: Mutex<Vec<MatchData>>,
}

impl MatchDataPool {
	/// A pool for `code` with no idle blocks.
	fn new(code: Code) -> Self {
		Self { code: Arc::new(code), free: Mutex::new(Vec::new()) }
	}

	/// A fresh-pool clone that shares `self`'s compiled pattern.
	fn shallow_clone(&self) -> Self {
		Self { code: Arc::clone(&self.code), free: Mutex::new(Vec::new()) }
	}

	/// Takes a block, allocating one if the pool is empty.
	fn get(&self) -> MatchData {
		self
			.free
			.lock()
			.pop()
			.unwrap_or_else(|| MatchData::new(&self.code))
	}

	/// Returns a block to the pool.
	fn put(&self, md: MatchData) {
		self.free.lock().push(md);
	}
}

/// A compiled PCRE2 matcher.
///
/// Implements [`grep_matcher::Matcher`]; it is safe to use from several
/// threads at once.
pub struct RegexMatcher {
	/// Capture group name to index.
	capture_names: HashMap<String, usize>,
	/// Capture group count, including the implicit whole-match group.
	capture_count: usize,
	/// Match-data blocks for concurrent searches.
	pool:          MatchDataPool,
}

impl Clone for RegexMatcher {
	fn clone(&self) -> Self {
		Self {
			capture_names: self.capture_names.clone(),
			capture_count: self.capture_count,
			pool:          self.pool.shallow_clone(),
		}
	}
}

impl std::fmt::Debug for RegexMatcher {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("RegexMatcher")
			.field("capture_count", &self.capture_count)
			.finish()
	}
}

impl Matcher for RegexMatcher {
	type Captures = RegexCaptures;
	type Error = Error;

	fn find_at(&self, haystack: &[u8], at: usize) -> Result<Option<Match>, Error> {
		let mut md = self.pool.get();
		let result = md.find(&self.pool.code, haystack, at);
		self.pool.put(md);
		result
	}

	fn new_captures(&self) -> Result<RegexCaptures, Error> {
		Ok(RegexCaptures { data: MatchData::new(&self.pool.code) })
	}

	fn capture_count(&self) -> usize {
		self.capture_count
	}

	fn capture_index(&self, name: &str) -> Option<usize> {
		self.capture_names.get(name).copied()
	}

	fn captures_at(
		&self,
		haystack: &[u8],
		at: usize,
		caps: &mut RegexCaptures,
	) -> Result<bool, Error> {
		Ok(caps.data.find(&self.pool.code, haystack, at)?.is_some())
	}
}

/// The capture group offsets of a single match.
pub struct RegexCaptures {
	/// Match-data block holding the offsets from the last search.
	data: MatchData,
}

impl Captures for RegexCaptures {
	fn len(&self) -> usize {
		self.data.ovector().len() / 2
	}

	fn get(&self, i: usize) -> Option<Match> {
		self.data.get(i).map(|(start, end)| Match::new(start, end))
	}
}

/// A builder for configuring the compilation of a PCRE2 matcher.
///
/// Mirrors `grep-pcre2`'s `RegexMatcherBuilder` for the options this
/// workspace uses.
#[derive(Clone, Debug, Default)]
pub struct RegexMatcherBuilder {
	/// `PCRE2_CASELESS`.
	caseless:      bool,
	/// Enable case insensitivity when the pattern holds no uppercase
	/// literal.
	case_smart:    bool,
	/// Wrap the pattern in word boundaries.
	word:          bool,
	/// Treat the pattern as a literal string.
	fixed_strings: bool,
	/// Anchor the pattern at line boundaries.
	whole_line:    bool,
	/// `PCRE2_MULTILINE`.
	multi_line:    bool,
	/// `PCRE2_DOTALL`.
	dotall:        bool,
	/// Treat CR, LF, and CRLF as line terminators.
	crlf:          bool,
	/// `PCRE2_UTF`.
	utf:           bool,
	/// `PCRE2_UCP` (implies UTF).
	ucp:           bool,
	/// `PCRE2_EXTRA_ASCII_BSD`.
	ascii_bsd:     bool,
	/// Attempt JIT compilation.
	jit:           bool,
}

impl RegexMatcherBuilder {
	/// A builder with the default configuration.
	pub fn new() -> Self {
		Self::default()
	}

	/// Compiles `pattern`, or reports a compile error.
	pub fn build(&self, pattern: &str) -> Result<RegexMatcher, Error> {
		self.build_many(&[pattern])
	}

	/// Compiles `patterns` as one alternation that matches any of them, or
	/// reports a compile error.
	pub fn build_many<P: AsRef<str>>(&self, patterns: &[P]) -> Result<RegexMatcher, Error> {
		let mut pats = Vec::with_capacity(patterns.len());
		for p in patterns {
			pats.push(if self.fixed_strings {
				format!("(?:{})", escape(p.as_ref()))
			} else {
				format!("(?:{})", p.as_ref())
			});
		}
		let mut singlepat = if patterns.is_empty() {
			// A pattern that can never match anything.
			r"[^\S\s]".to_string()
		} else {
			pats.join("|")
		};
		let caseless = self.caseless || (self.case_smart && !has_uppercase_literal(&singlepat));
		if self.whole_line {
			singlepat = format!(r"(?m:^)(?:{singlepat})(?m:$)");
		} else if self.word {
			singlepat = format!(r"(?<!\w)(?:{singlepat})(?!\w)");
		}

		let mut options = 0u32;
		if caseless {
			options |= PCRE2_CASELESS;
		}
		if self.dotall {
			options |= PCRE2_DOTALL;
		}
		if self.multi_line {
			options |= PCRE2_MULTILINE;
		}
		if self.ucp {
			options |= PCRE2_UCP | PCRE2_UTF | PCRE2_MATCH_INVALID_UTF;
		}
		if self.utf {
			options |= PCRE2_UTF;
		}

		let mut ctx = CompileContext::new();
		if self.crlf {
			ctx.set_newline(PCRE2_NEWLINE_ANYCRLF)
				.expect("PCRE2_NEWLINE_ANYCRLF is a legal value");
		}
		if self.ascii_bsd {
			ctx.set_extra_options(PCRE2_EXTRA_ASCII_BSD)
				.expect("PCRE2_EXTRA_ASCII_BSD is a legal value");
		}

		let mut code = Code::new(&singlepat, options, ctx)?;
		if self.jit {
			// JIT is best-effort: on failure, fall back to non-JIT matching.
			let _ = code.jit_compile();
		}

		let capture_names = code.capture_names()?;
		let capture_count = code.capture_count()?;
		let mut names = HashMap::new();
		for (i, name) in capture_names.iter().enumerate() {
			if let Some(name) = name {
				names.insert(name.clone(), i);
			}
		}
		Ok(RegexMatcher { capture_names: names, capture_count, pool: MatchDataPool::new(code) })
	}

	/// Enables case-insensitive matching.
	pub const fn caseless(&mut self, yes: bool) -> &mut Self {
		self.caseless = yes;
		self
	}

	/// Enables smart case: case-insensitive matching unless the pattern holds
	/// an uppercase literal.
	pub const fn case_smart(&mut self, yes: bool) -> &mut Self {
		self.case_smart = yes;
		self
	}

	/// Requires matches to fall on word boundaries.
	pub const fn word(&mut self, yes: bool) -> &mut Self {
		self.word = yes;
		self
	}

	/// Treats the pattern as a literal string.
	pub const fn fixed_strings(&mut self, yes: bool) -> &mut Self {
		self.fixed_strings = yes;
		self
	}

	/// Requires the pattern to match an entire line.
	pub const fn whole_line(&mut self, yes: bool) -> &mut Self {
		self.whole_line = yes;
		self
	}

	/// Enables multiline mode (`PCRE2_MULTILINE`).
	pub const fn multi_line(&mut self, yes: bool) -> &mut Self {
		self.multi_line = yes;
		self
	}

	/// Enables dot-all mode (`PCRE2_DOTALL`).
	pub const fn dotall(&mut self, yes: bool) -> &mut Self {
		self.dotall = yes;
		self
	}

	/// Treats CR, LF, and CRLF as line terminators.
	pub const fn crlf(&mut self, yes: bool) -> &mut Self {
		self.crlf = yes;
		self
	}

	/// Enables UTF matching (`PCRE2_UTF`).
	pub const fn utf(&mut self, yes: bool) -> &mut Self {
		self.utf = yes;
		self
	}

	/// Enables Unicode properties (`PCRE2_UCP`; implies UTF).
	pub const fn ucp(&mut self, yes: bool) -> &mut Self {
		self.ucp = yes;
		self
	}

	/// Makes `\d` match an ASCII digit alone, also under Unicode properties
	/// (`PCRE2_EXTRA_ASCII_BSD`).
	pub const fn ascii_bsd(&mut self, yes: bool) -> &mut Self {
		self.ascii_bsd = yes;
		self
	}

	/// Attempts JIT compilation when the regex is built, silently falling
	/// back to non-JIT matching on failure.
	pub const fn jit_if_available(&mut self, yes: bool) -> &mut Self {
		self.jit = yes;
		self
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn matches_offsets() {
		let matcher = RegexMatcherBuilder::new().build(r"b.rd").unwrap();
		let found = matcher.find_at(b"a bird flew", 0).unwrap().unwrap();
		assert_eq!((found.start(), found.end()), (2, 6));
	}

	#[test]
	fn no_match() {
		let matcher = RegexMatcherBuilder::new().build(r"zzz").unwrap();
		assert!(matcher.find_at(b"a bird flew", 0).unwrap().is_none());
	}

	#[test]
	fn case_insensitive() {
		let matcher = RegexMatcherBuilder::new()
			.caseless(true)
			.build(r"abc")
			.unwrap();
		assert!(matcher.is_match(b"ABC").unwrap());
	}

	#[test]
	fn capture_group() {
		let matcher = RegexMatcherBuilder::new().build(r"(\w+)-(\d+)").unwrap();
		let mut caps = matcher.new_captures().unwrap();
		assert!(matcher.captures_at(b"foo-42", 0, &mut caps).unwrap());
		assert_eq!(caps.len(), 3);
		let whole = caps.get(0).unwrap();
		assert_eq!((whole.start(), whole.end()), (0, 6));
		let word = caps.get(1).unwrap();
		assert_eq!((word.start(), word.end()), (0, 3));
		let digits = caps.get(2).unwrap();
		assert_eq!((digits.start(), digits.end()), (4, 6));
	}

	#[test]
	fn invalid_utf8_haystack_does_not_error() {
		let matcher = RegexMatcherBuilder::new()
			.utf(true)
			.ucp(true)
			.build(r".")
			.unwrap();
		let result = matcher.find_at(b"\xff\xfe", 0);
		assert!(result.is_ok(), "invalid UTF-8 should not error: {result:?}");
	}

	#[test]
	fn ascii_bsd_keeps_d_ascii_under_ucp() {
		let mut builder = RegexMatcherBuilder::new();
		builder.utf(true).ucp(true);
		let unicode = builder.build(r"\d").unwrap();
		assert!(unicode.is_match("\u{663}".as_bytes()).unwrap());
		let ascii = builder.ascii_bsd(true).build(r"\d").unwrap();
		assert!(!ascii.is_match("\u{663}".as_bytes()).unwrap());
		assert!(ascii.is_match(b"7").unwrap());
	}
}
