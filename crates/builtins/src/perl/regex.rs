//! Perl regular expressions (`perlre`, `perlrebackslash`, `perlrecharclass`)
//! translated to PCRE2's byte and UTF-8 matchers.

use std::{alloc::Layout, cell::{Cell, OnceCell, RefCell}, ffi::{CStr, c_void}, io::Write, ptr::{self, NonNull}, rc::Rc,
	sync::{Arc, OnceLock, atomic::{AtomicBool, Ordering}}};

use pcre2_sys as ffi;

use super::{code::Cv, rx::ucd::{self, Lookup}, value::PStr};

/// Character-set semantics of the shorthand and POSIX character classes.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum Charset {
	/// Use native byte semantics unless Unicode semantics are needed.
	#[default]
	Depends,
	/// Use Unicode properties even on byte strings.
	Unicode,
	/// Restrict shorthand and POSIX classes to ASCII, but fold case normally.
	Ascii,
	/// Also disallow case folds between ASCII and non-ASCII characters.
	AsciiStrict,
	/// Use the character set of the current locale.
	Locale,
}

/// Modifiers common to match, substitution, and quote-regexp operators.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) struct RxFlags {
	/// Ignore case.
	pub i: bool,
	/// Let line anchors match at embedded newlines.
	pub m: bool,
	/// Let dot match a newline.
	pub s: bool,
	/// Ignore whitespace and comments outside ordinary character classes.
	pub x: bool,
	/// Also ignore ASCII space and tab in ordinary character classes.
	pub xx: bool,
	/// Don't capture unnamed groups.
	pub n: bool,
	/// Preserve the prematch/match/postmatch variables.
	pub p: bool,
	/// The selected character set.
	pub charset: Charset,
}

impl RxFlags {
	/// Parse shared modifiers and return the operator-specific modifiers in order.
	pub fn parse(mods: &[u8]) -> Result<(RxFlags, Vec<u8>), String> {
		let mut flags = Self::default();
		let mut charset = None;
		let mut rest = Vec::new();
		for &m in mods {
			match m {
				b'i' => flags.i = true,
				b'm' => flags.m = true,
				b's' => flags.s = true,
				b'x' => { flags.xx |= flags.x; flags.x = true; }
				b'n' => flags.n = true,
				b'p' => flags.p = true,
				b'd' | b'u' | b'a' | b'l' => {
					if let Some(old) = charset {
						if m != old {
							return Err(format!("Regexp modifiers \"/{}\" and \"/{}\" are mutually exclusive", char::from(old), char::from(m)));
						}
						if m != b'a' {
							return Err(format!("Regexp modifier \"/{}\" may not appear twice", char::from(m)));
						}
						if flags.charset == Charset::AsciiStrict {
							return Err("Regexp modifier \"/a\" may appear a maximum of twice".into());
						}
						flags.charset = Charset::AsciiStrict;
					} else {
						charset = Some(m);
						flags.charset = charset_of(m);
					}
				}
				b'g' | b'c' | b'o' | b'e' | b'r' => rest.push(m),
				_ => return Err(format!("Unknown regexp modifier \"/{}\"", char::from(m))),
			}
		}
		Ok((flags, rest))
	}
}

fn charset_of(m: u8) -> Charset {
	match m {
		b'u' => Charset::Unicode,
		b'l' => Charset::Locale,
		b'a' => Charset::Ascii,
		_ => Charset::Depends,
	}
}

/// Character encoding of the program's `LC_CTYPE` locale, which `/l` patterns
/// follow (`perllocale`). The interpreter derives it from the shell environment.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub(super) enum Codeset {
	/// A single-byte locale such as "C": `/l` classes are ASCII-only.
	#[default]
	Bytes,
	/// A UTF-8 locale: `/l` behaves like `/u`.
	Utf8,
}

/// A user-defined property's set expression (`perlunicode` "User-Defined
/// Character Properties"), resolved by the interpreter from the property sub.
#[derive(Clone, Debug)]
pub(super) enum PropSet {
	/// Explicit code point ranges (inclusive).
	Ranges(Vec<(u32, u32)>),
	/// A built-in property, by the name written after `utf8::`.
	Builtin(Vec<u8>),
	/// Characters in any member.
	Union(Vec<PropSet>),
	/// Characters in the first set but not the second.
	Minus(Box<PropSet>, Box<PropSet>),
	/// Characters in both sets.
	And(Box<PropSet>, Box<PropSet>),
	/// Characters not in the set.
	Not(Box<PropSet>),
}

/// What the interpreter knows about one `\p{In...}`/`\p{Is...}` user property.
#[derive(Clone, Debug)]
pub(super) enum UserSet {
	/// The property sub ran; this is its set.
	Defined(PropSet),
	/// No sub exists yet: resolve again when the pattern is first matched.
	/// Holds the qualified sub name perl reports if it is still missing then.
	Deferred(String),
	/// Expanding the property failed with this message (without the regex marker).
	Invalid(String),
}

/// One user-defined property used by a pattern, keyed by its name as written
/// inside the braces (trimmed, without a leading `^`).
#[derive(Clone, Debug)]
pub(super) struct UserProperty {
	/// The property name as written.
	pub name: Vec<u8>,
	/// Its resolution.
	pub set: UserSet,
}

/// Interpreter-supplied context for compiling a pattern.
#[derive(Clone, Debug, Default)]
pub(super) struct CompileContext {
	/// The locale codeset `/l` follows.
	pub codeset: Codeset,
	/// User-defined properties referenced by the pattern.
	pub properties: Vec<UserProperty>,
}

/// A Perl regex, with separate cached PCRE2 code for each subject representation.
#[derive(Debug)]
pub(super) struct Regex {
	source: PStr,
	flags: RxFlags,
	actions: Vec<Action>,
	facts: Facts,
	capture_count: usize,
	/// Fixed, nonempty ASCII text with no regexp syntax or case folding.
	literal: Option<LiteralFinder>,
	/// Compiled variants, by `Self::variant`: subject representation, exact
	/// end (dynamic subpatterns), and cancellation checkpoints.
	codes: [OnceCell<Result<Code, String>>; 8],
	locale_unicode: bool,
	properties: Vec<UserProperty>,
}

#[derive(Debug)]
enum LiteralFinder {
	Byte(u8),
	String(memchr::memmem::Finder<'static>),
}

impl LiteralFinder {
	fn compile(pattern: &[u8], flags: RxFlags) -> Option<Self> {
		if flags.i || flags.x || pattern.is_empty() ||
			!pattern.iter().all(|&b| b.is_ascii() && !b"\\.^$|()[]{}*+?".contains(&b)) { return None; }
		Some(if let [b] = pattern { Self::Byte(*b) }
			else { Self::String(memchr::memmem::Finder::new(pattern).into_owned()) })
	}

	fn find(&self, bytes: &[u8]) -> Option<usize> {
		match self {
			Self::Byte(b) => memchr::memchr(*b, bytes),
			Self::String(finder) => finder.find(bytes),
		}
	}
}

/// One trusted Perl code block embedded in a regular expression.
#[derive(Clone)]
pub(super) struct Action {
	/// Byte offset of the action group within the interpolated regex.
	pub at: usize,
	/// Length of the action group source, including delimiters.
	pub len: usize,
	/// Perl code and the lexical scope captured when the regex was built.
	pub code: Cv,
	/// Whether the code's return value is used as a dynamic subpattern.
	pub dynamic: bool,
}

impl std::fmt::Debug for Action {
	fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		f.debug_struct("Action").field("at", &self.at).field("len", &self.len).field("dynamic", &self.dynamic).finish_non_exhaustive()
	}
}

/// What an interpreter callback should do at this point in the PCRE2 match.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum ActionPhase {
	/// Execute a zero-width Perl action.
	Eval,
	/// Evaluate Perl code as the condition of a regex branch.
	Test,
	/// Determine the range consumed by a dynamic subpattern.
	Begin,
	/// Confirm the first endpoint returned by a dynamic subpattern.
	End,
	/// Try a different endpoint after the first dynamic submatch backtracks.
	RetryEnd,
	/// Restore the previous action result when backtracking past the block.
	Rollback,
}

/// Match options including Perl's independently positioned `\G` assertion.
#[derive(Clone, Copy, Default)]
pub(super) struct ExecOpts {
	/// Reject an empty match exactly at the search start.
	pub not_empty_at_start: bool,
	/// Byte position matched by `\G`; absent means the search start.
	pub g_anchor: Option<usize>,
	/// Match only at the supplied start (dynamic subpatterns).
	pub anchored: bool,
	/// Require the match to end at this byte offset, without truncating input.
	pub required_end: Option<usize>,
	/// The caller has verified that a UTF-8 subject is well-formed, so PCRE2
	/// need not rescan it from the start offset on every call.
	pub utf8_valid: bool,
}

/// One match, with byte spans in the input's own representation.
#[derive(Debug)]
pub(super) struct Captures {
	/// Group zero is the whole match, followed by all the numbered groups.
	pub spans: Vec<Option<(usize, usize)>>,
	/// The last `(*MARK:...)` or named control verb on the successful path.
	pub mark: Option<PStr>,
	/// Number of the most recently closed group on the successful path.
	pub last_closed: Option<usize>,
}

type Span = Option<(usize, usize)>;

thread_local! {
	static SPARE_SPANS: Cell<Vec<Span>> = const { Cell::new(Vec::new()) };
}

impl Captures {
	fn buffer() -> Vec<Span> { SPARE_SPANS.try_with(Cell::take).unwrap_or_default() }

	pub fn whole(start: usize, end: usize) -> Self {
		let mut spans = Self::buffer();
		spans.push(Some((start, end)));
		Self { spans, mark: None, last_closed: None }
	}
}

impl Drop for Captures {
	fn drop(&mut self) {
		// Keep common ovectors warm, but don't pin arbitrarily large user patterns.
		if self.spans.capacity() <= 1024 {
			self.spans.clear();
			let _ = SPARE_SPANS.try_with(|slot| slot.set(std::mem::take(&mut self.spans)));
		}
	}
}

impl Regex {
	/// Validate the interpolated pattern and compile its natural representation.
	pub fn new(pattern: &PStr, flags: RxFlags) -> Result<Regex, String> {
		Self::with_actions(pattern, flags, Vec::new(), CompileContext::default())
	}

	/// Compile the pattern with trusted AST actions at designated source offsets,
	/// in the interpreter's context (locale codeset, user-defined properties).
	pub fn with_actions(pattern: &PStr, flags: RxFlags, actions: Vec<Action>, context: CompileContext) -> Result<Regex, String> {
		let flags = RxFlags { x: flags.x || flags.xx, ..flags };
		let CompileContext { codeset, properties } = context;
		let mut facts = Scanner::analyze(pattern, flags, &actions, &properties)?;
		facts.wide |= pattern.utf8;
		let locale_unicode = (facts.locale || flags.charset == Charset::Locale) && codeset == Codeset::Utf8;
		let literal = if actions.is_empty() { LiteralFinder::compile(&pattern.bytes, flags) } else { None };
		let mut regex = Self {
			source: pattern.clone(), flags, actions, facts, capture_count: 0,
			literal,
			codes: Default::default(), locale_unicode, properties,
		};
		regex.capture_count = regex.code(regex.facts.wide || regex.facts.bounds.need_utf(), false, false)?.captures;
		Ok(regex)
	}

	/// Byte searching ASCII literals is exact on unflagged strings, as well
	/// as well-formed UTF-8 (ASCII never occurs inside another character).
	pub fn is_byte_literal(&self) -> bool { self.literal.is_some() }

	pub fn literal_span(&self, bytes: &[u8], start: usize) -> Option<(usize, usize)> {
		let at = start + self.literal.as_ref()?.find(bytes.get(start..)?)?;
		Some((at, at + self.source.bytes.len()))
	}

	/// Search from a byte offset, optionally disallowing an empty match there.
	pub fn exec(&self, subject: &PStr, start: usize, opts: ExecOpts) -> Result<Option<Captures>, String> {
		self.exec_inner(subject, start, opts, None)
	}

	/// Search while invoking interpreter callbacks at compiled action sites.
	pub fn exec_actions(&self, subject: &PStr, start: usize, opts: ExecOpts, callback: &mut ActionCallback<'_>) -> Result<Option<Captures>, String> {
		self.exec_inner(subject, start, opts, Some(callback))
	}

	fn exec_inner(&self, subject: &PStr, start: usize, opts: ExecOpts, callback: Option<&mut ActionCallback<'_>>) -> Result<Option<Captures>, String> {
		if start > subject.bytes.len() {
			return Ok(None);
		}
		if self.is_byte_literal() && (!subject.utf8 || opts.utf8_valid) && opts.required_end.is_none() {
			return Ok(self.literal_span(&subject.bytes, start)
				.filter(|&(at, _)| !opts.anchored || at == start)
				.map(|(at, end)| Captures::whole(at, end)));
		}
		let anchor = opts.g_anchor.unwrap_or(start);
		// A leading `\G` pins the match to the anchor: try only there instead
		// of letting PCRE2 scan the rest of the subject for a start.
		let (start, opts) = if self.facts.g_leading && !self.facts.top_alternation && opts.required_end.is_none() {
			if anchor < start || anchor > subject.bytes.len() { return Ok(None); }
			let not_empty_at_start = opts.not_empty_at_start && anchor == start;
			(anchor, ExecOpts { anchored: true, not_empty_at_start, ..opts })
		} else { (start, opts) };
		let utf = subject.utf8 || self.facts.wide || self.facts.bounds.need_utf();
		// Searches of short subjects stay fast even at their worst (PCRE2's
		// match limit bounds backtracking, and start positions are few), so
		// only long subjects pay for cancellation checkpoints.
		let code = self.code(utf, opts.required_end.is_some(), subject.bytes.len() >= CHECKPOINT_SUBJECT)?;
		if utf && !subject.utf8 {
			let extras = subject.bytes.iter().filter(|b| !b.is_ascii()).count();
			if extras != 0 {
				let mut upgraded = Vec::with_capacity(subject.bytes.len() + extras);
				let mut continuations = Vec::with_capacity(extras);
				let mut upgraded_start = start;
				let mut upgraded_anchor = anchor;
				let mut upgraded_end = opts.required_end;
				for (i, &b) in subject.bytes.iter().enumerate() {
					if !b.is_ascii() {
						continuations.push(upgraded.len() + 1);
						upgraded_start += usize::from(i < start);
						upgraded_anchor += usize::from(i < anchor);
						if let Some(required) = opts.required_end && let Some(end) = upgraded_end.as_mut() {
							*end += usize::from(i < required);
						}
					}
					push_latin1(&mut upgraded, b);
				}
				let upgraded_opts = ExecOpts { required_end: upgraded_end, g_anchor: Some(upgraded_anchor), utf8_valid: true, ..opts };
				return code.exec(&upgraded, upgraded_start, upgraded_opts, self.source.utf8, &|offset| {
					offset - continuations.partition_point(|&b| b < offset)
				}, callback);
			}
		}
		if subject.utf8 && !opts.utf8_valid && std::str::from_utf8(&subject.bytes).is_err() {
			// Perl strings may hold surrogates, code points above Unicode and
			// malformations, which PCRE2 rejects. Match a copy where each such
			// character is the noncharacter U+FFFF: it matches `.` and negated
			// classes, like perl's treatment, but no property or literal.
			let clean = Sanitized::new(&subject.bytes);
			let opts = ExecOpts {
				g_anchor: Some(clean.forward(anchor)),
				required_end: opts.required_end.map(|end| clean.forward(end)),
				utf8_valid: true,
				..opts
			};
			return code.exec(&clean.bytes, clean.forward(start), opts, self.source.utf8, &|offset| clean.back(offset), callback);
		}
		code.exec(&subject.bytes, start, opts, self.source.utf8, &|byte| byte, callback)
	}

	/// Return the number of capturing groups, excluding group zero.
	pub fn captures_len(&self) -> usize { self.capture_count }

	/// Return the original group names and all numbers associated with each.
	pub fn names(&self) -> &[(Rc<str>, Vec<usize>)] { &self.facts.names }

	/// Return the pattern as supplied after interpolation.
	pub fn source(&self) -> &PStr { &self.source }

	/// Return the trusted code blocks that can execute during a match.
	pub fn actions(&self) -> &[Action] { &self.actions }

	/// Return the supplied regex modifiers.
	pub fn flags(&self) -> RxFlags { self.flags }

	/// Compile-time warnings (`perldiag` regexp diagnostics) as (category,
	/// message); the interpreter emits them when it compiles the pattern.
	pub fn warnings(&self) -> &[(&'static str, String)] { &self.facts.warnings }

	/// User properties whose subs did not exist at compile time, each with the
	/// error to report if they are still unknown when the pattern is matched.
	pub fn deferred_properties(&self) -> &[String] { &self.facts.deferred }

	/// Whether the pattern contains a `\G` assertion.
	pub fn uses_g(&self) -> bool { self.facts.g_anchor }

	/// With no cursor-dependent anchor or named verb, successive searches
	/// for a constant replacement need not publish intermediate match state.
	pub fn plain_sub_iterations(&self) -> bool { !self.facts.g_anchor && !self.facts.may_mark }

	/// Upper bound in input bytes for a consuming prefix before `\G`.
	/// `None` means the prefix could be arbitrarily wide.
	pub fn g_rewind(&self) -> Option<usize> {
		if !self.facts.g_rewind { Some(0) }
		else if self.facts.g_unbounded { None }
		// One pattern character can full-fold to three Unicode scalars.
		else { Some(self.source.bytes.len().saturating_mul(12)) }
	}

	/// Whether `/p` is active on the pattern or on any interpolated subpattern.
	pub fn preserves_match(&self) -> bool { self.flags.p || self.facts.keep }

	/// Return the string as Perl would stringify a `qr//` value.
	pub fn stringify(&self) -> PStr {
		let f = self.flags;
		let charset = match f.charset {
			Charset::Depends if self.facts.wide => b"u" as &[u8],
			Charset::Depends => b"",
			Charset::Unicode => b"u",
			Charset::Ascii => b"a",
			Charset::AsciiStrict => b"aa",
			Charset::Locale => b"l",
		};
		let mut result = PStr::new(Vec::with_capacity(self.source.bytes.len() + 16), self.facts.wide);
		result.push_bytes(b"(?");
		if charset.is_empty() || !(f.m && f.s && f.i && f.xx && f.n) { result.push_bytes(b"^"); }
		result.push_bytes(charset);
		for (active, byte) in [(f.p, b'p'), (f.m, b'm'), (f.s, b's'), (f.i, b'i'), (f.x, b'x'), (f.xx, b'x'), (f.n, b'n')] {
			if active { result.push_char(u32::from(byte)); }
		}
		result.push_bytes(b":");
		result.push(&self.source);
		if self.facts.trailing_comment { result.push_bytes(b"\n"); }
		result.push_bytes(b")");
		result
	}

	/// Whether the pattern is empty and can reuse the interpreter's last match.
	pub fn is_empty_pattern(&self) -> bool { self.source.is_empty() }

	fn code(&self, utf: bool, exact: bool, checkpoints: bool) -> Result<&Code, String> {
		// Only patterns that repeat or recurse get a checkpointed variant.
		let checkpoints = checkpoints && self.facts.loops;
		let index = usize::from(utf) | usize::from(exact) << 1 | usize::from(checkpoints) << 2;
		let Some(slot) = self.codes.get(index) else { return Err("Invalid regex variant".into()) };
		slot.get_or_init(|| {
			let mode = Mode {
				utf, depends_on_unicode: utf || self.facts.unicode,
				ucp: utf || self.facts.unicode || self.facts.explicit_unicode
					|| matches!(self.flags.charset, Charset::Unicode | Charset::Ascii | Charset::AsciiStrict)
					|| self.locale_unicode,
				locale_unicode: self.locale_unicode,
			};
			let out = Scanner::translate(&self.source, self.flags, &self.facts, mode, &self.actions, &self.properties, exact, checkpoints)?;
			Code::compile(&self.source, &out, mode, self.facts.bounds, exact || !self.actions.is_empty())
		}).as_ref().map_err(Clone::clone)
	}
}

#[derive(Clone, Copy)]
struct Mode {
	utf: bool,
	depends_on_unicode: bool,
	ucp: bool,
	locale_unicode: bool,
}

impl Mode {
	fn unicode(self, charset: Charset) -> bool {
		match charset {
			Charset::Depends => self.depends_on_unicode,
			Charset::Locale => self.locale_unicode,
			_ => true,
		}
	}
}

#[derive(Debug)]
struct Code {
	raw: NonNull<ffi::pcre2_code_8>,
	captures: usize,
	utf: bool,
	bounds: Bounds,
	/// Searches left before JIT compilation (`None`: never, or already done).
	/// Most patterns run once, where JIT compilation costs more than it saves.
	jit_after: Cell<Option<u32>>,
	/// A lower bound on the characters any match needs (patterns with actions).
	min_length: usize,
	/// Spare match data kept between searches; a search takes it (see
	/// `Lease`), so a nested search of the same code allocates its own.
	data: RefCell<Option<MatchData>>,
	context: OnceCell<Result<Context, String>>,
	/// The translation has cancellation checkpoints (`CANCEL_CALLOUT`).
	cancellable: bool,
}

impl Drop for Code {
	fn drop(&mut self) {
		// SAFETY: `raw` is owned and came from pcre2_compile_8.
		unsafe { ffi::pcre2_code_free_8(self.raw.as_ptr()); }
	}
}

#[derive(Debug)]
struct MatchData(NonNull<ffi::pcre2_match_data_8>);
impl Drop for MatchData {
	fn drop(&mut self) {
		// SAFETY: this is the unique owner of PCRE2's match data.
		unsafe { ffi::pcre2_match_data_free_8(self.0.as_ptr()); }
	}
}

#[derive(Debug)]
struct Context(NonNull<ffi::pcre2_match_context_8>);
impl Drop for Context {
	fn drop(&mut self) {
		// SAFETY: this is the unique owner of PCRE2's match context.
		unsafe { ffi::pcre2_match_context_free_8(self.0.as_ptr()); }
	}
}

// pcre2-sys doesn't bind callouts. Version-0 fields are followed by the
// pattern positions and version-1 string callout data from pcre2.h.
#[repr(C)]
struct CalloutBlock {
	version: u32,
	callout_number: u32,
	capture_top: u32,
	capture_last: u32,
	offset_vector: *mut usize,
	mark: *const u8,
	subject: *const u8,
	subject_length: usize,
	start_match: usize,
	current_position: usize,
	pattern_position: usize,
	next_item_length: usize,
	callout_string_offset: usize,
	callout_string_length: usize,
	callout_string: *const u8,
}

/// Receives the action index, phase, current offsets and partial captures.
/// Return `0` to continue, `1` to reject this branch, or negative to abort.
pub(super) type ActionCallback<'a> = dyn FnMut(usize, ActionPhase, usize, Option<Captures>) -> i32 + 'a;

struct CalloutData<'a, 'b> {
	boundaries: &'a [usize],
	words: &'a [usize],
	sentences: &'a [usize],
	lines: &'a [usize],
	anchor: usize,
	required_end: Option<usize>,
	last_closed: Option<usize>,
	convert: &'a dyn Fn(usize) -> usize,
	callback: Option<&'a mut ActionCallback<'b>>,
	panicked: bool,
	/// The host's cancellation flag, polled at checkpoints.
	cancel: Option<&'a AtomicBool>,
	/// A checkpoint found the invocation cancelled.
	cancelled: bool,
}

unsafe extern "C" {
	fn pcre2_set_callout_8(
		context: *mut ffi::pcre2_match_context_8,
		callback: Option<unsafe extern "C" fn(*mut CalloutBlock, *mut c_void) -> i32>,
		userdata: *mut c_void,
	) -> i32;
}

/// Callout number of the cancellation checkpoints the translator emits in
/// patterns that can search in superlinear time (`(?C12)`).
const CANCEL_CALLOUT: u32 = 12;

/// Subjects at least this long (bytes) are searched with checkpoints.
const CHECKPOINT_SUBJECT: usize = 4096;

/// Error text of a search abandoned at a checkpoint because the host
/// cancelled the invocation; the interpreter turns it into cancellation.
pub(super) const CANCELLED: &str = "Regex match cancelled";

thread_local! {
	/// The running interpreter's cancellation flag, which checkpoints poll.
	static CANCEL_FLAG: RefCell<Option<Arc<AtomicBool>>> = const { RefCell::new(None) };
	/// Bytes of PCRE2 match memory (backtracking frames, DFA workspace) in
	/// use on this thread, across every nested search.
	static HEAP_USED: Cell<usize> = const { Cell::new(0) };
}

/// Make `flag` the cancellation flag searches on this thread poll.
pub(super) fn install_cancel_flag(flag: &Arc<AtomicBool>) {
	let _ = CANCEL_FLAG.try_with(|slot| {
		let mut slot = slot.borrow_mut();
		if !slot.as_ref().is_some_and(|current| Arc::ptr_eq(current, flag)) { *slot = Some(Arc::clone(flag)); }
	});
}

/// Stop polling `flag` (its interpreter is gone), if it is the installed one.
pub(super) fn remove_cancel_flag(flag: &Arc<AtomicBool>) {
	let _ = CANCEL_FLAG.try_with(|slot| {
		let mut slot = slot.borrow_mut();
		if slot.as_ref().is_some_and(|current| Arc::ptr_eq(current, flag)) { *slot = None; }
	});
}

/// One PCRE2 match-memory budget for the thread, shared by nested searches
/// (a Perl action can start another search while its own is suspended).
const HEAP_BUDGET: usize = 512 << 20;
/// Allocations below this size always succeed (match data, small frames).
const HEAP_SMALL: usize = 64 << 10;
/// Spare match data whose frames grew past this is freed after the search.
const RETAINED_FRAMES: usize = 1 << 20;
/// Size header in front of each budgeted allocation (keeps 16-byte alignment).
const HEAP_HEADER: usize = 16;

unsafe extern "C" fn budget_malloc(size: usize, _: *mut c_void) -> *mut c_void {
	let Some(total) = size.checked_add(HEAP_HEADER) else { return ptr::null_mut() };
	let used = HEAP_USED.try_with(Cell::get).unwrap_or(0);
	if size >= HEAP_SMALL && used.saturating_add(total) > HEAP_BUDGET { return ptr::null_mut(); }
	let Ok(layout) = Layout::from_size_align(total, HEAP_HEADER) else { return ptr::null_mut() };
	// SAFETY: the layout has a nonzero size (it includes the header).
	let base = unsafe { std::alloc::alloc(layout) };
	if base.is_null() { return ptr::null_mut(); }
	// SAFETY: the block is at least HEAP_HEADER bytes and 16-byte aligned.
	unsafe { base.cast::<usize>().write(total); }
	let _ = HEAP_USED.try_with(|used| used.set(used.get().saturating_add(total)));
	// SAFETY: the header lies within the block.
	unsafe { base.add(HEAP_HEADER).cast() }
}

unsafe extern "C" fn budget_free(block: *mut c_void, _: *mut c_void) {
	if block.is_null() { return; }
	// SAFETY: `block` came from budget_malloc, so its header precedes it
	// and records the allocation's total size.
	unsafe {
		let base = block.cast::<u8>().sub(HEAP_HEADER);
		let total = base.cast::<usize>().read();
		let _ = HEAP_USED.try_with(|used| used.set(used.get().saturating_sub(total)));
		std::alloc::dealloc(base, Layout::from_size_align_unchecked(total, HEAP_HEADER));
	}
}

/// A process-wide PCRE2 general context allocating through the budget
/// (null, the default allocator, if PCRE2 could not create it).
fn budget_context() -> *mut ffi::pcre2_general_context_8 {
	static CONTEXT: OnceLock<usize> = OnceLock::new();
	// SAFETY: both functions match PCRE2's allocator signatures; the
	// context only stores them and is never freed.
	*CONTEXT.get_or_init(|| unsafe {
		ffi::pcre2_general_context_create_8(Some(budget_malloc), Some(budget_free), ptr::null_mut()) as usize
	}) as *mut ffi::pcre2_general_context_8
}

/// Match data in use by one search. It goes back to its code afterwards,
/// unless its backtracking frames grew large: they count against the budget.
struct Lease<'c> {
	code: &'c Code,
	data: Option<MatchData>,
}

impl Lease<'_> {
	fn ptr(&self) -> *mut ffi::pcre2_match_data_8 {
		self.data.as_ref().map_or(ptr::null_mut(), |data| data.0.as_ptr())
	}
}

