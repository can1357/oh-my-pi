//! bash arithmetic: 64-bit wrapping integers, every C operator bash has,
//! assignments, and recursive evaluation of variable values
//! (`a="2*3"; $((a+1))` is 7).
//!
//! Expression text is compiled once into an [`Expr`] tree, cached by text
//! in the engine's [`Cache`], and evaluated by walking it. bash evaluates
//! while it parses, so its diagnostics come in source order: `1/0 + `
//! reports the division before the missing operand. The compiler keeps
//! that order by turning the first syntax error into a [`Node::Fail`] at
//! the point where parsing stopped; the walk raises it when it gets there,
//! after everything to its left has been evaluated. Skipped branches
//! (`0 && …`, the untaken arm of `?:`) are walked without reading or
//! writing variables, as bash parses them with `noeval` set.
//!
//! Errors carry bash's message and error token, rendered as
//! `EXPR: MSG (error token is "TOKEN")`; the caller adds the command
//! prefix bash's `this_command_name` gives (`((: `, `let: `, `[[: `).

use std::sync::Arc;

use bstr::BString;
use hashbrown::HashMap;
use parking_lot::Mutex;

use crate::bash::diag::Diag;

/// A variable's value as the evaluator reads it ([`Env::get`]).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Value {
	/// A plain decimal integer ([`plain_decimal`]): its number, read
	/// without copying or evaluating the text (a loop counter's value).
	Number(i64),
	/// Any other text, evaluated as an expression.
	Text(BString),
}

impl Value {
	/// The value of variable text `text`.
	pub fn of(text: &[u8]) -> Self {
		plain_decimal(text).map_or_else(|| Self::Text(BString::from(text)), Self::Number)
	}
}

/// `text` as the number it is when it is plain decimal digits without a
/// leading zero (`010` is octal) and without blanks or a sign (a sign is
/// a nesting level, see [`decimal_value`]): evaluating such text as an
/// expression gives the same number, wrapped as bash wraps it.
fn plain_decimal(text: &[u8]) -> Option<i64> {
	let (&first, _) = text.split_first()?;
	if first == b'0' && text.len() > 1 {
		return None;
	}
	text.iter().try_fold(0i64, |v, &d| {
		d.is_ascii_digit()
			.then(|| v.wrapping_mul(10).wrapping_add(i64::from(d - b'0')))
	})
}

/// Variable access for the evaluator.
pub trait Env {
	/// Value of `name` (element `index` of an array), `None` when unset.
	fn get(&mut self, name: &[u8], index: Option<&[u8]>) -> Result<Option<Value>, Error>;
	/// Assign `value` to `name` (element `index`).
	fn set(&mut self, name: &[u8], index: Option<&[u8]>, value: i64) -> Result<(), Error>;
	/// Whether `name` is an associative array: its subscripts are keys,
	/// passed as written; other subscripts arrive evaluated, in decimal.
	fn is_assoc(&mut self, name: &[u8]) -> bool;
	/// The compiled-expression cache to use.
	fn cache(&self) -> &Cache;
	/// Report a diagnostic that does not stop evaluation (bash prints it
	/// and goes on: `` `a[]': not a valid identifier ``), with the prefix
	/// of the running command.
	fn warn(&mut self, diag: Diag);
	/// Whether the text was expanded already (bash's `EXP_EXPANDED`:
	/// `let` with `shopt -s assoc_expand_once`): indexed subscripts are
	/// then evaluated as written, without quote removal
	/// (`let 'a[""]=1'` is a syntax error).
	fn expanded(&self) -> bool {
		false
	}
	/// Expand an indexed subscript the evaluator meets that still holds
	/// `$` or `` ` `` (bash's `array_expand_index`: `expand_arith_string`
	/// with `Q_ARITH`, one pass, so the value's own `$(…)` stays text:
	/// `expr='a[$key]'; (( $expr ))`). The result is evaluated as is. The
	/// default returns `text` unchanged.
	///
	/// # Errors
	/// [`Error::Expand`] when the expansion fails.
	fn expand_index(&mut self, text: &[u8]) -> Result<BString, Error> {
		Ok(BString::from(text))
	}
	/// An associative-array key the evaluator meets, expanded once (bash's
	/// `expand_subscript_string`: `let 'a[" "]=1'` uses the key ` `; text
	/// that came from `(( ))` was backslash-quoted by the expander, so this
	/// only removes that quoting). The default only removes backslash
	/// quoting.
	///
	/// # Errors
	/// [`Error::Expand`] when the expansion fails.
	fn expand_key(&mut self, key: &[u8]) -> Result<BString, Error> {
		Ok(unescape(key))
	}
}

/// An arithmetic error.
#[derive(Debug)]
pub enum Error {
	/// An evaluation error: `EXPR: MSG (error token is "TOKEN")`.
	Eval {
		/// Expression being evaluated (leading blanks removed).
		expr:  BString,
		/// bash's message.
		msg:   &'static str,
		/// Rest of the expression from the offending token.
		token: BString,
	},
	/// Assignment to a readonly variable: bash prints a plain
	/// `NAME: readonly variable`, without expression or prefix.
	Readonly {
		/// The variable.
		name: BString,
	},
	/// `set -u` and an unset variable referenced where it is evaluated
	/// (not in a skipped branch): `NAME: unbound variable`.
	Unbound {
		/// The variable.
		name: BString,
	},
	/// An [`Error::Eval`] of an array subscript, which bash reports without
	/// the command's name.
	Subscript {
		/// Subscript expression.
		expr:  BString,
		/// bash's message.
		msg:   &'static str,
		/// Rest of the subscript from the offending token.
		token: BString,
	},
	/// Expanding a subscript at evaluation ([`Env::expand_index`]) failed.
	Expand {
		/// The expansion's diagnostic.
		diag: Box<Diag>,
	},
}

impl Error {
	/// `self` raised while evaluating a subscript.
	fn in_subscript(self) -> Self {
		match self {
			Self::Eval { expr, msg, token } => Self::Subscript { expr, msg, token },
			other => other,
		}
	}
}

impl From<Error> for Diag {
	fn from(e: Error) -> Self {
		match e {
			Error::Eval { expr, msg, token } => Self::Arith { expr, msg: msg.into(), token },
			Error::Readonly { name } => Self::Readonly { name },
			Error::Unbound { name } => Self::Unbound { name },
			Error::Subscript { expr, msg, token } => {
				Self::ArithSubscript { expr, msg: msg.into(), token }
			},
			Error::Expand { diag } => *diag,
		}
	}
}

/// Nesting limit: variable values evaluated as expressions, parentheses and
/// unary/`**` chains together. bash's `MAX_EXPR_RECURSION_LEVEL` is 1024
/// variable levels on a C stack; the evaluator recurses ~20 Rust frames per
/// level, so the bound is lower to stay within a 2 MiB thread stack (the
/// message is the same; only pathological nesting is affected).
const MAX_DEPTH: u32 = 256;

/// Entries the [`Cache`] holds at most, so a script that generates unique
/// expressions cannot grow it without bound.
const CACHE_ENTRIES: usize = 4096;

/// Compiled expressions by text (leading blanks removed). Shared by every
/// shell of an engine: compiling is a pure function of the text.
#[derive(Default)]
pub struct Cache {
	gens: Mutex<Gens>,
}

