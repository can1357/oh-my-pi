//! Contextual Perl parser. Statement grammar follows perlsyn, perlsub, perlmod and perlform;
//! the Pratt expression parser follows perlop, and interpolation follows perlop's quote rules.

mod expr;
mod quote;

use std::{collections::HashMap, fmt, rc::Rc};

use super::{
	ast::{self, *},
	lexer::{Kind, LexError, Lexer, QuoteScan, Token, ident_unit, line_end, name_end, unit},
	value::PStr,
};

/// Exposes the compile-time environment to a reentrant Perl parser.
pub trait ParseHooks {
	/// Called immediately after a `use` or `no` statement; registers names it imported into `pkg`.
	fn use_module(&mut self, stmt: &ast::Stmt, pkg: &str) -> Result<Vec<Imported>, String>;
	/// Called immediately after a `BEGIN` body is compiled, before the next statement is parsed.
	fn begin_block(&mut self, block: &Rc<ast::Block>, pkg: &str) -> Result<(), String>;
	/// Register a non-BEGIN phase block as soon as its body has been compiled.
	fn phase_block(&mut self, _phase: ast::Phase, _block: &Rc<ast::Block>, _pkg: &str) -> Result<(), String> { Ok(()) }
	/// Register a format declaration during compilation, whether or not its scope executes.
	fn format_decl(&mut self, _fmt: &ast::Format, _pkg: &str) -> Result<(), String> { Ok(()) }
	/// Look up a fully qualified sub: `None` is unknown; `Some(None)` is known without a prototype.
	fn sub_prototype(&self, qualified: &str) -> Option<Option<PStr>>;
	/// Imported sub from a prior compilation unit, eligible to override an implicit builtin.
	/// As in `sub_prototype`, the outer option distinguishes an unknown name from a known sub.
	fn imported_sub_prototype(&self, _pkg: &str, _name: &str) -> Option<Option<PStr>> { None }
	/// Enter a lexical scope; balanced by `leave_scope` even if parsing fails.
	fn enter_scope(&mut self) {}
	/// Leave the innermost lexical scope.
	fn leave_scope(&mut self) {}
	/// Publish a complete named declaration before later code or its BEGIN phase runs.
	fn declare_sub(&mut self, _sub: &ast::Subroutine, _pkg: &str) -> Result<(), String> { Ok(()) }
	/// Publish a variable declaration as soon as its AST node is formed, before the initializer.
	/// The name `Rc`s in `decl` are the same allocations retained by the AST.
	fn lexical_decl(&mut self, _decl: &ast::Expr, _pkg: &str) {}
	/// Register a package before compiling its body or later declarations, even if it is empty.
	fn declare_package(&mut self, _name: &str) {}
	/// Emit a compile-time warning of `category` when the lexical warnings being compiled (or
	/// `-w`/`$^W` outside any `use warnings`) enable it; `default_on` marks perl's default
	/// diagnostics, enabled unless explicitly disabled. `text` is complete, location and final
	/// newline included. `Err(text)` (a FATAL category) aborts the compilation with that text.
	fn compile_warning(&mut self, _category: &str, _default_on: bool, _text: String) -> Result<(), String> { Ok(()) }
	/// Whether a package (stash) of this name exists, for typed declarations (`my Class $x`).
	fn package_exists(&self, _name: &str) -> bool { true }
	/// Whether `%CLASS::FIELDS` (the `fields` pragma) has `field`, for subscripts of typed
	/// lexicals (`my CLASS $x; $x->{field}`); `None` when the class has no `%FIELDS`.
	fn class_field(&self, _class: &str, _field: &str) -> Option<bool> { None }
	/// Whether package `pkg` has a defined, non-imported sub `name` without the `:method`
	/// attribute, so a bare builtin of the same name is ambiguous (warning "ambiguous").
	fn sub_hides_builtin(&self, _pkg: &str, _name: &str) -> bool { false }
	/// `package NAME VERSION`: perl sets `$NAME::VERSION` while compiling (op.c package_version).
	fn package_version(&mut self, _name: &str, _version: &PStr) {}
	/// Whether an unqualified variable name resolves to a lexical (`my`/`state`) in the scope
	/// being compiled, for op descriptions ("private array" rather than "array dereference").
	fn is_lexical(&self, _sigil: ast::Sigil, _name: &str) -> bool { false }
	/// `\N{NAME}` through a custom translator (`$^H{charnames}`, perlapi/charnames "CUSTOM
	/// TRANSLATORS") in the scope being compiled: `None` when there is none, else its result
	/// or the error text it raised.
	fn custom_charname(&mut self, _name: &str) -> Option<Result<PStr, String>> { None }
}

/// A subroutine made available while compiling a module import.
pub struct Imported {
	/// Qualified name in the destination package.
	pub name: Rc<str>,
	/// Imported prototype, distinguishing no prototype from the empty prototype.
	pub prototype: Option<PStr>,
}

/// Parse without an interpreter (parser tests). The parser still records declarations within the input unit.
#[cfg(test)]
#[derive(Debug, Default)]
pub struct NoHooks;

#[cfg(test)]
impl ParseHooks for NoHooks {
	fn use_module(&mut self, _stmt: &Stmt, _pkg: &str) -> Result<Vec<Imported>, String> { Ok(Vec::new()) }
	fn begin_block(&mut self, _block: &Rc<Block>, _pkg: &str) -> Result<(), String> { Ok(()) }
	fn sub_prototype(&self, _qualified: &str) -> Option<Option<PStr>> { None }
}

/// Compile-time diagnostic, with the logical location and optional nearby source spelling.
#[derive(Clone, Debug)]
pub struct ParseError {
	/// Diagnostic message before the location suffix.
	pub message: String,
	/// Logical source location of the error.
	pub location: Location,
	/// Source excerpt for a syntax error, if not at EOF.
	pub near: Option<PStr>,
	/// File supplied to the parser (used in the compilation-aborted diagnostic).
	pub file: Rc<str>,
	/// Whether the error was reported at end of input.
	pub eof: bool,
	fatal: bool,
	missing_delimiter: bool,
	/// Earlier queued (yyerror) diagnostics, each a complete line, reported before this one.
	queued: Vec<String>,
}

impl ParseError {
	/// The diagnostic line without the compilation-aborted trailer.
	fn headline(&self) -> String {
		let mut line = format!("{} at {} line {}", self.message, self.location.file, self.location.line);
		if let Some(near) = &self.near {
			line.push_str(&format!(", near \"{}\"\n", near.to_string_lossy()));
		} else if self.eof {
			line.push_str(", at EOF\n");
		} else {
			line.push_str(".\n");
		}
		line
	}
}

impl fmt::Display for ParseError {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		for line in &self.queued { f.write_str(line)?; }
		if self.missing_delimiter {
			writeln!(f, "Missing right curly or square bracket at {} line {}, at end of line", self.location.file, self.location.line)?;
		}
		write!(f, "{} at {} line {}", self.message, self.location.file, self.location.line)?;
		if let Some(near) = &self.near {
			write!(f, ", near \"{}\"", near.to_string_lossy())?;
		} else if self.eof {
			write!(f, ", at EOF")?;
		} else {
			write!(f, ".")?;
		}
		writeln!(f)?;
		if !self.fatal { writeln!(f, "Execution of {} aborted due to compilation errors.", self.file)?; }
		Ok(())
	}
}

impl std::error::Error for ParseError {}

/// Parse a Perl source unit on line 1, initially in package `pkg` (`main` for a program; the
/// requiring package for `require`/`do FILE`).
pub fn parse_program(src: &[u8], file: &str, pkg: &str, hooks: &mut dyn ParseHooks) -> Result<ast::Program, ParseError> {
	let (tail, little) = if let Some(src) = src.strip_prefix(b"\xff\xfe") { (src, true) }
		else if let Some(src) = src.strip_prefix(b"\xfe\xff") { (src, false) }
		else {
			match src.get(..4) {
				Some([0, a, 0, b]) if *a != 0 && *b != 0 => (src, false),
				Some([a, 0, b, 0]) if *a != 0 && *b != 0 => (src, true),
				_ => return Parser::new(src, file.into(), 1, pkg.into(), ParseHints::default(), hooks).program(),
			}
		};
	let mut pairs = tail.chunks_exact(2);
	let words = pairs.by_ref().map(|b| if little { u16::from_le_bytes([b[0], b[1]]) } else { u16::from_be_bytes([b[0], b[1]]) });
	let decoded: Result<String, _> = char::decode_utf16(words).collect();
	let hints = ParseHints { utf8: true, ..ParseHints::default() };
	match decoded {
		Ok(decoded) if pairs.remainder().is_empty() => Parser::new(decoded.as_bytes(), file.into(), 1, pkg.into(), hints, hooks).program(),
		_ => Err(Parser::new(src, file.into(), 1, pkg.into(), hints, hooks)
			.diagnostic(Location { file: file.into(), line: 1 }, "Malformed UTF-16 character".into())),
	}
}

/// Compile code groups embedded in an already-interpolated runtime regexp.
/// No quote delimiters or second interpolation are applied; `extended` controls `#` comments.
pub fn parse_regex_eval(src: &PStr, file: &str, line: u32, pkg: &str, hints: ParseHints, extended: bool, hooks: &mut dyn ParseHooks) -> Result<ast::Program, ParseError> {
	// The pattern's encoding describes its characters, while the caller's hint
	// can also enable UTF-8 identifiers in code groups. Upgrade Latin-1 bytes
	// before combining these modes rather than reinterpreting them as UTF-8.
	let upgraded;
	let src = if hints.utf8 && !src.utf8 && !src.bytes.is_ascii() {
		upgraded = {
			let mut text = src.clone();
			text.upgrade();
			text
		};
		&upgraded
	} else { src };
	let hints = ParseHints { utf8: hints.utf8 || src.utf8, ..hints };
	let mut parser = Parser::new(&[], file.into(), line, pkg.into(), hints, hooks);
	parser.string_eval = true;
	let result = parser.scope(|parser| parser.regex_eval_program(src, extended));
	parser.finish(result)
}

/// Parse string eval at the caller's location, package and lexical hints.
/// A UTF-8 flagged eval string is read as characters independently of the caller's source encoding.
pub fn parse_eval(src: &PStr, file: &str, line: u32, pkg: &str, mut hints: ParseHints, hooks: &mut dyn ParseHooks) -> Result<ast::Program, ParseError> {
	hints.utf8 |= src.utf8;
	let mut parser = Parser::new(&src.bytes, file.into(), line, pkg.into(), hints, hooks);
	parser.string_eval = true;
	parser.program()
}

type ResultOf<T> = Result<T, ParseError>;

/// Lexical compilation hints. Pass the active value from the caller to string eval.
#[derive(Clone, Copy, Debug, Default)]
pub struct ParseHints {
	/// Read source identifiers and literals as UTF-8.
	pub utf8: bool,
	/// Active `strict` categories, also tracked by the lexical resolver.
	pub strict: StrictHints,
	signatures: bool,
	switch: bool,
	say: bool,
	state: bool,
	fc: bool,
	current_sub: bool,
	evalbytes: bool,
	isa: bool,
	postderef_qq: bool,
	bitwise: bool,
	try_catch: bool,
	declared_refs: bool,
	refaliasing: bool,
	indirect: Option<bool>,
}

/// Categories independently enabled by the `strict` pragma.
#[derive(Clone, Copy, Debug, Default)]
pub struct StrictHints {
	/// Require declaration or qualification of package variables.
	pub vars: bool,
	/// Disallow most unqualified barewords as strings.
	pub subs: bool,
	/// Disallow symbolic references.
	pub refs: bool,
}

impl StrictHints {
	fn all(flag: bool) -> Self { Self { vars: flag, subs: flag, refs: flag } }

	fn set(&mut self, name: &[u8], flag: bool) {
		match name {
			b"vars" => self.vars = flag,
			b"subs" => self.subs = flag,
			b"refs" => self.refs = flag,
			_ => {}
		}
	}
}

impl ParseHints {
	/// Apply `use VERSION` (feature bundle and, since 5.12, implicit strict).
	pub fn set_version(&mut self, version: &[u8]) {
		let (major, minor) = self.set_bundle(version);
		if major > 5 || major == 5 && minor >= 12 { self.strict = StrictHints::all(true); }
	}

	fn set_bundle(&mut self, version: &[u8]) -> (u32, u32) {
		let mut groups = version.strip_prefix(b"v").unwrap_or(version).split(|&b| b == b'.');
		let major = groups.next().and_then(decimal).unwrap_or(0);
		let raw_minor = groups.next().unwrap_or_default();
		let minor = if !version.starts_with(b"v") && groups.next().is_none() {
			// A decimal Perl version has exactly three positions per component.
			raw_minor.iter().copied().filter(u8::is_ascii_digit).chain(std::iter::repeat(b'0')).take(3)
				.fold(0, |n, digit| n * 10 + u32::from(digit - b'0'))
		} else { decimal(raw_minor).unwrap_or(0) };
		// feature.pm: an odd (development) minor selects the next stable bundle.
		let bundle = minor + minor % 2;
		self.switch = major > 5 || major == 5 && bundle >= 10;
		self.say = self.switch;
		self.state = self.switch;
		self.fc = major > 5 || major == 5 && bundle >= 16;
		self.current_sub = self.fc;
		self.evalbytes = self.fc;
		self.isa = false;
		self.postderef_qq = major > 5 || major == 5 && bundle >= 24;
		self.bitwise = major > 5 || major == 5 && bundle >= 28;
		self.try_catch = false;
		self.signatures = false;
		self.declared_refs = false;
		self.refaliasing = false;
		self.indirect = None;
		(major, minor)
	}

