//! Perl term parsing and operator precedence (perlop, perldata, perlfunc, perlref and perlobj).

use super::*;
use crate::perl::lexer::{Quoted, ident_unit, sigil_name_start, variable_end};

const P_OR: u8 = 1;
const P_AND: u8 = 2;
const P_NOT: u8 = 3;
const P_COMMA: u8 = 5;
/// Assignment precedence for signature defaults.
pub(super) const P_ASSIGN: u8 = 6;
const P_TERNARY: u8 = 7;
const P_RANGE: u8 = 8;
const P_DEFINED: u8 = 9;
const P_LOG_AND: u8 = 10;
const P_BIT_OR: u8 = 11;
const P_BIT_AND: u8 = 12;
const P_EQUAL: u8 = 13;
const P_ORDER: u8 = 14;
const P_UNARY: u8 = 16;
const P_SHIFT: u8 = 17;
const P_ADD: u8 = 18;
const P_MUL: u8 = 19;
const P_BIND: u8 = 20;
const P_PREFIX: u8 = 21;
const P_POWER: u8 = 22;
const P_INC: u8 = 23;
const P_ARROW: u8 = 24;

fn node(location: Location, kind: ExprKind) -> Expr { Expr { location, cache: NodeCache::default(), kind } }
fn unary(location: Location, op: Unary, inner: Expr) -> Expr { node(location, ExprKind::Unary(op, Box::new(inner))) }
fn empty(location: Location) -> Expr { node(location, ExprKind::List(Vec::new())) }

impl<'s, 'h> Parser<'s, 'h> {
	/// Parse an expression through the requested minimum precedence.
	pub(super) fn expr(&mut self, min: u8) -> ResultOf<Expr> {
		self.nested(|parser| {
			let term = parser.prefix()?;
			parser.expr_rest(term, min)
		})
	}

	fn expr_rest(&mut self, mut term: Expr, min: u8) -> ResultOf<Expr> {
		if min <= P_ARROW { term = self.postfix(term)?; }
		loop {
			let token = self.peek();
			let spelling = self.lex.text(&token);
			if self.split_operator(&token, min) { continue; }
			if min <= P_INC && matches!(spelling, b"++" | b"--") {
				if matches!(&term.kind, ExprKind::Unary(Unary::PostInc | Unary::PostDec, _)) { return Err(self.error()); }
				self.bump();
				let op = if spelling == b"++" { Unary::PostInc } else { Unary::PostDec };
				self.wrap_tree()?;
				term = unary(token.location, op, term);
				continue;
			}
			if min <= P_TERNARY && spelling == b"?" {
				self.bump();
				let yes = self.expr(0)?;
				self.expect(b":")?;
				let no = self.expr(P_TERNARY)?;
				self.wrap_tree()?;
				term = node(token.location, ExprKind::Conditional(Box::new(term), Box::new(yes), Box::new(no)));
				continue;
			}
			if min <= P_COMMA && matches!(spelling, b"," | b"=>") {
				let location = term.location.clone();
				let mut list = match term.kind { ExprKind::List(list) => list, _ => vec![term] };
				let mut trailing = false;
				while matches!(self.spelling(), b"," | b"=>") {
					self.bump();
					trailing = !self.can_term();
					if !trailing { list.push(self.expr(P_COMMA + 1)?); }
				}
				self.wrap_tree()?;
				term = node(location, ExprKind::List(list));
				// `substr $x, 0, 1, = $v`: after a trailing comma a list operator's arguments
				// are complete, and the operator applies to the call.
				if trailing && min == P_COMMA && infix(self.spelling()).is_some() { break; }
				continue;
			}
			if spelling == b"isa" && !self.features.isa { break; }
			if !self.features.bitwise && matches!(spelling, b"&." | b"|." | b"^." | b"&.=" | b"|.=" | b"^.=") { break; }
			let Some((op, prec, assoc)) = infix(spelling) else { break; };
			if prec < min { break; }
			self.bump();
			let mut right = self.expr(prec + u8::from(assoc != Assoc::Right))?;
			if let Binary::Bind(_) = op { self.bind_diagnostics(&term, &right, &token.location)?; }
			if let Some(message) = unmodifiable_assignment(op, &term, &right) {
				return Err(self.argument_error(message, false));
			}
			// Perl permits ternary lvalues, but an assignment inside the false arm
			// still binds to the conditional result unless it is parenthesized.
			if assoc == Assoc::Chain {
				let mut chain = Vec::new();
				let mut op = op;
				loop {
					let next = self.spelling();
					let Some((next_op, next_prec, next_assoc)) = infix(next) else { break; };
					if next_prec != prec { break; }
					if next_assoc != Assoc::Chain { return Err(self.error()); }
					self.bump();
					chain.push((op, right));
					op = next_op;
					right = self.expr(prec + 1)?;
				}
				if !chain.is_empty() {
					chain.push((op, right));
					self.wrap_tree()?;
					term = node(token.location, ExprKind::CompareChain(Box::new(term), chain));
					continue;
				}
			}
			if assoc == Assoc::None && infix(self.spelling()).is_some_and(|(_, next_prec, _)| next_prec == prec) {
				return Err(self.error());
			}
			self.wrap_tree()?;
			term = node(token.location, ExprKind::Binary(op, Box::new(term), Box::new(right)));
		}
		Ok(term)
	}

	fn split_operator(&mut self, token: &Token, min: u8) -> bool {
		let spelling = self.lex.text(token);
		let repeat = min <= P_MUL && token.kind == Kind::Word && spelling.first() == Some(&b'x') && spelling.get(1).is_some_and(u8::is_ascii_digit);
		let concat = min <= P_ADD && token.kind == Kind::Number && spelling.first() == Some(&b'.');
		if !(repeat || concat) { return false; }
		let mut op = token.clone();
		op.end = op.start + 1;
		op.kind = Kind::Symbol;
		self.lex.rewind(token);
		self.lex.advance(op.end);
		self.look = Some(op);
		true
	}

	/// Parse a term before any infix or postfix operator has been consumed.
	pub(super) fn prefix(&mut self) -> ResultOf<Expr> {
		let token = self.peek();
		let spelling = self.lex.text(&token);
		let location = token.location.clone();
		let result = match spelling {
			b"(" => return self.delimited_list(b"(", b")", true),
			b"[" => return self.delimited_list(b"[", b"]", false).map(|list| node(location, ExprKind::Array(Box::new(list)))),
			b"{" => return self.delimited_list(b"{", b"}", false).map(|list| node(location, ExprKind::Hash(Box::new(list)))),
			b"$" | b"@" | b"%" | b"&" | b"*" | b"**" | b"&." | b"%=" | b"*=" | b"&=" => return self.variable(true),
			b"/" | b"//" | b"/=" => return self.symbolic_quote(token, b'/'),
			b"\"" | b"'" | b"`" => return self.symbolic_quote(token, spelling[0]),
			b"<" | b"<=" | b"<=>" => return self.angle(token),
			b"<<" | b"<<=" => return self.here(token),
			b"+" | b"-" | b"!" | b"~" | b"~." | b"~~" | b"\\" | b"++" | b"--" => {
				self.bump();
				if spelling == b"-" {
					let next_raw = self.after_space(token.end);
					if let Some(end) = name_end(self.lex.source, next_raw, self.lex.utf8)
						&& self.lex.source.get(self.after_space(end)..).is_some_and(|tail| tail.starts_with(b"=>")) {
						let word = self.bump();
						let mut bytes = vec![b'-'];
						bytes.extend_from_slice(self.lex.text(&word));
						return Ok(node(location, ExprKind::String(PStr::new(bytes, self.lex.utf8))));
					}
					if let Some(op) = file_test(self.lex.source, token.end, self.lex.utf8) {
						self.bump();
						let next = self.peek();
						// `-f _` names the stat cache even when a sub `_` exists.
						let arg = if next.kind == Kind::Word && self.lex.text(&next) == b"_" {
							self.bump();
							Some(Box::new(node(next.location, ExprKind::Bareword("_".into()))))
						} else if self.can_term() && !matches!(self.spelling(), b"//" | b"//=") { Some(Box::new(self.expr(P_UNARY + 1)?)) } else { None };
						return Ok(node(location, ExprKind::FileTest(op, arg)));
					}
				}
				if spelling == b"~~" || spelling == b"~." && !self.features.bitwise {
					self.lex.rewind(&token);
					self.lex.advance(token.start + 1);
					return self.expr(P_PREFIX).map(|inner| unary(location, Unary::Complement, inner));
				}
				let (op, prec) = match spelling {
					b"+" => (Unary::Plus, P_PREFIX), b"-" => (Unary::Minus, P_PREFIX), b"!" => (Unary::Not, P_PREFIX),
					b"~" => (Unary::Complement, P_PREFIX), b"~." => (Unary::StringComplement, P_PREFIX),
					b"\\" => (Unary::Reference, P_PREFIX), b"++" => (Unary::PreInc, P_INC), _ => (Unary::PreDec, P_INC),
				};
				let rhs = if op == Unary::Reference && self.lex.source.get(self.after_space(token.end)) == Some(&b'&') {
					let code = self.variable(false)?;
					if self.at(b"(") { self.amp_call(code)? } else { code }
				} else { self.expr(prec)? };
				// `\(&name)` and `\(&a, &b)` take code references rather than calling.
				let rhs = if op == Unary::Reference { uncalled_code_refs(rhs) } else { rhs };
				return Ok(unary(location, op, rhs));
			}
			_ if token.kind == Kind::Number => {
				self.bump();
				if short_v(spelling) {
					if self.at(b"=>") { ExprKind::String(self.pstr(spelling)) }
					else if matches!(self.spelling(), b"(" | b"->") || self.prototype(&self.name(spelling)).is_some() { return self.word(token); }
					else { parse_number(spelling).ok_or_else(|| self.error_at(&token))? }
				} else if matches!(spelling, b"0x" | b"0X" | b"0b" | b"0B" | b"0o" | b"0O") {
					// toke.c scan_num: a queued error; the number is 0 and parsing goes on.
					let base = match spelling[1] { b'x' | b'X' => "hexadecimal", b'b' | b'B' => "binary", _ => "octal" };
					self.queue_error(token.start, token.end + 1, token.location.clone(), &format!("No digits found for {base} literal"));
					ExprKind::Int(0)
				} else {
					for problem in hex_float_problems(spelling) {
						let text = format!("Hexadecimal float: {problem} at {} line {}.\n", token.location.file, token.location.line);
						self.hooks.compile_warning("overflow", false, text)
							.map_err(|_| self.fatal(token.location.clone(), format!("Hexadecimal float: {problem}")))?;
					}
					parse_number(spelling).ok_or_else(|| self.error_at(&token))?
				}
			}
			_ if token.kind == Kind::Word => {
				self.bump();
				let token = self.split_builtin_apostrophe(token);
				return self.word(token);
			}
			_ => return Err(self.error()),
		};
		Ok(node(location, result))
	}

	fn split_builtin_apostrophe(&mut self, token: Token) -> Token {
		let token = self.lex.apostrophe_quote_token(token);
		let word = self.lex.text(&token);
		if let Some(at) = word.iter().position(|&b| b == b':') && quote_word(&word[..at]) {
			let end = token.start + at;
			return self.lex.split_token(token, end);
		}
		let Some(offset) = word.iter().position(|&b| b == b'\'') else { return token; };
		let prefix = std::str::from_utf8(&word[..offset]).unwrap_or_default();
		let core = prefix.strip_prefix("CORE::");
		if let Some(builtin) = Builtin::from_name(core.unwrap_or(prefix))
			&& builtin.class() != BuiltinClass::Syntax && (core.is_some() || self.enabled(builtin))
		{
			let end = token.start + offset;
			self.lex.split_token(token, end)
		} else { token }
	}

