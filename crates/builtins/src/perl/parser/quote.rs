//! Quote-like terms and interpolation from perlop's “Gory details of parsing quoted constructs”.

use super::*;
use crate::perl::lexer::{HereKind, Quoted, ident_unit, unit, variable_end};

#[derive(Clone, Copy, PartialEq, Eq)]
enum Mode {
	String,
	Replacement,
	Pattern { extended: bool, interpolate: bool },
}

impl Mode {
	fn pattern(self) -> bool { matches!(self, Self::Pattern { .. }) }
	fn interpolates(self) -> bool { !matches!(self, Self::Pattern { interpolate: false, .. }) }
}

impl<'s, 'h> Parser<'s, 'h> {
	/// Build a compilation unit for raw runtime pattern bytes, retaining any Perl code groups.
	pub(super) async fn regex_eval_program(&mut self, src: &PStr, extended: bool) -> ResultOf<Program> {
		let location = self.lex.location();
		let pattern = self.interpolate(&src.bytes, location.clone(), Mode::Pattern { extended, interpolate: false }).await?;
		let expr = Expr {
			location: location.clone(),
			cache: NodeCache::default(),
			kind: ExprKind::Regex(RegexExpr { kind: RegexKind::Compile, pattern, modifiers: if extended { vec![b'x'] } else { Vec::new() } }),
		};
		let stmt = Stmt { location: location.clone(), label: None, kind: StmtKind::Expr(expr) };
		Ok(Program { file: self.file.clone(), package: self.pkg.clone(), body: Block { location, stmts: vec![stmt] }, data: None })
	}

	/// Parse unprefixed strings, backticks or slash-delimited matches.
	pub(super) async fn symbolic_quote(&mut self, token: Token, symbol: u8) -> ResultOf<Expr> {
		self.bump();
		self.lex.rewind(&token);
		let location = token.location;
		match symbol {
			b'/' => self.regex(Builtin::Match, location).await,
			b'\'' => {
				let quoted = self.scan(QuoteScan::Single, None)?;
				Ok(self.simple_quote_value(quoted))
			}
			b'"' | b'`' => {
				let quoted = self.scan(QuoteScan::Double, None)?;
				let parts = self.interpolate(&quoted.bytes, quoted.location, Mode::String).await?;
				Ok(if symbol == b'`' { self.command_value(location, parts) } else { quote_value(location, QuoteKind::String, parts) })
			}
			_ => Err(self.diagnostic(location, "Search pattern not terminated".into())),
		}
	}

	/// Parse a keyword-led quote-like term.
	pub(super) async fn word_quote(&mut self, op: Builtin, location: Location) -> ResultOf<Expr> {
		self.lex.quote_gap(true);
		match op {
			Builtin::Q => {
				let quoted = self.scan(QuoteScan::Single, None)?;
				Ok(self.simple_quote_value(quoted))
			}
			Builtin::Qw => {
				let quoted = self.scan(QuoteScan::Single, None)?;
				let mut words = Vec::new();
				let mut line = quoted.location.line;
				let mut at = 0;
				while at < quoted.bytes.len() {
					let start = at;
					while quoted.bytes.get(at).is_some_and(|b| !b.is_ascii_whitespace()) { at += 1; }
					if at > start {
						words.push(Expr {
							location: Location { file: location.file.clone(), line },
							cache: NodeCache::default(),
							kind: ExprKind::String(self.pstr(&quoted.bytes[start..at])),
						});
					}
					while quoted.bytes.get(at).is_some_and(u8::is_ascii_whitespace) {
						line += u32::from(quoted.bytes[at] == b'\n');
						at += 1;
					}
				}
				// `qw` is parenthesized list syntax: scalar context observes its final word,
				// and it is not flattened by an enclosing comma expression.
				let list = Expr { location: location.clone(), cache: NodeCache::default(), kind: ExprKind::List(words) };
				Ok(Expr { location, cache: NodeCache::default(), kind: ExprKind::Group(Box::new(list)) })
			}
			Builtin::Qq | Builtin::Qx => {
				let literal = op == Builtin::Qx && self.lex.source.get(self.lex.pos) == Some(&b'\'');
				let quoted = self.scan(if literal { QuoteScan::Single } else { QuoteScan::Double }, None)?;
				let parts = if literal { vec![QuotePart::Literal(self.pstr(&quoted.bytes))] }
				else { self.interpolate(&quoted.bytes, quoted.location, Mode::String).await? };
				Ok(if op == Builtin::Qx { self.command_value(location, parts) } else { quote_value(location, QuoteKind::String, parts) })
			}
			_ => self.regex(op, location).await,
		}
	}