impl Drop for Lease<'_> {
	fn drop(&mut self) {
		let Some(data) = self.data.take() else { return };
		// SAFETY: the match data is valid and no search is using it.
		let frames = unsafe { ffi::pcre2_get_match_data_heapframes_size_8(data.0.as_ptr()) };
		if frames <= RETAINED_FRAMES && let Ok(mut slot) = self.code.data.try_borrow_mut() {
			slot.get_or_insert(data);
		}
	}
}

fn pcre_bytes(bytes: &[u8]) -> *const u8 {
	// PCRE2's JIT may read the aligned block containing an empty subject's
	// pointer. An empty Vec's dangling pointer (0x1) would align down to NULL.
	#[repr(align(16))]
	struct Aligned([u8; 16]);
	static EMPTY: Aligned = Aligned([0; 16]);
	if bytes.is_empty() { EMPTY.0.as_ptr() } else { bytes.as_ptr() }
}

impl Code {
	/// Run PCRE2's compiler; `Err` carries its error code and offset.
	fn pcre2(out: &Output, options: u32) -> Result<NonNull<ffi::pcre2_code_8>, (i32, usize)> {
		let mut error = 0;
		let mut offset = 0;
		// SAFETY: this is an owned context; its PCRE handle is valid until
		// freed below. Pattern bytes and out-parameters outlive the call.
		let raw = unsafe {
			let context = ffi::pcre2_compile_context_create_8(ptr::null_mut());
			if context.is_null() { return Err((ffi::PCRE2_ERROR_NOMEMORY, 0)); }
			ffi::pcre2_set_newline_8(context, ffi::PCRE2_NEWLINE_LF);
			ffi::pcre2_set_bsr_8(context, ffi::PCRE2_BSR_UNICODE);
			let code = ffi::pcre2_compile_8(pcre_bytes(&out.bytes), out.bytes.len(), options, &raw mut error, &raw mut offset, context);
			ffi::pcre2_compile_context_free_8(context);
			code
		};
		NonNull::new(raw).ok_or((error, offset))
	}

	fn compile(source: &PStr, out: &Output, mode: Mode, bounds: Bounds, actions: bool) -> Result<Self, String> {
		let mut options = ffi::PCRE2_DUPNAMES;
		if mode.utf { options |= ffi::PCRE2_UTF; }
		if mode.ucp { options |= ffi::PCRE2_UCP; }
		// Perl code must run at every start position perl itself would try,
		// so start-of-match shortcuts are off; only the minimum subject length
		// (computed by a second, optimized compile) still rules out attempts,
		// as perl's optimizer does before any code block can run.
		let mut min_length = 0u32;
		if actions {
			if let Ok(optimized) = Self::pcre2(out, options) {
				// SAFETY: `optimized` is a valid code we own; MINLENGTH writes one u32.
				unsafe {
					ffi::pcre2_pattern_info_8(optimized.as_ptr(), ffi::PCRE2_INFO_MINLENGTH, (&raw mut min_length).cast());
					ffi::pcre2_code_free_8(optimized.as_ptr());
				}
			}
			options |= ffi::PCRE2_NO_START_OPTIMIZE | ffi::PCRE2_NO_AUTO_POSSESS;
		}
		let raw = match Self::pcre2(out, options) {
			Ok(raw) => raw,
			Err((error, offset)) => {
				// Perl has no size limit on literal text; PCRE2's compiled form
				// does, so long periodic literal runs become counted repeats.
				let smaller = if error as u32 == ffi::PCRE2_ERROR_PATTERN_TOO_LARGE { compress_runs(out) } else { None };
				let Some(smaller) = smaller else { return Err(compile_error(source, out, error, offset)) };
				Self::pcre2(&smaller, options).map_err(|(error, offset)| compile_error(source, &smaller, error, offset))?
			}
		};
		let mut captures = 0u32;
		let mut lookbehind = 0u32;
		// SAFETY: `raw` is valid; CAPTURECOUNT and MAXLOOKBEHIND each write
		// one u32. On an unsupported lookbehind this frees the owned code.
		unsafe {
			ffi::pcre2_pattern_info_8(raw.as_ptr(), ffi::PCRE2_INFO_CAPTURECOUNT, (&raw mut captures).cast());
			ffi::pcre2_pattern_info_8(raw.as_ptr(), ffi::PCRE2_INFO_MAXLOOKBEHIND, (&raw mut lookbehind).cast());
			if lookbehind > 255 {
				ffi::pcre2_code_free_8(raw.as_ptr());
				return Err(diagnostic(source, "Lookbehind longer than 255 not implemented", None));
			}
		}
		let jit_after = Cell::new((!actions).then_some(2));
		Ok(Self { raw, captures: captures as usize, utf: mode.utf, bounds, jit_after, min_length: min_length as usize,
			data: RefCell::new(None), context: OnceCell::new(), cancellable: out.cancellable })
	}

	/// JIT-compile once the pattern is reused or meets a large subject.
	fn maybe_jit(&self, subject_len: usize) {
		let Some(left) = self.jit_after.get() else { return; };
		if left == 0 || subject_len >= 4096 { self.jit_now(); } else { self.jit_after.set(Some(left - 1)); }
	}

	fn jit_now(&self) {
		self.jit_after.set(None);
		// SAFETY: `raw` is a valid compiled pattern and no match is running on
		// it: patterns without Perl actions never re-enter a search, and
		// patterns with actions are never JIT-compiled.
		unsafe { ffi::pcre2_jit_compile_8(self.raw.as_ptr(), ffi::PCRE2_JIT_COMPLETE); }
	}

	/// Match data for one search: the spare one, or a new one when it is
	/// taken (a nested search of this code) or was given up.
	fn lease(&self) -> Result<Lease<'_>, String> {
		let spare = self.data.try_borrow_mut().ok().and_then(|mut slot| slot.take());
		let data = match spare { Some(data) => data, None => self.alloc_data()? };
		Ok(Lease { code: self, data: Some(data) })
	}

	fn alloc_data(&self) -> Result<MatchData, String> {
		// SAFETY: self.raw is a valid compiled pattern; the general context
		// (or null, for the default allocator) outlives this call.
		let raw = unsafe { ffi::pcre2_match_data_create_from_pattern_8(self.raw.as_ptr(), budget_context()) };
		NonNull::new(raw).map(MatchData).ok_or_else(|| "Out of memory matching regex".into())
	}

	fn alloc_context() -> Result<Context, String> {
		// SAFETY: the budgeted general context (or null, for the default
		// allocator) is only read during creation.
		let raw = unsafe { ffi::pcre2_match_context_create_8(budget_context()) };
		let context = NonNull::new(raw).map(Context).ok_or_else(|| "Out of memory matching regex".to_owned())?;
		// SAFETY: the context was just created and is exclusively owned.
		// Bound the interpreter's backtracking memory (KiB; PCRE2's default is 20 GiB).
		unsafe { ffi::pcre2_set_heap_limit_8(context.0.as_ptr(), 512 * 1024); }
		Ok(context)
	}

	fn exec(&self, subject: &[u8], start: usize, opts: ExecOpts, source_utf: bool,
		map: impl Fn(usize) -> usize, callback: Option<&mut ActionCallback<'_>>) -> Result<Option<Captures>, String> {
		// A Perl action can recursively use this same regex, so give any
		// callback-capable invocation its own match data and context.
		let reentrant = callback.is_some();
		// Characters never outnumber bytes, so this rules out a match.
		if subject.len().saturating_sub(start) < self.min_length { return Ok(None); }
		self.maybe_jit(subject.len());
		let lease = self.lease()?;
		let data = lease.ptr();
		let mut options = if opts.not_empty_at_start { ffi::PCRE2_NOTEMPTY_ATSTART } else { 0 };
		if opts.anchored { options |= ffi::PCRE2_ANCHORED | ffi::PCRE2_NO_JIT; }
		if opts.utf8_valid && self.utf { options |= ffi::PCRE2_NO_UTF_CHECK; }
		let boundaries = if self.bounds.grapheme && self.utf { grapheme_boundaries(subject)? } else { Vec::new() };
		let words = if self.bounds.word { text_boundaries(subject, Bounds::WORD)? } else { Vec::new() };
		let sentences = if self.bounds.sentence { text_boundaries(subject, Bounds::SENTENCE)? } else { Vec::new() };
		let lines = if self.bounds.line {
			super::rx::linebreak::boundaries(std::str::from_utf8(subject).map_err(|e| format!("{e} in regex match"))?)
		} else { Vec::new() };
		let cancel = if self.cancellable { CANCEL_FLAG.try_with(|slot| slot.borrow().clone()).ok().flatten() } else { None };
		let mut callout = CalloutData { boundaries: &boundaries, words: &words, sentences: &sentences, lines: &lines, anchor: opts.g_anchor.unwrap_or(start),
			required_end: opts.required_end, last_closed: None, convert: &map, callback, panicked: false,
			cancel: cancel.as_deref(), cancelled: false };
		let local_context;
		let context = {
			let ctx = if reentrant { local_context = Self::alloc_context()?; &local_context }
				else { self.context.get_or_init(Self::alloc_context).as_ref().map_err(Clone::clone)? };
			// SAFETY: the context, boundaries, and userdata live through this match.
			// Calls with Perl actions never share these mutable PCRE2 resources.
			unsafe { pcre2_set_callout_8(ctx.0.as_ptr(), Some(regex_callout), (&raw mut callout).cast()); }
			ctx.0.as_ptr()
		};
		let subject_ptr = pcre_bytes(subject);
		// SAFETY: the subject is readable for its length (and backed by real
		// storage if empty); data is sized for this code and is reentrancy-safe.
		let mut count = unsafe { ffi::pcre2_match_8(self.raw.as_ptr(), subject_ptr, subject.len(), start, options, data, context) };
		if count == ffi::PCRE2_ERROR_JIT_STACKLIMIT {
			callout.last_closed = None;
			// SAFETY: same arguments as above; the retry uses the interpreter.
			count = unsafe { ffi::pcre2_match_8(self.raw.as_ptr(), subject_ptr, subject.len(), start, options | ffi::PCRE2_NO_JIT, data, context) };
		}
		if callout.panicked { return Err("Panic in regex action".into()); }
		if callout.cancelled { return Err(CANCELLED.into()); }
		if matches!(count, ffi::PCRE2_ERROR_MATCHLIMIT | ffi::PCRE2_ERROR_DEPTHLIMIT
			| ffi::PCRE2_ERROR_HEAPLIMIT | ffi::PCRE2_ERROR_NOMEMORY | ffi::PCRE2_ERROR_JIT_STACKLIMIT) && !reentrant
		{
			// Perl's backtracking memoizes what PCRE2 retries exponentially.
			// The DFA matcher decides such searches in polynomial time; it
			// reports the leftmost-longest match without inner captures.
			let mut workspace = vec![0i32; 8192];
			callout.last_closed = None;
			// SAFETY: as above; the workspace is writable for its length.
			let rc = unsafe {
				ffi::pcre2_dfa_match_8(self.raw.as_ptr(), subject_ptr, subject.len(), start, options & !ffi::PCRE2_NO_JIT,
					data, context, workspace.as_mut_ptr(), workspace.len())
			};
			// 0: more alternative matches than the vector holds; the longest is first.
			count = if rc >= 0 { 1 } else { rc };
			if callout.cancelled { return Err(CANCELLED.into()); }
		}
		// Perl has no backtracking limits; a search that still exhausts a
		// budget simply fails to match, as perl's eventually would.
		// DFA errors (-43..=-38) mean the pattern needs backtracking features.
		if matches!(count, ffi::PCRE2_ERROR_NOMATCH | ffi::PCRE2_ERROR_MATCHLIMIT | ffi::PCRE2_ERROR_DEPTHLIMIT
			| ffi::PCRE2_ERROR_HEAPLIMIT | ffi::PCRE2_ERROR_NOMEMORY | ffi::PCRE2_ERROR_JIT_STACKLIMIT)
			|| (ffi::PCRE2_ERROR_DFA_WSSIZE..=ffi::PCRE2_ERROR_DFA_BADRESTART).contains(&count)
		{
			return Ok(None);
		}
		if count < 0 { return Err(format!("{} in regex match", error_message(count))); }
		let pairs = count as usize;
		// SAFETY: a successful match populated `count` pairs in `data`.
		let raw = unsafe { std::slice::from_raw_parts(ffi::pcre2_get_ovector_pointer_8(data), pairs * 2) };
		let mut spans = Captures::buffer();
		spans.reserve(self.captures + 1);
		spans.extend(raw.chunks_exact(2).map(|p| {
			(p[0] != ffi::PCRE2_UNSET && p[1] != ffi::PCRE2_UNSET).then(|| (map(p[0]), map(p[1])))
		}));
		spans.resize(self.captures + 1, None);
		// SAFETY: a non-null mark is a NUL-terminated string owned by the compiled code.
		let mark = unsafe {
			let p = ffi::pcre2_get_mark_8(data);
			(!p.is_null()).then(|| CStr::from_ptr(p.cast()).to_bytes())
		}.map(|mark| {
			if self.utf && !source_utf && !mark.is_ascii() {
				let s = PStr::new(mark.to_vec(), true);
				if let Some(b) = s.downgraded() { PStr::new(b, false) } else { s }
			} else { PStr::from_bytes(mark) }
		});
		Ok(Some(Captures { spans, mark, last_closed: callout.last_closed }))
	}
}

/// A well-formed UTF-8 copy of a subject with each character PCRE2 cannot
/// accept replaced by U+FFFF, plus the offset correspondence.
struct Sanitized {
	bytes: Vec<u8>,
	/// Each replaced character: (original start, original end, copy start, copy end).
	spans: Vec<(usize, usize, usize, usize)>,
}

impl Sanitized {
	fn new(original: &[u8]) -> Self {
		const REPLACEMENT: &[u8] = "\u{FFFF}".as_bytes();
		let mut bytes = Vec::with_capacity(original.len());
		let mut spans = Vec::new();
		let mut at = 0;
		while at < original.len() {
			match std::str::from_utf8(&original[at..]) {
				Ok(_) => { bytes.extend_from_slice(&original[at..]); break; }
				Err(error) => {
					let good = error.valid_up_to();
					bytes.extend_from_slice(&original[at..at + good]);
					at += good;
					// One perl character: the lead byte's length (perl's
					// extended UTF-8 allows up to 13 bytes) while continuation
					// bytes follow, else the single bad byte.
					let lead = original[at];
					let width = match lead.leading_ones() { 0 | 1 => 1, 7 | 8 => if lead == 0xFF { 13 } else { 7 }, n => n as usize };
					let mut end = at + 1;
					while end < at + width && original.get(end).is_some_and(|b| b & 0xC0 == 0x80) { end += 1; }
					let copy = bytes.len();
					bytes.extend_from_slice(REPLACEMENT);
					spans.push((at, end, copy, bytes.len()));
					at = end;
				}
			}
		}
		Self { bytes, spans }
	}

	/// Original offset → offset in the copy; offsets inside a replaced
	/// character map to the end of its replacement.
	fn forward(&self, original: usize) -> usize {
		let i = self.spans.partition_point(|&(start, ..)| start <= original);
		match i.checked_sub(1).and_then(|i| self.spans.get(i)) {
			Some(&(start, end, copy_start, copy_end)) => {
				if original == start { copy_start } else if original < end { copy_end } else { copy_end + (original - end) }
			}
			None => original,
		}
	}

	/// Offset in the copy → original offset.
	fn back(&self, copy: usize) -> usize {
		let i = self.spans.partition_point(|&(_, _, copy_start, _)| copy_start <= copy);
		match i.checked_sub(1).and_then(|i| self.spans.get(i)) {
			Some(&(start, end, copy_start, copy_end)) => {
				if copy == copy_start { start } else if copy < copy_end { end } else { end + (copy - copy_end) }
			}
			None => copy,
		}
	}
}