	fn word(&mut self, token: Token) -> ResultOf<Expr> {
		let spelling = self.lex.text(&token);
		let location = token.location.clone();
		let next = if quote_word(spelling) && self.lex.source.get(token.end) == Some(&b'#') {
			token.end
		} else { self.after_space(token.end) };
		let tail = self.lex.source.get(next..).unwrap_or_default();
		if spelling.len() > 251 { return Err(self.fatal(location, "Identifier too long")); }
		// toke.c parse_ident: a package separator must be followed by a name (`foo::$bar`,
		// `foo''bar`).
		let src = self.lex.source;
		let bad_separator = if spelling.ends_with(b"::") && src.get(token.end) == Some(&b'$') { Some("::") }
			else if src.get(token.end) == Some(&b'\'') && src.get(token.end + 1) == Some(&b'\'') && !quote_word(spelling) { Some("'") }
			else { None };
		if let Some(separator) = bad_separator {
			let word = spelling.strip_suffix(b"::").unwrap_or(spelling);
			return Err(self.fatal(location, format!("Bad name after {}{separator}", self.pstr(word).to_string_lossy())));
		}
		if tail.starts_with(b"=>") {
			let quoted = if spelling.contains(&b':') || spelling.contains(&b'\'') {
				let name = self.name(spelling);
				let known_core = name.strip_prefix("CORE::").is_some_and(|s| Builtin::from_name(s).is_some());
				if known_core || self.prototype(&name).is_some() { None }
				else if spelling.contains(&b'\'') { Some(PStr::from_str(&name)) }
				else { Some(self.pstr(spelling)) }
			} else { Some(self.pstr(spelling)) };
			if let Some(string) = quoted { return Ok(node(location, ExprKind::String(string))); }
		}
		let name = self.name(spelling);
		if let Some(proto) = self.lexical_prototype(&name).cloned() {
			if self.class_follows(proto.as_ref()) { return self.indirect_call(name, location); }
			// `our sub NAME` calls its package sub from any package in scope.
			let name = self.our_sub_name(&name).unwrap_or(name);
			return self.known_call(name, proto, location);
		}
		let (builtin, origin) = if let Some(b) = name.strip_prefix("CORE::GLOBAL::") {
			(Builtin::from_name(b), BuiltinOrigin::Global)
		} else if let Some(b) = name.strip_prefix("CORE::") {
			(Builtin::from_name(b), BuiltinOrigin::Core)
		} else {
			(Builtin::from_name(&name), BuiltinOrigin::Implicit)
		};
		if let Some(builtin) = builtin && (origin != BuiltinOrigin::Implicit || self.enabled(builtin)) {
			if origin == BuiltinOrigin::Implicit {
				if let Some(proto) = self.builtin_override(builtin, tail.starts_with(b"{")) {
					return self.known_call(name, proto, location);
				}
				self.ambiguous_builtin(builtin, tail.starts_with(b"{"), &location)?;
			}
			use Builtin as B;
			return match builtin {
				B::Q | B::Qq | B::Qw | B::Qx | B::Qr | B::Match | B::Substitute | B::Tr | B::Y => self.word_quote(builtin, location),
				B::File => self.special(location, Special::File),
				B::Line => self.special(location, Special::Line),
				B::CurrentPackage => self.special(location, Special::Package(self.pkg.clone())),
				B::CurrentSub => self.special(location, Special::Sub),
				B::Sub => self.subroutine(false, None).map(|sub| node(location, ExprKind::Sub(Box::new(sub)))),
				B::My | B::Our | B::Local | B::State => self.declaration(builtin, location),
				_ if builtin.class() == BuiltinClass::Syntax => Err(self.error_at(&token)),
				_ => self.builtin(builtin, origin, location),
			};
		}
		if spelling == b"not" {
			let operand = if self.at(b"(") { self.delimited_list(b"(", b")", false)? } else { self.expr(P_NOT)? };
			return Ok(unary(location, Unary::Not, operand));
		}
		if self.keyword(spelling) { return Err(self.error_at(&token)); }
		if let Some(arrow) = tail.strip_prefix(b"->") {
			// A bareword before `->` is a class name, exempt from strict subs; before a
			// dereference arrow it is the symbolic name being dereferenced.
			let deref = matches!(arrow.first(), Some(b'[' | b'{' | b'(' | b'@' | b'%' | b'*' | b'&'))
				|| arrow.starts_with(b"$*") || arrow.starts_with(b"$#*");
			if deref {
				if let Some(proto) = self.prototype(&name) { return self.known_call(name, proto, location); }
				return Ok(node(location, ExprKind::String(self.pstr(spelling))));
			}
			// perlobj: `Class->method` calls a sub named `Class` when one is known (`Class::->`
			// always names the package).
			if !name.ends_with("::") && let Some(proto) = self.prototype(&name) { return self.known_call(name, proto, location); }
			return Ok(node(location, ExprKind::Bareword(class_name(name))));
		}
		if let Some(proto) = self.prototype(&name) {
			if self.class_follows(proto.as_ref()) { return self.indirect_call(name, location); }
			return self.known_call(name, proto, location);
		}
		if self.at(b"(") { return self.named_call(name, location); }
		if self.features.indirect != Some(false) && self.indirect_possible() {
			return self.indirect_call(name, location);
		}
		Ok(node(location, ExprKind::Bareword(name)))
	}

	/// toke.c intuit_method for a known sub: `NAME Class ...` is a method call when the next
	/// word names an existing package and is neither a sub nor a keyword, unless the sub's
	/// prototype starts with `*`.
	fn class_follows(&mut self, proto: Option<&PStr>) -> bool {
		if self.features.indirect == Some(false) { return false; }
		if proto.is_some_and(|p| p.bytes.strip_prefix(b";").unwrap_or(&p.bytes).first() == Some(&b'*')) { return false; }
		let next = self.peek();
		if next.kind != Kind::Word { return false; }
		let text = self.lex.text(&next);
		if self.keyword(text) || quote_word(text) || text == b"x" { return false; }
		let class = self.name(text);
		if Builtin::from_name(&class).is_some() || self.prototype(&class).is_some() { return false; }
		let after = self.lex.source.get(self.after_space(next.end)..).unwrap_or_default();
		if after.starts_with(b"=>") || after.starts_with(b"->") { return false; }
		self.hooks.package_exists(class.strip_suffix("::").unwrap_or(&class))
	}

	/// `NAME INVOCANT ARGS`: indirect object syntax (perlobj).
	fn indirect_call(&mut self, name: Rc<str>, location: Location) -> ResultOf<Expr> {
		let obj = match self.spelling() {
			b"$" => self.variable(false)?,
			b"{" => {
				let block = self.block()?;
				node(block.location.clone(), ExprKind::Block(block, false))
			}
			_ => {
				let token = self.peek();
				let name = self.ident()?;
				node(token.location, ExprKind::Bareword(class_name(name)))
			}
		};
		let args = if self.at(b"(") { Some(self.delimited_list(b"(", b")", false)?) } else { self.list_argument(false)? };
		Ok(call(location, CallTarget::Method(Box::new(obj), Method::Name(name)), args, None, None))
	}

	fn special(&mut self, location: Location, kind: Special) -> ResultOf<Expr> {
		if self.eat(b"(").is_some() { self.expect(b")")?; }
		Ok(node(location, ExprKind::Special(kind)))
	}

	pub(super) fn builtin_override(&self, builtin: Builtin, block: bool) -> Option<Option<PStr>> {
		if !overridable(builtin, block) { return None; }
		self.imported_prototype(builtin.name())
	}

	/// toke.c S_check_word_keyword: a weak keyword whose name is also a (non-imported,
	/// non-`:method`) sub of the current package warns that the builtin wins.
	fn ambiguous_builtin(&mut self, builtin: Builtin, block: bool, location: &Location) -> ResultOf<()> {
		if !overridable(builtin, block) || builtin.name() == "x" { return Ok(()); }
		if !self.hooks.sub_hides_builtin(&self.pkg, builtin.name()) { return Ok(()); }
		let message = format!("Ambiguous call resolved as CORE::{}(), qualify as such or use &", builtin.name());
		let text = format!("{message} at {} line {}.\n", location.file, location.line);
		self.hooks.compile_warning("ambiguous", false, text).map_err(|_| self.fatal(location.clone(), message))
	}

	fn enabled(&self, builtin: Builtin) -> bool {
		match builtin {
			Builtin::Say => self.features.say,
			Builtin::State => self.features.state,
			Builtin::Fc => self.features.fc,
			Builtin::CurrentSub => self.features.current_sub,
			Builtin::Evalbytes => self.features.evalbytes,
			Builtin::Break => self.features.switch,
			Builtin::Import => false,
			_ => true,
		}
	}

	pub(super) fn keyword(&self, bytes: &[u8]) -> bool {
		matches!(bytes, b"if" | b"else" | b"elsif" | b"unless" | b"while" | b"until" | b"for" | b"foreach"
			| b"and" | b"or" | b"xor" | b"eq" | b"ne" | b"lt" | b"le" | b"gt" | b"ge" | b"cmp")
			|| matches!(bytes, b"CORE::given" | b"CORE::when" | b"CORE::default")
			|| self.features.switch && matches!(bytes, b"given" | b"when" | b"default")
			|| self.features.isa && bytes == b"isa"
	}

	fn indirect_possible(&mut self) -> bool {
		let token = self.peek();
		let text = self.lex.text(&token);
		if text == b"$" { return true; }
		// An indirect object block is never disambiguated as an anonymous hash, even `{}`.
		if text == b"{" { return self.lex.source.get(self.after_space(token.end)) == Some(&b'}') || !self.brace_hash(&token); }
		if token.kind != Kind::Word || self.keyword(text) || text == b"not" || text == b"x" || text == b"isa" && self.features.isa { return false; }
		let name = self.name(text);
		!Builtin::from_name(&name).is_some_and(|b| self.enabled(b)) && self.prototype(&name).is_none()
	}

	fn declaration(&mut self, builtin: Builtin, location: Location) -> ResultOf<Expr> {
		let kind = decl(builtin.name().as_bytes()).ok_or_else(|| self.error())?;
		let keyword_start = self.previous.as_ref().map_or(self.lex.pos, |token| token.start);
		let class = if kind != DeclKind::Local && self.peek().kind == Kind::Word { Some(self.ident()?) } else { None };
		// A constant sub names its value's package (find_in_my_stash); its value is not known here.
		if let Some(class) = &class && !self.hooks.package_exists(class) && self.prototype(class) != Some(Some(PStr::default())) {
			let mut error = self.diagnostic(location, format!("No such class {class}"));
			error.near = Some(self.pstr(&self.lex.source[keyword_start.min(self.lex.pos)..self.lex.pos]));
			return Err(error);
		}
		// `local +(EXPR)->[0]`: a unary plus only separates the operand.
		if kind == DeclKind::Local && self.at(b"+") { self.bump(); }
		let target_start = self.peek().start;
		let target = if kind == DeclKind::Local && self.at(b"our") {
			let location = self.bump().location;
			self.declaration(Builtin::Our, location)?
		} else if self.at(b"(") {
			let list = self.delimited_list(b"(", b")", true)?;
			if let Some(reference) = first_reference(&list) { self.declared_reference(reference)?; }
			if kind == DeclKind::Local { self.postfix(list)? } else { list }
		} else {
			// `my \$x`, `my \\$x`: each backslash takes a reference to the declared variable.
			let mut references = Vec::new();
			while let Some(reference) = self.eat(b"\\") {
				if references.is_empty() { self.declared_reference(reference.location.clone())?; }
				references.push(reference.location);
			}
			// `my \($x, @y)` declares a list of references.
			let operand = if !references.is_empty() && self.at(b"(") { self.delimited_list(b"(", b")", true)? } else { self.variable(false)? };
			// `my \$x ** 1`: `**` binds tighter than the backslash, so the declarator applies to it.
			if !references.is_empty() && self.at(b"**") {
				let message = if kind == DeclKind::Local { "Can't modify exponentiation (**) in local".to_owned() }
					else { format!("Can't declare exponentiation (**) in \"{}\"", builtin.name()) };
				return Err(self.fatal(location, message));
			}
			if references.is_empty() {
				if kind == DeclKind::Local { self.postfix(operand)? } else { operand }
			} else {
				references.into_iter().rev().fold(operand, |operand, location| unary(location, Unary::Reference, operand))
			}
		};
		// A single variable's diagnostics quote its spelling (`$::x`), not its qualified name.
		let spelled = matches!(&target.kind, ExprKind::Variable(..)).then(|| self.pstr(&self.lex.source[target_start.min(self.lex.pos)..self.lex.pos]).to_string_lossy().into_owned());
		if kind != DeclKind::Local && let Some(message) = declared_name_problem(kind, &target, self.lex.utf8, spelled.as_deref()) {
			let near = self.pstr(&self.lex.source[keyword_start.min(self.lex.pos)..self.lex.pos]);
			let mut error = self.diagnostic(location, message);
			error.near = Some(near);
			return Err(error);
		}
		if !matches!(&target.kind, ExprKind::Variable(..) | ExprKind::Group(_) | ExprKind::List(_))
			&& kind != DeclKind::Local && !(self.features.declared_refs && matches!(&target.kind, ExprKind::Unary(Unary::Reference, _)))
		{
			return Err(self.error());
		}
		// toke.c: a declaration's `:` followed by neither an attribute nor a list end is an
		// ordinary colon (`$c ? my $x : $y`), left for the grammar.
		let attribute_colon = self.at(b":") && {
			let src = self.lex.source;
			let colon_end = self.peek().end;
			let at = self.after_space(colon_end);
			at >= src.len() || matches!(src[at], b';' | b'}' | b'=' | b')') || ident_unit(src, at, self.lex.utf8, false).is_some()
		};
		let attrs = if attribute_colon {
			self.bump();
			self.attributes()?
		} else { Vec::new() };
		// Untyped declarations are recorded only to shadow a typed one.
		if kind != DeclKind::Local && (class.is_some() || self.symbols.typed.iter().any(|scope| !scope.is_empty())) {
			let mut names = Vec::new();
			declared_scalars(&target, &mut names);
			if let Some(scope) = self.symbols.typed.last_mut() {
				for name in names { scope.insert(name, class.clone()); }
			}
		}
		let decl = node(location, ExprKind::Declare(kind, class, Box::new(target), attrs));
		self.hooks.lexical_decl(&decl, &self.pkg);
		Ok(decl)
	}