	fn scan(&mut self, mode: QuoteScan, shared: Option<u32>) -> ResultOf<Quoted<'s>> {
		let quoted = self.lex.quote(mode, shared).map_err(|err| self.lex_error(err))?;
		self.finish_raw_token();
		Ok(quoted)
	}

	/// Parse angle-bracket reads and filename globs.
	pub(super) async fn angle(&mut self, token: Token) -> ResultOf<Expr> {
		self.bump();
		self.lex.rewind(&token);
		let quote = self.scan(QuoteScan::Double, None)?;
		let location = token.location;
		if quote.bytes.is_empty() { return Ok(Expr { location, cache: NodeCache::default(), kind: ExprKind::Readline(Readline::Argv(false)) }); }
		let name = |src: &[u8]| name_end(src, 0, self.lex.utf8) == Some(src.len());
		if name(&quote.bytes) {
			return Ok(Expr { location, cache: NodeCache::default(), kind: ExprKind::Readline(Readline::Handle(self.name(&quote.bytes))) });
		}
		if let Some(tail) = quote.bytes.strip_prefix(b"$") && name(tail) {
			let var = Expr { location: quote.location, cache: NodeCache::default(), kind: ExprKind::Variable(Sigil::Scalar, self.name(tail)) };
			return Ok(Expr { location, cache: NodeCache::default(), kind: ExprKind::Readline(Readline::Scalar(Box::new(var))) });
		}
		let parts = self.interpolate(&quote.bytes, quote.location, Mode::String).await?;
		Ok(quote_value(location, QuoteKind::Glob, parts))
	}

	/// Parse a heredoc or the safe `<<>>` input operator.
	pub(super) async fn here(&mut self, token: Token) -> ResultOf<Expr> {
		self.bump();
		self.lex.rewind(&token);
		self.lex.advance(token.start + 2);
		let location = token.location;
		if self.lex.source[self.lex.pos..].starts_with(b">>") {
			self.lex.advance(self.lex.pos + 2);
			self.finish_raw_token();
			return Ok(Expr { location, cache: NodeCache::default(), kind: ExprKind::Readline(Readline::Argv(true)) });
		}
		let here = self.lex.heredoc().map_err(|err| self.lex_error(err))?;
		self.finish_raw_token();
		if here.kind == HereKind::Literal {
			return Ok(Expr { location, cache: NodeCache::default(), kind: ExprKind::String(self.pstr(&here.bytes)) });
		}
		let parts = self.interpolate(&here.bytes, here.location, Mode::String).await?;
		Ok(if here.kind == HereKind::Command { self.command_value(location, parts) } else { quote_value(location, QuoteKind::String, parts) })
	}

	/// Resolves `\N{NAME}` at `open` (the brace): a custom `$^H{charnames}` translator in
	/// scope wins over the Unicode names, except for `U+` code points.
	fn char_name(&mut self, src: &[u8], open: usize) -> Result<(Vec<u32>, usize), String> {
		if let Some(len) = src[open + 1..].iter().position(|&b| b == b'}') {
			let raw = src[open + 1..open + 1 + len].trim_ascii();
			if self.lex.utf8 && std::str::from_utf8(raw).is_err() { return Err("Malformed UTF-8 character (fatal)".into()); }
			let name = self.pstr(raw).to_string_lossy().into_owned();
			if !raw.starts_with(b"U+") && let Some(custom) = self.hooks.custom_charname(&name) {
				let text = custom?;
				let cps = if text.utf8 { text.to_string_lossy().chars().map(u32::from).collect() } else { text.bytes.iter().map(|&b| u32::from(b)).collect() };
				return Ok((cps, open + len + 2));
			}
		}
		char_name(src, open)
	}

	/// Backticks, `qx` and command here-docs; an imported or `CORE::GLOBAL::` `readpipe`
	/// override receives the interpolated command instead (perlop "qx/STRING/").
	fn command_value(&self, location: Location, parts: Vec<QuotePart>) -> Expr {
		if self.builtin_override(Builtin::Readpipe, false).is_some() {
			let command = quote_value(location.clone(), QuoteKind::String, parts);
			return expr::call(location, CallTarget::Named("readpipe".into(), false), Some(command), None, None);
		}
		quote_value(location, QuoteKind::Command, parts)
	}

	async fn regex(&mut self, builtin: Builtin, location: Location) -> ResultOf<Expr> {
		let tr = matches!(builtin, Builtin::Tr | Builtin::Y);
		let sub = builtin == Builtin::Substitute;
		let first = self.scan(if tr { QuoteScan::Transliterate } else { QuoteScan::Pattern }, None).map_err(|mut error| {
			if tr { error.message = "Transliteration pattern not terminated".into(); }
			else if sub { error.message = "Substitution pattern not terminated".into(); }
			error
		})?;
		let second = if sub || tr {
			let shared = if first.paired { self.lex.quote_gap(true); None } else { Some(first.delimiter) };
			let scan = if tr { QuoteScan::Transliterate } else { QuoteScan::Double };
			Some(self.scan(scan, shared).map_err(|mut error| {
				error.message = if tr { "Transliteration replacement not terminated" } else { "Substitution replacement not terminated" }.into();
				error
			})?)
		} else { None };
		let modifiers = self.regex_modifiers(builtin)?;
		let pattern = if tr { Vec::new() } else {
			self.interpolate(&first.bytes, first.location.clone(), Mode::Pattern {
				extended: modifiers.contains(&b'x'),
				interpolate: first.delimiter != u32::from(b'\''),
			}).await?
		};
		let kind = if let Some(second) = second {
			let first_literal = first.delimiter == u32::from(b'\'');
			let second_literal = second.delimiter == u32::from(b'\'');
			if tr {
				RegexKind::Transliterate(Transliteration {
					search: self.pstr(&first.bytes), replacement: self.pstr(&second.bytes),
					literal_search: first_literal, literal_replacement: second_literal,
				})
			} else if let count @ 1.. = modifiers.iter().filter(|&&b| b == b'e').count() {
				let block = self.replacement_block(&second.bytes, second.location).await?;
				RegexKind::SubstituteEval(block, count)
			} else {
				let replacement = if second_literal {
					vec![QuotePart::Literal(self.pstr(&collapse_backslashes(&second.bytes)))]
				} else { self.interpolate(&second.bytes, second.location, Mode::Replacement).await? };
				RegexKind::Substitute(replacement)
			}
		} else if builtin == Builtin::Qr { RegexKind::Compile }
		else { RegexKind::Match(first.delimiter == u32::from(b'?')) };
		Ok(Expr { location, cache: NodeCache::default(), kind: ExprKind::Regex(RegexExpr { kind, pattern, modifiers }) })
	}

	fn regex_modifiers(&mut self, builtin: Builtin) -> ResultOf<Vec<u8>> {
		let allowed: &[u8] = match builtin {
			Builtin::Tr | Builtin::Y => b"cdsr",
			Builtin::Qr => b"msixpodualn",
			Builtin::Substitute => b"msixpodualngcer",
			_ => b"msixpodualngc",
		};
		let tr = matches!(builtin, Builtin::Tr | Builtin::Y);
		let mut modifiers = Vec::new();
		while let Some(&b) = self.lex.source.get(self.lex.pos) {
			if !b.is_ascii_alphabetic() { break; }
			if !allowed.contains(&b) {
				if tr { break; }
				return Err(self.diagnostic(self.lex.location(), format!("Unknown regexp modifier \"/{}\"", char::from(b))));
			}
			modifiers.push(b);
			self.lex.advance(self.lex.pos + 1);
		}
		self.finish_raw_token();
		Ok(modifiers)
	}

	async fn replacement_block(&mut self, src: &[u8], location: Location) -> ResultOf<Block> {
		let tail = self.lex.heredoc_tail();
		let symbols = std::mem::take(&mut self.symbols);
		let mut child = Parser::new(src, location.file.clone(), location.line, self.pkg.clone(), self.features, self.hooks);
		child.lex.set_heredoc_tail(tail);
		child.file = self.file.clone();
		child.symbols = symbols;
		child.string_eval = self.string_eval;
		child.depth = self.depth;
		child.tree_depth = self.depth;
		let loc = location.clone();
		let result = async {
			child.scope(|inner| Box::pin(async move {
				let stmts = inner.statements(false).await?;
				if inner.peek().kind != Kind::Eof { return Err(inner.error()); }
				Ok(Block { location: loc, stmts })
			})).await
		}.await;
		if let (Some(before), Some(after)) = (tail, child.lex.take_heredoc_tail())
			&& Lexer::heredoc_tail_changed(before, after) {
			self.lex.inherit_heredoc_tail(after);
		}
		self.tree_depth = self.tree_depth.max(child.tree_depth);
		self.symbols = child.symbols;
		self.queued.append(&mut child.queued);
		result
	}

	async fn interpolate(&mut self, bytes: &[u8], location: Location, mode: Mode) -> ResultOf<Vec<QuotePart>> {
		if self.depth >= MAX_DEPTH { return Err(self.depth_error()); }
		self.depth += 1;
		let previous_tree_depth = std::mem::replace(&mut self.tree_depth, self.depth);
		let at = self.depth;
		let result = {
			let child = Box::pin(self.interpolate_inner(bytes, location, mode));
			if at.is_multiple_of(PARSE_DESCEND_EVERY) { crate::deep::descend(child).await } else { child.await }
		};
		self.depth -= 1;
		self.tree_depth = self.tree_depth.max(previous_tree_depth);
		result
	}

	async fn interpolate_inner(&mut self, bytes: &[u8], mut location: Location, mode: Mode) -> ResultOf<Vec<QuotePart>> {
		let start_line = location.line;
		let utf8 = self.lex.utf8;
		let mut parts = Vec::new();
		// Literal text stays bytes unless the source spells a non-ASCII character or an escape
		// exceeds 0xFF: under `use utf8`, "\xFE\x82" is two bytes, as in perl.
		let mut lit = PStr::new(Vec::new(), false);
		let mut at = 0;
		let mut in_class = false;
		let mut class_initial = false;
		let mut posix = None;
		let mut pattern = mode.pattern().then_some(PatternContext { bytes, square: 0, curly: 0 });
		// Here-doc bodies that an interpolated expression read from the following lines.
		let mut bodies: Option<(usize, usize)> = None;
		// Open `\U \L \F \Q` scopes; under `\Q` a pattern's `(?{` is quoted text, not code.
		let mut case_scopes: Vec<CaseChange> = Vec::new();
		while let Some(&b) = bytes.get(at) {
			if let Some((from, to)) = bodies && at >= from {
				bodies = None;
				location.line = add_lines(location.line, &bytes[from.min(at)..to.max(at)]);
				at = at.max(to);
				continue;
			}
			let next = bytes.get(at + 1).copied();
			if mode.pattern() && !in_class {
				let tail = &bytes[at..];
				if tail.starts_with(b"(?#") {
					let end = regex_comment_end(bytes, at + 3);
					append(&mut lit, &bytes[at..end], utf8);
					location.line = add_lines(location.line, &bytes[at..end]);
					at = end;
					continue;
				}
				if matches!(mode, Mode::Pattern { extended: true, .. }) && b == b'#' {
					let end = line_end(bytes, at);
					append(&mut lit, &bytes[at..end], utf8);
					location.line = add_lines(location.line, &bytes[at..end]);
					at = end;
					continue;
				}
				let dynamic = tail.starts_with(b"(??{");
				if (dynamic || tail.starts_with(b"(?{")) && !case_scopes.contains(&CaseChange::Quote) {
					let open = at + if dynamic { 3 } else { 2 };
					// The code starts mid-line: diagnostics quote and count columns from the line start.
					let line_start = bytes[..open].iter().rposition(|&b| b == b'\n').map_or(0, |i| i + 1);
					let tail = self.lex.heredoc_tail();
					let symbols = std::mem::take(&mut self.symbols);
					let mut child = Parser::new(&bytes[line_start..], location.file.clone(), location.line, self.pkg.clone(), self.features, self.hooks);
					child.lex.set_heredoc_tail(tail);
					child.file = self.file.clone();
					child.symbols = symbols;
					child.string_eval = self.string_eval;
					child.depth = self.depth;
					child.tree_depth = self.depth;
					let result = async {
						child.lex.advance(open - line_start);
						let block = child.block().await?;
						child.expect(b")")?;
						Ok((block, child.lex.pos))
					}.await;
					if let (Some(before), Some(after)) = (tail, child.lex.take_heredoc_tail())
						&& Lexer::heredoc_tail_changed(before, after) {
						self.lex.inherit_heredoc_tail(after);
					}
					self.tree_depth = self.tree_depth.max(child.tree_depth);
					self.symbols = child.symbols;
					self.queued.append(&mut child.queued);
					let (block, end) = result?;
					flush(&mut parts, &mut lit);
					let end = line_start + end;
					parts.push(QuotePart::RegexCode(Rc::new(block), dynamic, self.pstr(&bytes[at..end])));
					location.line = add_lines(location.line, &bytes[at..end]);
					at = end;
					continue;
				}
			}
			if b == b'\\' && let Some(escaped) = next {
				let start = at;
				at += 2;
				if mode.interpolates() && let Some(change) = case_escape(escaped) {
					match change {
						CaseChange::End => { case_scopes.pop(); }
						CaseChange::Upper | CaseChange::Lower | CaseChange::Fold | CaseChange::Quote => case_scopes.push(change),
						CaseChange::UpperNext | CaseChange::LowerNext => {}
					}
					// toke.c pops one case modifier per `\E`: `\u\E` applies `\u` to nothing.
					if change == CaseChange::End && lit.is_empty()
						&& matches!(parts.last(), Some(QuotePart::Case(CaseChange::UpperNext | CaseChange::LowerNext)))
					{
						parts.pop();
					} else {
						flush(&mut parts, &mut lit);
						parts.push(QuotePart::Case(change));
					}
				} else if let b'N' = escaped && bytes.get(at) == Some(&b'{')
					// In patterns `\N{3,4}` is a quantified non-newline, and a non-interpolating
					// pattern leaves names to the regex compiler.
					&& !(mode.pattern() && (!mode.interpolates() || quantifier_braces(bytes, at)))
				{
					let (cps, end) = self.char_name(bytes, at).map_err(|msg| self.diagnostic(location.clone(), msg))?;
					at = end;
					if mode.pattern() {
						// `\N{U+...}` keeps perl's Unicode rules for the pattern.
						let hex = cps.iter().map(|cp| format!("{cp:X}")).collect::<Vec<_>>().join(".");
						lit.bytes.extend_from_slice(format!("\\N{{U+{hex}}}").as_bytes());
					} else {
						// perl marks a string holding `\N{...}` as UTF-8 even below 0x100.
						lit.upgrade();
						for cp in cps { lit.push_char(cp); }
					}
				} else if mode.pattern() {
					append(&mut lit, &bytes[start..at], utf8);
				} else if escaped == b'c' && bytes.get(at) == Some(&b'\\') {
					let slashes = bytes[at..].iter().take_while(|&&b| b == b'\\').count();
					at += slashes;
					lit.push_char(28);
					let pairs = (slashes - usize::from(at < bytes.len())) / 2;
					lit.bytes.extend(std::iter::repeat_n(b'\\', pairs));
				} else if mode == Mode::Replacement && matches!(escaped, b'1'..=b'9') && !bytes.get(at).is_some_and(u8::is_ascii_digit) {
					flush(&mut parts, &mut lit);
					let expr = Expr { location: location.clone(), cache: NodeCache::default(), kind: ExprKind::Variable(Sigil::Scalar, char::from(escaped).to_string().into()) };
					parts.push(QuotePart::Expr(expr, false));
				} else {
					let (cp, end) = string_escape(bytes, at, escaped, utf8).map_err(|message| self.diagnostic(location.clone(), message))?;
					at = end;
					lit.push_char(cp);
				}
				location.line = add_lines(location.line, &bytes[start..at]);
				class_initial = false;
				continue;
			}
			if mode.interpolates() && matches!(b, b'$' | b'@') && interpolation_start(bytes, at, utf8, mode.pattern()) {
				let tail = self.lex.heredoc_tail();
				let symbols = std::mem::take(&mut self.symbols);
				let mut child = Parser::new(&bytes[at..], location.file.clone(), location.line, self.pkg.clone(), self.features, self.hooks);
				child.lex.set_heredoc_tail(tail);
				child.file = self.file.clone();
				child.symbols = symbols;
				child.string_eval = self.string_eval;
				child.depth = self.depth;
				child.tree_depth = self.depth;
				let result = async {
					let interpolant = child.interpolant(pattern.as_mut(), at).await?;
					// The code's own line count, which a `#line` directive inside it may reset.
					let line = child.look.is_none().then(|| child.lex.location().line);
					Ok((interpolant, child.lex.pending_heredoc_bodies(), line))
				}.await;
				if let (Some(before), Some(after)) = (tail, child.lex.take_heredoc_tail())
					&& Lexer::heredoc_tail_changed(before, after) {
					self.lex.inherit_heredoc_tail(after);
				}
				self.tree_depth = self.tree_depth.max(child.tree_depth);
				self.symbols = child.symbols;
				self.queued.append(&mut child.queued);
				let ((expression, join, end), pending, line) = result?;
				if let Some((from, to)) = pending { bodies = Some((at + from, at + to)); }
				flush(&mut parts, &mut lit);
				parts.push(QuotePart::Expr(expression, join));
				let end = at + end;
				location.line = line.unwrap_or_else(|| add_lines(location.line, &bytes[at..end]));
				at = end;
				class_initial = false;
				continue;
			}
			if !mode.pattern() && b == b'$' && next.is_none() {
				return Err(self.diagnostic(location, "Final $ should be \\$ or $name".into()));
			}
			if mode.pattern() {
				if !in_class && b == b'[' { in_class = true; class_initial = true; }
				else if in_class {
					if posix.is_none() && b == b'[' && matches!(next, Some(b':' | b'.' | b'=')) { posix = next; }
					else if b == b']' {
						if posix.is_some() && bytes.get(at - 1).copied() == posix { posix = None; }
						else if !class_initial && posix.is_none() { in_class = false; }
					}
					if b != b'^' { class_initial = false; }
				}
			}
			if b == b'\n' { location.line = location.line.saturating_add(1); }
			append(&mut lit, &bytes[at..at + 1], utf8);
			at += 1;
		}
		flush(&mut parts, &mut lit);
		// A `#line` inside interpolated code renumbers the source after the quote too.
		let expected = add_lines(start_line, bytes);
		if location.line != expected {
			self.lex.shift_line(i64::from(location.line) - i64::from(expected));
		}
		Ok(parts)
	}

	async fn interpolant(&mut self, mut pattern: Option<&mut PatternContext<'_>>, offset: usize) -> ResultOf<(Expr, bool, usize)> {
		let source = self.lex.source;
		let mut join = source.first() == Some(&b'@');
		let name_at = if source.starts_with(b"$#") { 2 } else { 1 };
		let braced = source.get(after_space(source, name_at)) == Some(&b'{');
		let mut expr = self.variable(false).await?;
		let utf8 = self.lex.utf8;
		// `${name}` ends the interpolation before a subscript. Only the first subscript of a plain
		// variable is put to the pattern vote: after a block dereference (`${ EXPR }`, `@{[ ... ]}`),
		// an arrow or another subscript toke.c stays in code and always takes `[`/`{`.
		let mut braced_name = braced && !matches!(&expr.kind, ExprKind::Deref(..));
		let mut vote = !braced;
		let slot = match &expr.kind { ExprKind::Variable(sigil, _) | ExprKind::Deref(sigil, _) => *sigil, _ => Sigil::Scalar };
		let mut selected = matches!(&expr.kind, ExprKind::Select(..));
		loop {
			let at = self.lex.pos;
			let tail = source.get(at..).unwrap_or_default();
			if let Some(rest) = tail.strip_prefix(b"->") {
				let slot = self.features.postderef_qq.then(|| postfix_slot(rest)).flatten();
				if !matches!(rest.first(), Some(b'[' | b'{')) && slot.is_none() { break; }
				self.wrap_tree()?;
				let location = self.bump().location;
				expr = self.arrow(expr, location).await?;
				if let Some(sigil) = slot { join = sigil == Sigil::Array; }
				selected = matches!(&expr.kind, ExprKind::Select(..));
				braced_name = false;
				vote = false;
			} else if let Some(open @ (b'[' | b'{')) = tail.first().copied() {
				if braced_name || vote && pattern.as_deref_mut().is_some_and(|p| !p.subscript(offset + at, open, utf8)) { break; }
				vote = false;
				self.wrap_tree()?;
				let select = expr::select_kind(if selected { Sigil::Scalar } else { slot }, &[open], selected);
				expr = self.select(expr, select).await?;
				selected = true;
			} else { break; }
		}
		Ok((expr, join, self.lex.pos))
	}
}