/// Rewrite long literal text outside classes, a run of `\x{..}` tokens and
/// folded-character `(?:...)` groups, as counted repeats of its periodic
/// stretches (`(?:\x{30}\x{31}){500}`), keeping the final token separate when
/// a quantifier follows it. `None` when nothing could shrink.
fn compress_runs(out: &Output) -> Option<Output> {
	const MIN_TOKENS: usize = 8;
	const MAX_PERIOD: usize = 16;
	let bytes = &out.bytes;
	// The length of the `\x{HEX}` token or capture-free `(?:...)` group
	// (a folded character) starting at `i`, if one does.
	let token = |i: usize| -> Option<usize> {
		let rest = bytes.get(i..)?;
		if rest.starts_with(b"\\x{") {
			let close = rest.iter().position(|&b| b == b'}')?;
			rest.get(3..close).filter(|hex| !hex.is_empty() && hex.iter().all(u8::is_ascii_hexdigit))?;
			return Some(close + 1);
		}
		if !rest.starts_with(b"(?:") { return None; }
		let (mut depth, mut class, mut j) = (0usize, false, 0);
		while let Some(&b) = rest.get(j) {
			match b {
				b'\\' => j += 1,
				b'[' => class = true,
				b']' if class => class = false,
				b'(' if !class => {
					if rest.get(j + 1) != Some(&b'?') || matches!(rest.get(j + 2), Some(b'<' | b'\'' | b'P')) { return None; }
					depth += 1;
				}
				b')' if !class => {
					depth -= 1;
					if depth == 0 { return Some(j + 1); }
				}
				_ => {}
			}
			j += 1;
		}
		None
	};
	// A literal character: a token or a plain ASCII byte that is not syntax.
	let literal = |i: usize| -> Option<usize> {
		token(i).or_else(|| bytes.get(i).filter(|&&b| b.is_ascii_graphic() && !b"\\^$.|?*+()[]{}#".contains(&b)).map(|_| 1))
	};
	let mut result = Output { cancellable: out.cancellable, ..Output::default() };
	let mut changed = false;
	let mut depth = 0usize;
	let mut i = 0;
	let mut copied = 0;
	while i < bytes.len() {
		if depth == 0 && literal(i).is_some() {
			// The run of consecutive literals starting here, as (start, end).
			let mut run = Vec::new();
			let mut at = i;
			while let Some(len) = literal(at) {
				run.push((at, at + len));
				at += len;
			}
			if matches!(bytes.get(at), Some(b'*' | b'+' | b'?' | b'{')) { run.pop(); }
			let unit = |k: usize, p: usize| -> Option<&[u8]> {
				let (first, last) = (run.get(k)?, run.get(k + p - 1)?);
				bytes.get(first.0..last.1)
			};
			let mut k = 0;
			while k < run.len() {
				// The period covering the most literals from here.
				let mut best = (0, 0);
				for p in 1..=MAX_PERIOD.min(run.len() - k) {
					let Some(first) = unit(k, p) else { break };
					let mut repeats = 1;
					while unit(k + repeats * p, p) == Some(first) { repeats += 1; }
					if repeats >= 2 && repeats * p > best.0 * best.1 { best = (repeats, p); }
				}
				let (repeats, p) = best;
				if repeats * p < MIN_TOKENS {
					k += 1;
					continue;
				}
				let start = run[k].0;
				let end = run[k + repeats * p - 1].1;
				let text = unit(k, p).unwrap_or_default();
				result.note(out.original(copied));
				result.bytes.extend_from_slice(&bytes[copied..start]);
				result.note(out.original(start));
				let mut left = repeats;
				while left > 0 {
					let chunk = left.min(65535);
					result.bytes.extend_from_slice(b"(?:");
					result.bytes.extend_from_slice(text);
					let _ = write!(result.bytes, "){{{chunk}}}");
					left -= chunk;
				}
				copied = end;
				changed = true;
				k += repeats * p;
			}
			i = at.max(i + 1);
			continue;
		}
		// Skip syntax whose letters and digits are not literal text.
		let skip_to = |from: usize, stop: &[u8]| bytes.get(from..).and_then(|r| r.iter().position(|b| stop.contains(b))).map_or(bytes.len(), |n| from + n + 1);
		match bytes[i] {
			b'\\' => {
				i = match bytes.get(i + 1) {
					Some(b'x' | b'o' | b'g' | b'k' | b'N' | b'p' | b'P' | b'b' | b'B') if bytes.get(i + 2) == Some(&b'{') => skip_to(i + 2, &b"}"[..]),
					Some(b'k') if bytes.get(i + 2) == Some(&b'<') => skip_to(i + 2, &b">"[..]),
					_ => i + 2,
				};
			}
			b'(' if matches!(bytes.get(i + 1), Some(b'?' | b'*')) => {
				i += 2;
				if bytes.get(i) == Some(&b'#') { i = skip_to(i, &b")"[..]); }
				while bytes.get(i).is_some_and(|b| b.is_ascii_alphanumeric() || b"^-<>'=!&_".contains(b)) { i += 1; }
			}
			b'{' if depth == 0 => i = skip_to(i, &b"}"[..]),
			b'[' => { depth += 1; i += 1; }
			b']' if depth > 0 => { depth -= 1; i += 1; }
			_ => i += 1,
		}
	}
	if !changed { return None; }
	result.note(out.original(copied));
	result.bytes.extend_from_slice(bytes.get(copied..).unwrap_or_default());
	result.note(out.original(bytes.len()));
	Some(result)
}

/// A class range PCRE2 accepts in UTF mode: clipped to Unicode, endpoints
/// moved off surrogates; a range of nothing but those becomes U+FFFF, which
/// stands for them in subjects (`Sanitized`).
fn unicode_range(left: u32, right: u32, utf: bool) -> (u32, u32) {
	if !utf { return (left, right); }
	let surrogate = |cp: u32| (0xD800..=0xDFFF).contains(&cp);
	let right = right.min(0x10FFFF);
	let right = if surrogate(right) { 0xD7FF } else { right };
	let left = if surrogate(left) { 0xE000 } else { left };
	if left > right { (0xFFFF, 0xFFFF) } else { (left, right) }
}

fn push_latin1(out: &mut Vec<u8>, b: u8) {
	if b < 128 {
		out.push(b);
	} else {
		out.extend_from_slice(&[0xC0 | (b >> 6), 0x80 | (b & 63)]);
	}
}

fn grapheme_boundaries(subject: &[u8]) -> Result<Vec<usize>, String> {
	std::str::from_utf8(subject).map_err(|e| format!("{e} in regex match"))?;
	thread_local! {
		static GRAPHEME: OnceCell<Result<Code, String>> = const { OnceCell::new() };
	}
	GRAPHEME.with(|slot| {
		let code = slot.get_or_init(|| {
			let source = PStr::from_bytes(b"\\G\\X");
			let out = Output { bytes: source.bytes.clone(), knots: Vec::new(), cancellable: false };
			let code = Code::compile(&source, &out, Mode { utf: true, depends_on_unicode: true, ucp: true, locale_unicode: false }, Bounds::default(), false)?;
			code.jit_now();
			Ok(code)
		}).as_ref().map_err(Clone::clone)?;
		let lease = code.lease()?;
		let data = lease.ptr();
		let mut offsets = vec![0];
		let mut pos = 0;
		while pos < subject.len() {
			// SAFETY: the loop requires a nonempty subject, which Rust
			// validated as UTF-8. PCRE2 returns the subsequent offsets.
			let end = unsafe {
				let rc = ffi::pcre2_match_8(code.raw.as_ptr(), subject.as_ptr(), subject.len(), pos, ffi::PCRE2_NO_UTF_CHECK, data, ptr::null_mut());
				if rc != 1 { return Err(format!("{} in regex match", error_message(rc))); }
				*ffi::pcre2_get_ovector_pointer_8(data).add(1)
			};
			if end <= pos { return Err("Empty grapheme in regex match".into()); }
			offsets.push(end);
			pos = end;
		}
		Ok(offsets)
	})
}

/// Which Unicode text boundaries (UAX #29) a pattern tests with `\b{...}`.
#[derive(Clone, Copy, Debug, Default)]
struct Bounds {
	grapheme: bool,
	word: bool,
	sentence: bool,
	line: bool,
}

impl Bounds {
	const WORD: Self = Self { grapheme: false, word: true, sentence: false, line: false };
	const SENTENCE: Self = Self { grapheme: false, word: false, sentence: true, line: false };

	/// Word and sentence boundaries are only defined on characters, so these
	/// patterns always match against the UTF-8 form of the subject.
	fn need_utf(self) -> bool { self.word || self.sentence || self.line }
}

/// Word (`\b{wb}`) or sentence (`\b{sb}`) boundary offsets of a UTF-8 subject,
/// including both ends. Perl tailors word boundaries so that runs of white
/// space are never split (`perlrebackslash`).
fn text_boundaries(subject: &[u8], kind: Bounds) -> Result<Vec<usize>, String> {
	use unicode_segmentation::UnicodeSegmentation;
	let text = std::str::from_utf8(subject).map_err(|e| format!("{e} in regex match"))?;
	let mut out: Vec<usize> = if kind.word {
		text.split_word_bound_indices().map(|(i, _)| i).collect()
	} else {
		text.split_sentence_bound_indices().map(|(i, _)| i).collect()
	};
	out.push(text.len());
	if kind.word {
		let between_spaces = |i: usize| text[..i].chars().next_back().is_some_and(char::is_whitespace)
			&& text[i..].chars().next().is_some_and(char::is_whitespace);
		out.retain(|&i| !between_spaces(i));
		// Except: a final horizontal space that a combining character
		// (Extend/Format/ZWJ) attaches to is split from the span.
		let horizontal = |c: char| matches!(c, '\t' | ' ' | '\u{A0}' | '\u{1680}' | '\u{2000}'..='\u{200A}' | '\u{202F}' | '\u{205F}' | '\u{3000}');
		let mut extra = Vec::new();
		for (i, c) in text.char_indices() {
			if i == 0 || !horizontal(c) || !between_spaces(i) { continue; }
			let rest = &text[i + c.len_utf8()..];
			if rest.chars().next().is_some_and(|next| !next.is_whitespace())
				&& text[i..].graphemes(true).next().is_some_and(|g| g.len() > c.len_utf8())
			{
				extra.push(i);
			}
		}
		if !extra.is_empty() {
			out.extend(extra);
			out.sort_unstable();
			out.dedup();
		}
	}
	Ok(out)
}

unsafe extern "C" fn regex_callout(block: *mut CalloutBlock, userdata: *mut c_void) -> i32 {
	// SAFETY: PCRE2 supplies the live match block; the registered userdata
	// points to the `CalloutData` stack slot owned by `exec`.
	let (block, data) = unsafe { (&*block, &mut *userdata.cast::<CalloutData<'_, '_>>()) };
	let pos = block.current_position;
	match block.callout_number {
		0 if block.version >= 1 && !block.callout_string.is_null() => {
			// SAFETY: PCRE2 owns the string for the duration of the callback.
			let label = unsafe { std::slice::from_raw_parts(block.callout_string, block.callout_string_length) };
			let phase = match label.first() {
				Some(b'a') => ActionPhase::Eval,
				Some(b't') => ActionPhase::Test,
				Some(b'b') => ActionPhase::Begin,
				Some(b'e') => ActionPhase::End,
				Some(b'f') => ActionPhase::RetryEnd,
				Some(b'r') => ActionPhase::Rollback,
				_ => return ffi::PCRE2_ERROR_CALLOUT,
			};
			let Some(index) = std::str::from_utf8(&label[1..]).ok().and_then(|s| s.parse().ok()) else {
				return ffi::PCRE2_ERROR_CALLOUT;
			};
			let Some(cb) = data.callback.as_deref_mut() else { return ffi::PCRE2_ERROR_CALLOUT; };
			let map = data.convert;
			let caps = matches!(phase, ActionPhase::Eval | ActionPhase::Test | ActionPhase::Begin).then(|| {
				let count = block.capture_top as usize;
				let mut spans = Captures::buffer();
				spans.reserve(count.max(1));
				spans.push(Some((map(block.start_match), map(pos))));
				if count > 1 {
					// SAFETY: PCRE2's internal vector has `capture_top` readable pairs.
					let offsets = unsafe { std::slice::from_raw_parts(block.offset_vector, count * 2) };
					spans.extend(offsets.chunks_exact(2).skip(1).map(|p| {
						(p[0] != ffi::PCRE2_UNSET && p[1] != ffi::PCRE2_UNSET).then(|| (map(p[0]), map(p[1])))
					}));
				}
				let last = block.capture_last as usize;
				Captures { spans, mark: None, last_closed: (last != 0).then_some(last) }
			});
			// Never unwind across the C ABI, including if a tied variable or a
			// host hook happens to panic while evaluating Perl code.
			match std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| cb(index, phase, map(pos), caps))) {
				Ok(result) => result,
				Err(_) => { data.panicked = true; ffi::PCRE2_ERROR_CALLOUT }
			}
		}
		CANCEL_CALLOUT => {
			if data.cancel.is_some_and(|flag| flag.load(Ordering::Relaxed)) {
				data.cancelled = true;
				ffi::PCRE2_ERROR_CALLOUT
			} else { 0 }
		}
		3 => i32::from(pos != data.anchor),
		5 => i32::from(data.required_end != Some(pos)),
		4 => {
			let last = block.capture_last as usize;
			data.last_closed = (last != 0).then_some(last);
			0
		}
		6..=11 => {
			let list = match block.callout_number { 6 | 7 => data.words, 8 | 9 => data.sentences, _ => data.lines };
			let boundary = block.subject_length != 0 && list.binary_search(&pos).is_ok();
			i32::from(boundary != matches!(block.callout_number, 6 | 8 | 10))
		}
		_ => {
			// SAFETY: PCRE2's subject pointer is readable for subject_length.
			let subject = unsafe { std::slice::from_raw_parts(block.subject, block.subject_length) };
			let boundary = !subject.is_empty() && if data.boundaries.is_empty() {
				!(pos > 0 && subject.get(pos - 1) == Some(&b'\r') && subject.get(pos) == Some(&b'\n'))
			} else { data.boundaries.binary_search(&pos).is_ok() };
			i32::from(boundary != (block.callout_number == 1))
		}
	}
}

#[derive(Debug, Default)]
struct Facts {
	wide: bool,
	unicode: bool,
	explicit_unicode: bool,
	locale: bool,
	bounds: Bounds,
	g_anchor: bool,
	g_rewind: bool,
	g_unbounded: bool,
	/// A named verb can publish REGMARK/REGERROR between substitutions.
	may_mark: bool,
	/// The pattern begins with `\G`, so every match starts at the `\G` position.
	g_leading: bool,
	/// A `|` at the top level makes a leading assertion optional.
	top_alternation: bool,
	/// Total number of capture groups.
	group_count: usize,
	/// The pattern repeats or recurses, so a search can take superlinear
	/// time; translations then carry cancellation checkpoints.
	loops: bool,
	/// Compile-time diagnostics as (warning category, message with marker).
	warnings: Vec<(&'static str, String)>,
	/// Errors for user properties still undefined at compile time.
	deferred: Vec<String>,
	keep: bool,
	captures: bool,
	trailing_comment: bool,
	names: Vec<(Rc<str>, Vec<usize>)>,
}

#[derive(Default)]
struct Output {
	bytes: Vec<u8>,
	// (output offset, input offset). Identity runs share one entry.
	knots: Vec<(usize, usize)>,
	/// The translation contains cancellation checkpoints (`CANCEL_CALLOUT`).
	cancellable: bool,
}

impl Output {
	fn note(&mut self, input: usize) {
		let n = self.bytes.len();
		if self.knots.last().is_some_and(|&(out, orig)| orig.saturating_add(n - out) == input) { return; }
		self.knots.push((n, input));
	}

	fn original(&self, output: usize) -> usize {
		let i = self.knots.partition_point(|&(at, _)| at <= output);
		if let Some(&(at, original)) = i.checked_sub(1).and_then(|i| self.knots.get(i)) {
			original.saturating_add(output - at).min(self.knots.get(i).map_or(usize::MAX, |&(_, src)| src))
		} else { output }
	}
}

#[derive(Clone, Copy)]
struct Frame {
	opening: usize,
	/// Output offset where the group's opener begins.
	out_start: usize,
	flags: RxFlags,
	branch: Option<(usize, usize)>,
	prefix_consumes: bool,
	alternate_consumes: bool,
	conditional_branches: u8,
}

struct Scanner<'a> {
	source: &'a PStr,
	bytes: &'a [u8],
	pos: usize,
	flags: RxFlags,
	frames: Vec<Frame>,
	prefix_consumes: bool,
	prefix_unbounded: bool,
	groups: usize,
	mode: Option<Mode>,
	actions: &'a [Action],
	action_index: usize,
	properties: &'a [UserProperty],
	known: Option<&'a Facts>,
	facts: Facts,
	out: Output,
	in_set: bool,
	/// Output span of the group closed last, for wrapping it when quantified.
	closed_group: Option<(usize, usize)>,
	/// Quantifiers emitted since the last cancellation checkpoint.
	loops: u32,
	/// This translation carries cancellation checkpoints.
	checkpoints: bool,
	pending: Vec<Literal>,
	fold_units: Vec<FoldUnit>,
	fold_edges: Vec<FoldEdge>,
}

impl<'a> Scanner<'a> {
	fn new(source: &'a PStr, flags: RxFlags, actions: &'a [Action], properties: &'a [UserProperty]) -> Self {
		Self { source, bytes: &source.bytes, pos: 0, flags, frames: Vec::new(), groups: 0, prefix_consumes: false, prefix_unbounded: false,
			mode: None, known: None, actions, action_index: 0, properties, facts: Facts::default(), out: Output::default(), in_set: false,
			pending: Vec::new(), fold_units: Vec::new(), fold_edges: Vec::new(), closed_group: None, loops: 0, checkpoints: false }
	}

	fn analyze(source: &'a PStr, flags: RxFlags, actions: &'a [Action], properties: &'a [UserProperty]) -> Result<Facts, String> {
		let mut scan = Self::new(source, flags, actions, properties);
		scan.run()?;
		scan.facts.captures = scan.groups != 0;
		scan.facts.group_count = scan.groups;
		Ok(scan.facts)
	}

	fn translate(source: &'a PStr, flags: RxFlags, known: &'a Facts, mode: Mode, actions: &'a [Action],
		properties: &'a [UserProperty], exact: bool, checkpoints: bool) -> Result<Output, String> {
		let mut scan = Self::new(source, flags, actions, properties);
		scan.mode = Some(mode);
		scan.checkpoints = checkpoints;
		scan.known = Some(known);
		scan.out.bytes.reserve(source.bytes.len());
		// Observe `capture_last` only after the winning branch has finished.
		if known.captures || exact { scan.emit(b"(?:", 0, 0); }
		scan.options(flags, 0);
		// A pattern that repeats can search in superlinear time: give every
		// start position a cancellation checkpoint.
		if known.loops { scan.checkpoint(); }
		scan.run()?;
		let end = source.bytes.len();
		if known.captures || exact { scan.emit(b")", end, end); }
		if exact { scan.emit(b"(?C5)", end, end); }
		if known.captures { scan.emit(b"(?C4)", end, end); }
		scan.out.note(end);
		Ok(scan.out)
	}

	fn at(&self, i: usize) -> u8 { self.bytes.get(i).copied().unwrap_or_default() }

	fn matches(&self, i: usize, text: &[u8]) -> bool {
		self.bytes.get(i..).is_some_and(|rest| rest.starts_with(text))
	}

	fn tail(&self, i: usize) -> &'a [u8] { self.bytes.get(i..).unwrap_or_default() }

	fn find(&self, start: usize, byte: u8) -> Option<usize> {
		self.tail(start).iter().position(|&b| b == byte).map(|off| start + off)
	}

	fn cp(&self, i: usize) -> (u32, usize) {
		let b = self.at(i);
		if !self.source.utf8 || b < 128 { return (u32::from(b), i + 1); }
		let tail = self.tail(i);
		let width = (b.leading_ones() as usize).clamp(1, 4);
		if let Some(c) = tail.get(..width).and_then(|b| std::str::from_utf8(b).ok()).and_then(|s| s.chars().next()) {
			(u32::from(c), i + width)
		} else { (u32::from(b), i + 1) }
	}

	fn err(&self, msg: &str, at: usize) -> String { diagnostic(self.source, msg, Some(at)) }

	/// Record a compile-time warning once (during analysis, not translation).
	fn warn(&mut self, category: &'static str, msg: &str, at: usize) {
		if self.mode.is_some() { return; }
		let text = diagnostic(self.source, msg, Some(at.min(self.bytes.len())));
		self.facts.warnings.push((category, text));
	}

	fn raw(&mut self, a: usize, b: usize) {
		let Some(mode) = self.mode else { return; };
		let Some(bytes) = self.bytes.get(a..b) else { return; };
		self.out.note(a);
		if mode.utf && !self.source.utf8 && !bytes.is_ascii() {
			for (i, &byte) in bytes.iter().enumerate() {
				self.out.note(a + i);
				push_latin1(&mut self.out.bytes, byte);
			}
		} else { self.out.bytes.extend_from_slice(bytes); }
		self.out.note(b);
	}

	fn emit(&mut self, bytes: &[u8], start: usize, end: usize) {
		if self.mode.is_none() { return; }
		self.out.note(start);
		self.out.bytes.extend_from_slice(bytes);
		self.out.note(end);
	}

	fn options(&mut self, f: RxFlags, at: usize) {
		if self.mode.is_none() { return; }
		let mut b = [0; 13];
		let mut n = 3;
		b[..3].copy_from_slice(b"(?^");
		for (yes, ch) in [(f.i, b'i'), (f.m, b'm'), (f.n, b'n'), (f.s, b's'), (f.x, b'x'), (f.xx, b'x'), (f.charset == Charset::AsciiStrict, b'r')] {
			if yes { b[n] = ch; n += 1; }
		}
		b[n] = b')';
		self.emit(&b[..=n], at, at);
	}

	fn literal(&mut self, cp: u32, start: usize, end: usize, in_class: bool) {
		self.facts.wide |= cp > 255;
		let Some(mode) = self.mode else { return; };
		// PCRE2 has no surrogates or code points above Unicode; such
		// characters in a UTF-8 subject are matched as U+FFFF (`Sanitized`).
		let cp = if mode.utf && (cp > 0x10FFFF || (0xD800..=0xDFFF).contains(&cp)) { 0xFFFF } else { cp };
		let exact = !in_class && self.flags.i && mode.ucp && !mode.unicode(self.flags.charset) && (128..=255).contains(&cp);
		self.out.note(start);
		if exact { self.out.bytes.extend_from_slice(b"(?-i:"); }
		let _ = write!(self.out.bytes, "\\x{{{cp:X}}}");
		if exact { self.out.bytes.push(b')'); }
		self.out.note(end);
	}

	fn folds(&self) -> bool {
		self.flags.i && self.mode.is_some_and(|m| m.unicode(self.flags.charset))
	}