	/// `my \$x` and friends: a compile error without the declared_refs feature, else the
	/// default-on experimental warning.
	fn declared_reference(&mut self, location: Location) -> ResultOf<()> {
		if !self.features.declared_refs {
			return Err(self.fatal(location, "The experimental declared_refs feature is not enabled"));
		}
		let text = format!("Declaring references is experimental at {} line {}.\n", location.file, location.line);
		self.hooks.compile_warning("experimental::declared_refs", true, text)
			.map_err(|_| self.fatal(location, "Declaring references is experimental"))
	}

	/// Parse a balanced list, optionally preserving a parenthesized group.
	pub(super) fn delimited_list(&mut self, open: &[u8], close: &[u8], group: bool) -> ResultOf<Expr> {
		let location = self.expect(open)?.location;
		if self.eat(close).is_some() { return Ok(empty(location)); }
		self.unclosed_bracket(close)?;
		let inner = self.expr(0)?;
		self.unclosed_bracket(close)?;
		self.expect(close)?;
		if group { Ok(node(location, ExprKind::Group(Box::new(inner)))) } else { Ok(inner) }
	}

	/// End of input inside `[`/`{` reports perl's "Missing right curly or square bracket".
	fn unclosed_bracket(&mut self, close: &[u8]) -> ResultOf<()> {
		if close == b")" || self.peek().kind != Kind::Eof { return Ok(()); }
		let mut error = self.error();
		error.missing_delimiter = true;
		Err(error)
	}

	fn can_term(&mut self) -> bool {
		let token = self.peek();
		let text = self.lex.text(&token);
		match token.kind {
			Kind::Word => !self.keyword(text) ||
				std::str::from_utf8(text).ok().is_some_and(|name| self.lexical_prototype(name).is_some()) ||
				self.lex.source.get(self.after_space(token.end)..).is_some_and(|tail| tail.starts_with(b"=>")),
			Kind::Number => true,
			Kind::Symbol => matches!(text, b"(" | b"{" | b"[" | b"$" | b"@" | b"%" | b"&" | b"*" | b"**" | b"<" | b"<<" | b"<=" | b"<=>" | b"<<=" | b"/" | b"//" | b"/=" | b"\"" | b"'" | b"`" | b"+" | b"-" | b"!" | b"~" | b"~." | b"~~" | b"\\" | b"++" | b"--"),
			_ => false,
		}
	}

	fn list_argument(&mut self, parens: bool) -> ResultOf<Option<Expr>> {
		if self.can_term() { self.expr(if parens { 0 } else { P_COMMA }).map(Some) } else { Ok(None) }
	}

	fn named_call(&mut self, name: Rc<str>, location: Location) -> ResultOf<Expr> {
		let args = self.delimited_list(b"(", b")", false)?;
		Ok(call(location, CallTarget::Named(name, false), Some(args), None, None))
	}

	fn known_call(&mut self, name: Rc<str>, proto: Option<PStr>, location: Location) -> ResultOf<Expr> {
		let shape = proto.as_ref().and_then(|p| PrototypeShape::parse(&p.bytes));
		let mut slot = None;
		let parens = self.at(b"(");
		let args = if parens {
			let open = self.peek().end;
			let list = self.delimited_list(b"(", b")", false)?;
			// `f(())` passes one (empty-list) argument, unlike `f()`.
			let close = self.previous.as_ref().map_or(open, |token| token.start);
			if matches!(&list.kind, ExprKind::List(items) if items.is_empty()) && !self.lex.source[open..close.max(open)].trim_ascii().is_empty() {
				Some(node(list.location.clone(), ExprKind::Group(Box::new(list))))
			} else { Some(list) }
		} else if shape.is_some_and(PrototypeShape::nullary) {
			None
		} else if shape.is_some_and(|p| p.block_first) && self.at(b"{") {
			let block = self.block()?;
			slot = Some(CallSlot::Block(Rc::new(block)));
			self.list_argument(false)?
		} else if shape.is_some_and(|p| p.unary) {
			if self.can_term() { Some(self.expr(P_UNARY + 1)?) } else { None }
		} else { self.list_argument(false)? };
		let mut args = args;
		if let Some(proto) = &proto && let Some(args) = &mut args {
			star_barewords(&proto.bytes, args, slot.is_some());
		}
		// perlsub: a `_` slot left empty receives `$_` (ck_entersub_args_proto).
		if let Some(proto) = &proto
			// An optional `_` (after `;`) is simply omitted.
			&& let Some(topic_at) = proto.bytes.iter().take_while(|b| **b != b';').filter(|b| !b.is_ascii_whitespace()).position(|&b| b == b'_')
			&& usize::from(slot.is_some()) + argument_count(args.as_ref()) == topic_at
		{
			let topic = node(location.clone(), ExprKind::Variable(Sigil::Scalar, "_".into()));
			args = Some(match args {
				Some(Expr { kind: ExprKind::List(mut items), location, .. }) => { items.push(topic); node(location, ExprKind::List(items)) }
				Some(single) => node(single.location.clone(), ExprKind::List(vec![single, topic])),
				None => topic,
			});
		}
		let supplied = usize::from(slot.is_some()) + argument_count(args.as_ref());
		let problem = shape.and_then(|shape| {
			if supplied < shape.min { Some("Not enough") }
			else if shape.max.is_some_and(|max| supplied > max) { Some("Too many") } else { None }
		});
		// Wrong argument kinds are queued (yyerror), ahead of any count error.
		if let (Some(proto), Some(_)) = (&proto, shape) {
			for (index, expected, actual) in check_reference_arguments(&proto.bytes, args.as_mut(), slot.is_some()) {
				let shown = if name.contains("::") || self.lexical_prototype(&name).is_some() { name.to_string() } else { format!("{}::{name}", self.pkg) };
				let error = self.argument_error(format!("Type of arg {index} to {shown} must be {expected} (not {actual})"), parens);
				self.queued.push(error);
			}
		}
		if problem.is_some() || proto.is_some() && shape.is_none() {
			let qualified;
			let name = if name.contains("::") || self.lexical_prototype(&name).is_some() { name.as_ref() } else {
				qualified = format!("{}::{name}", self.pkg);
				&qualified
			};
			if let Some(problem) = problem {
				return Err(self.argument_error(format!("{problem} arguments for {name}"), parens));
			}
			if let Some(proto) = &proto {
				let message = format!("Malformed prototype for {name}: {}", proto.to_string_lossy());
				return Err(self.fatal(location, message));
			}
		}
		Ok(call(location, CallTarget::Named(name, false), args, slot, proto))
	}

	fn builtin(&mut self, builtin: Builtin, origin: BuiltinOrigin, location: Location) -> ResultOf<Expr> {
		use BuiltinClass as C;
		let class = builtin.class();
		if class == C::BlockUnary && self.at(b"{") {
			let block = self.block()?;
			return Ok(node(location, ExprKind::Block(block, builtin == Builtin::Eval)));
		}
		// Unlike ordinary list operators, return always consumes its right-hand
		// expression: `return (caller())[3] + 1` includes the slice and the addition.
		let parens = builtin != Builtin::Return && self.eat(b"(").is_some();
		// toke.c KEY_do: `do NAME(...)` (the removed do-SUBROUTINE call) is a syntax error;
		// `do CORE()` and keywords stay do-FILE.
		if builtin == Builtin::Do && !parens {
			let t = self.peek();
			let text = self.lex.text(&t);
			if t.kind == Kind::Word && text != b"CORE" && !self.keyword(text)
				&& !std::str::from_utf8(text).is_ok_and(|name| Builtin::from_name(name).is_some())
				&& self.lex.source.get(self.after_space(t.end)) == Some(&b'(')
			{
				self.bump();
				return Err(self.error());
			}
		}
		let version = if builtin == Builtin::Require {
			let t = self.peek();
			let text = self.lex.text(&t);
			if t.kind == Kind::Word && text.starts_with(b"::") {
				let message = format!("Bareword in require must not start with a double-colon: \"{}\"", self.pstr(text).to_string_lossy());
				return Err(self.fatal(t.location, message));
			}
			let after = &self.lex.source[self.after_space(t.end)..];
			if t.kind == Kind::Number && short_v(text) && (after.is_empty() || matches!(after.first(), Some(b')' | b';' | b'}' | b','))) {
				self.bump();
				Some(node(t.location.clone(), parse_number(text).ok_or_else(|| self.error_at(&t))?))
			} else { None }
		} else { None };
		let (args, slot) = match class {
			C::Print => self.print_args(parens)?,
			C::Exec => self.exec_args(parens)?,
			C::Sort => self.sort_args(parens)?,
			C::Transform => self.transform_args(builtin, parens)?,
			C::Control => (self.control_args(builtin, parens)?, None),
			C::Nullary => (None, None),
			C::Unary | C::OptionalUnary | C::BlockUnary => {
				let underscore = self.peek();
				let args = if version.is_some() { version }
				else if matches!(builtin, Builtin::Stat | Builtin::Lstat) && underscore.kind == Kind::Word && self.lex.text(&underscore) == b"_"
					&& !matches!(self.lex.source.get(self.after_space(underscore.end)), Some(b'(' | b'=' | b'-' | b':')) {
					// `stat _` names the stat cache even when a sub `_` exists.
					self.bump();
					Some(node(underscore.location, ExprKind::Bareword("_".into())))
				} else if parens {
					if self.at(b")") { Some(empty(location.clone())) } else { Some(self.expr(0)?) }
				// toke.c UNIDOR: after a named unary operator with an optional operand, `//` is
				// defined-or rather than an empty pattern, and `~~` is smartmatch.
				} else if class == C::OptionalUnary && matches!(self.spelling(), b"//" | b"//=" | b"~~") {
					None
				} else if self.can_term() { Some(self.expr(P_UNARY + 1)?) } else { None };
				(args, None)
			}
			C::List => (self.list_argument(parens)?, None),
			C::Syntax => return Err(self.error()),
		};
		if parens { self.expect(b")")?; }
		let arity_error = match builtin {
			// Named unary operators take one operand, even from a parenthesized list (`lc(($a, $b))`).
			// These instead read a comma expression as one operand (oracle-checked).
			_ if matches!(class, C::Unary | C::OptionalUnary)
				&& !matches!(builtin, Builtin::Scalar | Builtin::Getc | Builtin::Prototype | Builtin::Stat | Builtin::Lstat
					| Builtin::Evalbytes | Builtin::Readline | Builtin::Close | Builtin::Eof | Builtin::Tell | Builtin::Write)
				&& unary_operand_count(args.as_ref()) > 1 => Some("Too many"),
			Builtin::Pack | Builtin::Unpack if argument_count(args.as_ref()) == 0 => Some("Not enough"),
			_ if class == C::Unary && argument_count(args.as_ref()) == 0 => Some("Not enough"),
			_ => None,
		};
		if let Some(problem) = arity_error {
			return Err(self.argument_error(format!("{problem} arguments for {}", op_description(builtin)), parens));
		}
		// ck_each: keys/values/each take a hash or array, never a scalar expression.
		if matches!(builtin, Builtin::Keys | Builtin::Values | Builtin::Each) && let Some(arg) = &args
			&& let Some(what) = scalar_operand_description(arg)
		{
			let name = builtin.name();
			let message = format!(
				"Experimental {name} on scalar is now forbidden at {} line {}.\nType of arg 1 to {name} must be hash or array (not {what})",
				location.file, location.line,
			);
			return Err(self.argument_error(message, parens));
		}
		// ck_exists: `exists &name(...)` calls the sub rather than naming it.
		if builtin == Builtin::Exists && let Some(arg) = &args
			&& matches!(&arg.kind, ExprKind::Call(Call { target: CallTarget::Named(_, true) | CallTarget::Code(_, true), args: Some(_), .. }))
		{
			return Err(self.fatal(arg.location.clone(), "exists argument is not a subroutine name"));
		}
		// ck_length: length of an aggregate is almost certainly a mistake.
		if builtin == Builtin::Length && let Some(arg) = &args {
			let target = match &arg.kind { ExprKind::Declare(_, _, inner, _) => inner.as_ref(), _ => arg };
			let used = match &target.kind {
				ExprKind::Variable(Sigil::Array, name) => Some((format!("@{name}"), format!("@{name}"))),
				ExprKind::Variable(Sigil::Hash, name) => Some((format!("%{name}"), format!("keys %{name}"))),
				ExprKind::Deref(Sigil::Array, _) => Some(("@array".to_owned(), "@array".to_owned())),
				ExprKind::Deref(Sigil::Hash, _) => Some(("%hash".to_owned(), "keys %hash".to_owned())),
				_ => None,
			};
			if let Some((used, meant)) = used {
				let text = format!("length() used on {used} (did you mean \"scalar({meant})\"?) at {} line {}.\n", location.file, location.line);
				self.hooks.compile_warning("syntax", false, text)
					.map_err(|_| self.fatal(location.clone(), format!("length() used on {used} (did you mean \"scalar({meant})\"?)")))?;
			}
		}
		// op_lvalue: chop/chomp cannot modify a match, substitution or transliteration result.
		if matches!(builtin, Builtin::Chop | Builtin::Chomp) && let Some(args) = &args {
			let items: Vec<&Expr> = match &args.kind { ExprKind::List(items) => items.iter().collect(), _ => vec![args] };
			let operation = items.iter().find_map(|item| {
				let mut item = *item;
				while let ExprKind::Group(inner) = &item.kind { item = inner; }
				if let ExprKind::Binary(Binary::Bind(false), _, right) = &item.kind { item = right; }
				match &item.kind {
					ExprKind::Regex(RegexExpr { kind: RegexKind::Transliterate(_), .. }) => Some("transliteration (tr///)"),
					ExprKind::Regex(RegexExpr { kind: RegexKind::Substitute(_) | RegexKind::SubstituteEval(..), .. }) => Some("substitution (s///)"),
					ExprKind::Regex(RegexExpr { kind: RegexKind::Match(_), .. }) => Some("pattern match (m//)"),
					_ => None,
				}
			});
			if let Some(operation) = operation {
				return Err(self.argument_error(format!("Can't modify {operation} in {}", builtin.name()), parens));
			}
		}
		// op_lvalue on the modified operand: a literal or bareword cannot be tied, undefined or read into.
		let modified = match builtin {
			Builtin::Tie | Builtin::Untie => Some((0, builtin.name())),
			Builtin::Undef => Some((0, "undef operator")),
			Builtin::Read | Builtin::Sysread => Some((1, builtin.name())),
			_ => None,
		};
		if let Some((index, operation)) = modified && let Some(args) = &args {
			let operand = match &args.kind { ExprKind::List(items) => items.get(index), _ => (index == 0).then_some(args) };
			if operand.is_some_and(|operand| is_constant_lvalue(operand, false)) {
				return Err(self.argument_error(format!("Can't modify constant item in {operation}"), parens));
			}
		}
		let args = if parens && args.is_none() && slot.is_none() { Some(empty(location.clone())) } else { args };
		Ok(call(location, CallTarget::Builtin(builtin, origin), args, slot, None))
	}