fn quote_value(location: Location, kind: QuoteKind, mut parts: Vec<QuotePart>) -> Expr {
	if kind == QuoteKind::String {
		if parts.is_empty() { return Expr { location, cache: NodeCache::default(), kind: ExprKind::String(PStr::default()) }; }
		if let [QuotePart::Literal(_)] = parts.as_slice() && let Some(QuotePart::Literal(lit)) = parts.pop() {
			return Expr { location, cache: NodeCache::default(), kind: ExprKind::String(lit) };
		}
	}
	Expr { location, cache: NodeCache::default(), kind: ExprKind::Quote(kind, parts) }
}

fn append(lit: &mut PStr, raw: &[u8], source_utf8: bool) {
	if source_utf8 && !raw.is_ascii() {
		lit.upgrade();
		lit.bytes.extend_from_slice(raw);
	} else {
		lit.push_bytes(raw);
	}
}

fn flush(parts: &mut Vec<QuotePart>, lit: &mut PStr) {
	if !lit.is_empty() {
		let mut text = std::mem::replace(lit, PStr::new(Vec::new(), false));
		if text.bytes.is_ascii() { text.utf8 = false; }
		parts.push(QuotePart::Literal(text));
	}
}

fn add_lines(line: u32, bytes: &[u8]) -> u32 {
	line.saturating_add(bytes.iter().filter(|&&b| b == b'\n').count() as u32)
}