/// The two generations of a [`Cache`]: a full young generation becomes the
/// old one (the previous old one is dropped), and an old entry that is hit
/// moves back to the young one. Expressions in use survive a stream of
/// one-off texts; clearing everything at the bound recompiled the hot ones
/// too.
#[derive(Default)]
struct Gens {
	young: HashMap<BString, Arc<Expr>>,
	old:   HashMap<BString, Arc<Expr>>,
}

impl Gens {
	fn insert(&mut self, text: BString, expr: Arc<Expr>) {
		if self.young.len() >= CACHE_ENTRIES / 2 {
			self.old = std::mem::take(&mut self.young);
		}
		self.young.insert(text, expr);
	}
}

impl Cache {
	/// The compiled form of `text`, compiling it on a miss.
	pub fn get(&self, text: &[u8]) -> Arc<Expr> {
		{
			let mut gens = self.gens.lock();
			if let Some(e) = gens.young.get(text) {
				return Arc::clone(e);
			}
			if let Some((key, e)) = gens.old.remove_entry(text) {
				gens.insert(key, Arc::clone(&e));
				return e;
			}
		}
		let expr = Arc::new(compile(text));
		self
			.gens
			.lock()
			.insert(BString::from(text), Arc::clone(&expr));
		expr
	}
}

/// The value of `text` (leading blanks removed) when it is a plain decimal
/// constant with an optional sign and trailing blanks (` -42 `, bash's
/// `legal_number` shape, base prefixes excluded), as compiling and
/// evaluating it at `depth` gives, or `None` to compile it. Most variable
/// values arithmetic reads are such numbers, and each new one used to be
/// compiled and cached.
fn decimal_value(text: &[u8], depth: u32) -> Option<i64> {
	let end = text
		.iter()
		.rposition(|c| !matches!(c, b' ' | b'\t' | b'\n' | b'\r'))
		.map_or(0, |p| p + 1);
	let text = &text[..end];
	let (neg, digits) = match text.split_first() {
		Some((b'-', rest)) => (true, rest),
		Some((b'+', rest)) => (false, rest),
		_ => (false, text),
	};
	// A sign is a unary operator, one nesting level that can exceed the
	// recursion limit; a leading `0` makes octal (or `0x` hex).
	if (digits.len() != text.len() && depth + 1 >= MAX_DEPTH)
		|| digits.is_empty()
		|| (digits[0] == b'0' && digits.len() > 1)
		|| !digits.iter().all(u8::is_ascii_digit)
	{
		return None;
	}
	let v = digits
		.iter()
		.fold(0i64, |v, &d| v.wrapping_mul(10).wrapping_add(i64::from(d - b'0')));
	Some(if neg { v.wrapping_neg() } else { v })
}

/// A compiled expression.
#[derive(Debug)]
pub struct Expr {
	/// The text (leading blanks removed), for diagnostics.
	src:  BString,
	root: Node,
}

/// One node of a compiled expression. Offsets (`tok`) index
/// [`Expr::src`] and mark where an error found while evaluating the node
/// points (bash's `lasttp` at that moment).
#[derive(Debug)]
enum Node {
	/// A constant.
	Num(i64),
	/// The syntax error that ended compilation; raised when reached, also
	/// in a skipped branch.
	Fail(Box<SyntaxError>),
	/// Each in turn; the value is the last one's (`a, b`, or an operand
	/// followed by the error found after it).
	Seq(Vec<Self>),
	/// A variable reference.
	Var(Box<Lv>),
	/// `x++` / `x--`.
	PostInc(Box<Lv>, i64),
	/// `++x` / `--x`.
	PreInc(Box<Lv>, i64),
	/// `x = v` (`op` `=`) or `x OP= v`.
	Assign { lv: Box<Lv>, op: Bin, tok: u32, rhs: Box<Self> },
	/// One nesting level (parentheses, unary operators, `**`): bounded by
	/// [`MAX_DEPTH`] together with variable recursion.
	Nest { level: u32, tok: u32, inner: Box<Self> },
	/// `!`, `~` or unary `-` of a [`Node::Nest`].
	Unary(Un, Box<Self>),
	/// `base ** exp`.
	Pow { base: Box<Self>, exp: Box<Self>, tok: u32 },
	/// A left-associative chain of one precedence level.
	Binary(Box<Self>, Vec<(Bin, u32, Self)>),
	/// `a && b && …`.
	And(Box<Self>, Vec<Self>),
	/// `a || b || …`.
	Or(Box<Self>, Vec<Self>),
	/// `c ? a : b`.
	Cond(Box<[Self; 3]>),
}

/// A unary operator.
#[derive(Clone, Copy, Debug)]
enum Un {
	Not,
	BitNot,
	Neg,
}

/// A binary operator (`Set` is plain `=`).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Bin {
	Set,
	Mul,
	Div,
	Mod,
	Add,
	Sub,
	Shl,
	Shr,
	Lt,
	Le,
	Gt,
	Ge,
	Eq,
	Ne,
	BitAnd,
	BitXor,
	BitOr,
}

/// An lvalue: name, subscript text as written, and the nesting level it
/// was found at (its value's evaluation is one level deeper).
#[derive(Debug)]
struct Lv {
	name:  BString,
	index: Option<BString>,
	level: u32,
}

/// Evaluate `text` (compiled through `env`'s cache).
pub fn eval(text: &[u8], env: &mut dyn Env) -> Result<i64, Error> {
	eval_depth(text, env, 0)
}

fn eval_depth(text: &[u8], env: &mut dyn Env, depth: u32) -> Result<i64, Error> {
	let text = text.trim_ascii_start();
	if text.trim_ascii().is_empty() {
		return Ok(0);
	}
	if let Some(v) = decimal_value(text, depth) {
		return Ok(v);
	}
	let expr = env.cache().get(text);
	Walk { expr: &expr, env, depth, noeval: 0 }.eval(&expr.root)
}

/// Compile `text` (leading blanks already removed).
fn compile(text: &[u8]) -> Expr {
	let mut c = Compiler { src: text, pos: 0, last: 0, nest: 0, failed: false };
	let mut root = c.comma();
	if !c.failed {
		c.skip_ws();
		if let Some(&ch) = c.src.get(c.pos) {
			c.last = c.pos;
			let operator = matches!(
				ch,
				b'+'
					| b'-'
					| b'*'
					| b'/'
					| b'%'
					| b'<'
					| b'>'
					| b'='
					| b'!'
					| b'&'
					| b'|'
					| b'^'
					| b'~'
					| b'?'
					| b':'
					| b','
					| b'('
					| b')'
			);
			let fail = c.fail(if operator || ch.is_ascii_alphanumeric() || ch == b'_' {
				"arithmetic syntax error in expression"
			} else {
				"arithmetic syntax error: invalid arithmetic operator"
			});
			root = Node::Seq(vec![root, fail]);
		}
	}
	Expr { src: BString::from(text), root }
}

/// bash's `VALID_NUMCHAR`: a digit of some base up to 64.
const fn is_numchar(c: u8) -> bool {
	c.is_ascii_alphanumeric() || c == b'_' || c == b'@'
}

/// The parser half of bash's evaluator: builds the tree, stopping at the
/// first syntax error.
struct Compiler<'a> {
	src:    &'a [u8],
	pos:    usize,
	/// Start of the last token read (bash's `lasttp`).
	last:   usize,
	/// Parenthesis, unary and `**` nesting.
	nest:   u32,
	/// A [`Node::Fail`] was produced: parse nothing more.
	failed: bool,
}

/// Offset as stored in nodes (expression text is far below 4 GiB).
fn off(at: usize) -> u32 {
	u32::try_from(at).unwrap_or(u32::MAX)
}