	fn queue_literal(&mut self, cp: u32, start: usize, end: usize, raw: bool) {
		let literal = Literal { cp, start, end, raw };
		if self.folds() { self.pending.push(literal); }
		else { self.emit_literal(literal); }
	}

	fn emit_literal(&mut self, literal: Literal) {
		if literal.raw { self.raw(literal.start, literal.end); }
		else { self.literal(literal.cp, literal.start, literal.end, false); }
	}

	fn flush(&mut self, binds_last: bool) -> Result<(), String> {
		if self.pending.is_empty() { return Ok(()); }
		let mut pending = std::mem::take(&mut self.pending);
		let tail = if binds_last { pending.pop() } else { None };
		self.fold_literals(&pending)?;
		if let Some(tail) = tail { self.fold_literals(&[tail])?; }
		pending.clear();
		self.pending = pending;
		Ok(())
	}

	fn fold_literals(&mut self, literals: &[Literal]) -> Result<(), String> {
		let Some(mode) = self.mode else { return Ok(()); };
		let strict = self.flags.charset == Charset::AsciiStrict;
		match literals {
			[] => return Ok(()),
			[one] if full_fold(one.cp, strict)[1] == 0 => {
				self.emit_literal(*one);
				return Ok(());
			}
			_ => {}
		}
		let mut units = std::mem::take(&mut self.fold_units);
		units.clear();
		units.reserve(literals.len());
		for &literal in literals {
			let fold = full_fold(literal.cp, strict);
			if fold[1] == 0 {
				units.push(FoldUnit { normalized: fold[0], literal });
			} else {
				for cp in fold.into_iter().take_while(|&cp| cp != 0) {
					let unit = Literal { cp, raw: false, ..literal };
					units.push(FoldUnit { normalized: cp, literal: unit });
				}
			}
		}

		let mut edges = std::mem::take(&mut self.fold_edges);
		edges.clear();
		for (start, unit) in units.iter().enumerate() {
			let lead = unit.normalized;
			let mut add = |cp, fold: [u32; 3]| {
				if !mode.utf && cp > 255 { return; }
				let length = if fold[2] == 0 { 2 } else { 3 };
				if units.get(start..start + length).is_some_and(|u| {
					u.iter().map(|p| p.normalized).eq(fold[..length].iter().copied())
				}) {
					edges.push(FoldEdge { start, end: start + length, cp });
				}
			};
			if strict && lead == 0x17F {
				add(0xDF, [0x17F, 0x17F, 0]);
			}
			let offset = FULL_FOLD_REVERSE.partition_point(|&i| FULL_FOLD[i].1[0] < lead);
			for &i in &FULL_FOLD_REVERSE[offset..] {
				let (cp, fold) = FULL_FOLD[i];
				if fold[0] != lead { break; }
				if strict && fold.into_iter().any(|c| c != 0 && c < 128) { continue; }
				add(cp, fold);
			}
		}

		let mut from = 0;
		let mut i = 0;
		while let Some(edge) = edges.get(i) {
			for unit in &units[from..edge.start] { self.emit_literal(unit.literal); }
			let start_edge = i;
			let start = edge.start;
			let mut end = edge.end;
			while let Some(edge) = edges.get(i).filter(|edge| edge.start < end) {
				end = end.max(edge.end);
				i += 1;
			}
			let max_cp = if mode.utf { u32::MAX } else { 255 };
			let (mark, knots) = (self.out.bytes.len(), self.out.knots.len());
			let limit = mark.saturating_add(1 << 16);
			if self.fold_component(&units, &edges[start_edge..i], start, end, max_cp, limit).is_err() {
				// A very long run of overlapping multi-character folds would
				// not fit PCRE2's size limit: match its characters singly.
				self.out.bytes.truncate(mark);
				self.out.knots.truncate(knots);
				for unit in &units[start..end] {
					if unit.literal.cp > max_cp { self.emit(b"(?!)", unit.literal.start, unit.literal.end); }
					else { self.emit_literal(unit.literal); }
				}
			}
			from = end;
		}
		for unit in &units[from..] { self.emit_literal(unit.literal); }
		self.fold_units = units;
		self.fold_edges = edges;
		Ok(())
	}

	// Split at a middle code point and visit exactly one transition through
	// (or over) the split. This covers overlapping folds without explicitly
	// enumerating every tiling of a run such as /ssssssss/i.
	fn fold_component(&mut self, units: &[FoldUnit], edges: &[FoldEdge], lo: usize, hi: usize,
		max_cp: u32, limit: usize) -> Result<(), String> {
		if lo == hi { return Ok(()); }
		let edges = &edges[edges.partition_point(|edge| edge.start < lo)..edges.partition_point(|edge| edge.start < hi)];
		let left = units[lo].literal.start;
		let right = units[hi - 1].literal.end;
		if self.out.bytes.len() > limit { return Err(self.err("Regular expression too large", right)); }
		if !edges.iter().any(|edge| edge.end <= hi) {
			for unit in &units[lo..hi] {
				if unit.literal.cp > max_cp {
					self.emit(b"(?!)", unit.literal.start, unit.literal.end);
				} else { self.emit_literal(unit.literal); }
			}
			return Ok(());
		}
		let mid = lo + (hi - lo) / 2;
		let crossing = &edges[edges.partition_point(|edge| edge.start < mid.saturating_sub(2))..
			edges.partition_point(|edge| edge.start < mid)];
		let wraps = crossing.iter().any(|edge| edge.end > mid && edge.end <= hi);
		if wraps { self.emit(b"(?:", left, left); }
		self.fold_component(units, edges, lo, mid, max_cp, limit)?;
		self.fold_component(units, edges, mid, hi, max_cp, limit)?;
		if wraps {
			// Candidates with the same endpoints share their character
			// class and continuations.
			for start in lo.max(mid.saturating_sub(2))..mid {
				for end in mid + 1..=hi.min(start + 3) {
					let mut alternatives = crossing.iter().filter(|e| e.start == start && e.end == end).peekable();
					if alternatives.peek().is_none() { continue; }
					let a = units[start].literal.start;
					let b = units[end - 1].literal.end;
					self.emit(b"|", a, a);
					self.fold_component(units, edges, lo, start, max_cp, limit)?;
					self.emit(b"[", a, a);
					for edge in alternatives { self.literal(edge.cp, a, b, true); }
					self.emit(b"]", b, b);
					self.fold_component(units, edges, end, hi, max_cp, limit)?;
				}
			}
			self.emit(b")", right, right);
		}
		Ok(())
	}

	/// Emit a cancellation checkpoint: a callout that aborts the match once
	/// the host cancels the invocation (`CANCEL_CALLOUT`).
	fn checkpoint(&mut self) {
		if self.mode.is_none() || !self.checkpoints { return; }
		self.emit(b"(?C12)", self.pos, self.pos);
		self.out.cancellable = true;
		self.loops = 0;
	}

	/// A recursion or subroutine call: checkpoint every entry.
	fn recursion(&mut self) {
		self.facts.loops = true;
		self.checkpoint();
	}

	/// After a quantifier emitted at output offset `quantifier`, keep the
	/// work between cancellation checkpoints linear in the subject: a
	/// quantified group gets a checkpoint inside, run every iteration
	/// (`(?:(...)(?C12))*`), and a stretch never holds two quantifiers
	/// without one, so backtracking into the first reaches a checkpoint.
	fn guard_loop(&mut self, quantifier: usize) {
		self.facts.loops = true;
		if self.mode.is_none() || !self.checkpoints { return; }
		// A quantifier that follows directly is a syntax error PCRE2 reports.
		if matches!(self.at(self.pos), b'*' | b'+' | b'?' | b'{') { return; }
		if let Some((start, end)) = self.closed_group.take() && end == quantifier {
			self.insert_output(end, b"(?C12))");
			self.insert_output(start, b"(?:");
			self.out.cancellable = true;
		}
		self.loops += 1;
		if self.loops >= 2 { self.checkpoint(); }
	}

	/// Insert text into the translation at output offset `at`, keeping the
	/// offset map (inserted text maps to the input at `at`).
	fn insert_output(&mut self, at: usize, text: &[u8]) {
		let input = self.out.original(at);
		self.out.bytes.splice(at..at, text.iter().copied());
		let i = self.out.knots.partition_point(|&(output, _)| output < at);
		for knot in self.out.knots.iter_mut().skip(i) { knot.0 += text.len(); }
		self.out.knots.insert(i, (at, input));
	}

	fn open(&mut self, at: usize, branch_reset: bool) {
		let branch = branch_reset.then_some((self.groups, self.groups));
		self.frames.push(Frame { opening: at, out_start: self.out.bytes.len(), flags: self.flags, branch, prefix_consumes: self.prefix_consumes, alternate_consumes: false, conditional_branches: 0 });
	}

	fn run(&mut self) -> Result<(), String> {
		while self.pos < self.bytes.len() {
			let at = self.pos;
			self.pos += 1;
			let c = self.at(at);
			match c {
				b'\\' => {
					let item = self.escape(at, false)?;
					let c = self.at(at + 1);
					if !matches!(c, b'A' | b'Z' | b'z' | b'G' | b'K' | b'b' | b'B') {
						self.prefix_consumes = true;
					}
					self.prefix_unbounded |= matches!(c, b'X' | b'g' | b'k' | b'1'..=b'9');
					if let Atom::Literal(cp) = item { self.queue_literal(cp, at, self.pos, false); }
					else { self.flush(false)?; self.emit_atom(item, at, self.pos, false); }
				}
				b'[' => { self.prefix_consumes = true; self.class(at)?; }
				b'(' if self.matches(at, b"(?#") => self.group(at)?,
				b'(' => { self.flush(false)?; self.group(at)?; }
				b')' => {
					self.flush(false)?;
					let Some(frame) = self.frames.pop() else { return Err(self.err("Unmatched )", self.pos)); };
					self.flags = frame.flags;
					if let Some((_, max)) = frame.branch { self.groups = max.max(self.groups); }
					if self.matches(frame.opening, b"(?=") || self.matches(frame.opening, b"(?!")
						|| self.matches(frame.opening, b"(?<=") || self.matches(frame.opening, b"(?<!")
					{
						self.prefix_consumes = frame.prefix_consumes;
					} else {
						self.prefix_consumes |= frame.alternate_consumes;
					}
					self.raw(at, self.pos);
					self.closed_group = Some((frame.out_start, self.out.bytes.len()));
				}
				b'|' => {
					self.flush(false)?;
					if let Some(frame) = self.frames.last_mut() {
						if frame.conditional_branches == 2 {
							return Err(self.err("Switch (?(condition)... contains too many branches", self.pos));
						}
						if frame.conditional_branches != 0 { frame.conditional_branches += 1; }
						frame.alternate_consumes |= self.prefix_consumes;
						self.prefix_consumes = frame.prefix_consumes;
						if let Some((base, max)) = frame.branch.as_mut() {
							*max = self.groups.max(*max);
							self.groups = *base;
						}
					} else {
						self.prefix_consumes = false;
						self.facts.top_alternation = true;
					}
					self.raw(at, self.pos);
				}
				b'#' if self.flags.x => {
					let newline = self.find(self.pos, b'\n');
					self.pos = newline.map_or(self.bytes.len(), |n| n + 1);
					self.facts.trailing_comment = newline.is_none();
				}
				c if self.flags.x && (c.is_ascii_whitespace() || c == b'\x0B') => {},
				b'*' | b'+' | b'?' => {
					self.prefix_unbounded |= c != b'?';
					self.flush(true)?;
					let quantifier = self.out.bytes.len();
					// A lazy or possessive suffix belongs to the quantifier.
					if matches!(self.at(self.pos), b'?' | b'+') { self.pos += 1; }
					self.raw(at, self.pos);
					self.guard_loop(quantifier);
				}
				b'^' | b'$' | b'.' => {
					self.prefix_consumes |= c == b'.';
					self.flush(false)?;
					self.raw(at, self.pos);
				}
				b'{' => {
					self.prefix_unbounded = true;
					self.prefix_consumes = true;
					self.quantifier(at)?;
				}
				_ => {
					if c >= 128 {
						let (cp, end) = self.cp(at);
						self.pos = end;
						if self.flags.x && matches!(cp, 0x85 | 0x200E | 0x200F | 0x2028 | 0x2029) {
							continue;
						}
						self.queue_literal(cp, at, end, false);
					} else { self.queue_literal(u32::from(c), at, self.pos, true); }
					self.prefix_consumes = true;
				}
			}
		}
		if let Some(frame) = self.frames.last() {
			let opening = frame.opening;
			let (message, at) = if frame.conditional_branches != 0 {
				("Switch (?(condition)... not terminated", self.bytes.len())
			} else if self.at(opening + 1) == b'*' && !self.at(opening + 2).is_ascii_uppercase() {
				("Unterminated '(*...' argument", self.bytes.len())
			} else if [&b"(?<="[..], b"(?<!"].iter().any(|opener| self.tail(opening) == *opener) {
				("Sequence (?... not terminated", self.bytes.len())
			} else { ("Unmatched (", opening + 1) };
			return Err(self.err(message, at));
		}
		self.flush(false)
	}

	fn group(&mut self, at: usize) -> Result<(), String> {
		while self.actions.get(self.action_index).is_some_and(|a| a.at < at) { self.action_index += 1; }
		if let Some(action) = self.actions.get(self.action_index).filter(|a| a.at == at) {
			let index = self.action_index;
			self.action_index += 1;
			// Skip the original Perl text; only trusted AST actions have offsets.
			self.pos = at + action.len;
			if action.dynamic {
				self.prefix_consumes = true;
				self.prefix_unbounded = true;
				if self.mode.is_some() {
					self.emit(format!("(?:(?C'b{index}')(?:(?s:.*?)(?C'e{index}')|(?s:.*?)(?C'f{index}'))|(?C'r{index}')(?!))").as_bytes(), at, self.pos);
				}
			} else if self.mode.is_some() {
				self.emit(format!("(?:(?C'a{index}')|(?C'r{index}')(?!))").as_bytes(), at, self.pos);
			}
			return Ok(());
		}
		if self.at(at + 1) == b'*' { return self.verb(at); }
		if self.at(at + 1) != b'?' {
			if !self.flags.i && !self.flags.x && self.tail(at).len() >= 16 * 1024 && self.literal_alternation(at) {
				return Ok(());
			}
			self.open(at, false);
			self.groups += usize::from(!self.flags.n);
			self.raw(at, self.pos);
			return Ok(());
		}
		let begin = at + 2;
		if begin >= self.bytes.len() { return Err(self.err("Sequence (? incomplete", begin)); }
		if self.matches(begin, b"{") || self.matches(begin, b"?{") {
			return Err(diagnostic(self.source, "Eval-group not allowed at runtime, use re 'eval'", None));
		}
		match self.at(begin) {
			b'#' => {
				self.pos = self.find(begin + 1, b')').ok_or_else(|| self.err("Sequence (?#... not terminated", self.bytes.len()))? + 1;
				return Ok(());
			}
			b'[' => { self.prefix_consumes = true; return self.extended_class(at); }
			b'C' => return Err(self.err("Sequence (?C...) not recognized", begin + 1)),
			b'@' => return Err(self.err("Sequence (?@...) not implemented", begin + 1)),
			b'<' if !matches!(self.at(begin + 1), b'=' | b'!') => return self.named_capture(at, begin + 1, b'>'),
			b'\'' => return self.named_capture(at, begin + 1, b'\''),
			b'P' if self.at(begin + 1) == b'<' => return self.named_capture(at, begin + 2, b'>'),
			b'P' if self.at(begin + 1) == b'=' => {
				self.prefix_consumes = true;
				self.prefix_unbounded = true;
				return self.named_ref(at, begin + 2, b')', RefKind::Backref);
			}
			b'P' if self.at(begin + 1) == b'>' => {
				self.prefix_consumes = true;
				self.prefix_unbounded = true;
				return self.named_ref(at, begin + 2, b')', RefKind::Recurse);
			}
			b'P' => {
				let (ch, end) = if begin + 1 < self.bytes.len() { self.cp(begin + 1) } else { (0, begin + 1) };
				let shown = char::from_u32(ch).filter(|_| ch != 0).map(String::from).unwrap_or_default();
				return Err(self.err(&format!("Sequence (?P{shown}...) not recognized"), end));
			}
			b'&' => {
				self.prefix_consumes = true;
				self.prefix_unbounded = true;
				return self.named_ref(at, begin + 1, b')', RefKind::Recurse);
			}
			b'(' => return self.condition(at, begin + 1),
			b'|' | b'=' | b'!' | b'>' => {
				self.open(at, self.at(begin) == b'|');
				self.pos = begin + 1;
			}
			b'<' => {
				self.open(at, false);
				self.pos = begin + 2;
			}
			b'R' | b'0'..=b'9' | b'+' if self.find(begin, b')').is_some() => {
				self.prefix_consumes = true;
				self.prefix_unbounded = true;
				self.recursion();
				self.pos = self.find(begin, b')').unwrap_or(begin) + 1;
			}
			b'-' if self.at(begin + 1).is_ascii_digit() => {
				self.prefix_consumes = true;
				self.prefix_unbounded = true;
				self.recursion();
				self.pos = self.find(begin, b')').ok_or_else(|| self.err("Unterminated subpattern", begin + 1))? + 1;
			}
			_ => return self.inline_flags(at, begin),
		}
		self.raw(at, self.pos);
		Ok(())
	}

	// PCRE2's compiled jump offsets have a build-time size limit. A large
	// alternation of single characters is equivalent to a character class
	// if those characters can't start any of its multi-character branches.
	fn literal_alternation(&mut self, at: usize) -> bool {
		let mut single = Vec::new();
		let mut words = Vec::new();
		let mut pos = at + 1;
		loop {
			let begin = pos;
			let mut count = 0;
			let mut first = 0;
			while !matches!(self.at(pos), b'|' | b')') {
				let b = self.at(pos);
				if b == 0 || b"\\.[{(*+?$^".contains(&b) { return false; }
				let (cp, end) = self.cp(pos);
				if count == 0 { first = cp; }
				count += 1;
				pos = end;
			}
			match count {
				0 => return false,
				1 => single.push(first),
				_ => words.push((first, begin, pos)),
			}
			if self.at(pos) == b')' { break; }
			pos += 1;
		}
		if single.len() < 32 { return false; }
		single.sort_unstable();
		single.dedup();
		if words.iter().any(|(first, _, _)| single.binary_search(first).is_ok()) { return false; }
		self.groups += usize::from(!self.flags.n);
		self.prefix_consumes = true;
		self.pos = pos + 1;
		if self.mode.is_none() { return true; }
		self.raw(at, at + 1);
		for (_, start, end) in words {
			self.raw(start, end);
			self.emit(b"|", end, end);
		}
		self.emit(b"[", at + 1, at + 1);
		let mut ranges = single.into_iter().peekable();
		while let Some(start) = ranges.next() {
			let mut end = start;
			while ranges.next_if_eq(&end.saturating_add(1)).is_some() { end += 1; }
			if start == end {
				let _ = write!(self.out.bytes, "\\x{{{start:X}}}");
			} else {
				let _ = write!(self.out.bytes, "\\x{{{start:X}}}-\\x{{{end:X}}}");
			}
		}
		self.emit(b"])", pos, self.pos);
		true
	}

	fn inline_flags(&mut self, at: usize, mut p: usize) -> Result<(), String> {
		let reset = self.at(p) == b'^';
		if reset { p += 1; }
		let mut f = if reset { RxFlags::default() } else { self.flags };
		let mut negate = false;
		let mut x_count = 0;
		let mut charset = None;
		let mut warned_c = false;
		let mut warned_g = false;
		let mut warned_o = false;
		loop {
			let b = self.at(p);
			match b {
				b':' | b')' => break,
				b'-' if !negate && !reset => negate = true,
				b'i' => f.i = !negate,
				b'm' => f.m = !negate,
				b's' => f.s = !negate,
				b'n' => f.n = !negate,
				b'p' => f.p |= !negate,
				b'x' => { x_count += 1; f.x = !negate; f.xx = !negate && x_count >= 2; }
				b'a' | b'd' | b'u' | b'l' if !(reset && b == b'd') => {
					if let Some(old) = charset {
						if old != b { return Err(self.err(&format!("Regexp modifiers \"{}\" and \"{}\" are mutually exclusive", char::from(old), char::from(b)), p + 1)); }
					}
					if negate { return Err(self.err(&format!("Regexp modifier \"{}\" may not appear after the \"-\"", char::from(b)), p + 1)); }
					f.charset = if charset == Some(b'a') && b == b'a' && f.charset == Charset::Ascii {
						Charset::AsciiStrict
					} else if charset.is_some() {
						return Err(self.err(&format!("Regexp modifier \"{}\" may {}",
							char::from(b), if b == b'a' { "appear a maximum of twice" } else { "not appear twice" }), p + 1));
					} else { charset_of(b) };
					charset = Some(b);
					self.facts.locale |= b == b'l';
					self.facts.explicit_unicode |= matches!(b, b'u' | b'a');
				}
				b'c' | b'g' | b'o' => {
					// After (?c), perl no longer reports (?g).
					let skip = match b { b'c' => warned_c, b'g' => warned_g || warned_c, _ => warned_o };
					let modifier = match b { b'c' => { warned_c = true; "gc" } b'g' => { warned_g = true; "g" } _ => { warned_o = true; "o" } };
					if !skip {
						let msg = if negate {
							format!("Useless (?-{}) - don't use /{modifier} modifier", char::from(b))
						} else { format!("Useless (?{}) - use /{modifier} modifier", char::from(b)) };
						self.warn("regexp", &msg, p + 1);
					}
				}
				_ => {
					// The whole (possibly multi-byte) offending character.
					let end = if self.source.utf8 { self.cp(p).1 } else { p + 1 }.min(self.bytes.len());
					let flags = PStr::new(self.bytes.get(at..end).unwrap_or_default().to_vec(), self.source.utf8).to_string_lossy().into_owned();
					return Err(self.err(&format!("Sequence {flags}...) not recognized"), end));
				}
			}
			p += 1;
		}
		self.pos = p + 1;
		self.facts.keep |= f.p;
		if self.at(p) == b':' {
			self.open(at, false);
			self.emit(b"(?:", at, self.pos);
		}
		self.flags = f;
		self.options(f, self.pos);
		Ok(())
	}