fn collapse_backslashes(bytes: &[u8]) -> Vec<u8> {
	let mut result = Vec::with_capacity(bytes.len());
	let mut at = 0;
	while let Some(&b) = bytes.get(at) {
		result.push(b);
		at += if b == b'\\' && bytes.get(at + 1) == Some(&b'\\') { 2 } else { 1 };
	}
	result
}

fn regex_comment_end(bytes: &[u8], mut at: usize) -> usize {
	while let Some(&b) = bytes.get(at) {
		at += 1;
		if b == b')' { break; }
		if b == b'\\' && at < bytes.len() { at += 1; }
	}
	at
}

fn interpolation_start(src: &[u8], at: usize, utf8: bool, regex: bool) -> bool {
	let sigil = src[at];
	let next = src.get(at + 1).copied();
	if regex && matches!((sigil, next), (b'$', None | Some(b'(' | b')' | b'|' | b'\\')) | (b'@', Some(b'+' | b'-'))) { return false; }
	if next == Some(b'{') { return true; }
	if sigil == b'@' && matches!(next, Some(b'$' | b'+' | b'-' | b':')) { return true; }
	if sigil == b'$' && next == Some(b'#') { return true; }
	let start = if next.is_some_and(|b| b.is_ascii_whitespace()) {
		if regex || sigil == b'@' { return false; }
		after_space(src, at + 1)
	} else { at + 1 };
	if sigil == b'@' {
		name_end(src, start, utf8).is_some() || src.get(start) == Some(&b'\'') && name_end(src, start + 1, utf8).is_some()
	} else { variable_end(src, start, utf8, sigil, false).is_some() }
}