	fn control_args(&mut self, builtin: Builtin, parens: bool) -> ResultOf<Option<Expr>> {
		if parens { return if self.at(b")") { Ok(None) } else { self.expr(0).map(Some) }; }
		let token = self.peek();
		if self.is_word(&token) && !self.keyword(self.lex.text(&token)) && self.lex.text(&token) != b"not" {
			let text = self.lex.text(&token);
			let tail = self.lex.source.get(self.after_space(token.end)..).unwrap_or_default();
			if !tail.starts_with(b"(") && (builtin != Builtin::Goto || matches!(tail.first(), None | Some(b';' | b'}' | b')')) || name_end(tail, 0, self.lex.utf8).is_some_and(|end| self.modifier_word(&tail[..end]))) {
				self.bump();
				return Ok(Some(node(token.location, ExprKind::String(self.pstr(text)))));
			}
		}
		if !self.can_term() { return Ok(None); }
		let arg = self.expr(P_ASSIGN)?;
		// `goto &NAME` must retain the ampersand target, not execute the call.
		Ok(Some(if builtin == Builtin::Goto {
			match arg {
				Expr { location, kind: ExprKind::Call(Call { target: CallTarget::Named(name, true), args: None, .. }), .. } => {
					node(location, ExprKind::Variable(Sigil::Code, name))
				}
				Expr { location, kind: ExprKind::Call(Call { target: CallTarget::Code(code, true), args: None, .. }), .. } => {
					node(location, ExprKind::Deref(Sigil::Code, code))
				}
				other => other,
			}
		} else { arg }))
	}

	fn print_args(&mut self, parens: bool) -> ResultOf<(Option<Expr>, Option<CallSlot>)> {
		let token = self.peek();
		let text = self.lex.text(&token);
		let handle = if text == b"{" && !self.brace_hash(&token) {
			let block = self.block()?;
			if matches!(self.spelling(), b"," | b")" | b";" | b"}" | b"") { return Err(self.error()); }
			Some(node(block.location.clone(), ExprKind::Block(block, false)))
		} else if text == b"$" && let Some(end) = self.simple_scalar_end(token.end) && self.after_handle(end, false) {
			Some(self.variable(false)?)
		} else if token.kind == Kind::Word && !self.keyword(text) && text != b"not" {
			let name = self.name(text);
			let at = self.after_space(token.end);
			if !Builtin::from_name(&name).is_some_and(|b| self.enabled(b)) && self.prototype(&name).is_none() && self.after_handle(token.end, true) {
				if self.lex.source.get(at) == Some(&b',') { return Err(self.diagnostic(token.location, "No comma allowed after filehandle".into())); }
				self.bump();
				Some(node(token.location, ExprKind::Bareword(name)))
			} else { None }
		} else { None };
		let args = self.list_argument(parens)?;
		Ok((args, handle.map(|target| CallSlot::Handle(Box::new(target)))))
	}

	fn simple_scalar_end(&self, at: usize) -> Option<usize> {
		let src = self.lex.source;
		let mut at = sigil_name_start(src, at);
		let mut sigil = b'$';
		if src.get(at) == Some(&b'#') && src.get(at + 1) != Some(&b'[') {
			sigil = b'@';
			at += 1;
			at = sigil_name_start(src, at);
		}
		while src.get(at) == Some(&b'$') && is_deref(src, at + 1, self.lex.utf8) {
			sigil = b'$';
			at += 1;
		}
		if src.get(at) == Some(&b'{') {
			let start = after_space(src, at + 1);
			let end = variable_end(src, start, self.lex.utf8, sigil, true)?;
			let close = after_space(src, end);
			return (src.get(close) == Some(&b'}')).then_some(close + 1);
		}
		variable_end(src, at, self.lex.utf8, sigil, false)
	}

	fn after_handle(&self, end: usize, named: bool) -> bool {
		let src = self.lex.source;
		let at = after_space(src, end);
		let tail = &src[at..];
		if tail.starts_with(b"=>") || tail.starts_with(b"->") { return false; }
		if ident_unit(src, at, self.lex.utf8, false).is_some() &&
			let Some(next) = name_end(src, at, self.lex.utf8) {
			let word = &src[at..next];
			if self.keyword(word) {
				return named && (self.modifier_word(word) || matches!(word, b"and" | b"or" | b"xor"));
			}
			if word == b"isa" && self.features.isa { return false; }
			return named || word != b"x";
		}
		let following = tail.get(1).copied();
		let separated = at != end;
		// A scalar is already an expression. Only a prefix spelling that Perl's
		// indirect-object lookahead recognizes may displace its usual infix meaning.
		match tail.first().copied() {
			None | Some(b';' | b')' | b'}' | b',') => named,
			Some(b'0'..=b'9' | b'\'' | b'"' | b'`' | b'$' | b'@' | b'\\') => true,
			Some(b'(') => !named || separated,
			Some(b'[' | b'{') => named,
			Some(b'.') => (named || separated) && following.is_some_and(|b| b.is_ascii_digit()),
			Some(b'!') => !matches!(following, Some(b'=' | b'~')),
			Some(b'~') => named || following != Some(b'~'),
			Some(sign @ (b'+' | b'-')) => {
				if following == Some(b'=') { return false; }
				if following == Some(sign) {
					// `$h++` is postfix, whereas `H ++$x` / `$h ++$x` has a handle.
					return (named || separated) && src.get(after_space(src, at + 2)).is_some_and(|b| matches!(b, b'$' | b'@'));
				}
				if sign == b'-' && file_test(src, at + 1, self.lex.utf8).is_some() { return true; }
				named || separated && following.is_some_and(|b| !b.is_ascii_whitespace())
			}
			Some(b'/') => named || separated && following.is_some_and(|b| b != b'/' && b != b'=' && !b.is_ascii_whitespace()),
			Some(b'<') => match following {
				Some(b'=') => false,
				Some(b'<') => named || separated && (tail.starts_with(b"<<>>") ||
					tail.get(2).is_none_or(|&b| b == b'~' || b == b'\\' || matches!(b, b'\'' | b'"' | b'`') ||
						ident_unit(src, at + 2, self.lex.utf8, true).is_some())),
				_ => named || separated && ident_unit(src, at + 1, self.lex.utf8, false).is_some(),
			},
			Some(sigil @ (b'*' | b'%' | b'&')) => {
				if following.is_some_and(|b| matches!(b, b'=' | b'.') || b == sigil) { return false; }
				if named { return true; }
				separated && ident_unit(src, at + 1, self.lex.utf8, false).is_some()
			}
			_ => false,
		}
	}

	fn modifier_word(&self, word: &[u8]) -> bool {
		matches!(word, b"if" | b"unless" | b"for" | b"foreach" | b"until" | b"while") || self.features.switch && word == b"when"
	}

	fn exec_args(&mut self, parens: bool) -> ResultOf<(Option<Expr>, Option<CallSlot>)> {
		let token = self.peek();
		let program = if self.lex.text(&token) == b"{" && !self.brace_hash(&token) {
			let block = self.block()?;
			let expr = node(block.location.clone(), ExprKind::Block(block, false));
			Some(CallSlot::Program(Box::new(expr)))
		} else if self.lex.text(&token) == b"$" && let Some(end) = self.simple_scalar_end(token.end) && self.after_handle(end, false) {
			// `exec $program LIST`: the indirect-object form, like `print $fh LIST`.
			Some(CallSlot::Program(Box::new(self.variable(false)?)))
		} else { None };
		let args = self.list_argument(parens)?;
		if program.is_some() && args.is_none() { return Err(self.error()); }
		Ok((args, program))
	}

	fn sort_args(&mut self, parens: bool) -> ResultOf<(Option<Expr>, Option<CallSlot>)> {
		let t = self.peek();
		let text = self.lex.text(&t);
		let slot = if text == b"{" && !self.brace_hash(&t) {
			Some(CallSlot::Block(Rc::new(self.block()?)))
		} else if text == b"$" && let Some(end) = self.simple_scalar_end(t.end) && self.after_handle(end, false) {
			Some(CallSlot::Comparator(Box::new(self.variable(false)?)))
		} else if t.kind == Kind::Word && !self.keyword(text) && !text.strip_prefix(b"CORE::").is_some_and(|core| std::str::from_utf8(core).is_ok_and(|core| Builtin::from_name(core).is_some())) && self.after_space(t.end) != t.end && self.after_handle(t.end, false) {
			let name = self.name(text);
			if self.lexical_prototype(&name).is_some() ||
				Builtin::from_name(&name).filter(|&b| self.enabled(b)).is_none_or(|b| self.builtin_override(b, false).is_some()) {
				self.bump();
				let name = self.our_sub_name(&name).unwrap_or(name);
				Some(CallSlot::Comparator(Box::new(node(t.location, ExprKind::Bareword(name)))))
			} else { None }
		} else { None };
		let args = self.list_argument(parens)?;
		if slot.is_some() && args.is_none() { return Err(self.error()); }
		Ok((args, slot))
	}