/// A compile-time [`Error::Eval`], raised each time its node is reached.
#[derive(Debug)]
struct SyntaxError {
	/// Expression being evaluated.
	expr:  BString,
	/// bash's message.
	msg:   &'static str,
	/// Rest of the expression from the offending token.
	token: BString,
}

impl Compiler<'_> {
	/// The syntax error `msg` at the last token; compilation stops.
	fn fail(&mut self, msg: &'static str) -> Node {
		self.failed = true;
		Node::Fail(Box::new(SyntaxError {
			expr: BString::from(self.src),
			msg,
			token: BString::from(self.src.get(self.last..).unwrap_or_default()),
		}))
	}

	/// `f` one nesting level deeper, failing past [`MAX_DEPTH`].
	fn nested(&mut self, f: fn(&mut Self) -> Node) -> Node {
		let (level, tok) = (self.nest, off(self.last));
		if level + 1 >= MAX_DEPTH {
			return self.fail("expression recursion level exceeded");
		}
		self.nest += 1;
		let inner = f(self);
		self.nest -= 1;
		Node::Nest { level, tok, inner: Box::new(inner) }
	}

	/// Whether the `++`/`--` at `at` is an increment token. bash's lexer
	/// reads one only before (blanks and) an identifier; otherwise it is
	/// two `+`/`-` operators (`7++ ` is `7 + +`, `--5` is `-(-5)`).
	fn incdec_at(&self, at: usize) -> bool {
		let rest = &self.src[at.min(self.src.len())..];
		if !(rest.starts_with(b"++") || rest.starts_with(b"--")) {
			return false;
		}
		rest[2..]
			.iter()
			.find(|c| !matches!(c, b' ' | b'\t' | b'\n' | b'\r'))
			.is_some_and(|&c| c == b'_' || c.is_ascii_alphabetic())
	}

	/// Consume a binary `+`/`-` (`op`), which bash's lexer also reads from
	/// the first half of a `++`/`--` that does not precede an identifier.
	fn eat_additive(&mut self, op: u8) -> bool {
		self.skip_ws();
		let rest = &self.src[self.pos..];
		if rest.first() != Some(&op) || rest.get(1) == Some(&b'=') || self.incdec_at(self.pos) {
			return false;
		}
		self.last = self.pos;
		self.pos += 1;
		true
	}

	fn skip_ws(&mut self) {
		while self
			.src
			.get(self.pos)
			.is_some_and(|c| matches!(c, b' ' | b'\t' | b'\n' | b'\r'))
		{
			self.pos += 1;
		}
	}

	/// Whether the next token is `op` (exact, and not the start of a longer
	/// operator listed in `not`); consumes it.
	fn eat(&mut self, op: &[u8], not: &[&[u8]]) -> bool {
		self.skip_ws();
		let rest = &self.src[self.pos..];
		if !rest.starts_with(op) || not.iter().any(|n| rest.starts_with(n)) {
			return false;
		}
		self.last = self.pos;
		self.pos += op.len();
		true
	}

	fn comma(&mut self) -> Node {
		let first = self.assign();
		if self.failed || !self.eat(b",", &[]) {
			return first;
		}
		let mut items = vec![first, self.assign()];
		while !self.failed && self.eat(b",", &[]) {
			items.push(self.assign());
		}
		Node::Seq(items)
	}

	fn assign(&mut self) -> Node {
		let start = self.pos;
		self.skip_ws();
		if let Some(lv) = self.peek_lvalue() {
			self.skip_ws();
			let ops: [(&[u8], Bin); 11] = [
				(b"<<=", Bin::Shl),
				(b">>=", Bin::Shr),
				(b"*=", Bin::Mul),
				(b"/=", Bin::Div),
				(b"%=", Bin::Mod),
				(b"+=", Bin::Add),
				(b"-=", Bin::Sub),
				(b"&=", Bin::BitAnd),
				(b"^=", Bin::BitXor),
				(b"|=", Bin::BitOr),
				(b"=", Bin::Set),
			];
			for (tok, op) in ops {
				if self.src[self.pos..].starts_with(tok)
					&& !(op == Bin::Set && self.src[self.pos..].starts_with(b"=="))
				{
					self.last = self.pos;
					self.pos += tok.len();
					let rhs = self.assign();
					let tok = off(self.last);
					return Node::Assign { lv: Box::new(lv), op, tok, rhs: Box::new(rhs) };
				}
			}
		}
		self.pos = start;
		let v = self.ternary();
		if self.failed {
			return v;
		}
		self.skip_ws();
		let rest = &self.src[self.pos..];
		let assigning = (rest.starts_with(b"=") && !rest.starts_with(b"=="))
			|| [&b"*="[..], b"/=", b"%=", b"+=", b"-=", b"&=", b"^=", b"|=", b"<<=", b">>="]
				.iter()
				.any(|op| rest.starts_with(op));
		if assigning {
			self.last = self.pos;
			let fail = self.fail("attempted assignment to non-variable");
			return Node::Seq(vec![v, fail]);
		}
		v
	}

	/// An identifier (with optional `[subscript]`) at the cursor; the
	/// cursor stays put when there is none.
	fn peek_lvalue(&mut self) -> Option<Lv> {
		let save = self.pos;
		let lv = self.lvalue();
		if lv.is_none() {
			self.pos = save;
		}
		lv
	}

	fn lvalue(&mut self) -> Option<Lv> {
		let rest = &self.src[self.pos..];
		if !rest
			.first()
			.is_some_and(|&c| c == b'_' || c.is_ascii_alphabetic())
		{
			return None;
		}
		let n = rest
			.iter()
			.position(|&c| c != b'_' && !c.is_ascii_alphanumeric())
			.unwrap_or(rest.len());
		let name = BString::from(&rest[..n]);
		let start = self.pos;
		self.pos += n;
		let mut index = None;
		if self.src.get(self.pos) == Some(&b'[') {
			let mut depth = 0;
			let mut i = self.pos;
			while i < self.src.len() {
				match self.src[i] {
					// An escaped bracket (from an expansion) is part of the
					// subscript.
					b'\\' => i += 1,
					b'[' => depth += 1,
					b']' => {
						depth -= 1;
						if depth == 0 {
							break;
						}
					},
					_ => {},
				}
				i += 1;
			}
			if i >= self.src.len() {
				self.pos = start;
				return None;
			}
			index = Some(BString::from(&self.src[self.pos + 1..i]));
			self.pos = i + 1;
		}
		Some(Lv { name, index, level: self.nest })
	}

	fn ternary(&mut self) -> Node {
		let c = self.or();
		if self.failed || !self.eat(b"?", &[]) {
			return c;
		}
		// bash's `expcond`: the middle is a full (comma) expression, the
		// last part another conditional.
		self.skip_ws();
		match self.src.get(self.pos) {
			None => {
				let fail = self.fail("expression expected");
				return Node::Seq(vec![c, fail]);
			},
			Some(b':') => {
				self.last = self.pos;
				let fail = self.fail("expression expected");
				return Node::Seq(vec![c, fail]);
			},
			Some(_) => {},
		}
		let a = self.comma();
		let b = if self.failed {
			Node::Num(0)
		} else if !self.eat(b":", &[]) {
			self.fail("`:' expected for conditional expression")
		} else {
			self.skip_ws();
			if self.pos >= self.src.len() {
				self.fail("expression expected")
			} else {
				self.ternary()
			}
		};
		Node::Cond(Box::new([c, a, b]))
	}

	fn or(&mut self) -> Node {
		let first = self.and();
		let mut rest = Vec::new();
		while !self.failed && self.eat(b"||", &[]) {
			rest.push(self.and());
		}
		if rest.is_empty() {
			first
		} else {
			Node::Or(Box::new(first), rest)
		}
	}

	fn and(&mut self) -> Node {
		let first = self.bitor();
		let mut rest = Vec::new();
		while !self.failed && self.eat(b"&&", &[]) {
			rest.push(self.bitor());
		}
		if rest.is_empty() {
			first
		} else {
			Node::And(Box::new(first), rest)
		}
	}

	/// A left-associative chain: operands from `next`, operators from
	/// `op`. Each step records `lasttp` after its right operand (where a
	/// division by zero points).
	fn chain(&mut self, next: fn(&mut Self) -> Node, op: fn(&mut Self) -> Option<Bin>) -> Node {
		let first = next(self);
		let mut rest = Vec::new();
		while !self.failed {
			let Some(o) = op(self) else {
				break;
			};
			let r = next(self);
			rest.push((o, off(self.last), r));
		}
		if rest.is_empty() {
			first
		} else {
			Node::Binary(Box::new(first), rest)
		}
	}

	fn bitor(&mut self) -> Node {
		self.chain(Self::bitxor, |c| c.eat(b"|", &[b"||", b"|="]).then_some(Bin::BitOr))
	}

	fn bitxor(&mut self) -> Node {
		self.chain(Self::bitand, |c| c.eat(b"^", &[b"^="]).then_some(Bin::BitXor))
	}

	fn bitand(&mut self) -> Node {
		self.chain(Self::equality, |c| c.eat(b"&", &[b"&&", b"&="]).then_some(Bin::BitAnd))
	}

	fn equality(&mut self) -> Node {
		self.chain(Self::relational, |c| {
			if c.eat(b"==", &[]) {
				Some(Bin::Eq)
			} else {
				c.eat(b"!=", &[]).then_some(Bin::Ne)
			}
		})
	}

	fn relational(&mut self) -> Node {
		self.chain(Self::shift, |c| {
			if c.eat(b"<=", &[]) {
				Some(Bin::Le)
			} else if c.eat(b">=", &[]) {
				Some(Bin::Ge)
			} else if c.eat(b"<", &[b"<<"]) {
				Some(Bin::Lt)
			} else {
				c.eat(b">", &[b">>"]).then_some(Bin::Gt)
			}
		})
	}

	fn shift(&mut self) -> Node {
		self.chain(Self::additive, |c| {
			if c.eat(b"<<", &[b"<<="]) {
				Some(Bin::Shl)
			} else {
				c.eat(b">>", &[b">>="]).then_some(Bin::Shr)
			}
		})
	}

	fn additive(&mut self) -> Node {
		self.chain(Self::multiplicative, |c| {
			if c.eat_additive(b'+') {
				Some(Bin::Add)
			} else {
				c.eat_additive(b'-').then_some(Bin::Sub)
			}
		})
	}

	fn multiplicative(&mut self) -> Node {
		self.chain(Self::power, |c| {
			if c.eat(b"*", &[b"**", b"*="]) {
				Some(Bin::Mul)
			} else if c.eat(b"/", &[b"/="]) {
				Some(Bin::Div)
			} else {
				c.eat(b"%", &[b"%="]).then_some(Bin::Mod)
			}
		})
	}

	fn power(&mut self) -> Node {
		let base = self.unary();
		if self.failed || !self.eat(b"**", &[b"**="]) {
			return base;
		}
		let exp = self.nested(Self::power);
		Node::Pow { base: Box::new(base), exp: Box::new(exp), tok: off(self.last) }
	}

	fn unary(&mut self) -> Node {
		self.skip_ws();
		if self.incdec_at(self.pos) {
			let delta = if self.src[self.pos] == b'+' { 1 } else { -1 };
			self.last = self.pos;
			self.pos += 2;
			self.skip_ws();
			let Some(lv) = self.lvalue() else {
				return self.fail("identifier expected after pre-increment or pre-decrement");
			};
			let node = Node::PreInc(Box::new(lv), delta);
			// `--x++`: the incremented value is no lvalue.
			self.skip_ws();
			let rest = &self.src[self.pos..];
			if rest.starts_with(b"++") || rest.starts_with(b"--") {
				let msg = if rest[0] == b'+' {
					"++: assignment requires lvalue"
				} else {
					"--: assignment requires lvalue"
				};
				self.last = self.pos;
				let fail = self.fail(msg);
				return Node::Seq(vec![node, fail]);
			}
			return node;
		}
		let op = if self.eat(b"!", &[b"!="]) {
			Some(Un::Not)
		} else if self.eat(b"~", &[]) {
			Some(Un::BitNot)
		} else if self.eat(b"-", &[]) {
			Some(Un::Neg)
		} else if self.eat(b"+", &[]) {
			None
		} else {
			return self.postfix();
		};
		let inner = self.nested(Self::unary);
		match op {
			Some(op) => Node::Unary(op, Box::new(inner)),
			None => inner,
		}
	}

	fn postfix(&mut self) -> Node {
		self.skip_ws();
		let start = self.pos;
		let Some(lv) = self.lvalue() else {
			return self.primary();
		};
		self.last = start;
		self.skip_ws();
		let rest = &self.src[self.pos..];
		if rest.starts_with(b"++") || rest.starts_with(b"--") {
			let delta = if rest[0] == b'+' { 1 } else { -1 };
			self.last = self.pos;
			self.pos += 2;
			return Node::PostInc(Box::new(lv), delta);
		}
		Node::Var(Box::new(lv))
	}

	fn primary(&mut self) -> Node {
		self.skip_ws();
		let Some(&c) = self.src.get(self.pos) else {
			return self.fail("arithmetic syntax error: operand expected");
		};
		if c == b'(' {
			self.last = self.pos;
			self.pos += 1;
			let inner = self.nested(Self::comma);
			if self.failed || self.eat(b")", &[]) {
				return inner;
			}
			let fail = self.fail("missing `)'");
			return Node::Seq(vec![inner, fail]);
		}
		self.last = self.pos;
		if c.is_ascii_digit() {
			return self.number();
		}
		// A name whose `[` has no matching `]` (`let 'b[1'`, the lvalue
		// parse gave up on it): bash's `expr_skipsubscript` fails.
		if c == b'_' || c.is_ascii_alphabetic() {
			let n = self.src[self.pos..]
				.iter()
				.position(|&c| c != b'_' && !c.is_ascii_alphanumeric())
				.map_or(self.src.len(), |n| self.pos + n);
			if self.src.get(n) == Some(&b'[') {
				return self.fail("bad array subscript");
			}
		}
		// Whatever bash's lexer finds where an operand belongs (an
		// operator, a quote, `$`) follows an operator or the start.
		self.fail("arithmetic syntax error: operand expected")
	}

	/// A numeric constant (bash's `strlong`): `0` octal, `0x` hex,
	/// `BASE#DIGITS`. bash's lexer cuts the expression at the end of the
	/// constant while converting it, so its errors show the text only up to
	/// there.
	fn number(&mut self) -> Node {
		let start = self.pos;
		let n = self.src[start..]
			.iter()
			.position(|&c| !(is_numchar(c) || c == b'#'))
			.unwrap_or(self.src.len() - start);
		let end = start + n;
		self.pos = end;
		match strlong(&self.src[start..end]) {
			Ok(v) => Node::Num(v),
			Err(msg) => {
				self.failed = true;
				Node::Fail(Box::new(SyntaxError {
					expr: BString::from(&self.src[..end]),
					msg,
					token: BString::from(&self.src[start..end]),
				}))
			},
		}
	}
}