fn postfix_slot(tail: &[u8]) -> Option<Sigil> {
	if tail.starts_with(b"$#*") { return Some(Sigil::LastIndex); }
	let slot = expr::sigil(*tail.first()?)?;
	if tail.get(1) == Some(&b'*') && matches!(slot, Sigil::Scalar | Sigil::Array) { return Some(slot); }
	if matches!(tail.get(1), Some(b'[' | b'{')) && slot == Sigil::Array { return Some(slot); }
	None
}

// Perl votes on ambiguous [] in regex interpolation (toke.c's intuit_more): a weight starts at 2,
// variables, subscript-like digits and keywords push it negative (a subscript), while character
// class escapes, ranges and ascending runs push it positive (a character class). Braces
// beginning with a quantifier are not hash lookups.
struct PatternContext<'a> {
	bytes: &'a [u8],
	// Cache closing punctuation as interpolation walks forward. If a pattern's
	// bracket is unclosed, subsequent ambiguous `$x[` prefixes do not rescan it.
	square: usize,
	curly: usize,
}

impl PatternContext<'_> {
	fn subscript(&mut self, at: usize, open: u8, utf8: bool) -> bool {
		let (close, end) = if open == b'{' { (b'}', &mut self.curly) } else { (b']', &mut self.square) };
		if *end <= at {
			*end = self.bytes[at + 1..].iter().position(|&b| b == close).map_or(self.bytes.len(), |i| at + 1 + i);
		}
		if *end == self.bytes.len() { return false; }
		let end = *end;
		let bytes = self.bytes;
		if open == b'{' { return !bytes[at + 1..end].iter().all(|b| b.is_ascii_digit() || *b == b','); }
		let b = |i: usize| bytes.get(i).copied().unwrap_or(0);
		let start = at + 1;
		if matches!(b(start), b']' | b'^') { return false; }
		let mut weight: i32 = 2;
		if b(start) == b'$' {
			weight -= 3;
		} else if b(start).is_ascii_digit() {
			if b(start + 1) == b']' { weight -= 100; }
			else if b(start + 1).is_ascii_digit() && b(start + 2) == b']' { weight -= 10; }
		}
		let mut seen = [0i32; 256];
		let mut un_char: u8 = 255;
		let mut i = start;
		while i < end {
			let last_un_char = un_char;
			un_char = b(i);
			match un_char {
				b'@' | b'&' | b'$' => {
					weight -= seen[usize::from(un_char)] * 10;
					if ident_unit(bytes, i + 1, utf8, true).is_some() {
						// perl subtracts 100 for an existing multi-character global; without the
						// symbol table at this point every named variable counts as unknown.
						weight -= 10;
					} else if un_char == b'$' && b(i + 1) != 0 && b"[#!%*<>()-=".contains(&b(i + 1)) {
						weight -= if b"])} =".contains(&b(i + 2)) { 10 } else { 1 };
					}
				}
				b'\\' => {
					un_char = 254;
					let next = b(i + 1);
					if next == 0 { weight += 100; }
					else if b"wds]".contains(&next) { weight += 100; }
					else if seen[usize::from(b'\'')] != 0 || seen[usize::from(b'"')] != 0 { weight += 1; }
					else if b"rnftbxcav".contains(&next) { weight += 40; }
					else if next.is_ascii_digit() {
						weight += 40;
						while b(i + 1).is_ascii_digit() { i += 1; }
					}
				}
				b'-' => {
					if b(i + 1) == b'\\' { weight += 50; }
					if b"aA01! ".contains(&last_un_char) { weight += 30; }
					if b"zZ79~".contains(&b(i + 1)) { weight += 30; }
					if last_un_char == 255 && (b(i + 1).is_ascii_digit() || b(i + 1) == b'$') { weight -= 5; }
				}
				_ => {
					if !(last_un_char.is_ascii_alphanumeric() || last_un_char == b'_') && !matches!(last_un_char, b'$' | b'@' | b'&')
						&& un_char.is_ascii_alphabetic() && b(i + 1).is_ascii_alphabetic()
					{
						let word = i;
						while b(i).is_ascii_alphabetic() { i += 1; }
						if perl_keyword(&bytes[word..i]) { weight -= 150; }
					}
					if u16::from(un_char) == u16::from(last_un_char) + 1 { weight += 5; }
					weight -= seen[usize::from(un_char)];
				}
			}
			seen[usize::from(un_char)] += 1;
			i += 1;
		}
		weight < 0
	}
}