	fn transform_args(&mut self, builtin: Builtin, parens: bool) -> ResultOf<(Option<Expr>, Option<CallSlot>)> {
		let t = self.peek();
		let slot = if self.lex.text(&t) == b"{" && !self.brace_hash(&t) {
			CallSlot::Block(Rc::new(self.block()?))
		} else {
			let expr = self.expr(P_ASSIGN)?;
			if self.eat(b"=>").is_none() && self.eat(b",").is_none() {
				// `grep EXPR;` filters an empty list; anything else needs the comma (ck_fun).
				if self.can_term() {
					return Err(self.argument_error(format!("Missing comma after first argument to {} function", builtin.name()), false));
				}
				let location = self.peek().location;
				return Ok((Some(empty(location)), Some(CallSlot::Expression(Box::new(expr)))));
			}
			CallSlot::Expression(Box::new(expr))
		};
		let args = self.list_argument(parens)?;
		if args.is_none() && matches!(slot, CallSlot::Block(_)) { return Err(self.error()); }
		Ok((Some(args.unwrap_or_else(|| empty(self.peek().location))), Some(slot)))
	}

	// Perl's block-or-hash guess depends on only the opening tokens. A simple quoted or
	// numeric value followed immediately by a comma, or a word followed by `=>`, wins.
	pub(super) fn brace_hash(&self, open: &Token) -> bool {
		let mut probe = self.lex.clone();
		probe.rewind(open);
		probe.advance(open.end);
		let first = probe.next();
		let first = probe.apostrophe_quote_token(first);
		let text = probe.text(&first);
		// toke.c: braces holding nothing (comments and whitespace aside) are an anonymous hash.
		if text == b"}" { return true; }
		let scan = match text {
			b"\"" | b"'" | b"`" => { probe.rewind(&first); Some(QuoteScan::Boundary) }
			b"q" | b"qq" | b"qw" | b"qx" if !probe.source.get(after_space(probe.source, first.end)..).is_some_and(|s| s.starts_with(b"=>")) => {
				probe.quote_gap(true);
				Some(QuoteScan::Boundary)
			}
			_ => None,
		};
		let simple_value = first.kind == Kind::Number || scan.is_some();
		if let Some(scan) = scan && probe.quote(scan, None).is_err() { return false; }
		let next = probe.next();
		let next = probe.text(&next);
		matches!(next, b"," | b"=>") && simple_value || next == b"=>" && first.kind == Kind::Word
	}

	/// Parse one variable or prefix dereference; optional `&` call interpretation.
	pub(super) fn variable(&mut self, amp_call: bool) -> ResultOf<Expr> {
		self.nested(|parser| parser.variable_inner(amp_call))
	}

	fn variable_inner(&mut self, amp_call: bool) -> ResultOf<Expr> {
		let token = self.bump();
		let symbol = self.lex.text(&token).first().copied().unwrap_or_default();
		let Some(mut sigil) = sigil(symbol) else { return Err(self.error_at(&token)); };
		self.lex.rewind(&token);
		self.lex.advance(token.start + 1);
		let mut start = self.lex.pos;
		let src = self.lex.source;
		let utf8 = self.lex.utf8;
		if sigil == Sigil::Scalar && src.get(start) == Some(&b'#') {
			if src.get(start + 1) != Some(&b'[') {
				sigil = Sigil::LastIndex;
				start += 1;
			}
		}
		start = sigil_name_start(src, start);
		let location = token.location.clone();
		let mut term = if src.get(start) == Some(&b'{') {
			let at = after_space(src, start + 1);
			let named = variable_end(src, at, utf8, if sigil == Sigil::LastIndex { b'@' } else { symbol }, true);
			if let Some(end) = named && src.get(after_space(src, end)) == Some(&b'}') {
				// The blanks around a braced name may hold `#line` directives.
				self.lex.advance(start + 1);
				self.lex.skip_space();
				self.lex.advance(end);
				self.lex.skip_space();
				self.lex.advance(after_space(src, end) + 1);
				node(location.clone(), ExprKind::Variable(sigil, self.variable_name(&src[at..end])))
			} else if let Some(end) = named && let Some(&open @ (b'[' | b'{')) = src.get(after_space(src, end))
				&& (name_end(src, at, utf8) == Some(end) || src.get(at) == Some(&b'^'))
				// toke.c: `${sub {...}}` is a block holding an anonymous sub, not `%sub`.
				&& !(open == b'{' && &src[at..end] == b"sub") {
				self.lex.advance(end);
				let base = node(location.clone(), ExprKind::Variable(sigil, self.variable_name(&src[at..end])));
				let selected = self.postfix(base)?;
				self.expect(b"}")?;
				selected
			} else {
				// An empty dereference block (`${}`) is a syntax error, unlike `${;}`.
				if src.get(after_space(src, start + 1)) == Some(&b'}') { return Err(self.error_at(&token)); }
				self.lex.advance(start);
				self.deref_block_start = true;
				let block = self.block();
				self.deref_block_start = false;
				let mut block = block?;
				// Prefix dereference accepts statements, not just an expression.
				// Keep the common single-expression case in its original AST shape.
				let inner = if let [Stmt { label: None, kind: StmtKind::Expr(_), .. }] = block.stmts.as_slice()
					&& let Some(Stmt { kind: StmtKind::Expr(expr), .. }) = block.stmts.pop()
				{
					expr
				} else { node(block.location.clone(), ExprKind::Block(block, false)) };
				node(location.clone(), ExprKind::Deref(sigil, Box::new(inner)))
			}
		} else if src.get(start) == Some(&b'$') && is_deref(src, start + 1, utf8) {
			self.lex.advance(start);
			let inner = self.variable(false)?;
			node(location.clone(), ExprKind::Deref(sigil, Box::new(inner)))
		} else if let Some(end) = variable_end(src, start, utf8, if sigil == Sigil::LastIndex { b'@' } else { symbol }, false) {
			self.lex.advance(end);
			let spelling = &src[start..end];
			// toke.c reserves one byte of its identifier buffer for every sigil except `*`.
			if spelling.len() > if sigil == Sigil::Glob { 252 } else { 251 } { return Err(self.fatal(location, "Identifier too long")); }
			if sigil == Sigil::Scalar && spelling.len() > 1 && spelling[0] == b'0' && spelling[1].is_ascii_digit() {
				return Err(self.fatal(location, "Numeric variables with more than one digit may not start with '0'"));
			}
			let name = self.variable_name(spelling);
			let name = if sigil == Sigil::Code { self.our_sub_name(&name).unwrap_or(name) } else { name };
			node(location.clone(), ExprKind::Variable(sigil, name))
		} else if sigil == Sigil::LastIndex {
			return Err(self.fatal(location, "$# is no longer supported as of Perl 5.30"));
		} else if src.get(start).is_some_and(|&b| b >= 0x80 || b.is_ascii_control() && !b.is_ascii_whitespace() && b != 0) {
			return Err(self.unrecognized_char_at(start, location));
		} else { return Err(self.error_at(&token)); };
		self.finish_raw_token();
		if sigil == Sigil::Code && amp_call { term = self.amp_call(term)?; }
		Ok(term)
	}

	fn variable_name(&self, name: &[u8]) -> Rc<str> {
		if name == b"'" { "'".into() }
		else if name.first() == Some(&b'^') { String::from_utf8_lossy(name).as_ref().into() }
		// A length-1 Latin-1 name outside `use utf8` is not an identifier: like punctuation
		// variables it lives in main and is exempt from strict vars (gv.c).
		else if let [byte] = name && *byte >= 0x80 && !self.lex.utf8 { format!("main::{}", char::from(*byte)).into() }
		else { self.name(name) }
	}

	fn amp_call(&mut self, code: Expr) -> ResultOf<Expr> {
		let args = if self.at(b"(") { Some(self.delimited_list(b"(", b")", false)?) } else { None };
		let location = code.location.clone();
		let target = match code.kind {
			ExprKind::Variable(Sigil::Code, name) => CallTarget::Named(name, true),
			ExprKind::Deref(Sigil::Code, inner) => CallTarget::Code(inner, true),
			_ => CallTarget::Code(Box::new(code), true),
		};
		Ok(call(location, target, args, None, None))
	}

	/// Parse arrows, element selectors and slices immediately following a term.
	pub(super) fn postfix(&mut self, mut base: Expr) -> ResultOf<Expr> {
		loop {
			let token = self.peek();
			let text = self.lex.text(&token);
			let slot = match &base.kind {
				ExprKind::Variable(slot, _) | ExprKind::Deref(slot, _) => Some(*slot),
				_ => None,
			};
			let code_call = matches!(&base.kind, ExprKind::Call(Call { target: CallTarget::Code(_, false), .. }));
			let element = matches!(&base.kind, ExprKind::Select(_, Select::ArrayElement(_) | Select::HashElement(_) | Select::ListSlice, _));
			if text == b"->" {
				self.wrap_tree()?;
				self.bump();
				base = self.arrow(base, token.location)?;
			} else if text == b"(" && (code_call || element) {
				self.wrap_tree()?;
				base = self.code_arrow(base, token.location)?;
			} else if matches!(text, b"[" | b"{") && (code_call || slot.is_some() || matches!(base.kind, ExprKind::Select(..)) || text == b"[" && matches!(base.kind, ExprKind::Group(_) | ExprKind::List(_))) {
				self.wrap_tree()?;
				let indirect = code_call || matches!(base.kind, ExprKind::Select(..));
				let select = if matches!(base.kind, ExprKind::Group(_) | ExprKind::List(_)) { Select::ListSlice }
				else { select_kind(slot.unwrap_or(Sigil::Scalar), text, indirect) };
				base = self.select(base, select)?;
			} else { break; }
		}
		Ok(base)
	}

	/// Parse a balanced aggregate index following a term.
	pub(super) fn select(&mut self, base: Expr, select: Select) -> ResultOf<Expr> {
		let token = self.bump();
		let hash = self.lex.text(&token) == b"{";
		let close: &[u8] = if hash { b"}" } else { b"]" };
		let first = self.peek();
		let mut quoted = None;
		let name = self.lex.text(&first);
		let word = matches!(first.kind, Kind::Word | Kind::Data(_)) || first.kind == Kind::Number && name.starts_with(b"v") && !name.contains(&b'.');
		if hash && word && self.lex.source.get(self.after_space(first.end)) == Some(&b'}') {
			self.bump();
			quoted = Some(node(first.location.clone(), ExprKind::String(self.pstr(self.lex.text(&first)))));
		} else if hash && self.lex.text(&first) == b"-" {
			let raw = self.after_space(first.end);
			if let Some(end) = name_end(self.lex.source, raw, self.lex.utf8) && self.lex.source.get(self.after_space(end)) == Some(&b'}') {
				self.bump();
				self.bump();
				let mut bytes = vec![b'-'];
				bytes.extend_from_slice(&self.lex.source[raw..end]);
				quoted = Some(node(first.location, ExprKind::String(PStr::new(bytes, self.lex.utf8))));
			}
		}
		let index = if let Some(quoted) = quoted { quoted } else { self.expr(0)? };
		self.expect(close)?;
		// op.c check_hash_fields: constant keys of a typed lexical must be fields of its class.
		if let Some((variable, class)) = self.typed_subscript(&base, select) {
			let mut keys = Vec::new();
			constant_keys(&index, &mut keys);
			for key in keys {
				if self.hooks.class_field(&class, &key) == Some(false) {
					return Err(self.fatal(token.location, format!("No such class field \"{key}\" in variable ${variable} of type {class}")));
				}
			}
		}
		Ok(node(token.location, ExprKind::Select(Box::new(base), select, Box::new(index))))
	}