/// bash's `strlong` over one constant token.
fn strlong(tok: &[u8]) -> Result<i64, &'static str> {
	let (mut base, mut foundbase, mut s) = (10i64, false, 0);
	if tok.first() == Some(&b'0') {
		s = 1;
		if matches!(tok.get(1), Some(b'x' | b'X')) {
			base = 16;
			s = 2;
		} else {
			base = 8;
		}
		foundbase = true;
	}
	let mut val: i64 = 0;
	while let Some(&c) = tok.get(s) {
		s += 1;
		if c == b'#' {
			if foundbase {
				return Err("invalid number");
			}
			if !(2..=64).contains(&val) {
				return Err("invalid arithmetic base");
			}
			base = val;
			val = 0;
			foundbase = true;
			if !tok.get(s).is_some_and(|&c| is_numchar(c)) {
				return Err("invalid integer constant");
			}
			continue;
		}
		let d = match c {
			b'0'..=b'9' => c - b'0',
			b'a'..=b'z' => c - b'a' + 10,
			b'A'..=b'Z' if base <= 36 => c - b'A' + 10,
			b'A'..=b'Z' => c - b'A' + 36,
			b'@' => 62,
			_ => 63,
		};
		if i64::from(d) >= base {
			return Err("value too great for base");
		}
		val = val.wrapping_mul(base).wrapping_add(i64::from(d));
	}
	Ok(val)
}