/// Words toke.c's `keyword()` recognizes, for intuit_more's character-class vote.
fn perl_keyword(word: &[u8]) -> bool {
	std::str::from_utf8(word).is_ok_and(|w| Builtin::from_name(w).is_some()) || matches!(word,
		b"if" | b"else" | b"elsif" | b"unless" | b"while" | b"until" | b"for" | b"foreach" | b"and" | b"or" | b"xor" | b"not"
		| b"eq" | b"ne" | b"lt" | b"le" | b"gt" | b"ge" | b"cmp" | b"x" | b"return" | b"given" | b"when" | b"default"
		| b"BEGIN" | b"END" | b"INIT" | b"CHECK" | b"UNITCHECK" | b"DESTROY" | b"AUTOLOAD" | b"isa" | b"__DATA__" | b"__END__")
}

fn case_escape(b: u8) -> Option<CaseChange> {
	Some(match b {
		b'U' => CaseChange::Upper, b'L' => CaseChange::Lower, b'u' => CaseChange::UpperNext,
		b'l' => CaseChange::LowerNext, b'Q' => CaseChange::Quote, b'F' => CaseChange::Fold, b'E' => CaseChange::End,
		_ => return None,
	})
}

fn string_escape(src: &[u8], at: usize, escaped: u8, utf8: bool) -> Result<(u32, usize), String> {
	let mut end = at;
	let cp = match escaped {
		b'n' => 10, b'r' => 13, b't' => 9, b'f' => 12, b'b' => 8, b'a' => 7, b'e' => 27,
		b'c' => {
			let Some(&c) = src.get(end) else { return Err("Missing control char name in \\c".into()) };
			if !(b' '..=b'~').contains(&c) { return Err("Character following \\c must be printable ASCII".into()); }
			end += 1;
			if c == b'{' { return Err("Use \";\" instead of \"\\c{\"".into()); }
			u32::from(c.to_ascii_uppercase() ^ 0x40)
		}
		b'x' => {
			if src.get(end) == Some(&b'{') { return braced_escape(src, end, 16); }
			let (n, consumed) = escape_digits(&src[end..], 16, 2).ok_or_else(|| "Hexadecimal number in \\x escape overflows".to_string())?;
			end += consumed;
			n
		}
		b'o' => {
			if src.get(end) == Some(&b'{') { return braced_escape(src, end, 8); }
			return Err("Missing braces on \\o{}".into());
		}
		b'0'..=b'7' => {
			let (n, consumed) = escape_digits(&src[end - 1..], 8, 3).ok_or_else(|| "Octal number in escape overflows".to_string())?;
			end += consumed - 1;
			n
		}
		b'N' => return Err("Missing braces on \\N{}".into()),
		_ => {
			let (cp, width) = unit(src, end - 1, utf8).unwrap_or((u32::from(escaped), 1));
			end += width - 1;
			cp
		}
	};
	Ok((cp, end))
}