	/// Set a syntax feature, e.g. `b"signatures"`, or enable a `b":5.34"` feature bundle.
	pub fn set_feature(&mut self, name: &[u8], flag: bool) {
		match name {
			b"signatures" => self.signatures = flag,
			b"switch" => self.switch = flag,
			b"say" => self.say = flag,
			b"state" => self.state = flag,
			b"fc" => self.fc = flag,
			b"current_sub" => self.current_sub = flag,
			b"evalbytes" => self.evalbytes = flag,
			b"isa" => self.isa = flag,
			b"postderef_qq" => self.postderef_qq = flag,
			b"bitwise" => self.bitwise = flag,
			b"try" => self.try_catch = flag,
			b"declared_refs" => self.declared_refs = flag,
			b"refaliasing" => self.refaliasing = flag,
			b"indirect" => self.indirect = Some(flag),
			_ if name.starts_with(b":5.") && flag => { self.set_bundle(&name[1..]); }
			b":all" => {
				self.signatures = flag;
				self.switch = flag;
				self.say = flag;
				self.state = flag;
				self.fc = flag;
				self.current_sub = flag;
				self.evalbytes = flag;
				self.isa = flag;
				self.postderef_qq = flag;
				self.bitwise = flag;
				self.try_catch = flag;
				self.declared_refs = flag;
				self.refaliasing = flag;
				self.indirect = Some(flag);
			}
			_ => {}
		}
	}
}

#[derive(Default)]
struct PackageSub {
	prototype: Option<PStr>,
	imported: bool,
}

#[derive(Default)]
struct Symbols {
	package: HashMap<Rc<str>, HashMap<Rc<str>, PackageSub>>,
	lexical: Vec<HashMap<Rc<str>, LexicalSub>>,
	// Declared scalars per scope, with the class of a typed declaration (`my CLASS $x`).
	typed: Vec<HashMap<Rc<str>, Option<Rc<str>>>>,
}

struct LexicalSub {
	prototype: Option<PStr>,
	scope: DeclKind,
	// `our sub NAME`: the package sub it aliases, which later `sub NAME {...}` bodies define.
	package_name: Option<Rc<str>>,
}

// Use a fresh stack before Rust's inline parser frames exhaust the thread's stack. The
// separate depth budget also bounds the resulting tree for callers that drop it normally.
const STACK_RED_ZONE: usize = 256 * 1024;
const STACK_SEGMENT: usize = 4 * 1024 * 1024;
const MAX_DEPTH: usize = 512;

struct Parser<'s, 'h> {
	lex: Lexer<'s>,
	file: Rc<str>,
	pkg: Rc<str>,
	hooks: &'h mut dyn ParseHooks,
	symbols: Symbols,
	features: ParseHints,
	look: Option<Token>,
	previous: Option<Token>,
	penultimate: Option<Token>,
	string_eval: bool,
	depth: usize,
	tree_depth: usize,
	// The next statement opens a dereference block (`${ ... }`), where perl expects a term:
	// a leading `{` there is an anonymous hash.
	deref_block_start: bool,
	// yyerror-style diagnostics that did not stop parsing; reported when it ends.
	queued: Vec<ParseError>,
}

impl<'s, 'h> Parser<'s, 'h> {
	fn new(src: &'s [u8], file: Rc<str>, line: u32, pkg: Rc<str>, mut features: ParseHints, hooks: &'h mut dyn ParseHooks) -> Self {
		let lex = Lexer::new(src, file.clone(), line, features.utf8);
		features.utf8 = lex.utf8;
		Self {
			lex, file, pkg, hooks, features, look: None, previous: None, penultimate: None,
			symbols: Symbols::default(), string_eval: false, depth: 0, tree_depth: 0, deref_block_start: false, queued: Vec::new(),
		}
	}

	fn program(mut self) -> ResultOf<Program> {
		let result = self.scope(Self::program_inner);
		self.finish(result)
	}

	fn program_inner(&mut self) -> ResultOf<Program> {
		let location = self.lex.location();
		let package = self.pkg.clone();
		let stmts = self.statements(false)?;
		let token = self.bump();
		let data = match token.kind {
			Kind::Data(end) => Some(DataSection {
				package: if end { "main".into() } else { self.pkg.clone() },
				end,
				bytes: self.lex.source[line_end(self.lex.source, token.end)..].to_vec(),
			}),
			Kind::Eof => None,
			_ => return Err(self.error_at(&token)),
		};
		Ok(Program { file: self.file.clone(), package, body: Block { location, stmts }, data })
	}

	fn depth_error(&self) -> ParseError {
		let location = self.look.as_ref().map_or_else(|| self.lex.location(), |token| token.location.clone());
		self.diagnostic(location, "Parsing code nesting too deep".into())
	}

	fn nested<T>(&mut self, f: impl FnOnce(&mut Self) -> ResultOf<T>) -> ResultOf<T> {
		if self.depth >= MAX_DEPTH { return Err(self.depth_error()); }
		self.depth += 1;
		let previous_tree_depth = std::mem::replace(&mut self.tree_depth, self.depth);
		let result = stacker::maybe_grow(STACK_RED_ZONE, STACK_SEGMENT, || f(self));
		self.depth -= 1;
		self.tree_depth = self.tree_depth.max(previous_tree_depth);
		result
	}

	// Some Pratt nodes grow the left side of a tree without recursing. Count those too;
	// an iterative parse alone would still hand an unbounded recursive Drop to the caller.
	fn wrap_tree(&mut self) -> ResultOf<()> {
		if self.tree_depth >= MAX_DEPTH { return Err(self.depth_error()); }
		self.tree_depth += 1;
		Ok(())
	}

	fn scope<T>(&mut self, f: impl FnOnce(&mut Self) -> ResultOf<T>) -> ResultOf<T> {
		let hints = self.features;
		let pkg = self.pkg.clone();
		self.symbols.lexical.push(HashMap::new());
		self.symbols.typed.push(HashMap::new());
		self.hooks.enter_scope();
		let result = f(self);
		self.hooks.leave_scope();
		self.features = hints;
		self.lex.utf8 = hints.utf8;
		self.pkg = pkg;
		self.symbols.lexical.pop();
		self.symbols.typed.pop();
		result
	}

	fn peek(&mut self) -> Token {
		self.look.get_or_insert_with(|| self.lex.next()).clone()
	}