	/// op.c bind_match: `@a =~ OP` warns that OP acts on `scalar(@a)`, and a modifying `tr///`
	/// cannot take an aggregate.
	fn bind_diagnostics(&mut self, left: &Expr, right: &Expr, location: &Location) -> ResultOf<()> {
		let mut target = left;
		while let ExprKind::Group(inner) = &target.kind { target = inner; }
		let (array, name) = match &target.kind {
			ExprKind::Variable(Sigil::Array, name) => (true, Some(name)),
			ExprKind::Variable(Sigil::Hash, name) => (false, Some(name)),
			ExprKind::Deref(Sigil::Array, _) => (true, None),
			ExprKind::Deref(Sigil::Hash, _) => (false, None),
			_ => return Ok(()),
		};
		let operation = match &right.kind {
			ExprKind::Regex(RegexExpr { kind: RegexKind::Substitute(_) | RegexKind::SubstituteEval(..), .. }) => "substitution (s///)",
			ExprKind::Regex(RegexExpr { kind: RegexKind::Transliterate(_), .. }) => "transliteration (tr///)",
			_ => "pattern match (m//)",
		};
		let symbol = if array { '@' } else { '%' };
		let shown = name.map_or_else(|| (if array { "@array" } else { "%hash" }).to_owned(), |name| format!("{symbol}{name}"));
		let text = format!("Applying {operation} to {shown} will act on scalar({shown}) at {} line {}.\n", location.file, location.line);
		self.hooks.compile_warning("misc", false, text)
			.map_err(|_| self.fatal(location.clone(), format!("Applying {operation} to {shown} will act on scalar({shown})")))?;
		if let ExprKind::Regex(RegexExpr { kind: RegexKind::Transliterate(tr), modifiers, .. }) = &right.kind
			&& !modifiers.contains(&b'r')
			&& !(!modifiers.contains(&b'd') && (tr.replacement.bytes.is_empty() || tr.replacement.bytes == tr.search.bytes))
		{
			let sigil = if array { Sigil::Array } else { Sigil::Hash };
			let what = match name {
				Some(name) if self.hooks.is_lexical(sigil, name) => if array { "private array" } else { "private hash" },
				_ => if array { "array dereference" } else { "hash dereference" },
			};
			return Err(self.argument_error(format!("Can't modify {what} in transliteration (tr///)"), false));
		}
		Ok(())
	}

	/// The typed lexical (`my CLASS $x`) and its class whose referent a hash subscript reads.
	fn typed_subscript(&self, base: &Expr, select: Select) -> Option<(Rc<str>, Rc<str>)> {
		let variable = match (select, &base.kind) {
			(Select::HashElement(true) | Select::HashSlice(true) | Select::HashPairs(true), ExprKind::Variable(Sigil::Scalar, name)) => name,
			(Select::HashElement(false) | Select::HashSlice(false) | Select::HashPairs(false), ExprKind::Deref(_, inner)) => match &inner.kind {
				ExprKind::Variable(Sigil::Scalar, name) => name,
				_ => return None,
			},
			_ => return None,
		};
		let class = self.symbols.typed.iter().rev().find_map(|scope| scope.get(variable))?.clone()?;
		Some((variable.clone(), class))
	}

	/// Parse the target of an already-consumed arrow.
	pub(super) fn arrow(&mut self, base: Expr, location: Location) -> ResultOf<Expr> {
		let token = self.peek();
		let text = self.lex.text(&token);
		if matches!(text, b"[" | b"{") { return self.select(base, select_kind(Sigil::Scalar, text, true)); }
		if text == b"(" { return self.code_arrow(base, location); }
		let src = self.lex.source;
		if let Some(byte) = text.first().copied() && let Some(mut slot) = sigil(byte) {
			let mut end = token.start + 1;
			if src.get(end) == Some(&b'#') && slot == Sigil::Scalar { slot = Sigil::LastIndex; end += 1; }
			if src.get(end) == Some(&b'*') {
				self.bump();
				self.lex.rewind(&token);
				self.lex.advance(end + 1);
				self.finish_raw_token();
				return Ok(node(location, ExprKind::Deref(slot, Box::new(base))));
			}
			if matches!(slot, Sigil::Array | Sigil::Hash | Sigil::Glob) && matches!(src.get(end), Some(b'[' | b'{')) {
				self.bump();
				return self.select(base, select_kind(slot, &src[end..end + 1], true));
			}
		}
		let method = if text == b"$" {
			Method::Dynamic(Box::new(self.variable(false)?))
		} else {
			Method::Name(self.ident()?)
		};
		let args = if self.at(b"(") { Some(self.delimited_list(b"(", b")", false)?) } else { None };
		Ok(call(location, CallTarget::Method(Box::new(base), method), args, None, None))
	}

	fn code_arrow(&mut self, base: Expr, location: Location) -> ResultOf<Expr> {
		let args = self.delimited_list(b"(", b")", false)?;
		Ok(call(location, CallTarget::Code(Box::new(base), false), Some(args), None, None))
	}

	/// Convert a noninterpolating quote body into a string constant.
	pub(super) fn simple_quote_value(&self, quote: Quoted<'_>) -> Expr {
		let utf8 = self.lex.utf8 && !quote.bytes.is_ascii();
		node(quote.location, ExprKind::String(PStr::new(quote.bytes.into_owned(), utf8)))
	}
}

/// Convert a sigil byte to its syntax-tree slot.
pub(super) fn sigil(symbol: u8) -> Option<Sigil> {
	Some(match symbol {
		b'$' => Sigil::Scalar, b'@' => Sigil::Array, b'%' => Sigil::Hash, b'&' => Sigil::Code, b'*' => Sigil::Glob,
		_ => return None,
	})
}

/// Classify an element or slice from the sigil, delimiter and indirection.
pub(super) fn select_kind(sigil: Sigil, delimiter: &[u8], arrow: bool) -> Select {
	match (sigil, delimiter == b"[") {
		(Sigil::Array, true) => Select::ArraySlice(arrow),
		(Sigil::Array, false) => Select::HashSlice(arrow),
		(Sigil::Hash, true) => Select::ArrayPairs(arrow),
		(Sigil::Hash, false) => Select::HashPairs(arrow),
		(Sigil::Glob, false) => Select::GlobSlot,
		(_, true) => Select::ArrayElement(arrow),
		(_, false) => Select::HashElement(arrow),
	}
}

/// Compile-time errors for names that `my`/`our`/`state` cannot declare (perl's allocmy and
/// pending_ident): package-qualified names and punctuation, digit or caret globals.
fn declared_name_problem(kind: DeclKind, target: &Expr, utf8: bool, spelled: Option<&str>) -> Option<String> {
	let (sigil, name) = match &target.kind {
		ExprKind::Variable(sigil, name) => (*sigil, name),
		ExprKind::Group(inner) | ExprKind::Unary(Unary::Reference, inner) => return declared_name_problem(kind, inner, utf8, None),
		ExprKind::List(items) => return items.iter().find_map(|item| declared_name_problem(kind, item, utf8, None)),
		ExprKind::Deref(sigil @ (Sigil::Scalar | Sigil::Array | Sigil::Hash), _) if kind != DeclKind::Local => {
			let what = match sigil { Sigil::Scalar => "scalar", Sigil::Array => "array", _ => "hash" };
			let keyword = match kind { DeclKind::My => "my", DeclKind::State => "state", _ => "our" };
			return Some(format!("Can't declare {what} dereference in \"{keyword}\""));
		}
		_ => return None,
	};
	let symbol = match sigil { Sigil::Scalar => '$', Sigil::Array | Sigil::LastIndex => '@', Sigil::Hash => '%', Sigil::Code => '&', Sigil::Glob => '*' };
	let keyword = match kind { DeclKind::My => "my", DeclKind::State => "state", DeclKind::Our | DeclKind::Local => "our" };
	// Outside `use utf8` a Latin-1 length-1 name is spelled in main (see `variable_name`).
	let latin1 = name.strip_prefix("main::").filter(|rest| !utf8 && rest.chars().count() == 1 && !rest.is_ascii());
	let what = if sigil == Sigil::Code { "subroutine" } else { "variable" };
	if latin1.is_none() && name.contains("::") {
		let written = spelled.map_or_else(|| format!("{symbol}{name}"), |s| s.split_whitespace().collect());
		return Some(if kind == DeclKind::Our {
			format!("No package name allowed for {what} {written} in \"our\"")
		} else {
			format!("\"{keyword}\" {what} {written} can't be in a package")
		});
	}
	let shown = latin1.unwrap_or(name);
	let mut chars = shown.chars();
	let first = chars.next()?;
	let identifier = first.is_ascii_alphabetic() || first == '_' && chars.next().is_some() || utf8 && !first.is_ascii() && unicode_ident::is_xid_start(first);
	(kind != DeclKind::Our && !identifier).then(|| format!("Can't use global {symbol}{shown} in \"{keyword}\""))
}

/// op_desc of a scalar-valued operand given to an aggregate-only builtin; `None` when the
/// operand is (or may be) a hash or array.
fn scalar_operand_description(arg: &Expr) -> Option<&'static str> {
	Some(match &arg.kind {
		ExprKind::Group(inner) => return scalar_operand_description(inner),
		ExprKind::Int(_) | ExprKind::UInt(_) | ExprKind::Float(_) | ExprKind::String(_) => "constant item",
		ExprKind::Variable(Sigil::Scalar, _) | ExprKind::Deref(Sigil::Scalar, _) => "scalar dereference",
		ExprKind::Regex(RegexExpr { kind: RegexKind::Compile, .. }) => "pattern quote (qr//)",
		ExprKind::Call(Call { target: CallTarget::Builtin(Builtin::Undef, _), .. }) => "undef operator",
		ExprKind::Select(_, Select::ArrayElement(_), _) => "array element",
		ExprKind::Select(_, Select::HashElement(_), _) => "hash element",
		_ => return None,
	})
}

/// Inside a parenthesized `\( ... )`, an argument-less `&name` names the sub (no call).
fn uncalled_code_refs(expr: Expr) -> Expr {
	let Expr { location, kind, .. } = expr;
	let kind = match kind {
		ExprKind::Group(inner) => ExprKind::Group(Box::new(uncalled_code_refs(*inner))),
		ExprKind::List(items) => ExprKind::List(items.into_iter().map(uncalled_code_refs).collect()),
		ExprKind::Call(Call { target: CallTarget::Named(name, true), args: None, slot: None, .. }) => ExprKind::Variable(Sigil::Code, name),
		ExprKind::Call(Call { target: CallTarget::Code(code, true), args: None, slot: None, .. }) => ExprKind::Deref(Sigil::Code, code),
		kind => kind,
	};
	node(location, kind)
}

/// Location of the first `\` item in a declaration's parenthesized list.
fn first_reference(list: &Expr) -> Option<Location> {
	match &list.kind {
		ExprKind::Unary(Unary::Reference, _) => Some(list.location.clone()),
		ExprKind::Group(inner) => first_reference(inner),
		ExprKind::List(items) => items.iter().find_map(first_reference),
		_ => None,
	}
}

fn class_name(name: Rc<str>) -> Rc<str> {
	if let Some(class) = name.strip_suffix("::") { class.into() } else { name }
}

fn is_deref(src: &[u8], at: usize, utf8: bool) -> bool {
	matches!(src.get(at), Some(b'{' | b'$')) || name_end(src, at, utf8).is_some()
}

fn file_test(src: &[u8], at: usize, utf8: bool) -> Option<u8> {
	let op = *src.get(at)?;
	(b"rwxoRWXOezsfdlpSbctugkTBMAC".contains(&op) && ident_unit(src, at + 1, utf8, true).is_none()).then_some(op)
}

// op.c's op_lvalue diagnostics for an assignment's left side. Parenthesized simple
// assignments operate on a list, even if it has one item; compound assignment needs a scalar.
fn unmodifiable_assignment(op: Binary, left: &Expr, right: &Expr) -> Option<String> {
	// `@a =~ s///`: substitution modifies its target unless it is `/r`.
	if let Binary::Bind(_) = op
		&& let ExprKind::Regex(RegexExpr { kind: RegexKind::Substitute(_) | RegexKind::SubstituteEval(..), modifiers, .. }) = &right.kind
		&& !modifiers.contains(&b'r')
	{
		let mut target = left;
		while let ExprKind::Group(inner) = &target.kind { target = inner; }
		let what = match &target.kind {
			ExprKind::Variable(Sigil::Array, _) | ExprKind::Deref(Sigil::Array, _) => "array dereference",
			ExprKind::Variable(Sigil::Hash, _) | ExprKind::Deref(Sigil::Hash, _) => "hash dereference",
			_ if is_constant_lvalue(target, false) => "constant item",
			_ => return None,
		};
		return Some(format!("Can't modify {what} in substitution (s///)"));
	}
	if op == Binary::Assign {
		// `(state $x) = ...`, `state ($x) = ...`: only an unparenthesized state declaration may be initialized.
		let state_in_list = match &left.kind {
			ExprKind::Declare(DeclKind::State, _, target, _) => matches!(&target.kind, ExprKind::Group(_) | ExprKind::List(_)),
			ExprKind::Group(_) | ExprKind::List(_) => declares_state(left),
			_ => false,
		};
		if state_in_list { return Some("Initialization of state variables in list currently forbidden".into()); }
		let mut target = left;
		while let ExprKind::Group(inner) = &target.kind { target = inner; }
		if let ExprKind::Conditional(_, yes, no) = &target.kind {
			let list = |e: &Expr| matches!(&e.kind, ExprKind::Group(_) | ExprKind::List(_) | ExprKind::Variable(Sigil::Array | Sigil::Hash, _));
			if list(yes) != list(no) { return Some("Assignment to both a list and a scalar".into()); }
		}
	}
	if let Binary::AssignOp(compound) = op {
		let mut target = left;
		while let ExprKind::Group(inner) = &target.kind { target = inner; }
		if let ExprKind::Variable(sigil @ (Sigil::Array | Sigil::Hash), _) | ExprKind::Deref(sigil @ (Sigil::Array | Sigil::Hash), _) = &target.kind {
			let what = if *sigil == Sigil::Array { "array" } else { "hash" };
			return Some(format!("Can't modify {what} dereference in {}", compound_description(compound)));
		}
	}
	let operation = match op {
		Binary::Assign if is_constant_lvalue(left, true) => {
			if matches!(&left.kind, ExprKind::Group(_) | ExprKind::List(_)) { "list assignment" } else { "scalar assignment" }
		}
		Binary::AssignOp(op) if is_constant_lvalue(left, false) => compound_description(op),
		_ => return None,
	};
	Some(format!("Can't modify constant item in {operation}"))
}