	fn group_name(&self, start: usize, end: usize) -> Result<String, String> {
		let raw = self.bytes.get(start..end).unwrap_or_default();
		let s = PStr::new(raw.to_vec(), self.source.utf8).to_string_lossy().into_owned();
		let mut chars = s.chars();
		if !chars.next().is_some_and(|c| c == '_' || c.is_alphabetic()) || chars.any(|c| c.is_whitespace() || c.is_ascii() && !c.is_ascii_alphanumeric() && c != '_') {
			return Err(self.err("Group name must start with a non-digit word character", start));
		}
		Ok(s)
	}

	/// perl's "Sequence OPENER... not terminated" for a name opened at `at..start`.
	fn not_terminated(&self, at: usize, start: usize) -> String {
		let opener = String::from_utf8_lossy(self.bytes.get(at..start).unwrap_or_default()).into_owned();
		let opener = match opener.as_str() {
			"(?P=" => "?P=".to_owned(),
			"(?P>" if start < self.bytes.len() => "(?&".to_owned(),
			_ => opener,
		};
		self.err(&format!("Sequence {opener}... not terminated"), self.bytes.len())
	}

	fn named_capture(&mut self, at: usize, start: usize, delim: u8) -> Result<(), String> {
		if start >= self.bytes.len() { return Err(self.not_terminated(at, start)); }
		let first = self.at(start);
		if !(first == b'_' || first.is_ascii_alphabetic() || first >= 0x80) {
			return Err(self.err("Group name must start with a non-digit word character", (start + 1).min(self.bytes.len())));
		}
		let end = self.find(start, delim).ok_or_else(|| self.not_terminated(at, start))?;
		let name = self.group_name(start, end)?;
		self.pos = end + 1;
		self.open(at, false);
		self.groups += 1;
		if self.mode.is_none() {
			if let Some((_, groups)) = self.facts.names.iter_mut().find(|(key, _)| key.as_ref() == name) {
				if !groups.contains(&self.groups) { groups.push(self.groups); }
			} else { self.facts.names.push((Rc::from(name), vec![self.groups])); }
		} else {
			self.emit(format!("(?<p{}>", self.groups).as_bytes(), at, self.pos);
		}
		Ok(())
	}