	fn spelling(&mut self) -> &'s [u8] {
		let token = self.peek();
		self.lex.text(&token)
	}

	fn at(&mut self, word: &[u8]) -> bool {
		self.spelling() == word
	}

	fn bump(&mut self) -> Token {
		let token = self.look.take().unwrap_or_else(|| self.lex.next());
		self.penultimate = self.previous.replace(token.clone());
		token
	}

	fn eat(&mut self, word: &[u8]) -> Option<Token> {
		self.at(word).then(|| self.bump())
	}

	fn expect(&mut self, word: &[u8]) -> ResultOf<Token> {
		if let Some(token) = self.eat(word) { Ok(token) } else { Err(self.error()) }
	}

	fn error(&mut self) -> ParseError {
		let token = self.peek();
		self.error_at(&token)
	}

	fn error_at(&self, token: &Token) -> ParseError {
		if token.kind == Kind::Symbol && self.lex.source.get(token.start).is_some_and(|&b| b >= 0x80 || b.is_ascii_control() && !b.is_ascii_whitespace() && b != 0) {
			return self.unrecognized_char_at(token.start, token.location.clone());
		}
		if matches!(self.lex.text(token), b"<<<<<<<" | b"=======" | b">>>>>>>") {
			let mut error = self.diagnostic(token.location.clone(), "Version control conflict marker".into());
			error.near = Some(self.pstr(self.lex.text(token)));
			return error;
		}
		let eof = token.kind == Kind::Eof ||
			self.string_eval && matches!(self.lex.text(token), b";" | b"}");
		let near = if eof { None } else {
			let start = self.previous.as_ref().filter(|prev| prev.location.line == token.location.line && prev.start < token.start)
				.map_or(token.start, |prev| prev.start);
			let start = start.max(token.end.saturating_sub(80));
			Some(self.pstr(&self.lex.source[start..token.end]))
		};
		ParseError { message: "syntax error".into(), location: token.location.clone(), near, file: self.file.clone(), eof, fatal: false, missing_delimiter: false, queued: Vec::new() }
	}

	fn fatal(&self, location: Location, message: impl Into<String>) -> ParseError {
		let mut error = self.diagnostic(location, message.into());
		error.fatal = true;
		error
	}

	fn unrecognized_char_at(&self, at: usize, location: Location) -> ParseError {
		let src = self.lex.source;
		let cp = unit(src, at, self.lex.utf8).map_or(u32::from(src[at]), |(cp, _)| cp);
		let escaped = if self.lex.utf8 { format!("\\x{{{cp:x}}}") } else { format!("\\x{cp:02X}") };
		let preceding = &src[..at];
		let line = preceding.iter().rposition(|&b| b == b'\n').map_or(preceding, |i| &preceding[i + 1..]);
		// Under `use utf8` the excerpt (10 characters) and the column count characters.
		let starts: Vec<usize> = (0..line.len()).filter(|&i| !self.lex.utf8 || line[i] & 0xc0 != 0x80).collect();
		let start = starts.len().checked_sub(10).map_or(0, |i| starts[i]);
		let excerpt = self.pstr(&line[start..]);
		self.fatal(location, format!(
			"Unrecognized character {escaped}; marked by <-- HERE after {}<-- HERE near column {}",
			excerpt.to_string_lossy(), starts.len() + 1,
		))
	}

	fn diagnostic(&self, location: Location, message: String) -> ParseError {
		ParseError { message, location, near: None, file: self.file.clone(), eof: false, fatal: false, missing_delimiter: false, queued: Vec::new() }
	}

	// Quotes and variables extend the regular token consumed by `bump`. Keep that
	// extent for diagnostics without tokenizing inside the raw scanner's result.
	fn finish_raw_token(&mut self) {
		if self.look.is_none() && let Some(token) = &mut self.previous {
			token.end = self.lex.pos;
		}
	}

	fn argument_error(&mut self, message: String, parens: bool) -> ParseError {
		let next = self.peek();
		if !parens {
			let mut error = self.error_at(&next);
			error.message = message;
			return error;
		}
		// Parenthesized calls reduce before consuming the following token, but
		// Perl has already scanned trivia beyond the closing parenthesis.
		let Some(close) = &self.previous else { return self.diagnostic(next.location, message); };
		let src = self.lex.source;
		let mut start = close.start;
		if let Some(arg) = &self.penultimate {
			if arg.location.line == close.location.line && arg.location.file == close.location.file || self.lex.text(arg) == b"(" {
				start = arg.start;
			} else if arg.location.file == close.location.file &&
				let Some(last_newline) = src[arg.start..arg.end].iter().rposition(|&b| b == b'\n')
			{
				start = arg.start + last_newline + 1;
			}
		}
		let start = start.max(close.end.saturating_sub(80));
		let near = self.pstr(&src[start..next.start]);
		ParseError { message, location: next.location, near: Some(near), file: self.file.clone(), eof: false, fatal: false, missing_delimiter: false, queued: Vec::new() }
	}

	fn lex_error(&self, err: LexError) -> ParseError { self.fatal(err.location, err.message) }

	fn pstr(&self, bytes: &[u8]) -> PStr {
		PStr::new(bytes.to_vec(), self.lex.utf8 && !bytes.is_ascii())
	}

	fn name(&self, bytes: &[u8]) -> Rc<str> {
		if bytes.contains(&b'\'') {
			String::from_utf8_lossy(bytes).replace('\'', "::").into()
		} else if bytes.starts_with(b"::") {
			format!("main{}", String::from_utf8_lossy(bytes)).into()
		} else {
			String::from_utf8_lossy(bytes).as_ref().into()
		}
	}

	fn record_package_sub(&mut self, name: &Rc<str>, prototype: Option<PStr>, imported: bool) {
		let (pkg, short) = if let Some((pkg, short)) = name.rsplit_once("::") {
			let pkg = if pkg.is_empty() { "main" } else { pkg };
			(if pkg == self.pkg.as_ref() { self.pkg.clone() } else { pkg.into() }, short.into())
		} else {
			(self.pkg.clone(), name.clone())
		};
		let sub = self.symbols.package.entry(pkg).or_default().entry(short).or_default();
		sub.prototype = prototype;
		// Redefinition changes the implementation and prototype, not the import marker.
		sub.imported |= imported;
	}

	fn lexical_prototype(&self, name: &str) -> Option<&Option<PStr>> {
		if name.contains("::") { return None; }
		self.symbols.lexical.iter().rev().find_map(|scope| scope.get(name)).map(|sub| &sub.prototype)
	}

	/// The package sub a visible `our sub NAME` aliases.
	fn our_sub_name(&self, name: &str) -> Option<Rc<str>> {
		if name.contains("::") { return None; }
		self.symbols.lexical.iter().rev().find_map(|scope| scope.get(name)).and_then(|sub| sub.package_name.clone())
	}

	/// The declarator of the innermost visible `my sub NAME` / `state sub NAME`.
	fn lexical_sub_scope(&self, name: &str) -> Option<DeclKind> {
		if name.contains("::") { return None; }
		self.symbols.lexical.iter().rev().find_map(|scope| scope.get(name)).map(|sub| sub.scope)
			.filter(|scope| matches!(scope, DeclKind::My | DeclKind::State))
	}

	fn imported_prototype(&self, name: &str) -> Option<Option<PStr>> {
		self.symbols.package.get(&self.pkg).and_then(|pkg| pkg.get(name))
			.filter(|sub| sub.imported).map(|sub| sub.prototype.clone())
			.or_else(|| self.hooks.imported_sub_prototype(&self.pkg, name))
	}

	fn prototype(&self, name: &str) -> Option<Option<PStr>> {
		if let Some(proto) = self.lexical_prototype(name) { return Some(proto.clone()); }
		let explicit = name.rsplit_once("::");
		let (pkg, short) = explicit.unwrap_or((&self.pkg, name));
		let pkg = if pkg.is_empty() { "main" } else { pkg };
		if let Some(sub) = self.symbols.package.get(pkg).and_then(|symbols| symbols.get(short)) {
			return Some(sub.prototype.clone());
		}
		if explicit.is_some() {
			self.hooks.sub_prototype(name)
		} else {
			self.hooks.sub_prototype(&format!("{pkg}::{short}"))
		}
	}

	fn ident(&mut self) -> ResultOf<Rc<str>> {
		let token = self.peek();
		if !self.is_word(&token) { return Err(self.error_at(&token)); }
		if token.end - token.start > 251 { return Err(self.fatal(token.location, "Identifier too long")); }
		self.bump();
		Ok(self.name(self.lex.text(&token)))
	}

	fn after_space(&self, at: usize) -> usize { after_space(self.lex.source, at) }

	fn is_word(&self, token: &Token) -> bool {
		token.kind == Kind::Word || token.kind == Kind::Number && short_v(self.lex.text(token))
	}

	fn is_label(&self, token: &Token) -> bool {
		let word = self.lex.text(token);
		// `sub :ATTR {...}` opens an anonymous sub; perl reads it as a label only at a statement
		// start, where the anonymous sub would be useless, but not inside `&{...}`/`map {...}`.
		if !self.is_word(token) || word.contains(&b':') || word.contains(&b'\'') || quote_word(word) || word == b"sub" { return false; }
		let at = self.after_space(token.end);
		self.lex.source.get(at) == Some(&b':') && self.lex.source.get(at + 1) != Some(&b':')
	}

	fn stmt(&mut self) -> ResultOf<Stmt> {
		self.nested(Self::stmt_inner)
	}

	fn stmt_inner(&mut self) -> ResultOf<Stmt> {
		let term_start = std::mem::take(&mut self.deref_block_start);
		let start = self.peek();
		let mut label = None;
		if self.is_label(&start) {
			label = Some(self.ident()?);
			self.expect(b":")?;
		}
		let location = start.location;
		let token = self.peek();
		// Only the innermost of adjacent labels applies to the following statement.
		if label.is_some() && self.is_label(&token) {
			return Ok(Stmt { location, label, kind: StmtKind::Empty });
		}
		let spelling = self.lex.text(&token);
		let mut terminator = false;
		let mut modifier_allowed = false;
		let fat_comma = token.kind == Kind::Word && self.lex.source.get(self.after_space(token.end)..).is_some_and(|tail| tail.starts_with(b"=>"));
		let kind = match spelling {
			_ if fat_comma => {
				let expr = self.expr(0)?;
				terminator = true;
				modifier_allowed = true;
				StmtKind::Expr(expr)
			}
			b"..." => {
				self.bump();
				terminator = true;
				StmtKind::Expr(Expr { location: token.location, cache: NodeCache::default(), kind: ExprKind::Yada })
			}
			b";" => { self.bump(); StmtKind::Empty }
			b"}" | b"" if label.is_some() => StmtKind::Empty,
			b"{" if !term_start && !self.brace_hash(&token) => {
				let block = self.block()?;
				StmtKind::Block(block, self.continue_block()?)
			}
			b"if" | b"unless" => {
				self.bump();
				let mut arms = vec![(self.condition()?, spelling == b"unless", self.block()?)];
				while self.eat(b"elsif").is_some() { arms.push((self.condition()?, false, self.block()?)); }
				let otherwise = if self.eat(b"else").is_some() { Some(self.block()?) } else { None };
				StmtKind::If(arms, otherwise)
			}
			b"while" | b"until" => {
				self.bump();
				let cond = self.loop_condition(spelling == b"while")?;
				let block = self.block()?;
				StmtKind::While(cond, spelling == b"until", block, self.continue_block()?)
			}
			b"for" | b"foreach" => {
				self.bump();
				self.for_loop()?
			}
			b"given" | b"when" | b"CORE::given" | b"CORE::when" if self.features.switch || spelling.starts_with(b"CORE::") => {
				self.bump();
				let cond = self.condition()?;
				let body = self.block()?;
				if spelling.ends_with(b"given") { StmtKind::Given(cond, body) } else { StmtKind::When(Some(cond), body) }
			}
			b"default" | b"CORE::default" if self.features.switch || spelling == b"CORE::default" => {
				self.bump();
				StmtKind::When(None, self.block()?)
			}
			b"try" if self.features.try_catch => {
				self.bump();
				let block = self.block()?;
				self.expect(b"catch")?;
				self.expect(b"(")?;
				let exception = self.variable(false)?;
				if !matches!(&exception.kind, ExprKind::Variable(Sigil::Scalar, name) if !name.contains("::")) {
					return Err(self.error());
				}
				self.expect(b")")?;
				StmtKind::Try(block, exception, self.block()?)
			}
			b"package" => {
				self.bump();
				let name = self.ident()?;
				let version = self.package_version(&location)?;
				let previous = std::mem::replace(&mut self.pkg, name.clone());
				self.hooks.declare_package(&name);
				if let Some(version) = &version { self.hooks.package_version(&name, version); }
				let block = if self.at(b"{") {
					let body = self.block()?;
					self.pkg = previous;
					Some(body)
				} else { terminator = true; None };
				StmtKind::Package(Package { name, version, block })
			}
			b"use" | b"no" => {
				self.bump();
				let item = self.use_stmt(spelling == b"no")?;
				// Consume `;` before changing lexical hints; do not pre-tokenize past it.
				self.terminator()?;
				self.use_hints(&item);
				let stmt = Stmt { location, label, kind: StmtKind::Use(Rc::new(item)) };
				let imported = self.hooks.use_module(&stmt, &self.pkg)
					.map_err(|message| self.diagnostic(stmt.location.clone(), message))?;
				for Imported { name, prototype } in imported { self.record_package_sub(&name, prototype, true); }
				return Ok(stmt);
			}
			b"format" => {
				self.bump();
				let name = if self.at(b"=") { "STDOUT".into() } else { self.declaration_name()? };
				self.expect(b"=")?;
				let lines = self.lex.format().map_err(|err| self.lex_error(err))?;
				let format = Format { name, lines: self.pstr(lines) };
				self.hooks.format_decl(&format, &self.pkg).map_err(|message| self.diagnostic(location.clone(), message))?;
				StmtKind::Format
			}
			word if phase(word).is_some() && self.lex.source.get(self.after_space(token.end)) == Some(&b'{') => {
				self.bump();
				let block = Rc::new(self.block()?);
				let kind = phase(word).ok_or_else(|| self.error_at(&token))?;
				self.on_phase(kind, &block)?;
				StmtKind::Phase(kind, block)
			}
			b"AUTOLOAD" | b"DESTROY" if self.lex.source.get(self.after_space(token.end)) == Some(&b'{') => {
				let sub = self.subroutine(true, None)?;
				self.sub_statement(sub)?
			}
			b"sub" if self.named_sub_after(token.end) => {
				self.bump();
				let sub = self.subroutine(true, None)?;
				terminator = sub.body.is_none();
				self.sub_statement(sub)?
			}
			b"my" | b"our" | b"state" if (spelling != b"state" || self.features.state) &&
				self.lex.source.get(self.after_space(token.end)..).is_some_and(|s| s.starts_with(b"sub") && s.get(3).is_some_and(u8::is_ascii_whitespace)) => {
				self.bump();
				let scope = decl(spelling).ok_or_else(|| self.error_at(&token))?;
				self.expect(b"sub")?;
				let sub = self.subroutine(true, Some(scope))?;
				terminator = sub.body.is_none();
				self.sub_statement(sub)?
			}
			_ => {
				let expr = self.expr(0)?;
				terminator = true;
				modifier_allowed = true;
				StmtKind::Expr(expr)
			}
		};
		let mut stmt = Stmt { location: location.clone(), label, kind };
		if modifier_allowed && let Some(modifier) = self.modifier() {
			self.bump();
			let cond = self.expr(0)?;
			let label = stmt.label.take();
			stmt = Stmt { location, label, kind: StmtKind::Modifier(Box::new(stmt), modifier, cond) };
		}
		if terminator { self.terminator()?; }
		Ok(stmt)
	}

	fn terminator(&mut self) -> ResultOf<()> {
		if self.eat(b";").is_some() || self.at(b"}") || matches!(self.peek().kind, Kind::Eof | Kind::Data(_)) { return Ok(()); }
		let token = self.peek();
		self.operator_expected(&token)?;
		Err(self.error_at(&token))
	}

	/// toke.c's no_op: a term where an operator was expected draws the default-on syntax
	/// warning "TERM found where operator expected" with a hint, before the syntax error.
	fn operator_expected(&mut self, token: &Token) -> ResultOf<()> {
		let text = self.lex.text(token);
		let what = match token.kind {
			Kind::Number => "Number",
			Kind::Word if quote_word(text) => "String",
			Kind::Word if !self.keyword(text) && !matches!(text, b"x" | b"not" | b"isa") => "Bareword",
			Kind::Symbol => match text {
				b"\"" | b"'" => "String",
				b"`" => "Backticks",
				b"$" => "Scalar",
				b"@" => "Array",
				_ => return Ok(()),
			},
			_ => return Ok(()),
		};
		let mut end = token.end;
		if matches!(text, b"\"" | b"'" | b"`") {
			let mut probe = self.lex.clone();
			probe.rewind(token);
			if probe.quote(QuoteScan::Double, None).is_ok() { end = probe.pos; }
		}
		let previous = self.previous.clone();
		let first_on_line = previous.as_ref().is_none_or(|prev| prev.location.line != token.location.line || prev.location.file != token.location.file);
		let start = if first_on_line { token.start } else { previous.as_ref().map_or(token.start, |prev| prev.start) };
		let src = self.lex.source;
		let near = self.pstr(&src[start.max(end.saturating_sub(80))..end]);
		let hint = if first_on_line {
			"Missing semicolon on previous line?".to_owned()
		} else if let Some(prev) = &previous && prev.kind == Kind::Word && src.get(prev.end).is_some_and(u8::is_ascii_whitespace) {
			format!("Do you need to predeclare {}?", self.pstr(self.lex.text(prev)).to_string_lossy())
		} else {
			format!("Missing operator before {}?", self.pstr(text).to_string_lossy())
		};
		let message = format!(
			"{what} found where operator expected at {} line {}, near \"{}\"\n\t({hint})\n",
			token.location.file, token.location.line, near.to_string_lossy(),
		);
		self.hooks.compile_warning("syntax", true, message).map_err(|_| {
			let mut error = self.error_at(token);
			error.message = format!("{what} found where operator expected");
			error
		})
	}

	fn statements(&mut self, in_block: bool) -> ResultOf<Vec<Stmt>> {
		let mut stmts = Vec::new();
		loop {
			let t = self.peek();
			if matches!(t.kind, Kind::Eof | Kind::Data(_)) || in_block && self.lex.text(&t) == b"}" { break; }
			stmts.push(self.stmt()?);
		}
		Ok(stmts)
	}

	fn block(&mut self) -> ResultOf<Block> {
		self.nested(|parser| {
			let open = parser.expect(b"{")?;
			parser.scope(|parser| {
				let stmts = parser.statements(true)?;
				if parser.peek().kind == Kind::Eof {
					let mut error = parser.error();
					error.missing_delimiter = true;
					return Err(error);
				}
				parser.expect(b"}")?;
				Ok(Block { location: open.location, stmts })
			})
		})
	}

	fn continue_block(&mut self) -> ResultOf<Option<Block>> {
		let token = self.peek();
		if self.lex.text(&token) == b"continue" && self.lex.source.get(self.after_space(token.end)) == Some(&b'{') {
			self.bump();
			self.block().map(Some)
		} else { Ok(None) }
	}

	fn condition(&mut self) -> ResultOf<Expr> {
		self.loop_condition(false)
	}

	fn loop_condition(&mut self, empty_is_true: bool) -> ResultOf<Expr> {
		let open = self.expect(b"(")?;
		if empty_is_true && self.eat(b")").is_some() {
			return Ok(Expr { location: open.location, cache: NodeCache::default(), kind: ExprKind::Int(1) });
		}
		let expr = self.expr(0)?;
		self.expect(b")")?;
		Ok(expr)
	}

	fn for_loop(&mut self) -> ResultOf<StmtKind> {
		if let Some(open) = self.eat(b"(") {
			let first = if self.at(b";") || self.at(b")") { None } else { Some(self.expr(0)?) };
			if self.eat(b";").is_some() {
				let cond = if self.at(b";") { None } else { Some(self.expr(0)?) };
				self.expect(b";")?;
				let step = if self.at(b")") { None } else { Some(self.expr(0)?) };
				self.expect(b")")?;
				let body = self.block()?;
				return Ok(StmtKind::For(first, cond, step, body, self.continue_block()?));
			}
			self.expect(b")")?;
			let items = first.unwrap_or(Expr { location: open.location, cache: NodeCache::default(), kind: ExprKind::List(Vec::new()) });
			let body = self.block()?;
			return Ok(StmtKind::Foreach(None, items, body, self.continue_block()?));
		}
		// In a foreach header the parenthesis belongs to the iteration list,
		// not to the prefix backslash's operand expression.
		let reference = self.eat(b"\\");
		if let Some(reference) = &reference && !self.features.refaliasing {
			return Err(self.fatal(reference.location.clone(), "Experimental aliasing via reference not enabled"));
		}
		let word = self.peek();
		if word.kind == Kind::Word && !matches!(self.lex.text(&word), b"my" | b"our" | b"state" | b"CORE::my" | b"CORE::our" | b"CORE::state") {
			let message = if word.end - word.start > 252 { "Identifier too long" } else { "Missing $ on loop variable" };
			return Err(self.fatal(word.location, message));
		}
		// `for \&name (LIST)`: the list is not the call's argument list.
		let mut var = if reference.is_some() && self.at(b"&") { self.variable(false)? } else { self.prefix()? };
		let target = match &var.kind {
			ExprKind::Declare(DeclKind::My | DeclKind::Our | DeclKind::State, _, expr, _) => expr.as_ref(),
			_ => &var,
		};
		let valid = match &target.kind {
			ExprKind::Variable(Sigil::Scalar, _) => true,
			ExprKind::Variable(Sigil::Array | Sigil::Hash | Sigil::Code, _) => reference.is_some(),
			// `for my \$x (LIST)` (declared_refs) aliases like `for \my $x`.
			ExprKind::Unary(Unary::Reference, inner) => matches!(&inner.kind, ExprKind::Variable(Sigil::Scalar | Sigil::Array | Sigil::Hash, _)),
			_ => false,
		};
		if !valid { return Err(self.error()); }
		if let Some(reference) = reference {
			var = Expr { location: reference.location, cache: NodeCache::default(), kind: ExprKind::Unary(Unary::Reference, Box::new(var)) };
		}
		let items = self.delimited_list(b"(", b")", false)?;
		let body = self.block()?;
		Ok(StmtKind::Foreach(Some(var), items, body, self.continue_block()?))
	}

	fn modifier(&mut self) -> Option<Modifier> {
		Some(match self.spelling() {
			b"if" => Modifier::If,
			b"unless" => Modifier::Unless,
			b"while" => Modifier::While,
			b"until" => Modifier::Until,
			b"for" | b"foreach" => Modifier::For,
			b"when" if self.features.switch => Modifier::When,
			b"CORE::when" => Modifier::When,
			_ => return None,
		})
	}

	/// `package NAME VERSION`: the version must be a strict version (toke.c
	/// force_strict_version); anything but `;`, `{` or `}` after the name is checked as one.
	fn package_version(&mut self, location: &Location) -> ResultOf<Option<PStr>> {
		if self.look.is_some() { return Ok(self.version_token()); }
		let src = self.lex.source;
		let start = after_space(src, self.lex.pos);
		if matches!(src.get(start), None | Some(b';' | b'{' | b'}')) { return Ok(None); }
		match strict_version(&src[start..]) {
			Ok(len) => {
				self.lex.advance(start + len);
				Ok(Some(self.pstr(&src[start..start + len])))
			}
			Err(problem) => {
				let mut error = self.diagnostic(location.clone(), format!("Invalid version format ({problem})"));
				let end = line_end(src, start);
				error.near = Some(self.pstr(without_newline(&src[start..end])));
				Err(error)
			}
		}
	}

	fn version_token(&mut self) -> Option<PStr> {
		let token = self.peek();
		if token.kind != Kind::Number { return None; }
		self.bump();
		Some(self.pstr(self.lex.text(&token)))
	}

	fn use_stmt(&mut self, negated: bool) -> ResultOf<Use> {
		if let Some(version) = self.version_token() {
			return Ok(Use { negated, module: None, version: Some(version), args: None });
		}
		let module = self.ident()?;
		let version = self.version_token();
		let args = if self.at(b";") || self.at(b"}") || matches!(self.peek().kind, Kind::Eof | Kind::Data(_)) {
			None
		} else { Some(self.expr(0)?) };
		Ok(Use { negated, module: Some(module), version, args })
	}

	fn use_hints(&mut self, item: &Use) {
		let enabled = !item.negated;
		match item.module.as_deref() {
			None if enabled => {
				if let Some(version) = &item.version { self.features.set_version(&version.bytes); }
			}
			Some("utf8") => {
				self.features.utf8 = enabled;
				self.lex.utf8 = enabled;
			}
			Some("strict") => {
				if let Some(args) = &item.args {
					for_literal_args(args, &mut |name| self.features.strict.set(name, enabled));
				} else {
					self.features.strict = StrictHints::all(enabled);
				}
			}
			Some("feature" | "experimental") => {
				if let Some(args) = &item.args {
					for_literal_args(args, &mut |name| self.features.set_feature(name, enabled));
				} else if item.negated && item.module.as_deref() == Some("feature") {
					let ParseHints { utf8, strict, .. } = self.features;
					self.features = ParseHints { utf8, strict, ..ParseHints::default() };
				}
			}
			_ => {}
		}
	}

	fn on_phase(&mut self, kind: Phase, body: &Rc<Block>) -> ResultOf<()> {
		let result = if kind == Phase::Begin {
			self.hooks.begin_block(body, &self.pkg)
		} else {
			self.hooks.phase_block(kind, body, &self.pkg)
		};
		result.map_err(|message| self.diagnostic(body.location.clone(), message))
	}

	fn sub_statement(&mut self, mut sub: Subroutine) -> ResultOf<StmtKind> {
		// Lexical subs are never special blocks (`state sub BEGIN {...}` is an ordinary sub).
		if !matches!(sub.scope, Some(DeclKind::My | DeclKind::State))
			&& let Some(kind) = sub.name.as_deref().and_then(|s| s.rsplit("::").next()).and_then(|s| phase(s.as_bytes()))
			&& let Some(body) = sub.body.take()
		{
			self.on_phase(kind, &body)?;
			return Ok(StmtKind::Phase(kind, body));
		}
		Ok(StmtKind::Sub(sub))
	}

	fn named_sub_after(&self, end: usize) -> bool {
		let src = self.lex.source;
		let start = self.after_space(end);
		let start = start + usize::from(src.get(start) == Some(&b'\''));
		name_end(src, start, self.lex.utf8).is_some()
	}

	// Old package separators are allowed at the beginning of sub and format names,
	// but a standalone apostrophe in expression position still opens a quote.
	fn declaration_name(&mut self) -> ResultOf<Rc<str>> {
		let tick = self.eat(b"'");
		if let Some(tick) = tick && self.peek().start != tick.end { return Err(self.error()); }
		self.ident()
	}

	fn subroutine(&mut self, named: bool, mut scope: Option<DeclKind>) -> ResultOf<Subroutine> {
		let location = self.peek().location;
		let mut name = if named { Some(self.declaration_name()?) } else { None };
		// pad.c pad_check_dup: a second `my`/`state sub NAME` in one scope gets a new pad entry.
		if let Some(kind @ (DeclKind::My | DeclKind::State)) = scope && let Some(short) = &name
			&& self.symbols.lexical.last().is_some_and(|visible| visible.contains_key(short))
		{
			let keyword = if kind == DeclKind::My { "my" } else { "state" };
			let message = format!("\"{keyword}\" subroutine &{short} masks earlier declaration in same scope");
			let text = format!("{message} at {} line {}.\n", location.file, location.line);
			self.hooks.compile_warning("shadow", false, text).map_err(|_| self.fatal(location.clone(), message))?;
		}
		// perlsub: after `our sub NAME;`, a plain `sub NAME {...}` defines that package's sub;
		// after `my sub NAME;` / `state sub NAME;` it defines the lexical sub.
		if scope.is_none() && let Some(short) = &name && !short.contains("::") {
			if let Some(aliased) = self.our_sub_name(short) {
				name = Some(aliased);
			} else if let Some(lexical) = self.lexical_sub_scope(short) {
				scope = Some(lexical);
			}
		}
		let mut attributes = Vec::new();
		let mut signature = None;
		let mut prototype = None;
		if self.at(b"(") && !self.features.signatures {
			let location = self.peek().location;
			let proto = self.raw_parens()?;
			let shown = match &name {
				Some(name) if name.contains("::") => name.to_string(),
				Some(name) => format!("{}::{name}", self.pkg),
				None => "?".to_owned(),
			};
			for message in prototype_problems(&proto, &shown) {
				let text = format!("{message} at {} line {}.\n", location.file, location.line);
				self.hooks.compile_warning("illegalproto", false, text).map_err(|_| self.fatal(location.clone(), message))?;
			}
			prototype = Some(proto);
		}
		// toke.c: after the name and prototype come attributes, a signature or body, or the
		// end of a forward declaration; anything later out of place is a syntax error.
		let declaration_end = named && (self.at(b";") || self.at(b"}") || self.peek().kind == Kind::Eof);
		if !declaration_end && !matches!(self.spelling(), b":" | b"{" | b"(") {
			let message = match &name {
				Some(name) if name.contains("::") => format!("Illegal declaration of subroutine {name}"),
				Some(name) => format!("Illegal declaration of subroutine {}::{name}", self.pkg),
				None => "Illegal declaration of anonymous subroutine".to_owned(),
			};
			let location = self.peek().location;
			return Err(self.fatal(location, message));
		}
		if self.eat(b":").is_some() {
			attributes = self.attributes()?;
		}
		if self.at(b"(") && self.features.signatures {
			signature = Some(self.signature()?.into());
			if self.eat(b":").is_some() {
				self.attributes()?;
				let location = self.peek().location;
				return Err(self.fatal(location, "Subroutine attributes must come before the signature"));
			}
		}
		for attr in &attributes {
			if attr.name.as_ref() == "prototype" { prototype.clone_from(&attr.args); }
		}
		if attributes.iter().any(|attr| attr.name.as_ref() == "const") {
			let at = self.peek().location;
			if named { return Err(self.fatal(at, ":const is not permitted on named subroutines")); }
			let text = format!(":const is experimental at {} line {}.\n", at.file, at.line);
			self.hooks.compile_warning("experimental::const_attr", true, text)
				.map_err(|_| self.fatal(at.clone(), ":const is experimental"))?;
		}
		if let Some(proto) = &mut prototype {
			proto.bytes.retain(|b| !b.is_ascii_whitespace());
		}
		// A sub's new prototype is bound at the end of its declaration, not inside
		// its initial body. A forward declaration's prototype still applies there.
		let body = if named && (self.at(b";") || self.at(b"}") || self.peek().kind == Kind::Eof) { None } else {
			if !self.at(b"{") { return Err(self.error()); }
			Some(Rc::new(self.block()?))
		};
		if let Some(name) = &name {
			if scope.is_some() && let Some(visible) = self.symbols.lexical.last_mut() {
				let package_name = (scope == Some(DeclKind::Our)).then(|| format!("{}::{name}", self.pkg).into());
				visible.insert(name.clone(), LexicalSub { prototype: prototype.clone(), scope: scope.unwrap_or(DeclKind::My), package_name });
			}
			if !matches!(scope, Some(DeclKind::My | DeclKind::State)) {
				self.record_package_sub(name, prototype.clone(), false);
			}
		}
		let sub = Subroutine { name, scope, prototype, signature, attributes, body };
		if named {
			self.hooks.declare_sub(&sub, &self.pkg).map_err(|message| self.diagnostic(location, message))?;
		}
		Ok(sub)
	}

	/// A subroutine signature, scanned like toke.c's yyl_sigvar and checked like perly.y's
	/// sigscalarelem/sigslurpelem. Element errors are queued (yyerror) so that each is reported.
	fn signature(&mut self) -> ResultOf<Vec<Parameter>> {
		let open = self.expect(b"(")?;
		let src = self.lex.source;
		let utf8 = self.lex.utf8;
		let mut params: Vec<Parameter> = Vec::new();
		let (mut optional, mut slurpy, mut element_seen) = (false, false, false);
		// yyerror's context starts at the token before the one being scanned.
		let mut context = open.start;
		loop {
			self.unpeek();
			let at = self.after_space(self.lex.pos);
			self.lex.advance(at);
			let location = self.lex.location();
			let sigil = match src.get(at) {
				Some(b')') => { self.bump(); break; }
				Some(b',') => {
					// `(, $a)`; `($a,,$b)` and a trailing comma are allowed.
					if !element_seen { return Err(self.error()); }
					context = at;
					self.bump();
					continue;
				}
				Some(b'$') => Sigil::Scalar,
				Some(b'@') => Sigil::Array,
				Some(b'%') => Sigil::Hash,
				_ => {
					let end = (at + 1).min(src.len());
					self.queue_error(context, end, location, "A signature parameter must start with '$', '@' or '%'");
					self.lex.advance(end);
					let next = self.peek();
					if matches!(self.lex.text(&next), b")" | b",") { element_seen = true; continue; }
					return Err(self.near_error("syntax error", context, next.end.max(end), next.location));
				}
			};
			let after = at + 1;
			self.lex.advance(after);
			match src.get(after) {
				Some(b'$' | b':' | b'@' | b'%' | b'&' | b'*' | b';' | b'\\' | b'[' | b']') => {
					self.queue_error(context, after, location.clone(), "Illegal character following sigil in a subroutine signature");
					let end = src[after..].iter().position(|&b| b == b')').map_or(src.len(), |i| paren_end(src, after + i));
					return Err(self.near_error("syntax error", at, end, location));
				}
				Some(b'#') => {
					self.queue_error(context, after, location, "'#' not allowed immediately following a sigil in a subroutine signature");
					return Err(self.queued_failure());
				}
				_ => {}
			}
			let name_start = self.after_space(after);
			let name_end = ident_unit(src, name_start, utf8, false).map(|len| {
				let mut end = name_start + len;
				while let Some(len) = ident_unit(src, end, utf8, true) { end += len; }
				end
			});
			let name = name_end.map(|end| self.name(&src[name_start..end]));
			let pos = self.after_space(name_end.unwrap_or(name_start));
			self.lex.advance(pos);
			let symbol = match sigil { Sigil::Scalar => '$', Sigil::Array => '@', _ => '%' };
			if let Some(name) = &name {
				// pad.c allocmy: `$_`, `@_`, `%_` are globals.
				if name.as_ref() == "_" {
					self.queue_error(context, pos, location.clone(), &format!("Can't use global {symbol}_ in subroutine signature"));
				} else if params.iter().any(|p| p.sigil == sigil && p.name.as_ref() == Some(name)) {
					let text = format!("\"my\" variable {symbol}{name} masks earlier declaration in same scope at {} line {}.\n", location.file, location.line);
					self.hooks.compile_warning("shadow", false, text)
						.map_err(|_| self.fatal(location.clone(), format!("\"my\" variable {symbol}{name} masks earlier declaration in same scope")))?;
				}
			}
			// toke.c reads the `=` itself, so `==`, `=~`, `=>` and `+=` are not defaults.
			let assign = src.get(pos) == Some(&b'=') && !matches!(src.get(pos + 1), Some(b'=' | b'~' | b'>'));
			if !assign && !matches!(src.get(pos), Some(b',' | b')')) {
				let mut end = (pos + 1).min(src.len());
				while end < src.len() && !matches!(src[end], b'$' | b'@' | b'%' | b')') { end += 1; }
				self.queue_error(context, end, location.clone(), "Illegal operator following parameter in a subroutine signature");
				return Err(self.near_error("syntax error", context, end, location));
			}
			// Start of the element's last token, where its grammar errors' context begins.
			let mut last = at;
			let mut default = None;
			if assign {
				last = pos;
				self.lex.advance(pos + 1);
				if !matches!(src.get(self.after_space(pos + 1)), Some(b',' | b')')) {
					default = Some(self.expr(expr::P_ASSIGN)?);
					if let Some(previous) = &self.previous { last = previous.start; }
				} else if name.is_none() {
					// `$=`: an optional placeholder whose default is never needed.
					default = Some(Expr { location: location.clone(), cache: NodeCache::default(), kind: ExprKind::List(Vec::new()) });
				}
			}
			let next = self.peek();
			if !matches!(self.lex.text(&next), b"," | b")") { return Err(self.error()); }
			let end = if self.lex.text(&next) == b")" { paren_end(src, next.start) } else { next.end };
			let at_next = next.location.clone();
			if sigil == Sigil::Scalar {
				if slurpy { self.queue_error(last, end, at_next.clone(), "Slurpy parameter not last"); }
				if assign {
					optional = true;
					if default.is_none() && name.is_some() { self.queue_error(last, end, at_next, "Optional parameter lacks default expression"); }
				} else if optional {
					self.queue_error(last, end, at_next, "Mandatory parameter follows optional parameter");
				}
			} else {
				if slurpy { self.queue_error(last, end, at_next.clone(), "Multiple slurpy parameters not allowed"); }
				slurpy = true;
				if assign { self.queue_error(last, end, at_next, "A slurpy parameter may not have a default value"); }
			}
			element_seen = true;
			params.push(Parameter { sigil, name, default });
		}
		Ok(params)
	}

	/// Return a peeked token to the lexer, so raw scanning resumes at its start.
	fn unpeek(&mut self) {
		if let Some(token) = self.look.take() { self.lex.rewind(&token); }
	}

	fn near_error(&self, message: &str, start: usize, end: usize, location: Location) -> ParseError {
		let src = self.lex.source;
		let end = end.min(src.len());
		let mut error = self.diagnostic(location, message.to_owned());
		if start < end { error.near = Some(self.pstr(&src[start..end])); } else { error.eof = true; }
		error
	}

	/// Record a yyerror-style diagnostic; parsing continues and the program fails at the end.
	fn queue_error(&mut self, start: usize, end: usize, location: Location, message: &str) {
		let error = self.near_error(message, start, end, location);
		self.queued.push(error);
	}

	/// Stop at the most recently queued error.
	fn queued_failure(&mut self) -> ParseError {
		self.queued.pop().unwrap_or_else(|| self.error())
	}

	/// Combine queued diagnostics with the parse result: every message is reported, in order.
	fn finish<T>(&mut self, result: ResultOf<T>) -> ResultOf<T> {
		if self.queued.is_empty() { return result; }
		let mut queued = std::mem::take(&mut self.queued);
		let mut error = match result {
			Err(error) => error,
			Ok(_) => queued.pop().expect("queued errors"),
		};
		let mut lines: Vec<String> = queued.iter().map(ParseError::headline).collect();
		lines.append(&mut error.queued);
		error.queued = lines;
		Err(error)
	}

	fn raw_parens(&mut self) -> ResultOf<PStr> {
		let open = self.expect(b"(")?;
		self.lex.rewind(&open);
		let quote = self.lex.quote(QuoteScan::Double, None).map_err(|err| self.lex_error(err))?;
		Ok(PStr::new(quote.bytes.into_owned(), self.lex.utf8))
	}

	fn attributes(&mut self) -> ResultOf<Vec<Attribute>> {
		let mut attrs = Vec::new();
		while self.peek().kind == Kind::Word {
			let token = self.peek();
			let name = self.ident()?;
			let args = if self.lex.source.get(token.end) == Some(&b'(') {
				// toke.c scans attribute parameters keeping backslashes (scan_str keep_quoted).
				let open = self.expect(b"(")?;
				self.lex.rewind(&open);
				let quote = self.lex.quote(QuoteScan::Boundary, None)
					.map_err(|_| self.fatal(token.location.clone(), "Unterminated attribute parameter in attribute list"))?;
				Some(PStr::new(quote.bytes.into_owned(), self.lex.utf8))
			} else { None };
			attrs.push(Attribute { name, args });
			self.eat(b":");
		}
		// An empty list (`my $x : = 1`) is allowed; anything else must end the list.
		let next = self.peek();
		let text = self.lex.text(&next);
		if next.kind == Kind::Symbol && !matches!(text, b";" | b"=" | b"{" | b"}" | b"(" | b")" | b",") {
			let separator = char::from(text[0]);
			return Err(self.fatal(next.location, format!("Invalid separator character '{separator}' in attribute list")));
		}
		Ok(attrs)
	}
}