fn declares_state(e: &Expr) -> bool {
	match &e.kind {
		ExprKind::Declare(DeclKind::State, ..) => true,
		ExprKind::Group(inner) => declares_state(inner),
		ExprKind::List(items) => items.iter().any(declares_state),
		_ => false,
	}
}

fn compound_description(op: Compound) -> &'static str {
	match op {
			Compound::Add => "addition (+)",
			Compound::Sub => "subtraction (-)",
			Compound::Mul => "multiplication (*)",
			Compound::Div => "division (/)",
			Compound::Mod => "modulus (%)",
			Compound::Pow => "exponentiation (**)",
			Compound::Concat => "concatenation (.) or string",
			Compound::Repeat => "repeat (x)",
			Compound::Shl => "left bitshift (<<)",
			Compound::Shr => "right bitshift (>>)",
			Compound::BitAnd => "bitwise and (&)",
			Compound::BitOr => "bitwise or (|)",
			Compound::BitXor => "bitwise xor (^)",
			Compound::StrAnd => "string bitwise and (&.)",
			Compound::StrOr => "string bitwise or (|.)",
			Compound::StrXor => "string bitwise xor (^.)",
			Compound::And => "logical and assignment (&&=)",
			Compound::Or => "logical or assignment (||=)",
			Compound::DefinedOr => "defined or assignment (//=)",
	}
}

fn is_constant_lvalue(expr: &Expr, list: bool) -> bool {
	match &expr.kind {
		ExprKind::Int(_) | ExprKind::UInt(_) | ExprKind::Float(_) | ExprKind::String(_) |
		ExprKind::Version(_) | ExprKind::Bareword(_) | ExprKind::Special(Special::Line | Special::File | Special::Package(_)) => true,
		ExprKind::Group(inner) | ExprKind::Unary(Unary::Plus | Unary::Minus | Unary::Not | Unary::Complement | Unary::StringComplement, inner) => {
			is_constant_lvalue(inner, list)
		}
		ExprKind::List(items) if list => items.iter().any(|item| is_constant_lvalue(item, true)),
		// Compound assignment applies scalar lvalue context to a comma expression.
		ExprKind::List(items) => items.last().is_some_and(|item| is_constant_lvalue(item, false)),
		_ => false,
	}
}

// The textual prototype counts source argument expressions, not the eventual size of
// their flattened values. Backslash groups occupy one slot; @/% consume the rest.
#[derive(Clone, Copy)]
struct PrototypeShape {
	min: usize,
	max: Option<usize>,
	unary: bool,
	block_first: bool,
}

impl PrototypeShape {
	fn nullary(self) -> bool { self.max == Some(0) }

	fn parse(proto: &[u8]) -> Option<Self> {
		let mut atoms = proto.iter().copied().filter(|b| !b.is_ascii_whitespace()).peekable();
		let block_first = atoms.peek() == Some(&b'&');
		let mut min = 0;
		let mut max = 0;
		let mut optional = false;
		// One optional leading semicolon preserves named-unary precedence;
		// a trailing semicolon (`$;`) deliberately makes it a list operator.
		if atoms.next_if_eq(&b';').is_some() { optional = true; }
		let mut unary = false;
		while let Some(atom) = atoms.next() {
			match atom {
				b';' => { optional = true; unary = false; continue; }
				b'@' | b'%' => return Some(Self { min, max: None, unary: false, block_first }),
				b'_' => {
					if atoms.peek().is_some_and(|&after| !matches!(after, b';' | b'@' | b'%')) { return None; }
					optional = true;
				}
				b'\\' => match atoms.next()? {
					b'[' => { atoms.find(|&atom| atom == b']')?; }
					b'$' | b'@' | b'%' | b'&' | b'*' => {}
					_ => return None,
				},
				b'$' | b'&' | b'*' | b'+' => {}
				// Perl can warn about malformed prototypes at declaration time.
				// Do not invent an arity for unknown characters.
				_ => return None,
			}
			unary = max == 0 && atom != b'&';
			max += 1;
			if !optional { min += 1; }
		}
		Some(Self { min, max: Some(max), unary, block_first })
	}
}

/// perlsub: a `*` prototype slot accepts a bareword, passed as a simple scalar (its name) and
/// therefore exempt from strict subs.
fn star_barewords(proto: &[u8], args: &mut Expr, block_slot: bool) {
	let mut stars = Vec::new();
	let mut atoms = proto.iter().copied().filter(|b| !b.is_ascii_whitespace() && *b != b';');
	while let Some(atom) = atoms.next() {
		if atom == b'\\' && atoms.next() == Some(b'[') { atoms.find(|&atom| atom == b']'); }
		stars.push(atom == b'*');
	}
	let stars = stars.get(usize::from(block_slot)..).unwrap_or_default();
	// A typeglob arrives as a reference to it (perlsub).
	let stringify = |item: &mut Expr| match &item.kind {
		ExprKind::Bareword(name) => item.kind = ExprKind::String(PStr::new(name.as_bytes().to_vec(), !name.is_ascii())),
		ExprKind::Variable(Sigil::Glob, _) => {
			let glob = std::mem::replace(item, empty(item.location.clone()));
			*item = unary(glob.location.clone(), Unary::Reference, glob);
		}
		_ => {}
	};
	if let ExprKind::List(items) = &mut args.kind {
		for (item, _) in items.iter_mut().zip(stars).filter(|(_, star)| **star) { stringify(item); }
	} else if stars.first() == Some(&true) {
		stringify(args);
	}
}

/// op.c ck_entersub_args_proto: arguments for `&`, `\$`, `\@`, `\%`, `\&`, `\*` or `\[...]`
/// prototype slots that are of the wrong kind, as (1-based index, expected, op_desc of the
/// argument). Only argument kinds known at parse time are checked. A `&name` argument for a
/// `\[...&...]` slot names the sub rather than calling it.
fn check_reference_arguments(proto: &[u8], args: Option<&mut Expr>, block_slot: bool) -> Vec<(usize, String, &'static str)> {
	let mut items: Vec<&mut Expr> = match args {
		Some(Expr { kind: ExprKind::List(items), .. }) => items.iter_mut().collect(),
		Some(arg) => vec![arg],
		None => Vec::new(),
	};
	let mut problems = Vec::new();
	let mut atoms = proto.iter().copied().filter(|b| !b.is_ascii_whitespace() && *b != b';');
	let mut index = 0;
	while let Some(atom) = atoms.next() {
		index += 1;
		if matches!(atom, b'@' | b'%') { break; }
		let item = (index - usize::from(block_slot)).checked_sub(1);
		if atom == b'&' {
			if let Some(arg) = item.and_then(|i| items.get(i))
				&& let Some(actual) = code_argument_problem(arg)
			{
				let expected = if index == 1 { "block or sub {}" } else { "sub {}" };
				problems.push((index, expected.to_owned(), actual));
			}
			continue;
		}
		if atom != b'\\' { continue; }
		let (allowed, bracketed): (Vec<u8>, bool) = match atoms.next() {
			Some(b'[') => (atoms.by_ref().take_while(|&b| b != b']').collect(), true),
			Some(class) => (vec![class], false),
			None => break,
		};
		let Some(arg) = item.and_then(|i| items.get_mut(i)) else { continue; };
		let Some((kind, actual)) = argument_kind(&**arg) else { continue; };
		let named = match &arg.kind {
			ExprKind::Call(Call { target: CallTarget::Named(name, true), .. }) => Some(name.clone()),
			_ => None,
		};
		if bracketed && kind == b'&' && allowed.contains(&b'&') && let Some(name) = named {
			arg.kind = ExprKind::Variable(Sigil::Code, name);
		}
		let fits = allowed.iter().any(|&class| match class {
			// A lone `\$` takes any modifiable scalar.
			b'$' if !bracketed => kind != b'c',
			class => kind == class,
		});
		if fits { continue; }
		let expected = match (bracketed, allowed.as_slice()) {
			(false, [b'$']) => "scalar".to_owned(),
			(false, [b'@']) => "array".to_owned(),
			(false, [b'%']) => "hash".to_owned(),
			(false, [b'&']) => "subroutine".to_owned(),
			(false, [b'*']) => "symbol".to_owned(),
			(_, class) => format!("one of [{}]", String::from_utf8_lossy(class)),
		};
		problems.push((index, expected, actual));
	}
	problems
}

/// op_desc of an argument a `&` prototype slot rejects: it takes a block, `sub {...}`,
/// `\&name` or `undef`.
fn code_argument_problem(arg: &Expr) -> Option<&'static str> {
	match &arg.kind {
		ExprKind::Sub(_) | ExprKind::Call(Call { target: CallTarget::Builtin(Builtin::Undef, _), .. }) => None,
		ExprKind::Unary(Unary::Reference, inner) => match &inner.kind {
			ExprKind::Variable(Sigil::Code, _) | ExprKind::Deref(Sigil::Code, _) => None,
			ExprKind::Call(Call { target: CallTarget::Named(_, true) | CallTarget::Code(_, true), args: None, .. }) => None,
			ExprKind::Group(group) if matches!(&group.kind, ExprKind::Variable(Sigil::Code, _) | ExprKind::Deref(Sigil::Code, _)) => None,
			ExprKind::Group(_) | ExprKind::List(_) => Some("reference constructor"),
			_ => Some("single ref constructor"),
		},
		_ => argument_kind(arg).map(|(_, actual)| actual),
	}
}

/// Kind (`$`, `@`, `%`, `*`, `&` for an argument-less `&name`, `f` for another sub call, or `c`
/// for a constant) and op_desc of an argument whose kind the parser knows.
fn argument_kind(arg: &Expr) -> Option<(u8, &'static str)> {
	Some(match &arg.kind {
		ExprKind::Int(_) | ExprKind::UInt(_) | ExprKind::Float(_) | ExprKind::String(_) => (b'c', "constant item"),
		ExprKind::Variable(Sigil::Scalar, _) | ExprKind::Deref(Sigil::Scalar, _) => (b'$', "scalar dereference"),
		ExprKind::Variable(Sigil::Array, _) | ExprKind::Deref(Sigil::Array, _) => (b'@', "array dereference"),
		ExprKind::Variable(Sigil::Hash, _) | ExprKind::Deref(Sigil::Hash, _) => (b'%', "hash dereference"),
		ExprKind::Variable(Sigil::Glob, _) | ExprKind::Deref(Sigil::Glob, _) => (b'*', "ref-to-glob cast"),
		ExprKind::Variable(Sigil::Code, _) => (b'&', "subroutine entry"),
		ExprKind::Select(_, Select::ArrayElement(_), _) => (b'$', "array element"),
		ExprKind::Select(_, Select::HashElement(_), _) => (b'$', "hash element"),
		ExprKind::Call(Call { target: CallTarget::Named(_, true), args: None, .. }) => (b'&', "subroutine entry"),
		ExprKind::Call(Call { target: CallTarget::Named(..), .. }) => (b'f', "subroutine entry"),
		ExprKind::Declare(DeclKind::My | DeclKind::State, _, target, _) => match &target.kind {
			ExprKind::Variable(Sigil::Scalar, _) => (b'$', "private variable"),
			ExprKind::Variable(Sigil::Array, _) => (b'@', "private array"),
			ExprKind::Variable(Sigil::Hash, _) => (b'%', "private hash"),
			_ => return None,
		},
		_ => return None,
	})
}