fn braced_escape(src: &[u8], begin: usize, radix: u32) -> Result<(u32, usize), String> {
	let end = src[begin + 1..].iter().position(|&b| b == b'}').map(|offset| begin + 1 + offset)
		.ok_or_else(|| format!("Missing right brace on \\{}{{}}", if radix == 16 { 'x' } else { 'o' }))?;
	let digits = src[begin + 1..end].trim_ascii();
	if radix == 8 && digits.is_empty() { return Err("Empty \\o{}".into()); }
	let (cp, _) = escape_digits(digits, radix, usize::MAX).ok_or_else(|| "Character code in escape overflows".to_string())?;
	Ok((cp, end + 1))
}

fn escape_digits(digits: &[u8], radix: u32, limit: usize) -> Option<(u32, usize)> {
	let mut value = 0u32;
	let mut n = 0;
	for &b in digits.iter().take(limit) {
		if b == b'_' && limit == usize::MAX { n += 1; continue; }
		let Some(d) = char::from(b).to_digit(radix) else { break; };
		value = value.checked_mul(radix)?.checked_add(d)?;
		n += 1;
	}
	Some((value, n))
}

/// Whether `{...}` at `open` holds a regex quantifier (digits, commas and spaces, with a digit).
fn quantifier_braces(src: &[u8], open: usize) -> bool {
	let Some(len) = src[open + 1..].iter().position(|&b| b == b'}') else { return false };
	let inner = &src[open + 1..open + 1 + len];
	inner.iter().all(|&b| b.is_ascii_digit() || b == b',' || b == b' ') && inner.iter().any(u8::is_ascii_digit)
}

fn char_name(src: &[u8], open: usize) -> Result<(Vec<u32>, usize), String> {
	let end = src[open + 1..].iter().position(|&b| b == b'}').map(|offset| open + 1 + offset)
		.ok_or_else(|| "Missing right brace on \\N{}".to_string())?;
	let raw = src[open + 1..end].trim_ascii();
	if let Some(nums) = raw.strip_prefix(b"U+") {
		let cps = nums.split(|&b| b == b'.').map(|part| {
			let (cp, used) = escape_digits(part, 16, usize::MAX)?;
			(used == part.len() && part.iter().any(u8::is_ascii_hexdigit)).then_some(cp)
		}).collect::<Option<Vec<_>>>().ok_or_else(|| "Invalid hexadecimal number in \\N{U+...}".to_string())?;
		return Ok((cps, end + 1));
	}
	if let Some(cp) = std::str::from_utf8(raw).ok().and_then(crate::perl::charnames::character) {
		return Ok((vec![cp], end + 1));
	}
	Err(format!("Unknown charname '{}'", String::from_utf8_lossy(raw)))
}