/// An associative-array key as the arithmetic text carries it: the
/// expansion of the text backslash-escaped what came from expansions and
/// single quotes (bash's `expand_array_subscript`); undo that.
fn unescape(key: &[u8]) -> BString {
	let mut out = Vec::with_capacity(key.len());
	let mut it = key.iter();
	while let Some(&c) = it.next() {
		match (c, it.as_slice().first()) {
			(b'\\', Some(&n)) => {
				out.push(n);
				it.next();
			},
			_ => out.push(c),
		}
	}
	BString::from(out)
}

/// An indexed subscript before evaluation: bash's quote removal in
/// double-quote mode (`string_quote_removal` with `Q_DOUBLE_QUOTES`):
/// unescaped `"` disappear, `\` stays except before `$`, `` ` ``, `"`,
/// `\`, a newline and the brackets the expander escapes, `'` is literal.
fn dquote_removal(text: &[u8]) -> BString {
	if !text.iter().any(|c| matches!(c, b'"' | b'\\')) {
		return BString::from(text);
	}
	let mut out = Vec::with_capacity(text.len());
	let mut it = text.iter();
	while let Some(&c) = it.next() {
		match c {
			b'"' => {},
			b'\\' => match it.next() {
				Some(&n) => {
					// The expander escapes a nested subscript's brackets
					// (`a[b\[1\]]`) and `~`; bash 5.3.20's Q_ARITH quote
					// removal unescapes them.
					if !matches!(n, b'$' | b'`' | b'"' | b'\\' | b'\n' | b'[' | b']' | b'~') {
						out.push(b'\\');
					}
					out.push(n);
				},
				None => out.push(b'\\'),
			},
			_ => out.push(c),
		}
	}
	BString::from(out)
}

/// The evaluator half: walks a compiled expression.
struct Walk<'a> {
	expr:   &'a Expr,
	env:    &'a mut dyn Env,
	/// Variable-recursion depth of this expression.
	depth:  u32,
	/// >0 inside a branch that is not evaluated (`0 && x++`).
	noeval: u32,
}