	fn known_groups(&self, name: &str, end: usize) -> Result<&'a [usize], String> {
		self.known.and_then(|facts| facts.names.iter().find(|(key, _)| key.as_ref() == name))
			.map(|(_, groups)| groups.as_slice()).ok_or_else(|| self.err("Reference to nonexistent named group", end))
	}

	fn named_ref(&mut self, at: usize, start: usize, delim: u8, kind: RefKind) -> Result<(), String> {
		let close = self.find(start, delim).ok_or_else(|| self.not_terminated(at, start))?;
		// Braced forms allow blanks around the name: \k{ name }, \g{ name }.
		let (mut start, mut end) = (start, close);
		if delim == b'}' {
			while start < end && matches!(self.at(start), b' ' | b'\t') { start += 1; }
			while end > start && matches!(self.at(end - 1), b' ' | b'\t') { end -= 1; }
		}
		let name = self.group_name(start, end)?;
		self.pos = close + 1;
		if self.mode.is_none() {
			self.facts.loops |= matches!(kind, RefKind::Recurse);
			return Ok(());
		}
		let groups = self.known_groups(&name, end)?;
		match kind {
			RefKind::Backref if groups.len() > 1 => {
				self.emit(b"(?:", at, start);
				for n in groups { self.emit(format!("(?({n})\\g{{{n}}}|").as_bytes(), start, end); }
				self.emit(b"(?!)", end, end);
				for _ in groups { self.emit(b")", end, end); }
				self.emit(b")", end, self.pos);
			}
			RefKind::Backref => self.emit(format!("\\g{{{}}}", groups[0]).as_bytes(), at, self.pos),
			RefKind::Recurse => {
				self.recursion();
				self.emit(format!("(?{})", groups[0]).as_bytes(), at, self.pos);
			}
		}
		Ok(())
	}

	fn condition(&mut self, at: usize, start: usize) -> Result<(), String> {
		self.open(at, false);
		if let Some(frame) = self.frames.last_mut() { frame.conditional_branches = 1; }
		while self.actions.get(self.action_index).is_some_and(|action| action.at < start - 1) { self.action_index += 1; }
		if let Some(action) = self.actions.get(self.action_index).filter(|action| action.at == start - 1 && !action.dynamic) {
			let index = self.action_index;
			self.action_index += 1;
			self.pos = start - 1 + action.len;
			if self.mode.is_some() {
				self.emit(format!("(?(?=(?C't{index}'))").as_bytes(), at, self.pos);
			}
			return Ok(());
		}
		if self.at(start) == b'?' {
			if ![&b"?="[..], b"?!", b"?<=", b"?<!", b"?{"].iter().any(|prefix| self.matches(start, prefix)) {
				return Err(self.err("Unknown switch condition (?(...))", start + 1));
			}
			self.pos = start - 1;
			self.raw(at, self.pos);
			return Ok(());
		}
		if self.at(start) == b'*' {
			let name_end = self.tail(start + 1).iter().position(|&b| b == b':').map_or(start + 1, |n| start + 1 + n);
			let verb = self.bytes.get(start + 1..name_end).unwrap_or_default();
			if !matches!(verb, b"pla" | b"positive_lookahead" | b"nla" | b"negative_lookahead"
				| b"plb" | b"positive_lookbehind" | b"nlb" | b"negative_lookbehind")
			{
				return Err(self.err("Unknown switch condition (?(...))", start + 1));
			}
			self.pos = start - 1;
			self.raw(at, self.pos);
			return Ok(());
		}
		let Some(end) = self.find(start, b')') else {
			let first = self.at(start);
			return Err(if start >= self.bytes.len() { self.err("Unknown switch condition (?(...))", start) }
				else if matches!(first, b'<' | b'\'') { self.not_terminated(at, start + 1) }
				else if first.is_ascii_alphanumeric() { self.err("Switch condition not recognized", self.bytes.len()) }
				else { self.err("Switch condition not terminated", self.bytes.len()) });
		};
		self.pos = end + 1;
		let raw = self.bytes.get(start..end).unwrap_or_default();
		let number = std::str::from_utf8(raw).ok().and_then(|s| s.parse::<usize>().ok());
		if let Some(known) = self.known && number.is_some_and(|n| n > known.group_count) {
			// Perl treats a test of a group that doesn't exist as simply false.
			self.emit(b"(?(?!)", at, self.pos);
			return Ok(());
		}
		if raw.iter().all(u8::is_ascii_digit) || raw == b"R" || raw == b"DEFINE"
			|| raw.strip_prefix(b"R").is_some_and(|n| !n.is_empty() && n.iter().all(u8::is_ascii_digit)) {
			self.raw(at, self.pos);
			return Ok(());
		}
		let (a, b, recursive) = match raw {
			[b'<', .., b'>'] | [b'\'', .., b'\''] => (start + 1, end - 1, false),
			[b'R', b'&', ..] => (start + 2, end, true),
			[b'0'..=b'9', ..] => {
				let token_end = raw.iter().position(|b| !b.is_ascii_alphanumeric()).unwrap_or(raw.len());
				return Err(self.err("Switch condition not recognized", start + token_end));
			}
			_ => return Err(self.err("Unknown switch condition (?(...))", end)),
		};
		if self.mode.is_none() { return Ok(()); }
		let name = self.group_name(a, b)?;
		let groups = self.known_groups(&name, b)?;
		let prefix = if recursive { "R" } else { "" };
		if groups.len() == 1 || recursive {
			self.emit(format!("(?({prefix}{})", groups[0]).as_bytes(), at, self.pos);
		} else {
			self.emit(b"(?(?=(?:", at, start);
			for (i, n) in groups.iter().enumerate() {
				if i != 0 { self.emit(b"|", start, end); }
				self.emit(format!("(?({n})|(?!))").as_bytes(), start, end);
			}
			self.emit(b"))", end, self.pos);
		}
		Ok(())
	}

	fn verb(&mut self, at: usize) -> Result<(), String> {
		let start = at + 2;
		// Uppercase names are backtracking verbs, lowercase ones alpha assertions.
		let uppercase = self.at(start).is_ascii_uppercase();
		let end = self.tail(start).iter().position(|&b| matches!(b, b':' | b')')).map(|n| start + n).ok_or_else(|| {
			self.err(if uppercase { "Unterminated verb pattern" } else { "Unterminated '(*...' construct" }, self.bytes.len())
		})?;
		let verb = self.bytes.get(start..end).unwrap_or_default();
		let assertion = matches!(verb, b"pla" | b"positive_lookahead" | b"nla" | b"negative_lookahead" | b"plb" | b"positive_lookbehind" | b"nlb" | b"negative_lookbehind" | b"atomic" | b"sr" | b"script_run" | b"asr" | b"atomic_script_run");
		if assertion && self.at(end) == b')' {
			let shown = String::from_utf8_lossy(verb);
			return Err(self.err(&format!("'(*{shown}' requires a terminating ':'"), end));
		}
		if assertion && self.at(end) == b':' {
			if matches!(verb, b"sr" | b"script_run" | b"asr" | b"atomic_script_run") { self.facts.unicode = true; }
			self.pos = end + 1;
			self.open(at, false);
			// Spell lookarounds classically so they also work as conditions.
			let classic: &[u8] = match verb {
				b"pla" | b"positive_lookahead" => b"(?=",
				b"nla" | b"negative_lookahead" => b"(?!",
				b"plb" | b"positive_lookbehind" => b"(?<=",
				b"nlb" | b"negative_lookbehind" => b"(?<!",
				b"atomic" => b"(?>",
				_ => b"",
			};
			if classic.is_empty() { self.raw(at, self.pos); } else { self.emit(classic, at, self.pos); }
			return Ok(());
		}
		let close = self.find(end, b')').ok_or_else(|| {
			self.err(if uppercase { "Unterminated verb pattern argument" } else { "Unterminated '(*...' argument" }, self.bytes.len())
		})?;
		self.pos = close + 1;
		match verb {
			b"" if end == close => return Err(self.err("Unknown verb pattern ''", self.pos)),
			_ if !uppercase && !verb.is_empty() => {
				let shown = PStr::new(verb.to_vec(), self.source.utf8).to_string_lossy().into_owned();
				return Err(self.err(&format!("Unknown '(*...)' construct '{shown}'"), self.pos));
			}
			b"" | b"MARK" if end + 1 >= close => return Err(self.err("Verb pattern 'MARK' has a mandatory argument", end + 1)),
			b"" | b"MARK" | b"ACCEPT" | b"FAIL" | b"F" | b"COMMIT" | b"PRUNE" | b"SKIP" | b"THEN" => {},
			_ => {
				let shown = PStr::new(verb.to_vec(), self.source.utf8).to_string_lossy().into_owned();
				return Err(self.err(&format!("Unknown verb pattern '{shown}'"), self.pos));
			}
		}
		self.facts.may_mark |= end < close;
		// Some PCRE2 releases reject arguments on these verbs. MARK
		// provides Perl's successful-path mark without changing control flow.
		if end < close && matches!(verb, b"ACCEPT" | b"COMMIT" | b"FAIL" | b"F") {
			if end + 1 < close {
				self.emit(b"(*MARK:", at, end + 1);
				self.raw(end + 1, self.pos);
			}
			self.raw(at, end);
			self.emit(b")", close, self.pos);
		} else { self.raw(at, self.pos); }
		Ok(())
	}

	fn quantifier(&mut self, at: usize) -> Result<(), String> {
		let mut p = at + 1;
		let min = self.rep_number(&mut p);
		let comma = self.at(p) == b',';
		let max = if comma { p += 1; self.rep_number(&mut p) } else { min };
		if self.at(p) != b'}' || (min.is_none() && max.is_none()) {
			self.queue_literal(u32::from(b'{'), at, self.pos, false);
			return Ok(());
		}
		self.flush(true)?;
		self.pos = p + 1;
		let lowest = min.unwrap_or(b"0");
		for digits in min.into_iter().chain(max) {
			// Both number slices borrow the pattern; subtracting their offsets
			// gives the marker position at the end of each bound.
			let end = (digits.as_ptr() as usize).saturating_sub(self.bytes.as_ptr() as usize) + digits.len();
			if digits.len() > 1 && digits.starts_with(b"0") { return Err(self.err("Invalid quantifier in {,}", end)); }
			if (digits.len(), digits) > (5, b"65534".as_slice()) {
				return Err(self.err("Quantifier in {,} bigger than 65534", end));
			}
		}
		if max.is_some_and(|max| (max.len(), max) < (lowest.len(), lowest)) {
			self.warn("regexp", "Quantifier {n,m} with n > m can't match", self.pos);
			if matches!(self.at(self.pos), b'?' | b'+') { self.pos += 1; }
			self.emit(b"{0}(?!)", at, self.pos);
			return Ok(());
		}
		if comma && max == min && self.at(self.pos) == b'?' {
			self.warn("regexp", "Useless use of greediness modifier '?'", self.pos + 1);
		}
		let quantifier = self.out.bytes.len();
		self.emit(b"{", at, at + 1);
		self.emit(lowest, at + 1, p);
		if comma {
			self.emit(b",", p, p);
			if let Some(max) = max { self.emit(max, p, p); }
		}
		self.emit(b"}", p, self.pos);
		// A lazy or possessive suffix belongs to the quantifier.
		if matches!(self.at(self.pos), b'?' | b'+') {
			self.pos += 1;
			self.raw(self.pos - 1, self.pos);
		}
		self.guard_loop(quantifier);
		Ok(())
	}

	fn rep_number(&self, p: &mut usize) -> Option<&'a [u8]> {
		while matches!(self.at(*p), b' ' | b'\t') { *p += 1; }
		let start = *p;
		while self.at(*p).is_ascii_digit() { *p += 1; }
		let digits = self.bytes.get(start..*p).filter(|s| !s.is_empty());
		while matches!(self.at(*p), b' ' | b'\t') { *p += 1; }
		digits
	}

	fn escape(&mut self, at: usize, in_class: bool) -> Result<Atom<'a>, String> {
		let c = self.at(at + 1);
		self.pos = at + 2;
		Ok(match c {
			b'\0' if self.pos > self.bytes.len() => return Err(diagnostic(self.source, "Trailing \\", None)),
			b'a' => Atom::Literal(7), b'e' => Atom::Literal(27), b'f' => Atom::Literal(12),
			b'n' => Atom::Literal(10), b'r' => Atom::Literal(13), b't' => Atom::Literal(9),
			b'b' if in_class => Atom::Literal(8),
			b'c' => {
				let control = self.at(self.pos);
				if self.pos >= self.bytes.len() { return Err(self.err("Missing control char name in \\c", self.pos)); }
				self.pos += 1;
				if control == b'{' { return Err(self.err("Use \";\" instead of \"\\c{\"", self.pos)); }
				if !control.is_ascii() { return Err(self.err("Character following \\c must be ASCII", self.pos)); }
				let result = control.to_ascii_uppercase() ^ 64;
				if (0x20..0x7F).contains(&result) {
					let shown = if result.is_ascii_alphanumeric() || result == b'_' { String::from(char::from(result)) }
						else { format!("\\{}", char::from(result)) };
					self.warn("syntax", &format!("\"\\c{}\" is more clearly written simply as \"{shown}\"", char::from(control)), self.pos);
				}
				Atom::Literal(u32::from(result))
			}
			b'x' | b'o' => {
				let radix = if c == b'x' { 16 } else { 8 };
				let mut value = 0u32;
				if self.at(self.pos) == b'{' {
					let start = self.pos + 1;
					let Some(end) = self.find(start, b'}') else {
						// Marked after the blanks and digits that were read.
						let mut mark = start;
						while matches!(self.at(mark), b' ' | b'\t') { mark += 1; }
						while char::from(self.at(mark)).is_digit(radix) && mark < self.bytes.len() { mark += 1; }
						return Err(self.err(&format!("Missing right brace on \\{}{{}}", char::from(c)), mark));
					};
					self.pos = end + 1;
					let digits = self.bytes.get(start..end).unwrap_or_default();
					if c == b'o' && digits.is_empty() { return Err(self.err("Empty \\o{}", self.pos)); }
					value = self.number(digits, radix, self.pos)?;
				} else if c == b'o' {
					return Err(self.err("Missing braces on \\o{}", self.pos));
				} else {
					for _ in 0..2 {
						let Some(n) = char::from(self.at(self.pos)).to_digit(16) else { break; };
						value = value * 16 + n;
						self.pos += 1;
					}
				}
				Atom::Literal(value)
			}
			b'0'..=b'9' => {
				let start = at + 1;
				let mut end = self.pos;
				while self.at(end).is_ascii_digit() { end += 1; }
				let digits = self.bytes.get(start..end).unwrap_or_default();
				let number = std::str::from_utf8(digits).ok().and_then(|s| s.parse::<usize>().ok());
				if !in_class && c != b'0' && (digits.len() == 1 || matches!(c, b'8' | b'9') || number.is_some_and(|n| n <= self.groups)) {
					self.pos = end;
					self.check_reference(start, digits, end)?;
					Atom::BackrefNumber(digits)
				} else {
					self.pos = start;
					let mut cp = 0;
					for _ in 0..3 {
						let Some(n) = char::from(self.at(self.pos)).to_digit(8) else { break; };
						self.pos += 1;
						cp = cp * 8 + n;
					}
					let next = self.at(self.pos);
					if c == b'0' && self.pos - start < 3 && matches!(next, b'8' | b'9') {
						self.warn("regexp", &format!("Non-octal character '{}' terminates \\0 early.  Resolved as \"\\{cp:03o}{}\"",
							char::from(next), char::from(next)), self.pos + 1);
					}
					if self.pos == start { self.pos += 1; Atom::Literal(u32::from(c)) } else { Atom::Literal(cp) }
				}
			}
			b'N' => {
				let named = self.at(self.pos) == b'{' && !self.is_repeat(self.pos + 1);
				if named {
					let start = self.pos + 1;
					let end = self.find(start, b'}').ok_or_else(|| self.err("Missing right brace on \\N{}", start))?;
					self.pos = end + 1;
					self.facts.unicode = true;
					let raw = self.bytes.get(start..end).unwrap_or_default();
					let name = raw.trim_ascii();
					let Some(numbers) = name.strip_prefix(b"U+") else {
						let cp = char_by_name(name).ok_or_else(|| self.err(&format!("Unknown charname '{}'", String::from_utf8_lossy(raw)), end))?;
						self.facts.wide |= cp > 255;
						return Ok(Atom::Literal(cp));
					};
					let mut parts = numbers.split(|&b| b == b'.');
					let first = self.name_number(parts.next().unwrap_or_default())?;
					if let Some(second) = parts.next() {
						let mut sequence = vec![first, self.name_number(second)?];
						for part in parts { sequence.push(self.name_number(part)?); }
						self.facts.wide |= sequence.iter().any(|&cp| cp > 255);
						Atom::Sequence(sequence)
					} else { Atom::Literal(first) }
				} else if in_class {
					return Err(self.err("\\N in a character class must be a named character: \\N{...}", self.pos));
				} else if self.flags.x && self.at(self.pos).is_ascii_whitespace()
					&& let Some(brace) = self.tail(self.pos).iter().position(|b| !b.is_ascii_whitespace()).map(|n| self.pos + n)
					&& self.at(brace) == b'{' && !self.is_repeat(brace + 1)
				{
					return Err(self.err("Missing braces on \\N{}", self.pos));
				} else { Atom::Verbatim(b"\\N") }
			}
			b'B' | b'b' if !in_class => {
				if self.at(self.pos) == b'{' {
					let begin = self.pos + 1;
					let end = self.find(begin, b'}').ok_or_else(|| self.err(&format!("Missing right brace on \\{}{{}}", char::from(c)), begin))?;
					self.pos = end + 1;
					self.facts.unicode = true;
					let kind = self.bytes.get(begin..end).unwrap_or_default().trim_ascii();
					match kind {
						b"g" | b"gcb" => {
							self.facts.bounds.grapheme = true;
							Atom::Verbatim(if c == b'b' { b"(?C1)" } else { b"(?C2)" })
						}
						b"wb" => {
							self.facts.bounds.word = true;
							Atom::Verbatim(if c == b'b' { b"(?C6)" } else { b"(?C7)" })
						}
						b"sb" => {
							self.facts.bounds.sentence = true;
							Atom::Verbatim(if c == b'b' { b"(?C8)" } else { b"(?C9)" })
						}
						b"lb" => {
							self.facts.bounds.line = true;
							Atom::Verbatim(if c == b'b' { b"(?C10)" } else { b"(?C11)" })
						}
						b"" => return Err(self.err(&format!("Empty \\{}{{}}", char::from(c)), self.pos)),
						_ => {
							let shown = PStr::new(kind.to_vec(), self.source.utf8).to_string_lossy().into_owned();
							return Err(self.err(&format!("'{shown}' is an unknown bound type"), end));
						}
					}
				} else { Atom::Boundary(c == b'B') }
			}
			b'p' | b'P' => {
				self.facts.unicode = true;
				let name = if self.at(self.pos) == b'{' {
					let start = self.pos + 1;
					let end = self.find(start, b'}').ok_or_else(|| self.err(&format!("Missing right brace on \\{}{{}}", char::from(c)), start))?;
					self.pos = end + 1;
					if self.bytes.get(start..end).is_some_and(|name| name.trim_ascii().is_empty()) {
						return Err(self.err(&format!("Empty \\{}{{}}", char::from(c)), start));
					}
					self.bytes.get(start..end).unwrap_or_default()
				} else if self.pos >= self.bytes.len() {
					return Err(self.err(&format!("Empty \\{}", char::from(c)), self.pos));
				} else {
					let start = self.pos;
					self.pos += 1;
					self.bytes.get(start..self.pos).unwrap_or_default()
				};
				match self.user_property(name).map(|p| &p.set) {
					Some(UserSet::Invalid(msg)) => return Err(self.err(msg, self.pos)),
					Some(UserSet::Deferred(qualified)) if self.mode.is_none() => {
						let error = format!("Unknown user-defined property name \\p{{{qualified}}}");
						self.facts.deferred.push(error);
					}
					Some(_) => {}
					None if self.mode.is_none() => self.check_property(name)?,
					None => {}
				}
				Atom::Property(name, c == b'P')
			}
			b'w' | b'W' | b'd' | b'D' | b's' | b'S' | b'v' | b'V' | b'h' | b'H' => Atom::Shorthand(c),
			b'R' if !in_class => Atom::Newline,
			b'G' if !in_class => {
				self.facts.g_anchor = true;
				self.facts.g_leading |= at == 0 && !matches!(self.at(at + 2), b'*' | b'+' | b'?' | b'{');
				self.facts.g_rewind |= self.prefix_consumes;
				self.facts.g_unbounded |= self.prefix_consumes && self.prefix_unbounded;
				Atom::Verbatim(b"(?:(?C3))")
			}
			b'X' | b'A' | b'Z' | b'z' | b'K' if !in_class => Atom::Raw,
			b'C' if !in_class => return Err(self.err("\\C no longer supported", at + 1)),
			b'g' | b'k' if !in_class => {
				let sep = self.at(self.pos);
				let close = match sep { b'{' => b'}', b'<' if c == b'k' => b'>', b'\'' if c == b'k' => b'\'', _ => 0 };
				if close != 0 {
					let start = self.pos + 1;
					let Some(end) = self.find(start, close) else {
						let first = self.at(start);
						let message = if start >= self.bytes.len() { self.not_terminated(at, start) }
							else if c == b'g' && (first.is_ascii_digit() || first == b'-') { self.err("Unterminated \\g{...} pattern", self.bytes.len()) }
							else if !(first == b'_' || first.is_ascii_alphabetic() || first >= 0x80) {
								self.err("Group name must start with a non-digit word character", self.bytes.len())
							} else { self.not_terminated(at, start) };
						return Err(message);
					};
					let name = self.bytes.get(start..end).unwrap_or_default();
					let number = name.trim_ascii();
					if c == b'g' && is_reference_number(number) {
						let lead = start + (name.len() - name.trim_ascii_start().len());
						self.check_reference(lead, number, end + 1)?;
						self.pos = end + 1;
						Atom::BackrefNumber(number)
					} else {
						self.flush(false)?;
						self.named_ref(at, start, close, RefKind::Backref)?;
						Atom::Emitted
					}
				} else if c == b'g' && (sep.is_ascii_digit() || sep == b'-' && self.at(self.pos + 1).is_ascii_digit()) {
					let start = self.pos;
					if sep == b'-' { self.pos += 1; }
					while self.at(self.pos).is_ascii_digit() { self.pos += 1; }
					let number = self.bytes.get(start..self.pos).unwrap_or_default();
					self.check_reference(start, number, self.pos)?;
					Atom::BackrefNumber(number)
				} else { return Err(self.err(&format!("Unterminated \\{}... pattern", char::from(c)), self.pos)); }
			}
			_ => {
				let (cp, end) = self.cp(at + 1);
				self.pos = end;
				if c.is_ascii_alphabetic() {
					let place = if in_class { " in character class" } else { "" };
					self.warn("regexp", &format!("Unrecognized escape \\{}{place} passed through", char::from(c)), end);
				}
				Atom::Literal(cp)
			}
		})
	}

	/// Validate a numbered back reference (`\1`, `\g1`, `\g{1}`, `\g-1`) with
	/// perl's diagnostics. `at` is the offset of the number (or its `-`), `end`
	/// the end of the whole reference. Absolute numbers are checked once the
	/// total group count is known (translation); relative ones count the
	/// groups opened so far.
	fn check_reference(&self, at: usize, text: &[u8], end: usize) -> Result<(), String> {
		let relative = text.first() == Some(&b'-');
		let digits = if relative { &text[1..] } else { text };
		let value = std::str::from_utf8(digits).ok().and_then(|s| s.parse::<i32>().ok());
		let mark = at + usize::from(relative);
		match value {
			Some(0) => Err(self.err("Reference to invalid group 0", mark)),
			Some(n) if relative && n as usize > self.groups => Err(self.err("Reference to nonexistent or unclosed group", mark)),
			Some(n) if !relative && self.known.is_some_and(|known| n as usize > known.group_count) => {
				Err(self.err("Reference to nonexistent group", end))
			}
			Some(_) => Ok(()),
			None if relative => Err(self.err("Reference to nonexistent or unclosed group", mark)),
			None => Err(self.err("Reference to nonexistent group", at)),
		}
	}

	fn is_repeat(&self, mut p: usize) -> bool {
		let min = self.rep_number(&mut p);
		let max = if self.at(p) == b',' { p += 1; self.rep_number(&mut p) } else { None };
		self.at(p) == b'}' && (min.is_some() || max.is_some())
	}

	fn number(&self, digits: &[u8], radix: u32, end: usize) -> Result<u32, String> {
		let mut n = 0u32;
		let mut digits = digits.trim_ascii_start().iter().copied().peekable();
		while let Some(b) = digits.next() {
			if b == b'_' && digits.peek().is_some_and(|&c| char::from(c).is_digit(radix)) { continue; }
			let Some(digit) = char::from(b).to_digit(radix) else { break; };
			n = n.checked_mul(radix).and_then(|n| n.checked_add(digit)).ok_or_else(|| self.err("Use of code point too large", end))?;
		}
		Ok(n)
	}

	fn name_number(&self, digits: &[u8]) -> Result<u32, String> {
		let valid = !digits.is_empty() && digits.iter().enumerate().all(|(i, b)| {
			b.is_ascii_hexdigit() || *b == b'_' && digits.get(i + 1).is_some_and(u8::is_ascii_hexdigit)
		});
		if !valid { return Err(self.err("Invalid hexadecimal number in \\N{U+...}", self.pos)); }
		self.number(digits, 16, self.pos)
	}

	fn extended_class(&mut self, at: usize) -> Result<(), String> {
		self.facts.unicode = true;
		self.pos = at + 3;
		self.warn("experimental::regex_sets", "The regex_sets feature is experimental", self.pos);
		// PCRE2 cannot size an extended class inside a lookbehind, so there it
		// matches as a one-character lookahead test followed by any character.
		let behind = self.frames.iter().any(|frame| {
			[&b"(?<="[..], b"(?<!", b"(*plb:", b"(*nlb:", b"(*positive_lookbehind:", b"(*negative_lookbehind:"]
				.iter().any(|opener| self.matches(frame.opening, opener))
		});
		if behind { self.emit(b"(?:(?=", at, at); }
		self.raw(at, self.pos);
		let saved = self.flags;
		self.flags.xx = true;
		self.in_set = true;
		// A top-level `]` that does not close the construct.
		let mut stray = None;
		while self.pos < self.bytes.len() {
			let p = self.pos;
			self.pos += 1;
			match self.at(p) {
				b']' if self.at(self.pos) != b')' => {
					stray = stray.or(Some(self.pos));
					self.raw(p, self.pos);
				}
				b']' if self.at(self.pos) == b')' => {
					self.pos += 1;
					self.raw(p, self.pos);
					if behind { self.emit(b")(?s:.))", self.pos, self.pos); }
					self.flags = saved;
					self.in_set = false;
					return Ok(());
				}
				b'[' if self.at(p + 1) == b':' && self.posix_shaped(p) => {
					let a = self.posix(p)?;
					self.emit_atom(a, p, self.pos, false);
				}
				b'[' => self.class(p)?,
				b'\\' => {
					let a = self.escape(p, true)?;
					self.emit_atom(a, p, self.pos, false);
				}
				b'#' => {
					self.pos = self.find(self.pos, b'\n').map_or(self.bytes.len(), |n| n + 1);
				}
				c if c >= 0x80 => {
					// Non-ASCII Pattern_White_Space is insignificant here too.
					let (cp, end) = self.cp(p);
					self.pos = end;
					if !matches!(cp, 0x85 | 0x200E | 0x200F | 0x2028 | 0x2029) { self.raw(p, self.pos); }
				}
				_ => self.raw(p, self.pos),
			}
		}
		Err(match stray {
			Some(at) => self.err("Unexpected ']' with no following ')' in (?[...", at),
			None => self.err("Syntax error in (?[...])", self.bytes.len()),
		})
	}

	/// Whether `[:`, `[=` or `[.` at `at` reads as a POSIX class (`[:name:]`);
	/// otherwise perl takes the bracket literally.
	fn posix_shaped(&self, at: usize) -> bool {
		let delimiter = self.at(at + 1);
		self.find(at + 2, b']').is_some_and(|end| end >= at + 4 && self.at(end - 1) == delimiter)
	}

	fn posix(&mut self, at: usize) -> Result<Atom<'a>, String> {
		let delimiter = self.at(at + 1);
		let end = self.find(at + 2, b']').ok_or_else(|| self.err("POSIX class not terminated", self.bytes.len()))?;
		if self.at(end - 1) != delimiter { return Err(self.err("POSIX class not terminated", end)); }
		self.pos = end + 1;
		if delimiter != b':' {
			let d = char::from(delimiter);
			return Err(self.err(&format!("POSIX syntax [{d} {d}] is reserved for future extensions"), self.pos));
		}
		let name = self.bytes.get(at + 2..end - 1).unwrap_or_default();
		let (negate, name) = name.strip_prefix(b"^").map_or((false, name), |s| (true, s));
		if !is_posix_name(name) {
			return Err(self.err(&format!("POSIX class {} unknown", String::from_utf8_lossy(self.bytes.get(at..self.pos).unwrap_or_default())), self.pos));
		}
		Ok(Atom::Posix(name, negate))
	}

	fn class(&mut self, at: usize) -> Result<(), String> {
		let delimiter = self.at(at + 1);
		if !self.in_set && matches!(delimiter, b':' | b'.' | b'=')
			&& let Some(end) = self.find(at + 2, b']').filter(|&end| end >= at + 3 && self.at(end - 1) == delimiter)
		{
			let msg = if delimiter != b':' {
				let d = char::from(delimiter);
				format!("POSIX syntax [{d} {d}] belongs inside character classes (but this one isn't implemented)")
			} else {
				let name = self.bytes.get(at + 2..end - 1).unwrap_or_default();
				let name = name.strip_prefix(b"^").unwrap_or(name);
				let valid = if is_posix_name(name) { "" } else { " (but this one isn't fully valid)" };
				format!("POSIX syntax [: :] belongs inside character classes{valid}")
			};
			self.warn("regexp", &msg, end + 1);
		}
		let mut p = self.pos;
		if self.flags.xx { while matches!(self.at(p), b' ' | b'\t') { p += 1; } }
		let negate = self.at(p) == b'^';
		if negate { self.pos = p + 1; }
		let mut items = Vec::new();
		let mut shape = Vec::new();
		let mut first = true;
		loop {
			let p = self.pos;
			if p >= self.bytes.len() { return Err(self.err("Unmatched [", at + 1)); }
			self.pos += 1;
			let atom = match self.at(p) {
				b']' if !first => break,
				b' ' | b'\t' if self.flags.xx => continue,
				b'[' if matches!(self.at(p + 1), b':' | b'.' | b'=') && self.posix_shaped(p) => self.posix(p)?,
				b'\\' => self.escape(p, true)?,
				b'-' => Atom::Dash,
				_ => { let (cp, end) = self.cp(p); self.pos = end; Atom::Literal(cp) }
			};
			if let Atom::Literal(cp) = atom { self.facts.wide |= cp > 255; }
			first = false;
			if self.mode.is_none() {
				// Only the shape matters while analyzing: range endpoints or not.
				shape.push((if matches!(atom, Atom::Dash) { None } else { Some(atom.range_cp().is_some()) }, p, self.pos));
			} else { items.push((atom, p, self.pos)); }
		}
		if self.mode.is_none() { return self.false_ranges(&shape); }
		let close = self.pos;
		let mut expanded = false;
		if !negate && !self.in_set {
			let strict = self.flags.charset == Charset::AsciiStrict;
			if let Some((first, _, _)) = items.first() {
				if let Some(cp) = first.cp() {
					if items.len() == 1 || self.folds() && items.iter().all(|(a, _, _)| {
						matches!(a, Atom::Literal(c) if full_fold(*c, strict) == full_fold(cp, strict))
					}) {
						self.queue_literal(cp, at, close, false);
						return Ok(());
					}
				}
			}
			self.flush(false)?;
			let folds = self.folds();
			let mut i = 0;
			while let Some((a, start, end)) = items.get(i) {
				if a.range_cp().is_some() && matches!(items.get(i + 1), Some((Atom::Dash, _, _)))
					&& items.get(i + 2).is_some_and(|(rhs, _, _)| rhs.range_cp().is_some())
				{
					i += 3;
					continue;
				}
				i += 1;
				match a {
					Atom::Sequence(_) => {
						if !expanded { self.emit(b"(?:", at, at); expanded = true; }
						self.emit_atom(a.clone(), *start, *end, false);
						self.emit(b"|", *end, *end);
					}
					Atom::Literal(cp) if folds && full_fold(*cp, strict)[1] != 0 => {
						if !expanded { self.emit(b"(?:", at, at); expanded = true; }
						self.fold_literals(&[Literal { cp: *cp, start: *start, end: *end, raw: false }])?;
						self.emit(b"|", *end, *end);
					}
					_ => {}
				}
			}
		} else if !self.in_set { self.flush(false)?; }
		if items.iter().all(|(a, _, _)| matches!(a, Atom::Sequence(_))) {
			self.emit(if negate { b"\\p{Any}" } else { b"\\P{Any}" }, at, close);
			if expanded { self.emit(b")", close, close); }
			return Ok(());
		}
		let extended = items.iter().any(|(a, _, _)| !matches!(a, Atom::Dash | Atom::Literal(_) | Atom::Sequence(_)));
		let already_in_set = self.in_set;
		if extended {
			let prefix = match (already_in_set, negate) {
				(true, true) => b"!(" as &[u8],
				(true, false) => b"(",
				(false, true) => b"(?:(?!(?:",
				(false, false) => b"(?:",
			};
			self.emit(prefix, at, at + 1);
		} else { self.emit(if negate { b"[^" } else { b"[" }, at, at + 1); }
		let mut i = 0;
		let mut emitted = false;
		while let Some((a, p, end)) = items.get(i) {
			if let Some((Atom::Dash, dash, _)) = items.get(i + 1) {
				if let Some((b, rhs, fin)) = items.get(i + 2) {
					if let (Some(left), Some(right)) = (a.range_cp(), b.range_cp()) {
						if extended && emitted { self.emit(b"|", *p, *p); }
						emitted = true;
						if left > right {
							let range = PStr::new(self.bytes.get(*p..*fin).unwrap_or_default().to_vec(), self.source.utf8);
							return Err(self.err(&format!("Invalid [] range \"{}\"", range.to_string_lossy()), *fin));
						}
						let (left, right) = unicode_range(left, right, self.mode.is_some_and(|m| m.utf));
						if extended { self.emit(b"[", *p, *p); }
						self.literal(left, *p, *end, true);
						self.emit(b"-", *dash, *rhs);
						self.literal(right, *rhs, *fin, true);
						if extended { self.emit(b"]", *fin, *fin); }
						i += 3;
						continue;
					}
				}
			}
			if !matches!(a, Atom::Sequence(_)) {
				if extended && emitted { self.emit(b"|", *p, *p); }
				emitted = true;
				if let Some(cp) = a.cp() { self.literal(cp, *p, *end, true); }
				else { self.emit_atom(a.clone(), *p, *end, false); }
			}
			i += 1;
		}
		let suffix: &[u8] = match (extended, already_in_set, negate) {
			(false, _, _) => b"]",
			(true, false, true) => b"))(?s:.))",
			(true, _, _) => b")",
		};
		self.emit(suffix, close - 1, close);
		if expanded { self.emit(b")", close, close); }
		Ok(())
	}

	/// perl's "False [] range" for a class or property next to a `-` between
	/// two items (`[a-\d]`, `[\w-x]`): fatal inside `(?[ ])`, else a warning.
	/// `shape` holds each item as `None` (a dash) or whether it can end a range.
	fn false_ranges(&mut self, shape: &[(Option<bool>, usize, usize)]) -> Result<(), String> {
		let mut i = 0;
		while i + 2 < shape.len() {
			let (Some(&(Some(left), start, _)), Some(&(None, _, dash_end)), Some(&(Some(right), _, right_end)))
				= (shape.get(i), shape.get(i + 1), shape.get(i + 2)) else {
				i += 1;
				continue;
			};
			if left && right {
				i += 3;
				continue;
			}
			let end = if left { right_end } else { dash_end };
			let text = PStr::new(self.bytes.get(start..end).unwrap_or_default().to_vec(), self.source.utf8).to_string_lossy().into_owned();
			let message = format!("False [] range \"{text}\"");
			if self.in_set { return Err(self.err(&message, end)); }
			self.warn("regexp", &message, end);
			i += 2;
		}
		Ok(())
	}

	fn emit_atom(&mut self, a: Atom<'a>, at: usize, end: usize, in_class: bool) {
		let mode = self.mode;
		match a {
			Atom::Literal(cp) => self.literal(cp, at, end, in_class),
			Atom::Sequence(seq) => {
				self.emit(b"(?:", at, at);
				for cp in seq { self.literal(cp, at, end, in_class); }
				self.emit(b")", end, end);
			}
			Atom::Raw => self.raw(at, end),
			Atom::BackrefNumber(digits) => {
				self.emit(b"\\g{", at, at);
				self.emit(digits, at, end);
				self.emit(b"}", end, end);
			}
			Atom::Emitted => {},
			Atom::Dash => self.literal(u32::from(b'-'), at, end, in_class),
			Atom::Verbatim(bytes) => self.emit(bytes, at, end),
			Atom::Property(name, negate) => {
				if mode.is_some() { self.property(name, negate, at, end); }
			}
			Atom::Posix(name, negate) => {
				if let Some(mode) = mode {
					let unicode = mode.unicode(self.flags.charset) && !matches!(self.flags.charset, Charset::Ascii | Charset::AsciiStrict);
					let body = posix_set(name, unicode, self.flags.i);
					// `[[:ascii:]]` stays ASCII under /i: KELVIN SIGN folds to
					// `k` but is not ASCII (`perlrecharclass`).
					if unicode && name != b"ascii" { self.set(body, negate, at, end); }
					else { self.ascii_set(body, negate, at, end); }
				}
			}
			Atom::Shorthand(c) => {
				if let Some(mode) = mode {
					let unicode = mode.unicode(self.flags.charset) && !matches!(self.flags.charset, Charset::Ascii | Charset::AsciiStrict);
					let c0 = c.to_ascii_lowercase();
					let body = shorthand_set(c0, unicode, mode.utf);
					if !unicode && matches!(c0, b'w' | b'd' | b's') { self.ascii_set(body, c.is_ascii_uppercase(), at, end); }
					else { self.set(body, c.is_ascii_uppercase(), at, end); }
				}
			}
			Atom::Boundary(negate) => {
				if let Some(mode) = mode {
					let unicode = mode.unicode(self.flags.charset) && !matches!(self.flags.charset, Charset::Ascii | Charset::AsciiStrict);
					if !mode.ucp && !unicode {
						self.raw(at, end);
						return;
					}
					let body = shorthand_set(b'w', unicode, mode.utf);
					self.emit(if negate { b"(?!(?:" } else { b"(?:" }, at, end);
					self.emit(b"(?<!(?-i:[", at, end);
					self.emit(body, at, end);
					self.emit(b"]))(?=(?-i:[", at, end);
					self.emit(body, at, end);
					self.emit(b"]))|(?<=(?-i:[", at, end);
					self.emit(body, at, end);
					self.emit(b"]))(?!(?-i:[", at, end);
					self.emit(body, at, end);
					self.emit(if negate { b"]))))" } else { b"])))" }, at, end);
				}
			}
			Atom::Newline => {
				if let Some(mode) = mode {
					self.emit(b"(?>\\r\\n|", at, end);
					self.set(shorthand_set(b'v', true, mode.utf), false, at, end);
					self.emit(b")", at, end);
				}
			}
		}
	}

	fn set(&mut self, body: &[u8], mut negate: bool, at: usize, end: usize) {
		let body = if let Some(body) = body.strip_prefix(b"^") { negate = !negate; body } else { body };
		self.emit(if negate { b"[^" } else { b"[" }, at, at);
		self.emit(body, at, end);
		self.emit(b"]", end, end);
	}

	fn ascii_set(&mut self, body: &[u8], negate: bool, at: usize, end: usize) {
		if self.flags.i && self.mode.is_some_and(|mode| mode.utf) {
			if self.in_set {
				self.emit(if negate { b"!(" } else { b"(" }, at, at);
				self.set(body, false, at, end);
				self.emit(b"&\\p{ASCII})", end, end);
			} else {
				self.emit(b"(?-i:", at, at);
				self.set(body, negate, at, end);
				self.emit(b")", end, end);
			}
		} else { self.set(body, negate, at, end); }
	}

	/// The name inside `\p{...}` as user properties are keyed: trimmed, without `^`.
	fn property_key(raw: &[u8]) -> &[u8] {
		let raw = raw.trim_ascii();
		raw.strip_prefix(b"^").map_or(raw, <[u8]>::trim_ascii)
	}

	fn user_property(&self, raw: &[u8]) -> Option<&'a UserProperty> {
		let key = Self::property_key(raw);
		self.properties.iter().find(|p| p.name == key)
	}

	/// A set that matches nothing (or, negated, every character) in this mode.
	fn empty_set(&mut self, negate: bool, at: usize, end: usize) {
		let all: &[u8] = if self.mode.is_some_and(|m| m.utf) { b"\\x00-\\x{10FFFF}" } else { b"\\x00-\\xFF" };
		self.set(all, !negate, at, end);
	}

	/// Emit a user-defined property as an extended class expression.
	fn user_set(&mut self, set: &PropSet, negate: bool, at: usize, end: usize) {
		let outer = !self.in_set;
		if outer { self.emit(b"(?[ ", at, at); }
		self.in_set = true;
		if negate { self.emit(b"!", at, at); }
		self.prop_set(set, at, end);
		self.in_set = !outer;
		if outer { self.emit(b" ])", end, end); }
	}

	fn prop_set(&mut self, set: &PropSet, at: usize, end: usize) {
		match set {
			PropSet::Ranges(ranges) => {
				let max = if self.mode.is_some_and(|m| m.utf) { 0x10FFFF } else { 0xFF };
				let mut body = Vec::new();
				for &(first, last) in ranges.iter().filter(|(first, _)| *first <= max) {
					let _ = write!(body, "\\x{{{first:X}}}-\\x{{{:X}}}", last.min(max));
				}
				if body.is_empty() { self.empty_set(false, at, end); } else { self.set(&body, false, at, end); }
			}
			PropSet::Builtin(name) => self.property(name, false, at, end),
			PropSet::Union(members) => {
				if members.is_empty() { self.empty_set(false, at, end); return; }
				self.emit(b"(", at, at);
				for (i, member) in members.iter().enumerate() {
					if i != 0 { self.emit(b" + ", at, at); }
					self.prop_set(member, at, end);
				}
				self.emit(b")", end, end);
			}
			PropSet::Minus(a, b) | PropSet::And(a, b) => {
				self.emit(b"(", at, at);
				self.prop_set(a, at, end);
				self.emit(if matches!(set, PropSet::Minus(..)) { b" - " } else { b" & " }, at, at);
				self.prop_set(b, at, end);
				self.emit(b")", end, end);
			}
			PropSet::Not(a) => {
				self.emit(b"!(", at, at);
				self.prop_set(a, at, end);
				self.emit(b")", end, end);
			}
		}
	}

	fn property(&mut self, raw: &[u8], negate: bool, at: usize, end: usize) {
		match self.user_property(raw).map(|p| &p.set) {
			Some(UserSet::Defined(set)) => {
				let negate = negate != raw.trim_ascii().starts_with(b"^");
				self.user_set(set, negate, at, end);
				return;
			}
			Some(UserSet::Deferred(_) | UserSet::Invalid(_)) => {
				self.empty_set(negate != raw.trim_ascii().starts_with(b"^"), at, end);
				return;
			}
			None => {}
		}
		let raw = raw.trim_ascii();
		let (negate, text) = raw.strip_prefix(b"^").map_or((negate, raw), |n| (!negate, n.trim_ascii()));
		// Unknown names were reported while analyzing the pattern.
		let ranges = match ucd::lookup(text, self.flags.i) {
			Lookup::Found(found) => found.ranges,
			Lookup::Wildcard(property, pattern) => wildcard_set(property, pattern).map(|found| found.ranges).unwrap_or_default(),
			Lookup::NotFound => Vec::new(),
		};
		self.ranges_set(&ranges, negate, at, end);
	}

	/// Validate a built-in `\p{...}` while analyzing the pattern, recording
	/// its deprecation and wildcard warnings (`perldiag`).
	fn check_property(&mut self, raw: &[u8]) -> Result<(), String> {
		let text = Self::property_key(raw);
		let shown = String::from_utf8_lossy(text).into_owned();
		match ucd::lookup(text, self.flags.i) {
			Lookup::Found(found) => {
				if let Some(reason) = found.deprecated {
					self.facts.warnings.push(("deprecated", format!("Use of '{shown}' in \\p{{}} or \\P{{}} is deprecated because: {reason}")));
				}
				Ok(())
			}
			Lookup::Wildcard(property, pattern) => {
				self.facts.warnings.push(("experimental::uniprop_wildcards", "The Unicode property wildcards feature is experimental".to_owned()));
				match wildcard_set(property, pattern) {
					Ok(_) => Ok(()),
					Err(None) => Err(self.err(&format!("No Unicode property value wildcard matches: \"{shown}\""), self.pos)),
					Err(Some(msg)) => Err(msg),
				}
			}
			// A package-qualified name must be a user property (`In`/`Is...`).
			Lookup::NotFound if text.windows(2).any(|w| w == b"::") => {
				Err(self.err(&format!("Illegal user-defined property name \"{shown}\""), self.pos))
			}
			Lookup::NotFound => Err(self.err(&format!("Can't find Unicode property definition \"{shown}\""), self.pos)),
		}
	}

	/// Emit code point ranges as a class (negated for `\P`), clipped to the
	/// subject's representation. Properties ignore `/i` (`perlunicode`).
	fn ranges_set(&mut self, ranges: &[(u32, u32)], negate: bool, at: usize, end: usize) {
		let utf = self.mode.is_some_and(|m| m.utf);
		let max = if utf { 0x10FFFF } else { 0xFF };
		let mut body = Vec::new();
		for &(first, last) in ranges {
			if first > max { break; }
			let (mut first, mut last) = (first, last.min(max));
			// PCRE2 rejects surrogate code points in a UTF pattern, and a valid
			// UTF-8 subject cannot contain them.
			if utf {
				if (0xD800..=0xDFFF).contains(&first) { first = 0xE000; }
				if (0xD800..=0xDFFF).contains(&last) { last = 0xD7FF; }
				if first > last { continue; }
			}
			if first == last { let _ = write!(body, "\\x{{{first:X}}}"); }
			else { let _ = write!(body, "\\x{{{first:X}}}-\\x{{{last:X}}}"); }
		}
		if body.is_empty() {
			self.empty_set(negate, at, end);
			return;
		}
		let guard = self.flags.i && !self.in_set;
		if guard { self.emit(b"(?-i:", at, at); }
		self.set(&body, negate, at, end);
		if guard { self.emit(b")", end, end); }
	}
}