/// Weak keywords: builtins an imported sub (or `CORE::GLOBAL::`) may override.
fn overridable(builtin: Builtin, block: bool) -> bool {
	use Builtin as B;
	use BuiltinClass as C;
	if builtin.class() == C::Syntax || builtin == B::Do && block { return false; }
	!(matches!(builtin.class(), C::Print | C::Sort | C::Transform)
		|| matches!(builtin, B::Defined | B::Delete | B::Eval | B::Exists | B::Goto | B::Import | B::Last |
			B::Next | B::Pos | B::Prototype | B::Redo | B::Return | B::Scalar | B::Split | B::Study | B::Undef))
}

/// Scalars a `my`/`our`/`state` declaration introduces.
fn declared_scalars(target: &Expr, names: &mut Vec<Rc<str>>) {
	match &target.kind {
		ExprKind::Variable(Sigil::Scalar, name) => names.push(name.clone()),
		ExprKind::Group(inner) | ExprKind::Unary(Unary::Reference, inner) => declared_scalars(inner, names),
		ExprKind::List(items) => for item in items { declared_scalars(item, names); },
		_ => {}
	}
}

/// Constant string keys of a hash subscript (`{key}`, `{qw(a b)}`).
fn constant_keys(index: &Expr, keys: &mut Vec<String>) {
	match &index.kind {
		ExprKind::String(key) => keys.push(key.to_string_lossy().into_owned()),
		ExprKind::Group(inner) => constant_keys(inner, keys),
		ExprKind::List(items) => for item in items { constant_keys(item, keys); },
		_ => {}
	}
}

/// Operand count for a named unary operator, flattening one parenthesized list.
fn unary_operand_count(args: Option<&Expr>) -> usize {
	match args.map(|arg| &arg.kind) {
		Some(ExprKind::Group(inner)) => unary_operand_count(Some(inner)),
		_ => argument_count(args),
	}
}

/// perl's op description where it differs from the keyword, for arity diagnostics.
fn op_description(builtin: Builtin) -> &'static str {
	match builtin {
		Builtin::Defined => "defined operator",
		Builtin::Ref => "reference-type operator",
		Builtin::Readpipe => "quoted execution (``, qx)",
		Builtin::Undef => "undef operator",
		Builtin::Pos => "match position",
		Builtin::Reset => "symbol reset",
		_ => builtin.name(),
	}
}

fn argument_count(args: Option<&Expr>) -> usize {
	args.map_or(0, |arg| match &arg.kind {
		ExprKind::List(items) => items.len(),
		_ => 1,
	})
}

pub(super) fn call(location: Location, target: CallTarget, args: Option<Expr>, slot: Option<CallSlot>, prototype: Option<PStr>) -> Expr {
	node(location, ExprKind::Call(Call { target, args: args.map(Box::new), slot, prototype }))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Assoc { Left, Right, Chain, None }

fn infix(bytes: &[u8]) -> Option<(Binary, u8, Assoc)> {
	use Assoc::{Chain, Left, None as NonAssoc, Right};
	use Binary as B;
	use Compound as C;
	Some(match bytes {
		b"or" => (B::Or, P_OR, Left), b"xor" => (B::Xor, P_OR, Left), b"and" => (B::And, P_AND, Left),
		b"=" => (B::Assign, P_ASSIGN, Right),
		b"+=" => (B::AssignOp(C::Add), P_ASSIGN, Right), b"-=" => (B::AssignOp(C::Sub), P_ASSIGN, Right),
		b"*=" => (B::AssignOp(C::Mul), P_ASSIGN, Right), b"/=" => (B::AssignOp(C::Div), P_ASSIGN, Right),
		b"%=" => (B::AssignOp(C::Mod), P_ASSIGN, Right), b"**=" => (B::AssignOp(C::Pow), P_ASSIGN, Right),
		b".=" => (B::AssignOp(C::Concat), P_ASSIGN, Right), b"x=" => (B::AssignOp(C::Repeat), P_ASSIGN, Right),
		b"<<=" => (B::AssignOp(C::Shl), P_ASSIGN, Right), b">>=" => (B::AssignOp(C::Shr), P_ASSIGN, Right),
		b"&=" => (B::AssignOp(C::BitAnd), P_ASSIGN, Right), b"|=" => (B::AssignOp(C::BitOr), P_ASSIGN, Right),
		b"^=" => (B::AssignOp(C::BitXor), P_ASSIGN, Right), b"&.=" => (B::AssignOp(C::StrAnd), P_ASSIGN, Right),
		b"|.=" => (B::AssignOp(C::StrOr), P_ASSIGN, Right), b"^.=" => (B::AssignOp(C::StrXor), P_ASSIGN, Right),
		b"&&=" => (B::AssignOp(C::And), P_ASSIGN, Right), b"||=" => (B::AssignOp(C::Or), P_ASSIGN, Right),
		b"//=" => (B::AssignOp(C::DefinedOr), P_ASSIGN, Right),
		b".." => (B::Range(false), P_RANGE, NonAssoc), b"..." => (B::Range(true), P_RANGE, NonAssoc),
		b"||" => (B::Or, P_DEFINED, Left), b"//" => (B::DefinedOr, P_DEFINED, Left), b"&&" => (B::And, P_LOG_AND, Left),
		b"|" => (B::BitOr, P_BIT_OR, Left), b"^." => (B::StrXor, P_BIT_OR, Left),
		b"|." => (B::StrOr, P_BIT_OR, Left), b"^" => (B::BitXor, P_BIT_OR, Left),
		b"&" => (B::BitAnd, P_BIT_AND, Left), b"&." => (B::StrAnd, P_BIT_AND, Left),
		b"==" => (B::Eq, P_EQUAL, Chain), b"!=" => (B::Ne, P_EQUAL, Chain),
		b"eq" => (B::StrEq, P_EQUAL, Chain), b"ne" => (B::StrNe, P_EQUAL, Chain),
		b"<=>" => (B::Cmp, P_EQUAL, NonAssoc), b"cmp" => (B::StrCmp, P_EQUAL, NonAssoc), b"~~" => (B::SmartMatch, P_EQUAL, NonAssoc),
		b"<" => (B::Lt, P_ORDER, Chain), b">" => (B::Gt, P_ORDER, Chain),
		b"<=" => (B::Le, P_ORDER, Chain), b">=" => (B::Ge, P_ORDER, Chain),
		b"lt" => (B::StrLt, P_ORDER, Chain), b"le" => (B::StrLe, P_ORDER, Chain),
		b"gt" => (B::StrGt, P_ORDER, Chain), b"ge" => (B::StrGe, P_ORDER, Chain), b"isa" => (B::Isa, P_ORDER, NonAssoc),
		b"<<" => (B::Shl, P_SHIFT, Left), b">>" => (B::Shr, P_SHIFT, Left),
		b"+" => (B::Add, P_ADD, Left), b"-" => (B::Sub, P_ADD, Left), b"." => (B::Concat, P_ADD, Left),
		b"*" => (B::Mul, P_MUL, Left), b"/" => (B::Div, P_MUL, Left), b"%" => (B::Mod, P_MUL, Left), b"x" => (B::Repeat, P_MUL, Left),
		b"=~" => (B::Bind(false), P_BIND, Left), b"!~" => (B::Bind(true), P_BIND, Left), b"**" => (B::Pow, P_POWER, Right),
		_ => return None,
	})
}

fn parse_number(spelling: &[u8]) -> Option<ExprKind> {
	let normalized;
	let s = if spelling.contains(&b'_') {
		normalized = spelling.iter().copied().filter(|b| *b != b'_').collect::<Vec<_>>();
		normalized.as_slice()
	} else { spelling };
	let s = std::str::from_utf8(s).ok()?;
	let dot_count = s.split('.').count() - 1;
	if s.starts_with('v') || dot_count >= 2 {
		let parts = s.strip_prefix('v').unwrap_or(s).split('.').enumerate().map(|(i, part)| {
			if part.is_empty() && i == 0 { Some(0) } else { part.parse().ok() }
		}).collect::<Option<Vec<_>>>()?;
		return Some(ExprKind::Version(parts));
	}
	let (digits, radix) = if let Some(hex) = s.strip_prefix("0x").or_else(|| s.strip_prefix("0X")) {
		(hex, 16)
	} else if let Some(bin) = s.strip_prefix("0b").or_else(|| s.strip_prefix("0B")) {
		(bin, 2)
	} else if let Some(oct) = s.strip_prefix("0o").or_else(|| s.strip_prefix("0O")) {
		(oct, 8)
	} else if s.as_bytes().get(1).is_some_and(u8::is_ascii_digit) && s.starts_with('0') { (s, 8) }
	else { (s, 10) };
	if radix != 10 && let Some((mantissa, exponent)) = digits.split_once(['p', 'P']) {
		return radix_float(mantissa, exponent, radix).map(ExprKind::Float);
	}
	if radix == 10 && s.contains(['.', 'e', 'E']) { return s.parse().ok().map(ExprKind::Float); }
	integer(digits, radix)
}

/// toke.c's hexadecimal float diagnostics for an `NV` with a 53-bit mantissa: more significant
/// bits than fit, or a binary exponent outside the double range.
fn hex_float_problems(spelling: &[u8]) -> Vec<&'static str> {
	let Some(hex) = spelling.strip_prefix(b"0x").or_else(|| spelling.strip_prefix(b"0X")) else { return Vec::new() };
	let Some(split) = hex.iter().position(|&b| matches!(b, b'p' | b'P')) else { return Vec::new() };
	let (mantissa, exponent) = (&hex[..split], &hex[split + 1..]);
	let exponent = std::str::from_utf8(exponent).ok().map(|e| e.replace('_', ""))
		.and_then(|e| e.parse::<i64>().ok()).unwrap_or(0);
	let digits: Vec<u32> = mantissa.iter().filter(|&&b| b != b'_' && b != b'.').filter_map(|&b| char::from(b).to_digit(16)).collect();
	let whole = mantissa.iter().take_while(|&&b| b != b'.').filter(|&&b| b != b'_').count() as i64;
	let Some(first) = digits.iter().position(|&d| d != 0) else { return Vec::new() };
	let top = 32 - digits[first].leading_zeros();
	let last = digits[digits.len() - 1];
	let bits = i64::from(top) + 4 * (digits.len() - 1 - first) as i64 - if last != 0 { i64::from(last.trailing_zeros()) } else { 0 };
	let mut problems = Vec::new();
	if bits > 53 { problems.push("mantissa overflow"); }
	let binary_exponent = 4 * (whole - 1 - first as i64) + i64::from(top) - 1 + exponent;
	if binary_exponent >= 1024 { problems.push("exponent overflow"); }
	else if binary_exponent < -1025 { problems.push("exponent underflow"); }
	problems
}

fn radix_float(mantissa: &str, exponent: &str, radix: u32) -> Option<f64> {
	let (whole, frac) = mantissa.split_once('.').unwrap_or((mantissa, ""));
	if whole.is_empty() && frac.is_empty() { return None; }
	let base = f64::from(radix);
	let int = whole.chars().try_fold(0.0, |n, c| Some(n * base + f64::from(c.to_digit(radix)?)))?;
	let fraction = frac.chars().rev().try_fold(0.0, |n, c| Some((n + f64::from(c.to_digit(radix)?)) / base))?;
	let expo = exponent.parse::<i32>().unwrap_or(if exponent.starts_with('-') { i32::MIN } else { i32::MAX });
	let value = int + fraction;
	Some(if expo < -1022 {
		// Multiplying in two stages preserves representable subnormal values.
		value * 2f64.powi(expo.saturating_add(1022)) * f64::MIN_POSITIVE
	} else { value * 2f64.powi(expo) })
}

fn integer(s: &str, radix: u32) -> Option<ExprKind> {
	if s.is_empty() { return None; }
	if let Ok(n) = u64::from_str_radix(s, radix) {
		return Some(i64::try_from(n).map_or(ExprKind::UInt(n), ExprKind::Int));
	}
	if radix == 10 { return s.parse().ok().map(ExprKind::Float); }
	let n = s.chars().try_fold(0.0, |n, d| Some(n * f64::from(radix) + f64::from(d.to_digit(radix)?)))?;
	Some(ExprKind::Float(n))
}