impl Walk<'_> {
	fn err(&self, msg: &'static str, tok: u32) -> Error {
		let src = &self.expr.src;
		Error::Eval {
			expr: src.clone(),
			msg,
			token: BString::from(src.get(tok as usize..).unwrap_or_default()),
		}
	}

	fn eval(&mut self, n: &Node) -> Result<i64, Error> {
		match n {
			Node::Num(v) => Ok(*v),
			Node::Fail(e) => {
				Err(Error::Eval { expr: e.expr.clone(), msg: e.msg, token: e.token.clone() })
			},
			Node::Seq(items) => {
				let mut v = 0;
				for it in items {
					v = self.eval(it)?;
				}
				Ok(v)
			},
			Node::Var(lv) => {
				// `y[]` (`y[$none]` once expanded) names no element: bash
				// reports it twice (once as it scans the token, once as it
				// reads the value) and the operand is 0.
				if self.noeval == 0 && lv.index.as_ref().is_some_and(|i| i.is_empty()) {
					let mut shown = lv.name.clone();
					shown.extend_from_slice(b"[]");
					self.env.warn(Diag::BadSubscript { shown: shown.clone() });
					self.env.warn(Diag::BadSubscript { shown });
					return Ok(0);
				}
				let key = self.subscript(lv)?;
				self.var_value(lv, key.as_ref().map(|k| k.as_slice()))
			},
			Node::PostInc(lv, delta) => {
				let key = self.subscript(lv)?;
				let key = key.as_ref().map(|k| k.as_slice());
				let v = self.var_value(lv, key)?;
				self.store(lv, key, v.wrapping_add(*delta))?;
				Ok(v)
			},
			Node::PreInc(lv, delta) => {
				let key = self.subscript(lv)?;
				let key = key.as_ref().map(|k| k.as_slice());
				let v = self.var_value(lv, key)?.wrapping_add(*delta);
				self.store(lv, key, v)?;
				Ok(v)
			},
			Node::Assign { lv, op, tok, rhs } => {
				// bash evaluates the subscript of `=` after the value, and
				// that of `OP=` once, before it.
				if *op == Bin::Set {
					let v = self.eval(rhs)?;
					// `a[]=v` (an empty subscript, as `a[""]` becomes after
					// the text's quote removal) names no element: bash
					// reports it and assigns nothing.
					if self.noeval == 0 && lv.index.as_ref().is_some_and(|i| i.is_empty()) {
						let mut shown = lv.name.clone();
						shown.extend_from_slice(b"[]");
						self.env.warn(Diag::InvalidIdent { name: shown });
						return Ok(v);
					}
					let key = self.subscript(lv)?;
					self.store(lv, key.as_ref().map(|k| k.as_slice()), v)?;
					return Ok(v);
				}
				let key = self.subscript(lv)?;
				let key = key.as_ref().map(|k| k.as_slice());
				let cur = self.var_value(lv, key)?;
				let r = self.eval(rhs)?;
				let v = self.apply(*op, cur, r, *tok)?;
				self.store(lv, key, v)?;
				Ok(v)
			},
			Node::Nest { level, tok, inner } => {
				if self.depth + level + 1 >= MAX_DEPTH {
					return Err(self.err("expression recursion level exceeded", *tok));
				}
				self.eval(inner)
			},
			Node::Unary(op, inner) => {
				let v = self.eval(inner)?;
				Ok(match op {
					Un::Not => i64::from(v == 0),
					Un::BitNot => !v,
					Un::Neg => v.wrapping_neg(),
				})
			},
			Node::Pow { base, exp, tok } => {
				let base = self.eval(base)?;
				let exp = self.eval(exp)?;
				if exp < 0 {
					return Err(self.err("exponent less than 0", *tok));
				}
				// Square-and-multiply with wrapping, as bash's `ipow`.
				let (mut r, mut b, mut e) = (1i64, base, exp);
				while e > 0 {
					if e & 1 == 1 {
						r = r.wrapping_mul(b);
					}
					b = b.wrapping_mul(b);
					e >>= 1;
				}
				Ok(r)
			},
			Node::Binary(first, rest) => {
				let mut v = self.eval(first)?;
				for (op, tok, r) in rest {
					let r = self.eval(r)?;
					v = self.apply(*op, v, r, *tok)?;
				}
				Ok(v)
			},
			Node::And(first, rest) => {
				let mut v = self.eval(first)?;
				for r in rest {
					let r = self.skipping(v == 0, r)?;
					v = i64::from(v != 0 && r != 0);
				}
				Ok(v)
			},
			Node::Or(first, rest) => {
				let mut v = self.eval(first)?;
				for r in rest {
					let r = self.skipping(v != 0, r)?;
					v = i64::from(v != 0 || r != 0);
				}
				Ok(v)
			},
			Node::Cond(parts) => {
				let [c, a, b] = &**parts;
				let c = self.eval(c)?;
				let a = self.skipping(c == 0, a)?;
				let b = self.skipping(c != 0, b)?;
				Ok(if c != 0 { a } else { b })
			},
		}
	}

	/// Evaluate `n`, without variable access when `skip`.
	fn skipping(&mut self, skip: bool, n: &Node) -> Result<i64, Error> {
		if skip {
			self.noeval += 1;
		}
		let r = self.eval(n);
		if skip {
			self.noeval -= 1;
		}
		r
	}

	/// The subscript of `lv` as [`Env`] takes it: an associative array's
	/// key as written, else the evaluated index. bash evaluates it once per
	/// lvalue use (`a[RANDOM%6]++` reads and writes one element); `None`
	/// in a skipped branch, where nothing is read or written.
	fn subscript(&mut self, lv: &Lv) -> Result<Option<BString>, Error> {
		match &lv.index {
			Some(i) if self.noeval == 0 => {
				if self.env.is_assoc(&lv.name) {
					// `let` under `assoc_expand_once` takes the key as is.
					return Ok(Some(if self.env.expanded() {
						i.clone()
					} else {
						self.env.expand_key(i)?
					}));
				}
				let level = self.depth + lv.level + 1;
				let n = if self.env.expanded() {
					eval_depth(i, self.env, level)
				} else if i.iter().any(|c| matches!(c, b'$' | b'`')) {
					let text = self.env.expand_index(i)?;
					eval_depth(&text, self.env, level)
				} else {
					eval_depth(&dquote_removal(i), self.env, level)
				}
				.map_err(Error::in_subscript)?;
				Ok(Some(BString::from(n.to_string())))
			},
			_ => Ok(None),
		}
	}

	/// The value of `lv` (element `key`), its text evaluated.
	fn var_value(&mut self, lv: &Lv, key: Option<&[u8]>) -> Result<i64, Error> {
		if self.noeval > 0 {
			return Ok(0);
		}
		let raw = match self.env.get(&lv.name, key)? {
			None => return Ok(0),
			Some(Value::Text(raw)) if raw.trim_ascii().is_empty() => return Ok(0),
			Some(raw) => raw,
		};
		let depth = self.depth + lv.level + 1;
		if depth >= MAX_DEPTH {
			return Err(Error::Eval {
				expr:  self.expr.src.clone(),
				msg:   "expression recursion level exceeded",
				token: lv.name.clone(),
			});
		}
		match raw {
			Value::Number(n) => Ok(n),
			Value::Text(raw) => eval_depth(&raw, self.env, depth),
		}
	}

	/// Assign `value` unless in a skipped branch.
	fn store(&mut self, lv: &Lv, key: Option<&[u8]>, value: i64) -> Result<(), Error> {
		if self.noeval == 0 {
			self.env.set(&lv.name, key, value)?;
		}
		Ok(())
	}

	fn apply(&self, op: Bin, a: i64, b: i64, tok: u32) -> Result<i64, Error> {
		Ok(match op {
			Bin::Set => b,
			Bin::Mul => a.wrapping_mul(b),
			Bin::Div | Bin::Mod => {
				if b == 0 {
					if self.noeval > 0 {
						return Ok(0);
					}
					return Err(self.err("division by 0", tok));
				}
				if op == Bin::Div {
					a.wrapping_div(b)
				} else {
					a.wrapping_rem(b)
				}
			},
			Bin::Add => a.wrapping_add(b),
			Bin::Sub => a.wrapping_sub(b),
			Bin::Shl => a.wrapping_shl(b as u32),
			Bin::Shr => a.wrapping_shr(b as u32),
			Bin::Lt => i64::from(a < b),
			Bin::Le => i64::from(a <= b),
			Bin::Gt => i64::from(a > b),
			Bin::Ge => i64::from(a >= b),
			Bin::Eq => i64::from(a == b),
			Bin::Ne => i64::from(a != b),
			Bin::BitAnd => a & b,
			Bin::BitXor => a ^ b,
			Bin::BitOr => a | b,
		})
	}
}

#[cfg(test)]
mod tests {
	use std::collections::HashMap as StdMap;

	use super::*;

	#[derive(Default)]
	struct Vars(StdMap<BString, BString>, Cache, Vec<String>);

	/// `name` or `name[index]`.
	fn slot(name: &[u8], index: Option<&[u8]>) -> BString {
		let mut k = BString::from(name);
		if let Some(i) = index {
			k.push(b'[');
			k.extend_from_slice(i);
			k.push(b']');
		}
		k
	}

	impl Env for Vars {
		fn get(&mut self, name: &[u8], index: Option<&[u8]>) -> Result<Option<Value>, Error> {
			Ok(self.0.get(&slot(name, index)).map(|v| Value::of(v)))
		}

		fn set(&mut self, name: &[u8], index: Option<&[u8]>, value: i64) -> Result<(), Error> {
			self
				.0
				.insert(slot(name, index), BString::from(value.to_string()));
			Ok(())
		}

		fn is_assoc(&mut self, _name: &[u8]) -> bool {
			false
		}

		fn warn(&mut self, diag: Diag) {
			self.2.push(diag.to_string());
		}

		/// `$name` only: enough for the evaluator's subscript expansion.
		fn expand_index(&mut self, text: &[u8]) -> Result<BString, Error> {
			let name = text.strip_prefix(b"$").unwrap_or(text);
			Ok(self.0.get(name).cloned().unwrap_or_default())
		}

		fn cache(&self) -> &Cache {
			&self.1
		}
	}

	impl Cache {
		fn len(&self) -> usize {
			let gens = self.gens.lock();
			gens.young.len() + gens.old.len()
		}
	}

	fn ev(s: &str) -> Result<i64, Error> {
		eval(s.as_bytes(), &mut Vars::default())
	}

	// A variable's value read as a number without evaluating it
	// (`Value::Number`) gives what evaluating it gives: a leading zero is
	// octal, a sign or a blank goes through the evaluator, and a decimal
	// out of range wraps.
	#[test]
	fn variable_values_read_like_expressions() {
		for (value, want) in [
			("12", 12),
			("0", 0),
			("010", 8),
			("0x10", 16),
			("-3", -3),
			(" 7 ", 7),
			("9223372036854775808", i64::MIN),
			("2+3", 5),
		] {
			let mut v = Vars::default();
			v.0.insert(BString::from("x"), BString::from(value));
			assert_eq!(eval(b"x", &mut v).unwrap(), want, "x={value}");
		}
		assert_eq!(Value::of(b"12"), Value::Number(12));
		assert_eq!(Value::of(b"012"), Value::Text(BString::from("012")));
		assert_eq!(Value::of(b"-1"), Value::Text(BString::from("-1")));
	}