fn for_literal_args(expr: &Expr, f: &mut impl FnMut(&[u8])) {
	match &expr.kind {
		ExprKind::String(s) => f(&s.bytes),
		ExprKind::Quote(QuoteKind::String, parts) if let [QuotePart::Literal(s)] = parts.as_slice() => f(&s.bytes),
		ExprKind::Bareword(s) => f(s.as_bytes()),
		ExprKind::List(args) => { for arg in args { for_literal_args(arg, f); } }
		ExprKind::Group(arg) => for_literal_args(arg, f),
		_ => {}
	}
}

fn after_space(src: &[u8], mut at: usize) -> usize {
	loop {
		while src.get(at).is_some_and(u8::is_ascii_whitespace) { at += 1; }
		if src.get(at) != Some(&b'#') { return at; }
		at = line_end(src, at);
	}
}

/// toke.c validate_proto: the illegalproto warnings for a sub's prototype text.
fn prototype_problems(proto: &PStr, name: &str) -> Vec<String> {
	let (mut bad, mut in_brackets, mut after_slash, mut greedy, mut after_greedy) = (false, false, false, ' ', false);
	let (mut must_be_last, mut underscore, mut bad_after_underscore) = (false, false, false);
	for &b in proto.bytes.iter().filter(|b| !b.is_ascii_whitespace()) {
		if must_be_last { after_greedy = true; }
		if underscore {
			if !matches!(b, b';' | b'@' | b'%') { bad_after_underscore = true; }
			underscore = false;
		}
		match b {
			b'[' => in_brackets = true,
			b']' => in_brackets = false,
			b'@' | b'%' if !after_slash && !in_brackets => { must_be_last = true; greedy = char::from(b); }
			b'_' => underscore = true,
			b'$' | b'@' | b'%' | b'*' | b';' | b'&' | b'\\' | b'+' => {}
			_ => bad = true,
		}
		after_slash = b == b'\\';
	}
	// pv_pretty / sv_uni_display: backslashes doubled in byte strings, other bytes escaped.
	let shown: String = if proto.utf8 { proto.to_string_lossy().into_owned() } else {
		proto.bytes.iter().map(|&b| match b {
			b'\\' => "\\\\".to_owned(),
			b' '..=b'~' => char::from(b).to_string(),
			_ => format!("\\x{{{b:x}}}"),
		}).collect()
	};
	let mut problems = Vec::new();
	if after_greedy { problems.push(format!("Prototype after '{greedy}' for {name} : {shown}")); }
	if in_brackets { problems.push(format!("Missing ']' in prototype for {name} : {shown}")); }
	if bad { problems.push(format!("Illegal character in prototype for {name} : {shown}")); }
	if bad_after_underscore { problems.push(format!("Illegal character after '_' in prototype for {name} : {shown}")); }
	problems
}