/// The values of `property` whose names a `\p{name=/pattern/}` subpattern
/// matches (case-insensitively unless it says `(?-i)`). `Err(None)`: no value
/// matched; `Err(Some(..))`: the subpattern is invalid.
fn wildcard_set(property: &'static ucd::Property, pattern: &[u8]) -> Result<ucd::Resolved, Option<String>> {
	// Nested properties are illegal in wildcard subpatterns (`perlunicode`).
	if pattern.windows(2).any(|w| w == b"\\p" || w == b"\\P") {
		return Err(Some(format!("Use of \\p{{}} or \\P{{}} is not allowed in Unicode property wildcard subpatterns in regex m/{}/",
			String::from_utf8_lossy(pattern))));
	}
	let flags = RxFlags { i: true, ..RxFlags::default() };
	let regex = Regex::new(&PStr::new(pattern.to_vec(), false), flags).map_err(Some)?;
	ucd::wildcard(property, |name| {
		regex.exec(&PStr::from_str(name), 0, ExecOpts::default()).is_ok_and(|found| found.is_some())
	}).ok_or(None)
}

#[derive(Clone, Copy)]
struct Literal {
	cp: u32,
	start: usize,
	end: usize,
	raw: bool,
}

struct FoldUnit {
	normalized: u32,
	literal: Literal,
}

struct FoldEdge {
	start: usize,
	end: usize,
	cp: u32,
}

fn full_fold(cp: u32, strict: bool) -> [u32; 3] {
	if cp < 128 { return [u32::from((cp as u8).to_ascii_lowercase()), 0, 0]; }
	if strict && matches!(cp, 0xDF | 0x1E9E) { return [0x17F, 0x17F, 0]; }
	if let Ok(i) = FULL_FOLD.binary_search_by_key(&cp, |r| r.0) {
		let fold = FULL_FOLD[i].1;
		if !strict || fold.into_iter().all(|c| c == 0 || c >= 128) { return fold; }
	}
	if let Ok(i) = SIMPLE_FOLD.binary_search_by_key(&cp, |r| r.0) {
		let folded = SIMPLE_FOLD[i].1;
		if !strict || folded >= 128 { return [folded, 0, 0]; }
	}
	[cp, 0, 0]
}

// Unicode 13.0 CaseFolding.txt, © 2019 Unicode, Inc.: default multi-code-point
// folds and the simple folds that can participate in those sequences.
// https://www.unicode.org/Public/13.0.0/ucd/CaseFolding.txt
// https://www.unicode.org/terms_of_use.html
const SIMPLE_FOLD: &[(u32, u32)] = &[
	(0x17F, 0x73),
	(0x345, 0x3B9),
	(0x386, 0x3AC),
	(0x389, 0x3AE),
	(0x38F, 0x3CE),
	(0x391, 0x3B1),
	(0x397, 0x3B7),
	(0x399, 0x3B9),
	(0x3A1, 0x3C1),
	(0x3A5, 0x3C5),
	(0x3A9, 0x3C9),
	(0x3F1, 0x3C1),
	(0x535, 0x565),
	(0x53B, 0x56B),
	(0x53D, 0x56D),
	(0x544, 0x574),
	(0x546, 0x576),
	(0x54E, 0x57E),
	(0x552, 0x582),
	(0x1F08, 0x1F00),
	(0x1F09, 0x1F01),
	(0x1F0A, 0x1F02),
	(0x1F0B, 0x1F03),
	(0x1F0C, 0x1F04),
	(0x1F0D, 0x1F05),
	(0x1F0E, 0x1F06),
	(0x1F0F, 0x1F07),
	(0x1F28, 0x1F20),
	(0x1F29, 0x1F21),
	(0x1F2A, 0x1F22),
	(0x1F2B, 0x1F23),
	(0x1F2C, 0x1F24),
	(0x1F2D, 0x1F25),
	(0x1F2E, 0x1F26),
	(0x1F2F, 0x1F27),
	(0x1F68, 0x1F60),
	(0x1F69, 0x1F61),
	(0x1F6A, 0x1F62),
	(0x1F6B, 0x1F63),
	(0x1F6C, 0x1F64),
	(0x1F6D, 0x1F65),
	(0x1F6E, 0x1F66),
	(0x1F6F, 0x1F67),
	(0x1FBA, 0x1F70),
	(0x1FBE, 0x3B9),
	(0x1FCA, 0x1F74),
	(0x1FFA, 0x1F7C),
	(0x2126, 0x3C9),
];

const FULL_FOLD: &[(u32, [u32; 3])] = &[
	(0xDF, [0x73, 0x73, 0]),
	(0x130, [0x69, 0x307, 0]),
	(0x149, [0x2BC, 0x6E, 0]),
	(0x1F0, [0x6A, 0x30C, 0]),
	(0x390, [0x3B9, 0x308, 0x301]),
	(0x3B0, [0x3C5, 0x308, 0x301]),
	(0x587, [0x565, 0x582, 0]),
	(0x1E96, [0x68, 0x331, 0]),
	(0x1E97, [0x74, 0x308, 0]),
	(0x1E98, [0x77, 0x30A, 0]),
	(0x1E99, [0x79, 0x30A, 0]),
	(0x1E9A, [0x61, 0x2BE, 0]),
	(0x1E9E, [0x73, 0x73, 0]),
	(0x1F50, [0x3C5, 0x313, 0]),
	(0x1F52, [0x3C5, 0x313, 0x300]),
	(0x1F54, [0x3C5, 0x313, 0x301]),
	(0x1F56, [0x3C5, 0x313, 0x342]),
	(0x1F80, [0x1F00, 0x3B9, 0]),
	(0x1F81, [0x1F01, 0x3B9, 0]),
	(0x1F82, [0x1F02, 0x3B9, 0]),
	(0x1F83, [0x1F03, 0x3B9, 0]),
	(0x1F84, [0x1F04, 0x3B9, 0]),
	(0x1F85, [0x1F05, 0x3B9, 0]),
	(0x1F86, [0x1F06, 0x3B9, 0]),
	(0x1F87, [0x1F07, 0x3B9, 0]),
	(0x1F88, [0x1F00, 0x3B9, 0]),
	(0x1F89, [0x1F01, 0x3B9, 0]),
	(0x1F8A, [0x1F02, 0x3B9, 0]),
	(0x1F8B, [0x1F03, 0x3B9, 0]),
	(0x1F8C, [0x1F04, 0x3B9, 0]),
	(0x1F8D, [0x1F05, 0x3B9, 0]),
	(0x1F8E, [0x1F06, 0x3B9, 0]),
	(0x1F8F, [0x1F07, 0x3B9, 0]),
	(0x1F90, [0x1F20, 0x3B9, 0]),
	(0x1F91, [0x1F21, 0x3B9, 0]),
	(0x1F92, [0x1F22, 0x3B9, 0]),
	(0x1F93, [0x1F23, 0x3B9, 0]),
	(0x1F94, [0x1F24, 0x3B9, 0]),
	(0x1F95, [0x1F25, 0x3B9, 0]),
	(0x1F96, [0x1F26, 0x3B9, 0]),
	(0x1F97, [0x1F27, 0x3B9, 0]),
	(0x1F98, [0x1F20, 0x3B9, 0]),
	(0x1F99, [0x1F21, 0x3B9, 0]),
	(0x1F9A, [0x1F22, 0x3B9, 0]),
	(0x1F9B, [0x1F23, 0x3B9, 0]),
	(0x1F9C, [0x1F24, 0x3B9, 0]),
	(0x1F9D, [0x1F25, 0x3B9, 0]),
	(0x1F9E, [0x1F26, 0x3B9, 0]),
	(0x1F9F, [0x1F27, 0x3B9, 0]),
	(0x1FA0, [0x1F60, 0x3B9, 0]),
	(0x1FA1, [0x1F61, 0x3B9, 0]),
	(0x1FA2, [0x1F62, 0x3B9, 0]),
	(0x1FA3, [0x1F63, 0x3B9, 0]),
	(0x1FA4, [0x1F64, 0x3B9, 0]),
	(0x1FA5, [0x1F65, 0x3B9, 0]),
	(0x1FA6, [0x1F66, 0x3B9, 0]),
	(0x1FA7, [0x1F67, 0x3B9, 0]),
	(0x1FA8, [0x1F60, 0x3B9, 0]),
	(0x1FA9, [0x1F61, 0x3B9, 0]),
	(0x1FAA, [0x1F62, 0x3B9, 0]),
	(0x1FAB, [0x1F63, 0x3B9, 0]),
	(0x1FAC, [0x1F64, 0x3B9, 0]),
	(0x1FAD, [0x1F65, 0x3B9, 0]),
	(0x1FAE, [0x1F66, 0x3B9, 0]),
	(0x1FAF, [0x1F67, 0x3B9, 0]),
	(0x1FB2, [0x1F70, 0x3B9, 0]),
	(0x1FB3, [0x3B1, 0x3B9, 0]),
	(0x1FB4, [0x3AC, 0x3B9, 0]),
	(0x1FB6, [0x3B1, 0x342, 0]),
	(0x1FB7, [0x3B1, 0x342, 0x3B9]),
	(0x1FBC, [0x3B1, 0x3B9, 0]),
	(0x1FC2, [0x1F74, 0x3B9, 0]),
	(0x1FC3, [0x3B7, 0x3B9, 0]),
	(0x1FC4, [0x3AE, 0x3B9, 0]),
	(0x1FC6, [0x3B7, 0x342, 0]),
	(0x1FC7, [0x3B7, 0x342, 0x3B9]),
	(0x1FCC, [0x3B7, 0x3B9, 0]),
	(0x1FD2, [0x3B9, 0x308, 0x300]),
	(0x1FD3, [0x3B9, 0x308, 0x301]),
	(0x1FD6, [0x3B9, 0x342, 0]),
	(0x1FD7, [0x3B9, 0x308, 0x342]),
	(0x1FE2, [0x3C5, 0x308, 0x300]),
	(0x1FE3, [0x3C5, 0x308, 0x301]),
	(0x1FE4, [0x3C1, 0x313, 0]),
	(0x1FE6, [0x3C5, 0x342, 0]),
	(0x1FE7, [0x3C5, 0x308, 0x342]),
	(0x1FF2, [0x1F7C, 0x3B9, 0]),
	(0x1FF3, [0x3C9, 0x3B9, 0]),
	(0x1FF4, [0x3CE, 0x3B9, 0]),
	(0x1FF6, [0x3C9, 0x342, 0]),
	(0x1FF7, [0x3C9, 0x342, 0x3B9]),
	(0x1FFC, [0x3C9, 0x3B9, 0]),
	(0xFB00, [0x66, 0x66, 0]),
	(0xFB01, [0x66, 0x69, 0]),
	(0xFB02, [0x66, 0x6C, 0]),
	(0xFB03, [0x66, 0x66, 0x69]),
	(0xFB04, [0x66, 0x66, 0x6C]),
	(0xFB05, [0x73, 0x74, 0]),
	(0xFB06, [0x73, 0x74, 0]),
	(0xFB13, [0x574, 0x576, 0]),
	(0xFB14, [0x574, 0x565, 0]),
	(0xFB15, [0x574, 0x56B, 0]),
	(0xFB16, [0x57E, 0x576, 0]),
	(0xFB17, [0x574, 0x56D, 0]),
];

// Indices into FULL_FOLD sorted by folded sequence, then source code point.
const FULL_FOLD_REVERSE: &[usize] = &[
	11, 92, 95, 96, 93, 94, 7, 1, 3, 0, 12, 97, 98, 8, 9, 10, 2, 67, 73, 68,
	69, 66, 70, 74, 75, 72, 76, 77, 4, 78, 80, 79, 83, 81, 5, 82, 85, 13, 14, 15,
	16, 84, 89, 90, 87, 91, 88, 6, 100, 101, 103, 99, 102, 17, 25, 18, 26, 19, 27, 20,
	28, 21, 29, 22, 30, 23, 31, 24, 32, 33, 41, 34, 42, 35, 43, 36, 44, 37, 45, 38,
	46, 39, 47, 40, 48, 49, 57, 50, 58, 51, 59, 52, 60, 53, 61, 54, 62, 55, 63, 56,
	64, 65, 71, 86,
];

#[derive(Clone, Copy)]
enum RefKind { Backref, Recurse }

fn is_reference_number(name: &[u8]) -> bool {
	let n = name.strip_prefix(b"-").unwrap_or(name);
	!n.is_empty() && n.iter().all(u8::is_ascii_digit)
}

#[derive(Clone)]
enum Atom<'a> {
	Literal(u32),
	Sequence(Vec<u32>),
	Dash,
	Raw,
	BackrefNumber(&'a [u8]),
	Emitted,
	Verbatim(&'static [u8]),
	Property(&'a [u8], bool),
	Posix(&'a [u8], bool),
	Shorthand(u8),
	Boundary(bool),
	Newline,
}

impl Atom<'_> {
	fn cp(&self) -> Option<u32> {
		match self { Self::Literal(cp) => Some(*cp), Self::Dash => Some(u32::from(b'-')), _ => None }
	}

	fn range_cp(&self) -> Option<u32> {
		if let Self::Sequence(cps) = self { cps.first().copied() }
		else { self.cp() }
	}
}

fn shorthand_set(c: u8, unicode: bool, utf: bool) -> &'static [u8] {
	match (c, unicode) {
		(b'w', true) => b"\\p{Alphabetic}\\p{M}\\p{Nd}\\p{Pc}\\p{Join_Control}",
		(b'w', false) => b"A-Za-z0-9_",
		(b'd', true) => b"\\p{Nd}",
		(b'd', false) => b"0-9",
		(b's', true) => b"\\p{White_Space}",
		(b's', false) => b"\\x09-\\x0D\\x20",
		(b'h', _) => b"\\x09\\p{Zs}",
		(b'v', _) if utf => b"\\x0A-\\x0D\\x85\\x{2028}\\x{2029}",
		_ => b"\\x0A-\\x0D\\x85",
	}
}

fn is_posix_name(name: &[u8]) -> bool {
	matches!(name, b"alpha" | b"alnum" | b"ascii" | b"blank" | b"cntrl" | b"digit" | b"graph"
		| b"lower" | b"print" | b"punct" | b"space" | b"upper" | b"word" | b"xdigit")
}

fn posix_set(name: &[u8], unicode: bool, fold: bool) -> &'static [u8] {
	match (name, unicode) {
		(b"alnum", true) => b"\\p{Alphabetic}\\p{Nd}",
		(b"alnum", false) => b"A-Za-z0-9",
		(b"alpha", true) => b"\\p{Alphabetic}",
		(b"alpha", false) => b"A-Za-z",
		(b"ascii", _) => b"\\x00-\\x7F",
		(b"blank", true) => b"\\x09\\p{Zs}",
		(b"blank", false) => b"\\x09\\x20",
		(b"cntrl", true) => b"\\p{Cc}",
		(b"cntrl", false) => b"\\x00-\\x1F\\x7F",
		(b"digit", _) => shorthand_set(b'd', unicode, false),
		(b"graph", true) => b"^\\p{Z}\\p{Cc}\\p{Cs}\\p{Cn}",
		(b"graph", false) => b"\\x21-\\x7E",
		(b"lower" | b"upper", true) if fold => b"\\p{Cased}",
		(b"lower" | b"upper", false) if fold => b"A-Za-z",
		(b"lower", true) => b"\\p{Lowercase}",
		(b"lower", false) => b"a-z",
		(b"print", true) => b"^\\p{Zl}\\p{Zp}\\p{Cc}\\p{Cs}\\p{Cn}",
		(b"print", false) => b"\\x20-\\x7E",
		(b"punct", true) => b"\\p{P}\\x21-\\x2F\\x3A-\\x40\\x5B-\\x60\\x7B-\\x7E",
		(b"punct", false) => b"\\x21-\\x2F\\x3A-\\x40\\x5B-\\x60\\x7B-\\x7E",
		(b"space", _) => shorthand_set(b's', unicode, false),
		(b"upper", true) => b"\\p{Uppercase}",
		(b"upper", false) => b"A-Z",
		(b"word", _) => shorthand_set(b'w', unicode, false),
		(b"xdigit", true) => b"\\p{Hex_Digit}",
		(b"xdigit", false) => b"0-9A-Fa-f",
		_ => b"",
	}
}

/// Resolve a `\N{NAME}` Unicode character name (`charnames` full names plus
/// the C0 control aliases perl accepts without a `use charnames`).
pub(super) fn char_by_name(name: &[u8]) -> Option<u32> {
	let name = std::str::from_utf8(name).ok()?;
	let alias = match name {
		"NULL" | "NUL" => Some(0), "BEL" | "ALERT" => Some(7), "BS" | "BACKSPACE" => Some(8),
		"HT" | "TAB" | "CHARACTER TABULATION" => Some(9), "LF" | "NL" | "LINE FEED" => Some(10),
		"VT" | "LINE TABULATION" => Some(11), "FF" | "FORM FEED" => Some(12), "CR" | "CARRIAGE RETURN" => Some(13),
		"ESC" | "ESCAPE" => Some(27), "SP" | "SPACE" => Some(32), "DEL" | "DELETE" => Some(127),
		"NBSP" => Some(0xA0), "SHY" => Some(0xAD),
		_ => None,
	};
	if alias.is_some() { return alias; }
	if name.bytes().any(|b| b.is_ascii_lowercase()) { return None; }
	super::charnames::character(name)
}

fn diagnostic(src: &PStr, reason: &str, at: Option<usize>) -> String {
	let Some(mut at) = at.map(|n| n.min(src.bytes.len())) else {
		return format!("{reason} in regex m/{}/", src.to_string_lossy());
	};
	if src.utf8 {
		while at > 0 && src.bytes.get(at).is_some_and(|b| b & 0xC0 == 0x80) { at -= 1; }
	}
	let first = PStr::new(src.bytes[..at].to_vec(), src.utf8);
	let rest = PStr::new(src.bytes[at..].to_vec(), src.utf8);
	format!("{reason} in regex; marked by <-- HERE in m/{} <-- HERE {}/", first.to_string_lossy(), rest.to_string_lossy())
}