	// Goldens: bash 5.3.20 (arith6.sub): `=` evaluates its subscript after
	// the value; `++` and `OP=` evaluate it once.
	#[test]
	fn subscripts_evaluate_like_bash() {
		let mut v = Vars::default();
		assert_eq!(eval(b"n = 0, (a[n] = ++n), n", &mut v).unwrap(), 1);
		assert_eq!(v.0.get(&BString::from("a[1]")).map(|s| s.to_string()), Some("1".to_owned()));
		assert!(!v.0.contains_key(&BString::from("a[0]")));
		assert_eq!(eval(b"i = 0, b[i++]++, b[i++] += 5, i", &mut v).unwrap(), 2);
		assert_eq!(v.0[&BString::from("b[0]")], "1");
		assert_eq!(v.0[&BString::from("b[1]")], "5");
	}

	// Golden: bash 5.3.20 `(( a[""]=24 ))` → `((: `a[]': not a valid
	// identifier`, nothing assigned, evaluation goes on.
	#[test]
	fn empty_subscript_assignment_warns() {
		let mut v = Vars::default();
		assert_eq!(eval(b"a[]=24, 7", &mut v).unwrap(), 7);
		assert!(!v.0.contains_key(&BString::from("a[0]")));
		assert_eq!(v.2, ["`a[]': not a valid identifier"]);
	}