/// End of a `)` token and the blanks toke.c skips after it (yyerror context).
fn paren_end(src: &[u8], close: usize) -> usize {
	let mut end = close + 1;
	while matches!(src.get(end), Some(b' ' | b'\t')) { end += 1; }
	end.min(src.len())
}

fn without_newline(bytes: &[u8]) -> &[u8] {
	bytes.strip_suffix(b"\n").unwrap_or(bytes)
}

/// vutil.c's prescan_version in strict mode: the length of the version at the start of
/// `s`, or the reason it is not a strict version.
fn strict_version(s: &[u8]) -> Result<usize, &'static str> {
	let at = |i: usize| s.get(i).copied().unwrap_or(0);
	let digits = |mut i: usize| { while at(i).is_ascii_digit() { i += 1; } i };
	let mut decimals = 0;
	let d = if at(0) == b'v' {
		if !at(1).is_ascii_digit() { return Err("dotted-decimal versions require at least three parts"); }
		if at(1) == b'0' && at(2).is_ascii_digit() { return Err("no leading zeros"); }
		let mut d = digits(1);
		if at(d) != b'.' { return Err("dotted-decimal versions require at least three parts"); }
		decimals += 1;
		d += 1;
		let mut parts = 0;
		while at(d).is_ascii_digit() {
			parts += 1;
			let part = d;
			d = digits(d);
			if d - part > 3 { return Err("maximum 3 digits between decimals"); }
			if at(d) == b'_' { return Err("no underscores"); }
			if at(d) != b'.' { break; }
			decimals += 1;
			d += 1;
		}
		if parts < 2 { return Err("dotted-decimal versions require at least three parts"); }
		d
	} else {
		if at(0) == b'.' { return Err("0 before decimal required"); }
		if at(0) == b'0' && at(1).is_ascii_digit() { return Err("no leading zeros"); }
		if at(0) == b'-' { return Err("negative version number"); }
		let mut d = digits(0);
		if at(d) == b'.' {
			decimals += 1;
			d += 1;
			if !at(d).is_ascii_digit() { return Err("fractional part required"); }
			d = digits(d);
			if at(d) == b'.' { return Err("dotted-decimal versions must begin with 'v'"); }
		}
		if d > 0 && at(d) == b'_' { return Err("no underscores"); }
		d
	};
	let mut end = d;
	while at(end).is_ascii_whitespace() { end += 1; }
	if !matches!(at(end), 0 | b';' | b'{' | b'}') && !at(end).is_ascii_digit() { return Err("non-numeric data"); }
	if decimals > 1 && d > 0 && at(d - 1) == b'.' { return Err("trailing decimal"); }
	Ok(d)
}

fn quote_word(word: &[u8]) -> bool {
	matches!(word, b"q" | b"qq" | b"qw" | b"qx" | b"qr" | b"m" | b"s" | b"tr" | b"y")
}

fn short_v(word: &[u8]) -> bool {
	word.starts_with(b"v") && !word.contains(&b'.')
}

fn decimal(src: &[u8]) -> Option<u32> {
	if src.is_empty() { return None; }
	src.iter().try_fold(0u32, |value, &b| {
		if b == b'_' { Some(value) } else { value.checked_mul(10)?.checked_add(u32::from(b.checked_sub(b'0')?)).filter(|_| b.is_ascii_digit()) }
	})
}

fn phase(word: &[u8]) -> Option<Phase> {
	Some(match word {
		b"BEGIN" => Phase::Begin,
		b"END" => Phase::End,
		b"CHECK" => Phase::Check,
		b"INIT" => Phase::Init,
		b"UNITCHECK" => Phase::Unitcheck,
		_ => return None,
	})
}

fn decl(word: &[u8]) -> Option<DeclKind> {
	Some(match word {
		b"my" => DeclKind::My,
		b"our" => DeclKind::Our,
		b"local" => DeclKind::Local,
		b"state" => DeclKind::State,
		_ => return None,
	})
}

#[cfg(test)]
mod tests {
	use super::*;

	fn parse(src: &[u8]) -> Program {
		parse_program(src, "test.pl", "main", &mut NoHooks).expect("valid Perl syntax")
	}

	fn expressions(program: &Program) -> Vec<&Expr> {
		program.body.stmts.iter().filter_map(|stmt| {
			if let StmtKind::Expr(expr) = &stmt.kind { Some(expr) } else { None }
		}).collect()
	}

	fn get_call(expr: &Expr) -> &Call {
		let ExprKind::Call(call) = &expr.kind else { panic!("expected call, got {:?}", expr.kind); };
		call
	}

	#[test]
	fn contextual_slash_and_angle_terms() {
		let program = parse(b"$a / 2; /a/; $a // 2; //; $a << 2; <STDIN>; <$fh>; <>; <<>>; <*.c>;");
		let expr = expressions(&program);
		assert!(matches!(&expr[0].kind, ExprKind::Binary(Binary::Div, ..)));
		assert!(matches!(&expr[1].kind, ExprKind::Regex(RegexExpr { kind: RegexKind::Match(false), .. })));
		assert!(matches!(&expr[2].kind, ExprKind::Binary(Binary::DefinedOr, ..)));
		assert!(matches!(&expr[3].kind, ExprKind::Regex(RegexExpr { pattern, .. }) if pattern.is_empty()));
		assert!(matches!(&expr[4].kind, ExprKind::Binary(Binary::Shl, ..)));
		assert!(matches!(&expr[5].kind, ExprKind::Readline(Readline::Handle(h)) if h.as_ref() == "STDIN"));
		assert!(matches!(&expr[6].kind, ExprKind::Readline(Readline::Scalar(_))));
		assert!(matches!(&expr[7].kind, ExprKind::Readline(Readline::Argv(false))));
		assert!(matches!(&expr[8].kind, ExprKind::Readline(Readline::Argv(true))));
		assert!(matches!(&expr[9].kind, ExprKind::Quote(QuoteKind::Glob, _)));
	}

	#[test]
	fn opening_brace_depends_on_first_term_and_its_separator() {
		let program = parse(b"{ foo => 1 }; { foo, 1 }; {; foo => 1 }; +{ foo, 1 }; map { $_ + 1 } @a; map { 'k' => $_ }, @a;");
		assert!(matches!(&program.body.stmts[0].kind, StmtKind::Expr(Expr { kind: ExprKind::Hash(_), .. })));
		assert!(program.body.stmts.iter().filter(|stmt| matches!(stmt.kind, StmtKind::Block(..))).count() == 2);
		let expr = expressions(&program);
		assert!(matches!(&expr[1].kind, ExprKind::Unary(Unary::Plus, _)));
		assert!(matches!(&get_call(expr[2]).slot, Some(CallSlot::Block(_))));
		assert!(matches!(&get_call(expr[3]).slot, Some(CallSlot::Expression(_))));
	}