fn error_message(error: i32) -> String {
	let mut buf = [0u8; 256];
	// SAFETY: the buffer is writable for the given capacity.
	let len = unsafe { ffi::pcre2_get_error_message_8(error, buf.as_mut_ptr(), buf.len()) };
	if let Ok(len) = usize::try_from(len) {
		String::from_utf8_lossy(&buf[..len.min(buf.len())]).into_owned()
	} else { format!("PCRE2 error {error}") }
}

fn compile_error(src: &PStr, out: &Output, error: i32, offset: usize) -> String {
	let at = out.original(offset).min(src.bytes.len());
	let reason = match error as u32 {
		ffi::PCRE2_ERROR_BAD_SUBPATTERN_REFERENCE => "Reference to nonexistent group",
		ffi::PCRE2_ERROR_QUANTIFIER_INVALID => {
			let prefix = src.bytes.get(..at).unwrap_or_default();
			if prefix.last().is_some_and(|b| matches!(b, b'*' | b'+' | b'?')) && matches!(src.bytes.get(at), Some(b'*' | b'+' | b'?')) {
				return diagnostic(src, "Nested quantifiers", Some(at + 1));
			}
			if prefix.iter().rev().nth(1).is_some_and(|b| matches!(b, b'*' | b'+' | b'?' | b'}')) { "Nested quantifiers" }
			else {
				// Marked after the quantifier itself.
				let after = if matches!(src.bytes.get(at), Some(b'*' | b'+' | b'?')) { at + 1 } else { at };
				return diagnostic(src, "Quantifier follows nothing", Some(after));
			}
		}
		// Extended bracketed character classes, `(?[ ])` (`perlrecharclass`).
		ffi::PCRE2_ERROR_ECLASS_UNEXPECTED_OPERATOR => {
			let operator = at.checked_sub(1).and_then(|i| src.bytes.get(i)).map_or('?', |&b| char::from(b));
			return diagnostic(src, &format!("Unexpected binary operator '{operator}' with no preceding operand"), Some(at));
		}
		ffi::PCRE2_ERROR_PERL_ECLASS_UNEXPECTED_EXPR => {
			if at.checked_sub(1).and_then(|i| src.bytes.get(i)) == Some(&b'(') { "Unexpected '(' with no preceding operator" }
			else { "Operand with no preceding operator" }
		}
		ffi::PCRE2_ERROR_PERL_ECLASS_UNEXPECTED_CHAR => "Unexpected character",
		ffi::PCRE2_ERROR_PERL_ECLASS_MISSING_CLOSE => "Unexpected ']' with no following ')' in (?[...",
		ffi::PCRE2_ERROR_PERL_ECLASS_EMPTY_EXPR | ffi::PCRE2_ERROR_ECLASS_EXPECTED_OPERAND => {
			let before = at.checked_sub(1).filter(|&i| src.bytes.get(i) == Some(&b']')).unwrap_or(at);
			return diagnostic(src, "Incomplete expression within '(?[ ])'", Some(before));
		}
		ffi::PCRE2_ERROR_UNMATCHED_CLOSING_PARENTHESIS if src.bytes.get(..at).is_some_and(|b| b.windows(3).any(|w| w == b"(?[")) => "Unexpected ')'",
		ffi::PCRE2_ERROR_BACKSLASH_K_IN_LOOKAROUND => "\\K not permitted in lookahead/lookbehind",
		ffi::PCRE2_ERROR_LOOKBEHIND_NOT_FIXED_LENGTH | ffi::PCRE2_ERROR_MAX_VAR_LOOKBEHIND_EXCEEDED => {
			return diagnostic(src, "Lookbehind longer than 255 not implemented", None);
		}
		ffi::PCRE2_ERROR_UNKNOWN_UNICODE_PROPERTY => {
			let raw = src.bytes.get(..at).unwrap_or_default();
			if let Some(start) = raw.iter().rposition(|&b| b == b'{') {
				let name = raw.get(start + 1..).unwrap_or_default().strip_suffix(b"}").unwrap_or(&raw[start + 1..]);
				return diagnostic(src, &format!("Can't find Unicode property definition \"{}\"", String::from_utf8_lossy(name)), Some(at));
			}
			return diagnostic(src, &error_message(error), Some(at));
		}
		_ => return diagnostic(src, &error_message(error), Some(at)),
	};
	diagnostic(src, reason, Some(at))
}

#[cfg(test)]
mod tests {
	use super::*;

	fn rx(p: &str, mods: &[u8]) -> Regex {
		let (flags, _) = RxFlags::parse(mods).unwrap();
		Regex::new(&PStr::from_str(p), flags).unwrap()
	}

	fn match_spans(r: &Regex, s: &PStr) -> Option<Vec<Option<(usize, usize)>>> {
		r.exec(s, 0, ExecOpts::default()).unwrap().map(|mut caps| std::mem::take(&mut caps.spans))
	}

	fn compile_error(p: &str) -> String {
		Regex::new(&PStr::from_str(p), RxFlags::default()).unwrap_err()
	}

	#[test]
	fn references_conditions_and_posix_brackets_follow_perl() {
		assert!(compile_error(r"\g0").starts_with("Reference to invalid group 0 in regex; marked by <-- HERE in m/\\g <-- HERE 0/"));
		assert!(compile_error(r"(a)\g{-2}").starts_with("Reference to nonexistent or unclosed group"));
		assert!(compile_error(r"\87").starts_with("Reference to nonexistent group in regex; marked by <-- HERE in m/\\87 <-- HERE /"));
		assert!(compile_error(r"(.)\g{2147483648}").starts_with("Reference to nonexistent group"));
		assert!(compile_error("(?<%)b").starts_with("Group name must start with a non-digit word character"));
		assert!(compile_error("a**").starts_with("Nested quantifiers in regex; marked by <-- HERE in m/a** <-- HERE /"));
		assert!(compile_error("(*)b").starts_with("Unknown verb pattern ''"));
		assert_eq!(match_spans(&rx("(?(1)b|a)", b""), &PStr::from_str("a")), Some(vec![Some((0, 1))]));
		assert_eq!(match_spans(&rx("(?(*pla:a)a|b)", b""), &PStr::from_str("a")), Some(vec![Some((0, 1))]));
		assert_eq!(match_spans(&rx("([[:]+)", b""), &PStr::from_str("a:[b")), Some(vec![Some((1, 3)); 2]));
		assert_eq!(match_spans(&rx(r"(?<as>as) \k{ as }", b""), &PStr::from_str("as as")), Some(vec![Some((0, 5)), Some((0, 2))]));
		assert_eq!(match_spans(&rx(r"\N{ U+41 }\N{LATIN SMALL LETTER B}", b""), &PStr::from_str("Ab")), Some(vec![Some((0, 2))]));
		assert_eq!(match_spans(&rx(r"\p{InHiragana}", b""), &PStr::from_str("a\u{3042}")), Some(vec![Some((1, 4))]));
		assert_eq!(match_spans(&rx(r"\p{L_}", b""), &PStr::from_str("\u{3400}")), None);
	}

	#[test]
	fn leading_g_tries_only_the_anchor_and_warnings_are_collected() {
		let r = rx(r"\Gb", b"");
		let s = PStr::from_bytes(b"aab");
		assert!(r.exec(&s, 0, ExecOpts { g_anchor: Some(1), ..ExecOpts::default() }).unwrap().is_none());
		assert_eq!(r.exec(&s, 2, ExecOpts { g_anchor: Some(2), ..ExecOpts::default() }).unwrap().unwrap().spans, [Some((2, 3))]);
		let w = rx(r"\q(?c)a{2,1}", b"");
		let texts: Vec<_> = w.warnings().iter().map(|(_, msg)| msg.as_str()).collect();
		assert_eq!(texts, [
			"Unrecognized escape \\q passed through in regex; marked by <-- HERE in m/\\q <-- HERE (?c)a{2,1}/",
			"Useless (?c) - use /gc modifier in regex; marked by <-- HERE in m/\\q(?c <-- HERE )a{2,1}/",
			"Quantifier {n,m} with n > m can't match in regex; marked by <-- HERE in m/\\q(?c)a{2,1} <-- HERE /",
		]);
	}

	#[test]
	fn charset_depends_on_subject_encoding_and_mode() {
		let latin = PStr::from_bytes(b"!\xE9_!");
		let utf = PStr::from_str("!é_!");
		let d = rx(r"(?<run>\w+)", b"d");
		assert_eq!(match_spans(&d, &latin), Some(vec![Some((2, 3)); 2]));
		assert_eq!(match_spans(&d, &utf), Some(vec![Some((1, 4)); 2]));
		assert_eq!(match_spans(&rx(r"(?<run>\w+)", b"u"), &latin), Some(vec![Some((1, 3)); 2]));
		assert_eq!(match_spans(&rx(r"(?<run>\w+)", b"a"), &utf), Some(vec![Some((3, 4)); 2]));
		assert_eq!(match_spans(&rx(r"(?u:\w)|\W", b"d"), &PStr::from_bytes(b"\xE9")), Some(vec![Some((0, 1))]));
		assert_eq!(match_spans(&rx(r"\b(é)\b", b"u"), &utf), None);
		assert_eq!(match_spans(&rx(r"\b(é)\b", b"u"), &PStr::from_str("!é!")), Some(vec![Some((1, 3)); 2]));
	}

	#[test]
	fn large_literal_alternation_retains_word_and_character_matches() {
		let source = format!("(the|are|{})", (255..16_000).rev().filter_map(char::from_u32)
			.map(|c| c.to_string()).collect::<Vec<_>>().join("|"));
		let r = rx(&source, b"");
		assert_eq!(match_spans(&r, &PStr::from_str("the")), Some(vec![Some((0, 3)); 2]));
		assert_eq!(match_spans(&r, &PStr::from_str("ÿ")), Some(vec![Some((0, 2)); 2]));
	}

	#[test]
	fn anchored_endpoint_can_backtrack_without_truncating_the_subject() {
		let r = rx(r"b+(?=b*c)", b"");
		let subject = PStr::from_str("bbc");
		let opts = ExecOpts { anchored: true, required_end: Some(1), ..ExecOpts::default() };
		assert_eq!(r.exec(&subject, 0, opts).unwrap().unwrap().spans, [Some((0, 1))]);
		assert!(r.exec(&subject, 0, ExecOpts { required_end: Some(3), ..opts }).unwrap().is_none());
	}

	#[test]
	fn actions_can_reenter_the_same_compiled_regex() {
		let pattern = PStr::from_str("(?C'a0')z");
		let out = Output { bytes: pattern.bytes.clone(), knots: Vec::new(), cancellable: false };
		let mode = Mode { utf: false, depends_on_unicode: false, ucp: false, locale_unicode: false };
		let code = Code::compile(&pattern, &out, mode, Bounds::default(), true).unwrap();
		let mut inner = |_, _, _, _| 0;
		let mut outer = |index, phase, at, captures: Option<Captures>| {
			assert_eq!(index, 0);
			assert!(phase == ActionPhase::Eval);
			assert_eq!(at, 0);
			assert_eq!(captures.unwrap().spans, [Some((0, 0))]);
			assert!(code.exec(b"z", 0, ExecOpts::default(), false, &|x| x, Some(&mut inner)).unwrap().is_some());
			0
		};
		let found = code.exec(b"z", 0, ExecOpts::default(), false, &|x| x, Some(&mut outer)).unwrap().unwrap();
		assert_eq!(found.spans, [Some((0, 1))]);
	}

	#[test]
	fn jit_matches_empty_byte_and_utf8_subjects() {
		let literal = rx("z", b"");
		let anchor = rx("^$", b"");
		// Repeat past the lazy JIT threshold so both matchers are exercised.
		for _ in 0..4 {
			let mut empty = PStr::default();
			assert!(match_spans(&literal, &empty).is_none());
			assert_eq!(match_spans(&anchor, &empty), Some(vec![Some((0, 0))]));
			empty.upgrade();
			assert!(match_spans(&literal, &empty).is_none());
			assert_eq!(match_spans(&anchor, &empty), Some(vec![Some((0, 0))]));
		}
	}

	#[test]
	fn maps_bridged_latin1_captures_and_start_to_original_offsets() {
		let r = rx(r"\x{100}|(.)", b"d");
		let caps = r.exec(&PStr::from_bytes(b"\xE9\xE9x"), 1, ExecOpts::default()).unwrap().unwrap();
		assert_eq!(caps.spans, vec![Some((1, 2)), Some((1, 2))]);
	}

	#[test]
	fn unicode_and_ascii_restricted_casefolding() {
		let latin1 = PStr::from_bytes(b"\xC9");
		let utf = PStr::from_str("É");
		assert_eq!(match_spans(&rx(r"\x{E9}", b"id"), &latin1), None);
		assert_eq!(match_spans(&rx(r"\x{E9}", b"iu"), &latin1), Some(vec![Some((0, 1))]));
		assert_eq!(match_spans(&rx(r"\x{E9}", b"id"), &utf), Some(vec![Some((0, 2))]));
		let kelvin = PStr::from_str("K");
		assert_eq!(match_spans(&rx("k", b"ia"), &kelvin), Some(vec![Some((0, 3))]));
		assert_eq!(match_spans(&rx("k", b"iaa"), &kelvin), None);
		assert_eq!(match_spans(&rx(r"\w", b"ia"), &kelvin), None);
	}

	#[test]
	fn full_folds_respect_legacy_mode_ascii_strict_and_quantifier_boundaries() {
		let sharp_s = PStr::from_bytes(b"\xDF");
		assert_eq!(match_spans(&rx("ss", b"id"), &sharp_s), None);
		assert_eq!(match_spans(&rx("ss", b"iu"), &sharp_s), Some(vec![Some((0, 1))]));
		assert_eq!(match_spans(&rx("s{2}", b"iu"), &sharp_s), None);
		assert_eq!(match_spans(&rx("ss", b"iaa"), &PStr::from_str("ẞ")), None);
		assert_eq!(match_spans(&rx("ß", b"iaa"), &PStr::from_str("ſſ")), Some(vec![Some((0, 4))]));
		assert_eq!(match_spans(&rx("ssss", b"iu"), &PStr::from_str("ßß")), Some(vec![Some((0, 4))]));
		assert_eq!(match_spans(&rx("[s][s]", b"iu"), &sharp_s), Some(vec![Some((0, 1))]));
		assert_eq!(match_spans(&rx("[ßa]", b"iu"), &PStr::from_str("ASs")), Some(vec![Some((0, 1))]));
		assert_eq!(match_spans(&rx("[ßa]", b"iu"), &PStr::from_str("Ss")), Some(vec![Some((0, 2))]));
		assert_eq!(match_spans(&rx("ffi", b"iu"), &PStr::from_str("fﬁ")), Some(vec![Some((0, 4))]));
	}

	#[test]
	fn branch_reset_aliases_duplicate_names_marks_and_recursion() {
		let r = rx(r"(?|(?<x>a)|(?<y>b))\k<x>(*MARK:chosen)", b"");
		assert_eq!(r.captures_len(), 1);
		assert_eq!(r.names(), &[(Rc::from("x"), vec![1]), (Rc::from("y"), vec![1])]);
		let caps = r.exec(&PStr::from_str("zbbz"), 0, ExecOpts::default()).unwrap().unwrap();
		assert_eq!(caps.spans, [Some((1, 3)), Some((1, 2))]);
		assert_eq!(caps.mark, Some(PStr::from_str("chosen")));
		let r = rx(r"(?<x>.)(?<x>.)\k<x>", b"");
		assert_eq!(r.names(), &[(Rc::from("x"), vec![1, 2])]);
		assert!(match_spans(&r, &PStr::from_str("abb")).is_none());
		assert!(match_spans(&r, &PStr::from_str("aba")).is_some());
		let r = rx(r"(?<x>a(?&x)?b)", b"");
		assert_eq!(match_spans(&r, &PStr::from_str("zaaabbby")), Some(vec![Some((1, 7)); 2]));
	}

	#[test]
	fn notempty_anchors_keep_and_grapheme_boundary() {
		let r = rx(r"(?<g>a*?)|z", b"");
		let s = PStr::from_str("ba");
		let opts = ExecOpts { not_empty_at_start: true, ..ExecOpts::default() };
		assert_eq!(r.exec(&s, 1, opts).unwrap().unwrap().spans[0], Some((1, 2)));
		assert_eq!(r.exec(&s, 0, opts).unwrap().unwrap().spans[0], Some((1, 1)));
		assert_eq!(match_spans(&rx(r"a\Kb(c)?", b""), &PStr::from_str("zabz")), Some(vec![Some((2, 3)), None]));
		assert_eq!(match_spans(&rx(r"b\Z", b""), &PStr::from_str("xb\n")), Some(vec![Some((1, 2))]));
		assert_eq!(match_spans(&rx("b$", b"m"), &PStr::from_str("xb\ny")), Some(vec![Some((1, 2))]));
		assert_eq!(match_spans(&rx(r"\R", b""), &PStr::from_str("x\r\ny")), Some(vec![Some((1, 3))]));
		assert_eq!(match_spans(&rx(r"\X\b{gcb}", b""), &PStr::from_str("a\u{301}b")), Some(vec![Some((0, 3))]));
		assert_eq!(match_spans(&rx(r"\b{gcb}", b""), &PStr::default()), None);
	}

	#[test]
	fn independently_positions_g_and_records_nested_capture_order() {
		let r = rx(r"((a)|b)\G", b"");
		let s = PStr::from_str("abc");
		let opts = ExecOpts { g_anchor: Some(1), ..ExecOpts::default() };
		let found = r.exec(&s, 0, opts).unwrap().unwrap();
		assert_eq!(found.spans, [Some((0, 1)); 3]);
		assert_eq!(found.last_closed, Some(1));
		assert!(r.exec(&s, 0, ExecOpts::default()).unwrap().is_none());
		let r = rx(r"(\w)\G(.)", b"u");
		let found = r.exec(&PStr::from_bytes(b"\xE9x"), 0, opts).unwrap().unwrap();
		assert_eq!(found.spans, [Some((0, 2)), Some((0, 1)), Some((1, 2))]);
	}

	#[test]
	fn perl_escapes_sets_and_stringification() {
		assert_eq!(match_spans(&rx(r"\N{U+61.62}+|\o{141}", b""), &PStr::from_str("zabab")), Some(vec![Some((1, 5))]));
		assert_eq!(match_spans(&rx(r"[c\N{U+61.62}]", b""), &PStr::from_str("zabc")), Some(vec![Some((1, 3))]));
		assert_eq!(match_spans(&rx(r"[^\N{U+61.62}]", b""), &PStr::from_str("ab")), Some(vec![Some((0, 1))]));
		assert_eq!(match_spans(&rx(r"[a-\d]+", b""), &PStr::from_str("x-29a")), Some(vec![Some((1, 5))]));
		assert_eq!(match_spans(&rx(r"[^a\d]+", b""), &PStr::from_str("xj2k")), Some(vec![Some((0, 2))]));
		assert_eq!(match_spans(&rx(r"(?xx:[ab \t#])+ ", b"x"), &PStr::from_str("x#a\tb")), Some(vec![Some((1, 5))]));
		assert_eq!(match_spans(&rx(r"[[:punct:]]+", b"u"), &PStr::from_str("¢!§")), Some(vec![Some((2, 5))]));
		assert_eq!(match_spans(&rx(r"[[:xdigit:]]+", b"u"), &PStr::from_str("ＧＡＦz")), Some(vec![Some((3, 9))]));
		assert_eq!(match_spans(&rx(r"(?[[aq\d] & [^q]])", b""), &PStr::from_str("qza")), Some(vec![Some((2, 3))]));
		assert_eq!(rx("foo", b"piamsnxx").stringify(), PStr::from_str("(?apmsixxn:foo)"));
		assert_eq!(rx("foo # hi", b"x").stringify(), PStr::from_str("(?^x:foo # hi\n)"));
		assert_eq!(rx(r"\x{100}", b"").stringify(), PStr::from_str(r"(?^u:\x{100})"));
		assert_eq!(rx(r"\p{L}", b"").stringify(), PStr::from_str(r"(?^:\p{L})"));
		let bad = Regex::new(&PStr::from_str(r"(??{2 + 2})"), RxFlags::default()).unwrap_err();
		assert!(bad.starts_with("Eval-group not allowed at runtime, use re 'eval' in regex"));
		assert_eq!(Regex::new(&PStr::from_str("("), RxFlags::default()).unwrap_err(), "Unmatched ( in regex; marked by <-- HERE in m/( <-- HERE /");
	}

	#[test]
	fn checkpoints_keep_matches_and_observe_cancellation() {
		// Quantified groups gain a checkpoint without changing captures.
		let r = rx(r"(?:(a)|b)+?(\d{2,}?)(x*)(?1)*$", b"");
		let long = format!("{}ba123xxaa", "y".repeat(CHECKPOINT_SUBJECT));
		let n = CHECKPOINT_SUBJECT;
		assert_eq!(match_spans(&r, &PStr::from_str(&long)), Some(vec![Some((n, n + 9)), Some((n + 1, n + 2)), Some((n + 2, n + 5)), Some((n + 5, n + 7))]));
		assert_eq!(match_spans(&r, &PStr::from_str("ba123xxaa")), Some(vec![Some((0, 9)), Some((1, 2)), Some((2, 5)), Some((5, 7))]));
		let subject = PStr::from_bytes(&b"x".repeat(200_000));
		let quadratic = rx(r"(?:x(?=x*y))+", b"");
		let flag = Arc::new(AtomicBool::new(true));
		install_cancel_flag(&flag);
		let started = std::time::Instant::now();
		assert_eq!(quadratic.exec(&subject, 0, ExecOpts::default()).unwrap_err(), CANCELLED);
		assert!(started.elapsed() < std::time::Duration::from_secs(1));
		// A pattern without repetition has no checkpoints and is unaffected.
		assert!(rx("xx", b"").exec(&subject, 0, ExecOpts::default()).unwrap().is_some());
		flag.store(false, Ordering::Relaxed);
		assert!(rx(r"(?:x(?=x*y))+", b"").exec(&PStr::from_str("xxy"), 0, ExecOpts::default()).unwrap().is_some());
		remove_cancel_flag(&flag);
	}
}