	// Goldens: bash 5.3.20. `(( a[\" \"]=16 ))` reaches the evaluator as
	// `a[" "]=16` and stores element 0; an expansion's quotes arrive
	// escaped (`x='" "'; (( a[$x]=1 ))` → `a[\" \"]`) and stay literal.
	#[test]
	fn indexed_subscripts_lose_double_quotes() {
		let mut v = Vars::default();
		assert_eq!(eval(b"a[\" \"]=16", &mut v).unwrap(), 16);
		assert_eq!(v.0[&BString::from("a[0]")], "16");
		let err = Diag::from(eval(br#"a[\" \"]=1"#, &mut v).unwrap_err()).to_string();
		assert_eq!(err, r#"" ": arithmetic syntax error: operand expected (error token is "" "")"#);
		let err = Diag::from(eval(br"a[\1]", &mut v).unwrap_err()).to_string();
		assert_eq!(err, r#"\1: arithmetic syntax error: operand expected (error token is "\1")"#);
		assert_eq!(dquote_removal(br"\$j"), "$j");
		// `k='~'; (( a[$k] ))` → `~: arithmetic syntax error` (bash 5.3.20).
		assert_eq!(dquote_removal(br"\~\[\]\a"), r"~[]\a");
		assert_eq!(unescape(br"x\],b\[\$(echo)"), "x],b[$(echo)");
	}

	// Goldens: bash 5.3.20. A subscript still holding `$` when evaluated
	// (`e='a[$k]=5'; (( $e ))`) is expanded once, then evaluated; the
	// value's own `$(…)` stays text (`key='x],b[$(echo)'`).
	#[test]
	fn subscripts_reached_unexpanded_are_expanded_once() {
		let mut v = Vars::default();
		v.0.insert("k".into(), "3".into());
		assert_eq!(eval(b"a[$k]=5", &mut v).unwrap(), 5);
		assert_eq!(v.0[&BString::from("a[3]")], "5");
		v.0.insert("key".into(), "x],b[$(echo)".into());
		let err = Diag::from(eval(b"a[$key]", &mut v).unwrap_err()).to_string();
		assert_eq!(
			err,
			r#"x],b[$(echo): arithmetic syntax error: invalid arithmetic operator (error token is "],b[$(echo)")"#
		);
	}

	#[test]
	fn precedence_bases_and_wrapping() {
		assert_eq!(ev("1 + 2 * 3").unwrap(), 7);
		assert_eq!(ev("(1+2)*3").unwrap(), 9);
		assert_eq!(ev("2**10").unwrap(), 1024);
		assert_eq!(ev("2**3**2").unwrap(), 512, "** is right-associative");
		assert_eq!(ev("0x1f + 010 + 2#101 + 64#_").unwrap(), 31 + 8 + 5 + 63);
		assert_eq!(ev("9223372036854775807 + 1").unwrap(), i64::MIN);
		assert_eq!(ev("-7 / 2").unwrap(), -3);
		assert_eq!(ev("-7 % 2").unwrap(), -1);
		assert_eq!(ev("5 > 3 && 0 || 7, 9").unwrap(), 9);
		assert_eq!(ev("1 ? 2 : 3").unwrap(), 2);
		assert_eq!(ev("!0 + ~0").unwrap(), 0);
		assert_eq!(ev("").unwrap(), 0);
		// `&` binds tighter than `^`, which binds tighter than `|`:
		// ((7 & 3) ^ 1) | 8 = 10 (bash 5.3.20).
		assert_eq!(ev("10 - 2 - 3, 2 << 3 >> 1, 7 & 3 ^ 1 | 8").unwrap(), 10);
	}

	#[test]
	fn variables_assign_and_evaluate_recursively() {
		let mut v = Vars::default();
		v.0.insert("a".into(), "2*3".into());
		assert_eq!(eval(b"a+1", &mut v).unwrap(), 7);
		assert_eq!(eval(b"i=5, i++ + ++i", &mut v).unwrap(), 12);
		assert_eq!(v.0[&BString::from("i")], "7");
		assert_eq!(eval(b"i += 3, i <<= 1", &mut v).unwrap(), 20);
		assert_eq!(eval(b"0 && (j=1), j", &mut v).unwrap(), 0, "short-circuit skips side effects");
		assert_eq!(eval(b"1 || (j=1), 0 ? (j=2) : j", &mut v).unwrap(), 0);
		assert_eq!(eval(b"unset_var + 1", &mut v).unwrap(), 1);
	}

	/// The diagnostic body bash prints for `text`.
	fn diag(text: &str, v: &mut Vars) -> String {
		Diag::from(eval(text.as_bytes(), v).unwrap_err()).to_string()
	}

	// Goldens: bash 5.3.20 `echo $((…))` diagnostics (after `line N: `).
	#[test]
	fn errors_match_bash_messages_and_tokens() {
		let check = |s: &str, want: &str| assert_eq!(diag(s, &mut Vars::default()), want, "{s}");
		check(" 1 + ", r#"1 + : arithmetic syntax error: operand expected (error token is "+ ")"#);
		check("1/0", r#"1/0: division by 0 (error token is "0")"#);
		check("08", r#"08: value too great for base (error token is "08")"#);
		check("2 ** -1 ", r#"2 ** -1 : exponent less than 0 (error token is "1 ")"#);
		check("1 ? 2 ", r#"1 ? 2 : `:' expected for conditional expression (error token is "2 ")"#);
		check("3=4 ", r#"3=4 : attempted assignment to non-variable (error token is "=4 ")"#);
		check(
			"1 @ 2 ",
			r#"1 @ 2 : arithmetic syntax error: invalid arithmetic operator (error token is "@ 2 ")"#,
		);
		check(
			"64#zz 37#a ",
			r#"64#zz 37#a : arithmetic syntax error in expression (error token is "37#a ")"#,
		);
		// Constants: the expression is cut at the end of the bad constant.
		check(" 3425#56 ", r#"3425#56: invalid arithmetic base (error token is "3425#56")"#);
		check(" 2# ", r#"2#: invalid integer constant (error token is "2#")"#);
		check("0#4", r#"0#4: invalid number (error token is "0#4")"#);
		check("1 + 08 + 2", r#"1 + 08: value too great for base (error token is "08")"#);
		assert_eq!(ev("0x").unwrap(), 0);
		// Conditionals.
		check("4 ? : 3 + 5 ", r#"4 ? : 3 + 5 : expression expected (error token is ": 3 + 5 ")"#);
		check("4 ? 20 : ", r#"4 ? 20 : : expression expected (error token is ": ")"#);
		check(
			"1 ? 20 : x+=2",
			r#"1 ? 20 : x+=2: attempted assignment to non-variable (error token is "+=2")"#,
		);
		assert_eq!(ev("1 ? 2, 3 : 4").unwrap(), 3);
		// A non-operand where one belongs (bash: `let '0 - ""'`).
		check(
			r#"0 - """#,
			r#"0 - "": arithmetic syntax error: operand expected (error token is """")"#,
		);
		let mut v = Vars::default();
		v.0.insert("a".into(), "a".into());
		assert_eq!(
			diag("a", &mut v),
			r#"a: expression recursion level exceeded (error token is "a")"#
		);
	}

	// Goldens: bash 5.3.20 — bash evaluates while parsing, so errors and
	// side effects to the left of a syntax error come first.
	#[test]
	fn errors_keep_bash_order() {
		let check = |s: &str, want: &str| assert_eq!(diag(s, &mut Vars::default()), want, "{s}");
		check("1/0 + ", r#"1/0 + : division by 0 (error token is "0 + ")"#);
		check(
			"0 && 1/0 + ",
			r#"0 && 1/0 + : arithmetic syntax error: operand expected (error token is "+ ")"#,
		);
		check("0 && 08", r#"0 && 08: value too great for base (error token is "08")"#);
		let mut v = Vars::default();
		assert!(eval(b"x = 5, 1 + ", &mut v).is_err());
		assert_eq!(v.0[&BString::from("x")], "5", "the assignment ran before the error");
	}

	// Goldens: bash 5.3.20; `++`/`--` is an increment only before an
	// identifier (or right after one), else two `+`/`-` operators.
	#[test]
	fn increments_lex_like_bash() {
		let check = |s: &str, want: &str| assert_eq!(diag(s, &mut Vars::default()), want, "{s}");
		check("7++ ", r#"7++ : arithmetic syntax error: operand expected (error token is "+ ")"#);
		check("7 ++x ", r#"7 ++x : arithmetic syntax error in expression (error token is "++x ")"#);
		check(
			"7 ++ x ",
			r#"7 ++ x : arithmetic syntax error in expression (error token is "++ x ")"#,
		);
		check("x++ ++", r#"x++ ++: arithmetic syntax error: operand expected (error token is "+")"#);
		check("j=", r#"j=: arithmetic syntax error: operand expected (error token is "=")"#);
		check("--x++ ", r#"--x++ : ++: assignment requires lvalue (error token is "++ ")"#);
		assert_eq!(ev("--5").unwrap(), 5);
		assert_eq!(ev("++5").unwrap(), 5);
		assert_eq!(ev("1 --2").unwrap(), 3);
		let mut v = Vars::default();
		assert_eq!(eval(b"x = 4, ++x + x++", &mut v).unwrap(), 10);
		assert_eq!(v.0[&BString::from("x")], "6");
	}

	#[test]
	fn cache_reuses_compiled_expressions() {
		let mut v = Vars::default();
		v.0.insert("a".into(), "2*3".into());
		assert_eq!(eval(b"  a + 1", &mut v).unwrap(), 7);
		// Leading blanks are not part of the key; the variable's value went
		// through the same cache.
		assert!(Arc::ptr_eq(&v.1.get(b"a + 1"), &v.1.get(b"a + 1")));
		assert_eq!(v.1.len(), 2, "`a + 1` and `2*3`");
		assert_eq!(eval(b"a + 1", &mut v).unwrap(), 7);
		assert_eq!(v.1.len(), 2);
		// A cached expression sees the current variable values.
		v.0.insert("a".into(), "10".into());
		assert_eq!(eval(b"a + 1", &mut v).unwrap(), 11);
		// Errors are cached too and repeat identically.
		let e = diag("1/0 + ", &mut v);
		assert_eq!(diag("1/0 + ", &mut v), e);
	}

	#[test]
	fn cache_is_bounded() {
		let cache = Cache::default();
		for i in 0..=CACHE_ENTRIES {
			cache.get(i.to_string().as_bytes());
		}
		assert!(cache.len() <= CACHE_ENTRIES);
		assert!(cache.len() >= 1);
	}

	#[test]
	fn cache_keeps_hot_expressions_past_the_bound() {
		let cache = Cache::default();
		let hot = cache.get(b"i + 1");
		for i in 0..CACHE_ENTRIES * 2 {
			cache.get(format!("x{i}").as_bytes());
			// Used every round: never recompiled.
			assert!(Arc::ptr_eq(&hot, &cache.get(b"i + 1")), "recompiled at {i}");
		}
		assert!(cache.len() <= CACHE_ENTRIES);
	}

	// Goldens: bash 5.3.20, `x=VALUE; echo $((x))`.
	#[test]
	fn decimal_values_skip_the_compiler() {
		let mut v = Vars::default();
		for (value, want) in [
			("42", 42),
			("  -42 \t\n", -42),
			("+7", 7),
			("0", 0),
			("-0", 0),
			("010", 8),
			("0x10", 16),
			("2#101", 5),
			("9223372036854775807", i64::MAX),
			("9223372036854775808", i64::MIN),
			("-9223372036854775808", i64::MIN),
			("99999999999999999999", 7_766_279_631_452_241_919),
		] {
			v.0.insert("x".into(), value.into());
			assert_eq!(eval(b"x", &mut v).unwrap(), want, "{value:?}");
		}
		// Plain numbers stay out of the cache; only `x` was compiled, plus
		// the three that need the compiler.
		assert_eq!(v.1.len(), 4);
		assert_eq!(decimal_value(b"12", 0), Some(12));
		assert_eq!(decimal_value(b"- 1", 0), None);
		assert_eq!(decimal_value(b"1 2", 0), None);
		assert_eq!(decimal_value(b"1\x0c", 0), None);
		assert_eq!(decimal_value(b"-", 0), None);
		assert_eq!(decimal_value(b"--1", 0), None);
		// A sign is a nesting level: at the limit the compiler reports it.
		assert_eq!(decimal_value(b"-1", MAX_DEPTH - 1), None);
		assert_eq!(decimal_value(b"1", MAX_DEPTH - 1), Some(1));
		v.0.insert("x".into(), "1\x0c".into());
		assert!(eval(b"x", &mut v).is_err());
	}

	#[test]
	fn deep_nesting_is_bounded() {
		let deep = format!("{}1{}", "(".repeat(300), ")".repeat(300));
		let err = ev(&deep).unwrap_err();
		assert!(matches!(err, Error::Eval { msg: "expression recursion level exceeded", .. }));
		let long = vec!["1"; 20_000].join("+");
		assert_eq!(ev(&long).unwrap(), 20_000, "operator chains are not recursion");
	}
}