	#[test]
	fn print_handle_slots_are_not_ordinary_arguments() {
		let program = parse(br#"print STDERR "a"; print {$fh} "b"; print $fh "c"; print $fh, "d"; print $fh + 2; print $fh +2; print STDOUT("e"); print STDOUT ("f"); print $fh /abc/;"#);
		let expr = expressions(&program);
		for i in [0, 1, 2, 5, 7, 8] {
			assert!(matches!(&get_call(expr[i]).slot, Some(CallSlot::Handle(_))), "{i}");
		}
		for i in [3, 4, 6] {
			assert!(get_call(expr[i]).slot.is_none(), "{i}");
		}
		assert!(parse_program(b"print STDERR, 'x';", "test.pl", "main", &mut NoHooks).is_err());
		let nested = parse(b"print($a or $b);");
		assert!(matches!(&get_call(expressions(&nested)[0]).args.as_deref().map(|e| &e.kind), Some(ExprKind::Binary(Binary::Or, ..))));
	}

	#[test]
	fn simultaneous_heredocs_skip_their_bodies_and_update_line_numbers() {
		let program = parse(b"<<'ONE' . <<~\"TWO\";\n\\$x\nONE\n  $x\n  TWO\n__LINE__;\n");
		let expr = expressions(&program);
		let ExprKind::Binary(Binary::Concat, first, second) = &expr[0].kind else { panic!("not a concatenation"); };
		assert!(matches!(&first.kind, ExprKind::String(s) if s.bytes == b"\\$x\n"));
		assert!(matches!(&second.kind, ExprKind::Quote(QuoteKind::String, parts) if matches!(&parts[..], [QuotePart::Expr(e, false), QuotePart::Literal(s)] if e.location.line == 4 && s.bytes == b"\n")));
		assert_eq!(expr[1].location.line, 6);
	}

	#[test]
	fn nested_and_apostrophe_quotes_handle_delimiters_before_interpolation() {
		let program = parse(br#"q(a\(b\)(c)); qq#one \# two#; q'abc'; qq'$x'; qw(alpha be\ ta);"#);
		let expr = expressions(&program);
		assert!(matches!(&expr[0].kind, ExprKind::String(s) if s.bytes == b"a(b)(c)"));
		assert!(matches!(&expr[1].kind, ExprKind::String(s) if s.bytes == b"one # two"));
		assert!(matches!(&expr[2].kind, ExprKind::String(s) if s.bytes == b"abc"));
		assert!(matches!(&expr[3].kind, ExprKind::Quote(QuoteKind::String, parts) if matches!(&parts[..], [QuotePart::Expr(_, false)])));
		assert!(matches!(&expr[4].kind, ExprKind::Group(group) if matches!(&group.kind, ExprKind::List(words) if words.len() == 3)));
	}

	#[test]
	fn fat_comma_and_simple_hash_keys_quote_the_original_spelling() {
		let program = parse(b"if => 1; (-foo => 2, v1 => 3); $h{time}; $h{-e};");
		let expr = expressions(&program);
		assert!(matches!(&expr[0].kind, ExprKind::List(items) if matches!(&items[0].kind, ExprKind::String(s) if s.bytes == b"if")));
		let ExprKind::Group(group) = &expr[1].kind else { panic!("not a group"); };
		let ExprKind::List(items) = &group.kind else { panic!("not a list"); };
		assert!(matches!(&items[0].kind, ExprKind::String(s) if s.bytes == b"-foo"));
		assert!(matches!(&items[2].kind, ExprKind::String(s) if s.bytes == b"v1"));
		assert!(matches!(&expr[2].kind, ExprKind::Select(_, Select::HashElement(false), key) if matches!(&key.kind, ExprKind::String(s) if s.bytes == b"time")));
		assert!(matches!(&expr[3].kind, ExprKind::Select(_, _, key) if matches!(&key.kind, ExprKind::String(s) if s.bytes == b"-e")));
	}

	#[test]
	fn postfix_dereference_and_key_value_slices() {
		let program = parse(b"$r->@*; $r->%*; $r->$#*; $r->&*; $r->**; $r->@[0,2]; $r->%{a,b}; %h{a,b}; %a[1,2];");
		let expr = expressions(&program);
		for (e, slot) in expr.iter().zip([Sigil::Array, Sigil::Hash, Sigil::LastIndex, Sigil::Code, Sigil::Glob]) {
			assert!(matches!(&e.kind, ExprKind::Deref(found, _) if *found == slot));
		}
		assert!(matches!(&expr[5].kind, ExprKind::Select(_, Select::ArraySlice(true), _)));
		assert!(matches!(&expr[6].kind, ExprKind::Select(_, Select::HashPairs(true), _)));
		assert!(matches!(&expr[7].kind, ExprKind::Select(_, Select::HashPairs(false), _)));
		assert!(matches!(&expr[8].kind, ExprKind::Select(_, Select::ArrayPairs(false), _)));
	}

	#[test]
	fn interpolation_parses_indirection_and_regex_anchors() {
		let program = parse(br#""$x->{a}[0] @{[ 1, 2 ]} $#a"; qr/$x[0]$|$x[0-9]$/; s{(a)}{ $1 . 'x' }ee;"#);
		let expr = expressions(&program);
		let ExprKind::Quote(_, parts) = &expr[0].kind else { panic!("not an interpolated quote"); };
		assert!(matches!(&parts[0], QuotePart::Expr(e, false) if matches!(&e.kind, ExprKind::Select(base, Select::ArrayElement(true), _) if matches!(&base.kind, ExprKind::Select(_, Select::HashElement(true), _)))));
		assert!(matches!(&parts[2], QuotePart::Expr(e, true) if matches!(&e.kind, ExprKind::Deref(Sigil::Array, _))));
		assert!(matches!(&parts[4], QuotePart::Expr(e, false) if matches!(&e.kind, ExprKind::Variable(Sigil::LastIndex, s) if s.as_ref() == "a")));
		let ExprKind::Regex(RegexExpr { pattern, .. }) = &expr[1].kind else { panic!("not a regex"); };
		assert!(matches!(&pattern[..], [QuotePart::Expr(sub, false), QuotePart::Literal(a), QuotePart::Expr(var, false), QuotePart::Literal(b)] if matches!(&sub.kind, ExprKind::Select(..)) && matches!(&var.kind, ExprKind::Variable(..)) && a.bytes == b"$|" && b.bytes == b"[0-9]$"));
		assert!(matches!(&expr[2].kind, ExprKind::Regex(RegexExpr { kind: RegexKind::SubstituteEval(_, 2), .. })));
	}

	#[test]
	fn use_and_begin_hooks_run_before_following_statements() {
		#[derive(Default)]
		struct Hooks { events: Vec<String> }

		impl ParseHooks for Hooks {
			fn use_module(&mut self, _: &Stmt, pkg: &str) -> Result<Vec<Imported>, String> {
				self.events.push(format!("use {pkg}"));
				Ok(vec![Imported { name: format!("{pkg}::answer").into(), prototype: Some(PStr::default()) }])
			}
			fn begin_block(&mut self, _: &Rc<Block>, pkg: &str) -> Result<(), String> {
				self.events.push(format!("BEGIN {pkg}"));
				Ok(())
			}
			fn sub_prototype(&self, qualified: &str) -> Option<Option<PStr>> {
				(qualified == "P::twice" && self.events.last().is_some_and(|s| s == "BEGIN P")).then(|| Some(PStr::from_bytes(b"$")))
			}
		}

		let mut hooks = Hooks::default();
		let program = parse_program(b"package P; use M; BEGIN {} answer + 1; twice 2, 3;", "test.pl", "main", &mut hooks).unwrap();
		assert_eq!(hooks.events, ["use P", "BEGIN P"]);
		let expr = expressions(&program);
		assert!(matches!(&expr[0].kind, ExprKind::Binary(Binary::Add, e, _) if matches!(&get_call(e).target, CallTarget::Named(name, false) if name.as_ref() == "answer")));
		assert!(matches!(&expr[1].kind, ExprKind::List(items) if matches!(&get_call(&items[0]).target, CallTarget::Named(name, false) if name.as_ref() == "twice")));
	}

	#[test]
	fn lexical_features_and_subroutine_attributes() {
		let program = parse(b"use feature qw(try signatures); sub f :lvalue :prototype($) ($x = 1) { $x } try { f(17) } catch ($e) { die $e }");
		let StmtKind::Sub(sub) = &program.body.stmts[1].kind else { panic!("expected a subroutine"); };
		assert!(sub.is_lvalue());
		assert_eq!(sub.prototype.as_ref().map(|p| p.bytes.as_slice()), Some(b"$".as_slice()));
		assert!(matches!(sub.signature.as_deref(), Some([Parameter { default: Some(_), .. }])));
		assert!(matches!(&program.body.stmts[2].kind, StmtKind::Try(..)));
	}

	#[test]
	fn syntax_error_reports_location_and_nearby_tokens() {
		let err = parse_program(b"my $x = ;", "test.pl", "main", &mut NoHooks).unwrap_err();
		assert_eq!(err.to_string(), "syntax error at test.pl line 1, near \"= ;\"\nExecution of test.pl aborted due to compilation errors.\n");
	}

	#[test]
	fn deep_input_grows_stack_and_rejects_unbounded_trees() {
		// The 150 nested blocks mirror t/comp/parser.t's bracket-stack regression.
		std::thread::Builder::new().stack_size(512 * 1024).spawn(|| {
			drop(parse(format!("{}1;{}", "{".repeat(150), "}".repeat(150)).as_bytes()));
			let n = MAX_DEPTH + 32;
			let inputs = [
				format!("{}1;{}", "{".repeat(n), "}".repeat(n)),
				format!("{}1{}", "(".repeat(n), ")".repeat(n)),
				format!("{}1", "1+".repeat(n)),
				format!("$r{}", "->[0]".repeat(n)),
				format!("${}x", "$".repeat(n)),
				format!(r#""${{[{}1{}]}}""#, "(".repeat(n), ")".repeat(n)),
			];
			for src in inputs {
				let error = parse_program(src.as_bytes(), "test.pl", "main", &mut NoHooks).unwrap_err();
				assert_eq!(error.message, "Parsing code nesting too deep");
			}
		}).unwrap().join().unwrap();
	}

	#[test]
	fn string_eval_inherits_scoped_utf8_and_features() {
		let mut hints = ParseHints::default();
		hints.utf8 = true;
		hints.set_feature(b"say", true);
		hints.strict.subs = true;
		let input = PStr::from_bytes("say $café; { no feature 'say'; say => 1; } say $café;".as_bytes());
		let program = parse_eval(&input, "(eval 1)", 70, "Caller", hints, &mut NoHooks).unwrap();
		let expr = expressions(&program);
		assert_eq!(expr[0].location.line, 70);
		assert_eq!(program.package.as_ref(), "Caller");
		for expr in expr {
			let call = get_call(expr);
			assert!(matches!(call.target, CallTarget::Builtin(Builtin::Say, BuiltinOrigin::Implicit)));
			assert!(matches!(call.args.as_deref().map(|arg| &arg.kind), Some(ExprKind::Variable(Sigil::Scalar, n)) if n.as_ref() == "café"));
		}
	}

	#[test]
	fn scope_and_declaration_hooks_balance_on_errors() {
		#[derive(Default)]
		struct Hooks { level: usize, declarations: Vec<String> }

		impl ParseHooks for Hooks {
			fn use_module(&mut self, _: &Stmt, _: &str) -> Result<Vec<Imported>, String> { Ok(vec![]) }
			fn begin_block(&mut self, _: &Rc<Block>, pkg: &str) -> Result<(), String> {
				assert_eq!(self.level, 1);
				assert_eq!(self.declarations, [format!("{pkg}::f")]);
				Ok(())
			}
			fn sub_prototype(&self, _: &str) -> Option<Option<PStr>> { None }
			fn enter_scope(&mut self) { self.level += 1; }
			fn leave_scope(&mut self) { self.level -= 1; }
			fn declare_sub(&mut self, sub: &Subroutine, pkg: &str) -> Result<(), String> {
				assert!(sub.body.is_some());
				self.declarations.push(format!("{pkg}::{}", sub.name.as_deref().unwrap()));
				Ok(())
			}
		}

		let mut hooks = Hooks::default();
		let result = parse_program(b"sub f { 1; } BEGIN { f(); } { +;", "test.pl", "main", &mut hooks);
		assert!(result.is_err());
		assert_eq!(hooks.level, 0);
	}

	#[test]
	fn perl_regressions_for_return_eval_dereferences_and_extra_commas() {
		let program = parse(br#"sub pb { return (caller(0))[3] + 2 } CORE::eval'answer'; ${no strict; \$_}; $#[0]; $^; @?; print(11,, => ,22);"#);
		let StmtKind::Sub(sub) = &program.body.stmts[0].kind else { panic!("expected sub"); };
		let StmtKind::Expr(expr) = &sub.body.as_ref().unwrap().stmts[0].kind else { panic!("expected return"); };
		assert!(matches!(get_call(expr).args.as_deref().map(|arg| &arg.kind), Some(ExprKind::Binary(Binary::Add, left, _)) if matches!(left.kind, ExprKind::Select(_, Select::ListSlice, _))));
		let expr = expressions(&program);
		assert!(matches!(get_call(expr[0]).target, CallTarget::Builtin(Builtin::Eval, BuiltinOrigin::Core)));
		assert!(matches!(&expr[1].kind, ExprKind::Deref(Sigil::Scalar, b) if matches!(b.kind, ExprKind::Block(..))));
		assert!(matches!(&expr[2].kind, ExprKind::Select(v, Select::ArrayElement(false), _) if matches!(&v.kind, ExprKind::Variable(Sigil::Scalar, n) if n.as_ref() == "#")));
		assert!(matches!(get_call(expr[5]).args.as_deref().map(|arg| &arg.kind), Some(ExprKind::List(args)) if args.len() == 2));
	}

	#[test]
	fn declared_refs_and_ampersand_calls_follow_term_context() {
		let program = parse(br#"use feature qw(refaliasing declared_refs); our \$TODO = \$::TODO; &{"CORE::$op"}($input);"#);
		let expr = expressions(&program);
		assert!(matches!(&expr[0].kind, ExprKind::Binary(Binary::Assign, lhs, _) if matches!(&lhs.kind, ExprKind::Declare(DeclKind::Our, _, reference, _) if matches!(reference.kind, ExprKind::Unary(Unary::Reference, _)))));
		assert!(matches!(get_call(expr[1]).target, CallTarget::Code(_, true)));
	}

	#[test]
	fn unicode_names_and_core_switch_parse_without_feature() {
		let program = parse(br#"CORE::given(1) { CORE::when(1) { continue } CORE::default {} } "\N{NEL}\N{KELVIN SIGN}\N{CYRILLIC SMALL LETTER ER} @?";"#);
		assert!(matches!(&program.body.stmts[0].kind, StmtKind::Given(_, b) if matches!(b.stmts[0].kind, StmtKind::When(Some(_), _))));
		assert!(matches!(&expressions(&program)[0].kind, ExprKind::String(s) if s.chars().eq([0x85, 0x212a, 0x440, 32, 64, 63])));
	}

	#[test]
	fn format_and_phase_hooks_run_while_compiling_unexecuted_branches() {
		#[derive(Default)]
		struct Hooks {
			format_seen: bool,
			phase: Option<Rc<Block>>,
		}

		impl ParseHooks for Hooks {
			fn use_module(&mut self, _: &Stmt, _: &str) -> Result<Vec<Imported>, String> { Ok(vec![]) }
			fn begin_block(&mut self, _: &Rc<Block>, _: &str) -> Result<(), String> { Ok(()) }
			fn sub_prototype(&self, _: &str) -> Option<Option<PStr>> { None }
			fn phase_block(&mut self, phase: Phase, block: &Rc<Block>, pkg: &str) -> Result<(), String> {
				assert_eq!(phase, Phase::End);
				assert_eq!(pkg, "P");
				self.phase = Some(block.clone());
				Ok(())
			}
			fn format_decl(&mut self, format: &Format, pkg: &str) -> Result<(), String> {
				assert_eq!(format.name.as_ref(), "F");
				assert_eq!(pkg, "P");
				self.format_seen = true;
				Ok(())
			}
		}

		let mut hooks = Hooks::default();
		let program = parse_program(b"package P; if (0) { format F =\nhello\n.\nsub Other::END { 1; } }", "test.pl", "main", &mut hooks).unwrap();
		assert!(hooks.format_seen);
		let StmtKind::If(arms, _) = &program.body.stmts[1].kind else { panic!("expected conditional"); };
		let StmtKind::Phase(Phase::End, body) = &arms[0].2.stmts[1].kind else { panic!("expected phase"); };
		assert!(Rc::ptr_eq(hooks.phase.as_ref().unwrap(), body));
	}

	#[test]
	fn imported_prototypes_override_only_eligible_implicit_builtins() {
		struct Hooks;

		impl ParseHooks for Hooks {
			fn use_module(&mut self, _: &Stmt, pkg: &str) -> Result<Vec<Imported>, String> {
				Ok([("stat", b"$".as_slice()), ("time", b""), ("exists", b"@")].into_iter().map(|(name, prototype)| {
					Imported { name: format!("{pkg}::{name}").into(), prototype: Some(PStr::from_bytes(prototype)) }
				}).collect())
			}
			fn begin_block(&mut self, _: &Rc<Block>, _: &str) -> Result<(), String> { Ok(()) }
			fn sub_prototype(&self, _: &str) -> Option<Option<PStr>> { None }
			fn imported_sub_prototype(&self, pkg: &str, name: &str) -> Option<Option<PStr>> {
				(pkg == "P" && name == "sleep").then(|| Some(PStr::from_bytes(b";$")))
			}
		}

		let program = parse_program(b"sub time () { 1 } time(); package P; use TestImports; stat $file, 2; time + 1; CORE::stat $file; exists $h{k}; sort time @a;", "test.pl", "main", &mut Hooks).unwrap();
		let expr = expressions(&program);
		assert!(matches!(get_call(expr[0]).target, CallTarget::Builtin(Builtin::Time, BuiltinOrigin::Implicit)));
		assert!(matches!(&expr[1].kind, ExprKind::List(args) if matches!(&get_call(&args[0]).target, CallTarget::Named(name, false) if name.as_ref() == "stat")));
		assert!(matches!(&expr[2].kind, ExprKind::Binary(Binary::Add, call, _) if matches!(&get_call(call).target, CallTarget::Named(name, false) if name.as_ref() == "time")));
		assert!(matches!(get_call(expr[3]).target, CallTarget::Builtin(Builtin::Stat, BuiltinOrigin::Core)));
		assert!(matches!(get_call(expr[4]).target, CallTarget::Builtin(Builtin::Exists, BuiltinOrigin::Implicit)));
		assert!(matches!(&get_call(expr[5]).slot, Some(CallSlot::Comparator(_))));

		let eval = parse_eval(&PStr::from_bytes(b"sleep 1"), "(eval 1)", 1, "P", ParseHints::default(), &mut Hooks).unwrap();
		assert!(matches!(&get_call(expressions(&eval)[0]).target, CallTarget::Named(name, false) if name.as_ref() == "sleep"));
	}

	#[test]
	fn use_hooks_keep_distinct_source_sites_on_the_same_line() {
		#[derive(Default)]
		struct Hooks(Vec<Rc<Use>>);
		impl ParseHooks for Hooks {
			fn use_module(&mut self, stmt: &Stmt, _: &str) -> Result<Vec<Imported>, String> {
				let StmtKind::Use(site) = &stmt.kind else { panic!("expected use"); };
				self.0.push(site.clone());
				Ok(vec![])
			}
			fn begin_block(&mut self, _: &Rc<Block>, _: &str) -> Result<(), String> { Ok(()) }
			fn sub_prototype(&self, _: &str) -> Option<Option<PStr>> { None }
		}

		let mut hooks = Hooks::default();
		let program = parse_program(b"use utf8; no utf8;", "test.pl", "main", &mut hooks).unwrap();
		assert!(!Rc::ptr_eq(&hooks.0[0], &hooks.0[1]));
		for (stmt, observed) in program.body.stmts.iter().zip(&hooks.0) {
			assert!(matches!(&stmt.kind, StmtKind::Use(site) if Rc::ptr_eq(site, observed)));
		}
	}

	#[test]
	fn prototypes_check_arity_at_the_call_site() {
		for (src, message, near, line) in [
			("sub f($$) { 1 } f(1);", "Not enough arguments for main::f", "1)", 1),
			("sub f($) { 1 } f(1, 2);", "Too many arguments for main::f", "2)", 1),
			("sub f() { 1 } f(1);", "Too many arguments for main::f", "1)", 1),
			("sub f($$) { 1 } f($x);", "Not enough arguments for main::f", "$x)", 1),
			("sub f($$) { 1 } f(q{hi} );", "Not enough arguments for main::f", "q{hi} )", 1),
			("sub f($$) { 1 } f() + 1;", "Not enough arguments for main::f", "() ", 1),
			("sub f($$) { 1 } f 1;", "Not enough arguments for main::f", "1;", 1),
			("sub f($$) { 1 } f(\n1\n);", "Not enough arguments for main::f", ")", 3),
			("package A; sub f($$) { 1 } f(1);", "Not enough arguments for A::f", "1)", 1),
			("my sub f($$) { 1 } f(1);", "Not enough arguments for f", "1)", 1),
			("sub f($$) { 1 } f((1, 2));", "Not enough arguments for main::f", "))", 1),
			("sub f(&\\[$@]$) { 1 } f {} $x;", "Not enough arguments for main::f", "$x;", 1),
			("sub f($;) { 1 } f 1, 2;", "Too many arguments for main::f", "2;", 1),
		] {
			let err = parse_program(src.as_bytes(), "test.pl", "main", &mut NoHooks).unwrap_err();
			assert_eq!(err.to_string(), format!("{message} at test.pl line {line}, near \"{near}\"\nExecution of test.pl aborted due to compilation errors.\n"));
		}

		parse(br#"sub f($$) {} &f(1); \&f; f(1, 2); sub g(;$$) {} g(); g(1); g(1,2); sub h($;_) {} h(1); h(1, 2); sub k($@) {} k(1, 2, @a); sub qv($) {} qv(()); qv(qw(a b)); sub cb(&) {} cb {}; sub refs(\[$@]$) {} refs(@a, 1); sub p(;$) {} p 1, 2;"#);
	}

	#[test]
	fn lexical_declaration_hooks_keep_source_identity_and_order() {
		#[derive(Default)]
		struct Hooks(Vec<(Rc<str>, Rc<str>)>);

		impl ParseHooks for Hooks {
			fn use_module(&mut self, _: &Stmt, _: &str) -> Result<Vec<Imported>, String> { Ok(vec![]) }
			fn begin_block(&mut self, _: &Rc<Block>, pkg: &str) -> Result<(), String> {
				assert_eq!(pkg, "P");
				assert_eq!(self.0.len(), 2);
				Ok(())
			}
			fn sub_prototype(&self, _: &str) -> Option<Option<PStr>> { None }
			fn lexical_decl(&mut self, decl: &Expr, pkg: &str) {
				self.0.push((pkg.into(), name(decl).clone()));
			}
		}

		fn name(decl: &Expr) -> &Rc<str> {
			let ExprKind::Declare(DeclKind::My, _, operand, _) = &decl.kind else { panic!("expected lexical declaration"); };
			let ExprKind::Variable(Sigil::Scalar, name) = &operand.kind else { panic!("expected scalar"); };
			name
		}

		let mut hooks = Hooks::default();
		let program = parse_program(b"package P; my $x; my $x = do { BEGIN {} 1 };", "test.pl", "main", &mut hooks).unwrap();
		assert!(!Rc::ptr_eq(&hooks.0[0].1, &hooks.0[1].1));
		let exprs = expressions(&program);
		let ExprKind::Binary(Binary::Assign, lhs, _) = &exprs[1].kind else { panic!("expected assignment"); };
		for (decl, (pkg, observed)) in [exprs[0], lhs.as_ref()].into_iter().zip(&hooks.0) {
			assert_eq!(pkg.as_ref(), "P");
			assert!(Rc::ptr_eq(name(decl), observed));
		}
	}

	#[test]
	fn print_and_sort_do_not_steal_left_operands_for_their_slots() {
		let program = parse(br#"
			print $x+0, "\n";
			print $o-3, "|", 3-$o;
			print $x + 1;
			print $s !~ /z/ ? 1 : 0, "\n";
			printf $x!=1;
			CORE::say $$s, "\n";
			print $x //1;
			print $x *$n;
			print $x <=1;
			print $x.2;
			print $x -1;
			print $x +1;
			print $$fh "message";
			print $fh ! $x;
			print STDOUT + 1;
			print $fh /abc/;
			sort $x+1;
			sort $cmp +1;
		"#);
		let expressions = expressions(&program);
		for i in (0..10).chain([16]) {
			assert!(get_call(expressions[i]).slot.is_none(), "{i}");
		}
		for i in 10..16 {
			assert!(matches!(get_call(expressions[i]).slot, Some(CallSlot::Handle(_))), "{i}");
		}
		assert!(matches!(get_call(expressions[17]).slot, Some(CallSlot::Comparator(_))));
		let args = get_call(expressions[5]).args.as_deref().unwrap();
		assert!(matches!(&args.kind, ExprKind::List(items) if matches!(&items[0].kind, ExprKind::Deref(Sigil::Scalar, _))));
		let args = get_call(expressions[3]).args.as_deref().unwrap();
		assert!(matches!(&args.kind, ExprKind::List(items) if matches!(&items[0].kind, ExprKind::Conditional(test, _, _) if matches!(&test.kind, ExprKind::Binary(Binary::Bind(true), _, _)))));
	}

	#[test]
	fn constant_assignment_is_rejected_before_execution() {
		for (src, op, near) in [
			("7 = 3;", "scalar assignment", "3;"),
			("(7, $x) = (3,4);", "list assignment", ");"),
			("7 += 3;", "addition (+)", "3;"),
			("-7 = 3 if 0;", "scalar assignment", "3 if"),
			("\"value\" = 3;", "scalar assignment", "3;"),
		] {
			let err = parse_program(src.as_bytes(), "test.pl", "main", &mut NoHooks).unwrap_err();
			assert_eq!(err.to_string(), format!("Can't modify constant item in {op} at test.pl line 1, near \"{near}\"\nExecution of test.pl aborted due to compilation errors.\n"));
		}
		parse(b"(undef, $x) = (3,4); $x = 7; $x += 3; (1 ? $x : 2) = 3;");
	}

	#[test]
	fn string_eval_statement_terminator_is_reported_as_eof() {
		for (src, line) in [(b"my $x = ;".as_slice(), 20), (b"my $x =\n;", 21), (b"7 = 3;", 20)] {
			let err = parse_eval(&PStr::from_bytes(src), "(eval 1)", 20, "main", ParseHints::default(), &mut NoHooks).unwrap_err();
			assert!(err.eof);
			assert!(err.near.is_none());
			assert_eq!(err.location.line, line);
		}
		let err = parse_eval(&PStr::from_bytes(b"my $x = , 2;"), "(eval 1)", 20, "main", ParseHints::default(), &mut NoHooks).unwrap_err();
		assert!(!err.eof);
		assert!(err.near.is_some());
	}

	#[test]
	fn heredocs_in_quoted_code_share_the_enclosing_source_line() {
		let program = parse(b"$x =~ s/^not /substr(<<EOF, 0, 0)/e;\nignored\nEOF\nprint qq|${\\<<'NEXT'}|;\nmore\nNEXT\n__LINE__;");
		let exprs = expressions(&program);
		let ExprKind::Binary(Binary::Bind(false), _, pattern) = &exprs[0].kind else { panic!("expected substitution"); };
		let ExprKind::Regex(RegexExpr { kind: RegexKind::SubstituteEval(body, 1), .. }) = &pattern.kind else { panic!("expected /e"); };
		let StmtKind::Expr(call) = &body.stmts[0].kind else { panic!("expected replacement call"); };
		assert!(matches!(&get_call(call).args.as_deref().unwrap().kind,
			ExprKind::List(items) if matches!(&items[0].kind, ExprKind::String(s) if s.bytes == b"ignored\n")));
		assert_eq!(exprs[2].location.line, 7);

		let source = b"<<~' EOF ';\n  body\n   EOF \n";
		let program = parse(source);
		assert!(matches!(&expressions(&program)[0].kind, ExprKind::String(s) if s.bytes == b"body\n"));
		assert!(parse_program(b"<<'';\nno terminating line", "test.pl", "main", &mut NoHooks).is_err());
		assert!(parse_program(b"<<'';\n", "test.pl", "main", &mut NoHooks).is_err());
		assert!(parse_program(b"<<~ EOF;\ntext\nEOF\n", "test.pl", "main", &mut NoHooks).is_err());
		let program = parse(b"<<2;\nhello\n2");
		assert!(matches!(&expressions(&program)[0].kind, ExprKind::String(s) if s.bytes == b"hello\n"));
	}

	#[test]
	fn perl_regressions_for_late_sub_binding_and_lexical_keywords() {
		let program = parse(br#"sub 'Hello'_he_said (_); AUTOLOAD { 42 } sub stubbedsub; sub f($) { f() } our sub if() { 42 } my $x = if if if; f sub { [0] }->()[0]; sub v5(){ 99 } require v5;"#);
		assert!(matches!(&program.body.stmts[0].kind, StmtKind::Sub(s) if s.name.as_deref() == Some("Hello::_he_said")));
		assert!(matches!(&program.body.stmts[1].kind, StmtKind::Sub(s) if s.name.as_deref() == Some("AUTOLOAD")));
		assert!(matches!(&program.body.stmts[5].kind, StmtKind::Modifier(_, Modifier::If, _)));
		let ExprKind::Select(_, Select::ArrayElement(true), _) = &get_call(expressions(&program)[0]).args.as_deref().unwrap().kind else {
			panic!("expected index on arrow code call");
		};
		assert!(matches!(&get_call(expressions(&program)[1]).args.as_deref().unwrap().kind, ExprKind::Version(v) if v == &[5]));
		let err = parse_program(b"sub f($); sub f($){ f() }", "test.pl", "main", &mut NoHooks).unwrap_err();
		assert_eq!(err.message, "Not enough arguments for main::f");
		let err = parse_program(b"sub f(_$); f(1,2);", "test.pl", "main", &mut NoHooks).unwrap_err();
		assert!(err.message.starts_with("Malformed prototype for main::f"));
	}

	#[test]
	fn implicit_utf16_and_non_decimal_float_source() {
		let text = " 'ā𐀀'; 01.1p0; 0b1.1p-1; 0o1.3p2; 0x1p-1074; ~~2;";
		for little in [false, true] {
			for bom in [false, true] {
				let mut source = if !bom { Vec::new() } else if little { vec![0xff, 0xfe] } else { vec![0xfe, 0xff] };
				for word in text.encode_utf16() {
					source.extend(if little { word.to_le_bytes() } else { word.to_be_bytes() });
				}
				let program = parse(&source);
				let expressions = expressions(&program);
				assert!(matches!(&expressions[0].kind, ExprKind::String(s) if s.chars().eq([0x101, 0x10000])));
				for (expr, expected) in expressions[1..5].iter().zip([1.125, 0.75, 5.5, f64::from_bits(1)]) {
					assert!(matches!(expr.kind, ExprKind::Float(n) if n == expected));
				}
				assert!(matches!(&expressions[5].kind, ExprKind::Unary(Unary::Complement, x) if matches!(x.kind, ExprKind::Unary(Unary::Complement, _))));
			}
		}
	}

	#[test]
	fn lexical_boundary_diagnostics_and_nul_sigils() {
		parse(b"$\0eq; @\0eq; %\0eq; *\0eq; &\0eq;");
		let err = parse_program(b"1+\n", "test.pl", "main", &mut NoHooks).unwrap_err();
		assert_eq!(err.location.line, 1);
		assert!(err.eof);
		let err = parse_program(b"1;\n<<<<<<< HEAD\n", "test.pl", "main", &mut NoHooks).unwrap_err();
		assert_eq!(err.message, "Version control conflict marker");
		assert_eq!(err.location.line, 2);
		let err = parse_program(b"print $001;", "test.pl", "main", &mut NoHooks).unwrap_err();
		assert_eq!(err.to_string(), "Numeric variables with more than one digit may not start with '0' at test.pl line 1.\n");
		let err = parse_program(b"$x=\xdf", "test.pl", "main", &mut NoHooks).unwrap_err();
		assert_eq!(err.to_string(), "Unrecognized character \\xDF; marked by <-- HERE after $x=<-- HERE near column 4 at test.pl line 1.\n");
	}

	#[test]
	fn refaliasing_foreach_has_a_separate_target_and_list() {
		let program = parse(br#"use feature qw(refaliasing state); for \my $topic (\$a, \$b) {} for \@items (\@a) {} for \state %item (\%a) {}"#);
		let StmtKind::Foreach(Some(target), list, _, _) = &program.body.stmts[1].kind else { panic!("expected foreach"); };
		assert!(matches!(&target.kind, ExprKind::Unary(Unary::Reference, decl) if matches!(&decl.kind, ExprKind::Declare(DeclKind::My, _, _, _))));
		assert!(matches!(&list.kind, ExprKind::List(items) if items.len() == 2));
		let err = parse_program(br#"for \$x (\$a) {}"#, "test.pl", "main", &mut NoHooks).unwrap_err();
		assert_eq!(err.message, "Experimental aliasing via reference not enabled");
	}

	#[test]
	fn implicit_code_arrows_do_not_end_prototyped_argument_lists() {
		let program = parse(b"sub f($$) {} f $x->()(), 1; f $subs[0]()(0), 2; f $cr->(){ppp}, 3;");
		let expr = expressions(&program);
		for (i, e) in expr.iter().enumerate() {
			let Some(Expr { kind: ExprKind::List(args), .. }) = get_call(e).args.as_deref() else { panic!("expected two arguments"); };
			assert_eq!(args.len(), 2);
			if i == 2 {
				assert!(matches!(&args[0].kind, ExprKind::Select(_, Select::HashElement(true), _)));
			} else {
				assert!(matches!(&get_call(&args[0]).target, CallTarget::Code(base, false) if matches!(base.kind, ExprKind::Call(_))));
			}
		}
		for src in [b"f()();".as_slice(), b"$x->f()[0];", b"@x[0]();"] {
			assert!(parse_program(src, "test.pl", "main", &mut NoHooks).is_err());
		}
	}

	#[test]
	fn compound_assignments_use_the_last_comma_operand_as_lvalue() {
		parse(br#"("const", my $x) ||= 1; (42, $x) += 1; () ||= 3;"#);
		let err = parse_program(b"($x, 42) ||= 1;", "test.pl", "main", &mut NoHooks).unwrap_err();
		assert_eq!(err.message, "Can't modify constant item in logical or assignment (||=)");
	}

	#[test]
	fn isa_and_repeated_signature_separators_do_not_change_argument_boundaries() {
		let program = parse(br#"use feature qw(isa signatures); sub f($a,,, $b,,) {} f(undef isa "BaseClass", 2);"#);
		assert!(matches!(&program.body.stmts[1].kind, StmtKind::Sub(s) if s.signature.as_deref().is_some_and(|params| params.len() == 2)));
		let exprs = expressions(&program);
		let Some(Expr { kind: ExprKind::List(args), .. }) = get_call(exprs[0]).args.as_deref() else { panic!("expected two arguments"); };
		assert!(matches!(&args[0].kind, ExprKind::Binary(Binary::Isa, left, _) if get_call(left).args.is_none()));
		assert!(parse_program(b"use feature 'signatures'; sub f(,$a) {}", "test.pl", "main", &mut NoHooks).is_err());
	}

	#[test]
	fn raw_regex_eval_keeps_escapes_and_skips_extended_comments() {
		let src = PStr::from_bytes(b"$prefix(?{ 'ab\\'c' })(??{ '@array' }) # (?{ '+' })\nend");
		let mut hints = ParseHints::default();
		hints.set_feature(b"say", true);
		let program = parse_regex_eval(&src, "(eval 1)", 4, "Caller", hints, true, &mut NoHooks).unwrap();
		let StmtKind::Expr(Expr { kind: ExprKind::Regex(rx), .. }) = &program.body.stmts[0].kind else { panic!("expected regex"); };
		let [QuotePart::Literal(prefix), QuotePart::RegexCode(code, false, raw), QuotePart::RegexCode(_, true, _), QuotePart::Literal(suffix)] = rx.pattern.as_slice()
			else { panic!("unexpected pattern parts"); };
		assert_eq!(prefix.bytes, b"$prefix");
		assert_eq!(raw.bytes, b"(?{ 'ab\\'c' })");
		assert!(matches!(&code.stmts[0].kind, StmtKind::Expr(Expr { kind: ExprKind::String(s), .. }) if s.bytes == b"ab'c"));
		assert_eq!(suffix.bytes, b" # (?{ '+' })\nend");
		assert_eq!(code.location.line, 4);
		assert_eq!(program.package.as_ref(), "Caller");
	}

	#[test]
	fn signature_errors_are_queued_like_yyerror() {
		let err = |src: &[u8]| parse_program(src, "foo", "main", &mut NoHooks).unwrap_err().to_string();
		assert_eq!(err(b"use feature 'signatures'; sub f ($a = 1, $b = 2, $c, $d) { }"),
			"Mandatory parameter follows optional parameter at foo line 1, near \"$c,\"\n\
			 Mandatory parameter follows optional parameter at foo line 1, near \"$d) \"\n\
			 Execution of foo aborted due to compilation errors.\n");
		assert!(err(b"use feature 'signatures'; sub f ($a =) { }").starts_with("Optional parameter lacks default expression at foo line 1, near \"=) \"\n"));
		assert!(err(b"use feature 'signatures'; sub f (@a, $b = 222) { }").starts_with("Slurpy parameter not last at foo line 1, near \"222) \"\n"));
		assert!(err(b"use feature 'signatures'; sub f ($a 123) { }").starts_with(
			"Illegal operator following parameter in a subroutine signature at foo line 1, near \"($a 123\"\nsyntax error at foo line 1, near \"($a 123\"\n"));
		assert!(err(b"use feature 'signatures'; sub f ($a, $b) :prototype($$) { }").starts_with("Subroutine attributes must come before the signature"));
		assert!(err(b"sub f :method ($a) { }").starts_with("syntax error"));
		let program = parse(b"use feature 'signatures'; sub f ($=, $x = 1) { }");
		assert!(matches!(&program.body.stmts[1].kind, StmtKind::Sub(s) if s.signature.as_deref().is_some_and(|p| p.iter().all(|p| p.default.is_some()))));
	}

	#[test]
	fn queued_and_declaration_diagnostics() {
		let err = |src: &[u8]| parse_program(src, "foo", "main", &mut NoHooks).unwrap_err().to_string();
		assert!(err(b"0xp3;").starts_with("No digits found for hexadecimal literal at foo line 1"));
		assert!(err(b"use feature 'state'; (state $x) = 1;").starts_with("Initialization of state variables in list currently forbidden"));
		assert!(err(b"sub F (\\%) {1} F(1);").starts_with("Type of arg 1 to main::F must be hash (not constant item)"));
		assert!(err(b"use feature 'isa'; $x isa $y < 1;").starts_with("syntax error"));
		parse(b"use feature qw(declared_refs); no warnings; my $r = my \\\\$x; my $s = $c ? my $y : $z;");
		let program = parse(b"my $x : Ugly('\\(\") ;");
		let Some(Expr { kind: ExprKind::Declare(_, _, _, attrs), .. }) = expressions(&program).first().copied() else { panic!("expected declaration"); };
		assert_eq!(attrs[0].args.as_ref().map(|a| a.bytes.as_slice()), Some(b"'\\(\"".as_slice()));
	}

	#[test]
	fn do_subname_grep_comma_and_illegal_prototypes() {
		let err = |src: &[u8]| parse_program(src, "foo", "main", &mut NoHooks).unwrap_err().to_string();
		assert!(err(b"sub subname {} do subname('arg');").starts_with("syntax error"));
		assert!(err(b"my $x; grep $x (1,2,3);").starts_with("Missing comma after first argument to grep function"));
		parse(b"do CORE(); do 'file.pl'; my @e = grep $x; my @m = map $_, ;");
		assert_eq!(prototype_problems(&PStr::from_str("@ $b ar"), "main::p"), vec![
			"Prototype after '@' for main::p : @ $b ar".to_owned(),
			"Illegal character in prototype for main::p : @ $b ar".to_owned(),
		]);
		assert_eq!(prototype_problems(&PStr::from_str("$_$"), "main::p"), vec!["Illegal character after '_' in prototype for main::p : $_$".to_owned()]);
		assert!(prototype_problems(&PStr::from_str("\\[$@%]$;@"), "main::p").is_empty());
	}

	#[test]
	fn logical_file_pod_utf8_format_and_data() {
		let program = parse("use utf8;\n=pod\nignore me\n=cut\n#line 40 \"logical.pl\"\nmy $café = 'é';\nformat F =\n@<<<\n$café\n.\n__DATA__\n1\n".as_bytes());
		let expr = expressions(&program);
		assert_eq!(expr[0].location.file.as_ref(), "logical.pl");
		assert_eq!(expr[0].location.line, 40);
		assert!(matches!(&expr[0].kind, ExprKind::Binary(Binary::Assign, _, s) if matches!(&s.kind, ExprKind::String(s) if s.utf8)));
		assert!(matches!(&program.body.stmts[2].kind, StmtKind::Format));
		assert_eq!(program.data.as_ref().map(|d| d.bytes.as_slice()), Some(b"1\n".as_slice()));
	}
}
