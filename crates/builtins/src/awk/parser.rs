//! Recursive-descent AWK parser, ported from GoAWK's `parser` package.
//!
//! `print` arguments use a parallel set of precedence levels that leave out
//! `>` and `cmd | getline`, so `print a > "file"` is a redirection.

use std::rc::Rc;

use super::{
	ast::{
		Action, ArrayRef, BinOp, Expr, Function, GetlineSrc, Pattern, Program, Redirect, ScalarRef, Slot, Stmt,
		Stmts, UnOp,
	},
	lexer::{Func, Lexer, Pos, Tok},
	regex::AwkRegex,
};

/// A syntax (or resolution) error at a source position.
#[derive(Debug)]
pub(super) struct ParseError {
	pub pos:     Pos,
	pub message: String,
}

type PResult<T> = Result<T, ParseError>;

/// A precedence level, so levels can be shared by `expr` and `print_expr`.
type Level<'a> = fn(&mut Parser<'a>) -> PResult<Expr>;

/// Parses a whole program (unresolved).
pub(super) fn parse(src: &[u8]) -> PResult<Program> {
	let mut parser = Parser {
		lexer:        Lexer::new(src),
		pos:          Pos::default(),
		tok:          Tok::Illegal,
		prev_tok:     Tok::Illegal,
		val:          Vec::new(),
		in_action:    false,
		in_function:  false,
		loop_depth:   0,
		pending_left: None,
		multis:       Vec::new(),
		next_multi:   0,
	};
	parser.next()?;
	parser.program()
}

struct Parser<'a> {
	lexer:        Lexer<'a>,
	pos:          Pos,
	tok:          Tok,
	prev_tok:     Tok,
	val:          Vec<u8>,
	in_action:    bool,
	in_function:  bool,
	loop_depth:   usize,
	/// The command to the left of a pending `| getline`.
	pending_left: Option<Expr>,
	/// Comma lists not yet consumed by `print (a, b)`.
	multis:       Vec<(usize, Pos)>,
	next_multi:   usize,
}

fn make_assign(left: Expr, op: Tok, right: Expr) -> Expr {
	let op = match op {
		Tok::AddAssign => BinOp::Add,
		Tok::SubAssign => BinOp::Sub,
		Tok::MulAssign => BinOp::Mul,
		Tok::DivAssign => BinOp::Div,
		Tok::ModAssign => BinOp::Mod,
		Tok::PowAssign => BinOp::Pow,
		_ => return Expr::Assign(Box::new(left), Box::new(right)),
	};
	Expr::AugAssign(Box::new(left), op, Box::new(right))
}

impl<'a> Parser<'a> {
	fn error_at(pos: Pos, message: impl Into<String>) -> ParseError {
		ParseError { pos, message: message.into() }
	}

	fn error(&self, message: impl Into<String>) -> ParseError {
		Self::error_at(self.pos, message)
	}

	fn next(&mut self) -> PResult<()> {
		self.prev_tok = self.tok;
		let token = self.lexer.scan();
		self.pos = token.pos;
		self.tok = token.tok;
		self.val = token.val;
		if self.tok == Tok::Illegal {
			return Err(self.error(String::from_utf8_lossy(&self.val).into_owned()));
		}
		Ok(())
	}

	fn matches(&self, toks: &[Tok]) -> bool {
		toks.contains(&self.tok)
	}

	fn expect(&mut self, tok: Tok) -> PResult<()> {
		if self.tok != tok {
			return Err(self.error(format!("expected {tok} instead of {}", self.tok)));
		}
		self.next()
	}

	fn expect_name(&mut self) -> PResult<(Rc<str>, Pos)> {
		let name: Rc<str> = Rc::from(String::from_utf8_lossy(&self.val).as_ref());
		let pos = self.pos;
		self.expect(Tok::Name)?;
		Ok((name, pos))
	}

	fn optional_newlines(&mut self) -> PResult<()> {
		while self.tok == Tok::Newline {
			self.next()?;
		}
		Ok(())
	}

	fn comma_newlines(&mut self) -> PResult<()> {
		self.expect(Tok::Comma)?;
		self.optional_newlines()
	}

	fn program(&mut self) -> PResult<Program> {
		let mut prog = Program {
			begin:     Vec::new(),
			actions:   Vec::new(),
			end:       Vec::new(),
			functions: Vec::new(),
			scalars:   Vec::new(),
			arrays:    Vec::new(),
		};
		let mut needs_terminator = false;
		while self.tok != Tok::Eof {
			if needs_terminator {
				if !self.matches(&[Tok::Newline, Tok::Semicolon]) {
					return Err(self.error("expected ; or newline between items"));
				}
				self.next()?;
				needs_terminator = false;
			}
			self.optional_newlines()?;
			match self.tok {
				Tok::Eof => {},
				Tok::Begin => {
					self.next()?;
					prog.begin.push(self.stmts_brace()?);
				},
				Tok::End => {
					self.next()?;
					prog.end.push(self.stmts_brace()?);
				},
				Tok::Function => prog.functions.push(self.function()?),
				_ => {
					self.in_action = true;
					let mut pattern = Pattern::All;
					if !self.matches(&[Tok::LBrace, Tok::Eof]) {
						let first = self.expr()?;
						pattern = if self.matches(&[Tok::LBrace, Tok::Eof, Tok::Newline, Tok::Semicolon]) {
							Pattern::Expr(first)
						} else {
							self.comma_newlines()?;
							Pattern::Range(first, self.expr()?)
						};
					}
					let body = if self.tok == Tok::LBrace {
						Some(self.stmts_brace()?)
					} else {
						needs_terminator = true;
						None
					};
					prog.actions.push(Action { pattern, body });
					self.in_action = false;
				},
			}
		}
		if let Some(&(_, pos)) = self.multis.iter().min_by_key(|(_, pos)| (pos.line, pos.col)) {
			return Err(Self::error_at(pos, "unexpected comma-separated expression"));
		}
		Ok(prog)
	}

	fn stmts(&mut self) -> PResult<Stmts> {
		match self.tok {
			Tok::Semicolon => {
				self.next()?;
				Ok(Vec::new())
			},
			Tok::LBrace => self.stmts_brace(),
			_ => Ok(vec![self.stmt()?]),
		}
	}

	fn stmts_brace(&mut self) -> PResult<Stmts> {
		self.expect(Tok::LBrace)?;
		self.optional_newlines()?;
		let mut stmts = Vec::new();
		while self.tok != Tok::RBrace && self.tok != Tok::Eof {
			if self.matches(&[Tok::Semicolon, Tok::Newline]) {
				self.next()?;
				continue;
			}
			stmts.push(self.stmt()?);
		}
		self.expect(Tok::RBrace)?;
		if self.tok == Tok::Semicolon {
			self.next()?;
		}
		Ok(stmts)
	}

	fn loop_stmts(&mut self) -> PResult<Stmts> {
		self.loop_depth += 1;
		let stmts = self.stmts();
		self.loop_depth -= 1;
		stmts
	}

	fn simple_stmt(&mut self) -> PResult<Stmt> {
		match self.tok {
			Tok::Print | Tok::Printf => {
				let op = self.tok;
				self.next()?;
				let mut args = self.expr_list(Self::print_expr)?;
				if args.len() == 1 && matches!(args[0], Expr::Multi(..)) {
					if let Some(Expr::Multi(exprs, id)) = args.pop() {
						self.multis.retain(|(multi, _)| *multi != id);
						args = exprs;
					}
				}
				let redirect = match self.tok {
					Tok::Greater | Tok::Append | Tok::Pipe => {
						let redirect = match self.tok {
							Tok::Greater => Redirect::Write,
							Tok::Append => Redirect::Append,
							_ => Redirect::Pipe,
						};
						self.next()?;
						Some((redirect, self.expr()?))
					},
					_ => None,
				};
				if op == Tok::Print {
					Ok(Stmt::Print { args, redirect })
				} else {
					if args.is_empty() {
						return Err(self.error("expected printf args, got none"));
					}
					Ok(Stmt::Printf { args, redirect })
				}
			},
			Tok::Delete => {
				self.next()?;
				let (name, pos) = self.expect_name()?;
				let mut index = None;
				if self.tok == Tok::LBracket {
					self.next()?;
					let exprs = self.expr_list(Self::expr)?;
					if exprs.is_empty() {
						return Err(self.error("expected expression instead of ]"));
					}
					self.expect(Tok::RBracket)?;
					index = Some(exprs);
				}
				Ok(Stmt::Delete { array: ArrayRef::new(name, pos), index })
			},
			Tok::If
			| Tok::For
			| Tok::While
			| Tok::Do
			| Tok::Break
			| Tok::Continue
			| Tok::Next
			| Tok::Nextfile
			| Tok::Exit
			| Tok::Return => Err(self.error("expected print/printf, delete, or expression")),
			_ => Ok(Stmt::Expr(self.expr()?)),
		}
	}

	fn stmt(&mut self) -> PResult<Stmt> {
		let stmt = match self.tok {
			Tok::If => {
				self.next()?;
				self.expect(Tok::LParen)?;
				let cond = self.expr()?;
				self.expect(Tok::RParen)?;
				self.optional_newlines()?;
				let body = self.stmts()?;
				self.optional_newlines()?;
				let mut els = Vec::new();
				if self.tok == Tok::Else {
					self.next()?;
					self.optional_newlines()?;
					els = self.stmts()?;
				}
				Stmt::If { cond, body, els }
			},
			Tok::For => {
				self.next()?;
				self.expect(Tok::LParen)?;
				let pre = if self.tok == Tok::Semicolon { None } else { Some(self.simple_stmt()?) };
				match pre {
					Some(pre) if self.tok == Tok::RParen => {
						self.next()?;
						self.optional_newlines()?;
						let bad = || Self::error_at(self.pos, "expected 'for (var in array) ...'");
						let Stmt::Expr(Expr::In(mut index, array)) = pre else {
							return Err(bad());
						};
						if index.len() != 1 {
							return Err(bad());
						}
						let Some(Expr::Var(var)) = index.pop() else {
							return Err(bad());
						};
						let body = self.loop_stmts()?;
						Stmt::ForIn { var, array, body }
					},
					pre => {
						self.expect(Tok::Semicolon)?;
						self.optional_newlines()?;
						let cond = if self.tok == Tok::Semicolon { None } else { Some(self.expr()?) };
						self.expect(Tok::Semicolon)?;
						self.optional_newlines()?;
						let post = if self.tok == Tok::RParen { None } else { Some(Box::new(self.simple_stmt()?)) };
						self.expect(Tok::RParen)?;
						self.optional_newlines()?;
						let body = self.loop_stmts()?;
						Stmt::For { pre: pre.map(Box::new), cond, post, body }
					},
				}
			},
			Tok::While => {
				self.next()?;
				self.expect(Tok::LParen)?;
				let cond = self.expr()?;
				self.expect(Tok::RParen)?;
				self.optional_newlines()?;
				let body = self.loop_stmts()?;
				Stmt::While { cond, body }
			},
			Tok::Do => {
				self.next()?;
				self.optional_newlines()?;
				let body = self.loop_stmts()?;
				self.optional_newlines()?;
				self.expect(Tok::While)?;
				self.expect(Tok::LParen)?;
				let cond = self.expr()?;
				self.expect(Tok::RParen)?;
				Stmt::DoWhile { body, cond }
			},
			Tok::Break | Tok::Continue => {
				let tok = self.tok;
				if self.loop_depth == 0 {
					return Err(self.error(format!("{tok} must be inside a loop body")));
				}
				self.next()?;
				if tok == Tok::Break { Stmt::Break } else { Stmt::Continue }
			},
			Tok::Next | Tok::Nextfile => {
				let tok = self.tok;
				if !self.in_action && !self.in_function {
					return Err(self.error(format!("{tok} can't be inside BEGIN or END")));
				}
				self.next()?;
				if tok == Tok::Next { Stmt::Next } else { Stmt::NextFile }
			},
			Tok::Exit => {
				self.next()?;
				let status = if self.matches(&[Tok::Newline, Tok::Semicolon, Tok::RBrace]) {
					None
				} else {
					Some(self.expr()?)
				};
				Stmt::Exit(status)
			},
			Tok::Return => {
				if !self.in_function {
					return Err(self.error("return must be inside a function"));
				}
				self.next()?;
				let value = if self.matches(&[Tok::Newline, Tok::Semicolon, Tok::RBrace]) {
					None
				} else {
					Some(self.expr()?)
				};
				Stmt::Return(value)
			},
			Tok::LBrace => Stmt::Block(self.stmts_brace()?),
			_ => self.simple_stmt()?,
		};
		if !self.matches(&[Tok::Newline, Tok::Semicolon, Tok::RBrace])
			&& !matches!(self.prev_tok, Tok::Newline | Tok::Semicolon | Tok::RBrace)
		{
			return Err(self.error("expected ; or newline between statements"));
		}
		while self.matches(&[Tok::Newline, Tok::Semicolon]) {
			self.next()?;
		}
		Ok(stmt)
	}

	fn function(&mut self) -> PResult<Function> {
		if self.in_function {
			return Err(self.error("can't nest functions"));
		}
		self.next()?;
		let (name, pos) = self.expect_name()?;
		self.expect(Tok::LParen)?;
		let mut params: Vec<Rc<str>> = Vec::new();
		let mut first = true;
		while self.tok != Tok::RParen {
			if !first {
				self.comma_newlines()?;
			}
			first = false;
			let param = String::from_utf8_lossy(&self.val).into_owned();
			if self.tok == Tok::Name {
				if *param == *name {
					return Err(self.error("can't use function name as parameter name"));
				}
				if params.iter().any(|p| **p == *param) {
					return Err(self.error(format!("duplicate parameter name {param:?}")));
				}
			}
			self.expect(Tok::Name)?;
			params.push(Rc::from(param));
		}
		self.expect(Tok::RParen)?;
		self.optional_newlines()?;
		self.in_function = true;
		let body = self.stmts_brace();
		self.in_function = false;
		Ok(Function { name, params, pos, body: body?, kinds: Vec::new() })
	}

	/// Comma-separated expressions: `print` arguments, call arguments,
	/// multi-dimensional subscripts.
	fn expr_list(&mut self, parse: Level<'a>) -> PResult<Vec<Expr>> {
		let mut exprs = Vec::new();
		let mut first = true;
		while !self.matches(&[
			Tok::Newline,
			Tok::Semicolon,
			Tok::RBrace,
			Tok::RBracket,
			Tok::RParen,
			Tok::Greater,
			Tok::Pipe,
			Tok::Append,
		]) {
			if !first {
				self.comma_newlines()?;
			}
			first = false;
			exprs.push(parse(self)?);
		}
		Ok(exprs)
	}

	fn expr(&mut self) -> PResult<Expr> {
		self.assign(Self::getline)
	}

	fn print_expr(&mut self) -> PResult<Expr> {
		self.assign(Self::print_cond)
	}

	/// `cond [| getline [lvalue]]`
	fn getline(&mut self) -> PResult<Expr> {
		self.pending_left = None;
		let left = self.cond()?;
		if self.tok == Tok::Pipe {
			self.pending_left = Some(left);
			return self.cond();
		}
		Ok(left)
	}

	fn assign(&mut self, higher: Level<'a>) -> PResult<Expr> {
		let left_pos = self.pos;
		let expr = higher(self)?;
		if !self.matches(&[
			Tok::Assign,
			Tok::AddAssign,
			Tok::DivAssign,
			Tok::ModAssign,
			Tok::MulAssign,
			Tok::PowAssign,
			Tok::SubAssign,
		]) {
			return Ok(expr);
		}
		let op = self.tok;
		self.next()?;
		let right = self.assign(higher)?;
		if expr.is_lvalue() {
			return Ok(make_assign(expr, op, right));
		}
		// "1 && x=1": onetrue-awk, gawk and mawk accept an assignment as the
		// right operand of logical, match and comparison operators.
		match expr {
			Expr::Binary(l, bin, r)
				if r.is_lvalue()
					&& matches!(bin, BinOp::Eq | BinOp::Ne | BinOp::Lt | BinOp::Le | BinOp::Gt | BinOp::Ge) =>
			{
				Ok(Expr::Binary(l, bin, Box::new(make_assign(*r, op, right))))
			},
			Expr::And(l, r) if r.is_lvalue() => Ok(Expr::And(l, Box::new(make_assign(*r, op, right)))),
			Expr::Or(l, r) if r.is_lvalue() => Ok(Expr::Or(l, Box::new(make_assign(*r, op, right)))),
			Expr::Match(l, negate, r) if r.is_lvalue() => {
				Ok(Expr::Match(l, negate, Box::new(make_assign(*r, op, right))))
			},
			_ => Err(Self::error_at(left_pos, format!("expected lvalue before {op}"))),
		}
	}

	fn cond(&mut self) -> PResult<Expr> {
		self.ternary(Self::or)
	}

	fn print_cond(&mut self) -> PResult<Expr> {
		self.ternary(Self::print_or)
	}

	fn ternary(&mut self, higher: Level<'a>) -> PResult<Expr> {
		let expr = higher(self)?;
		if self.tok != Tok::Question {
			return Ok(expr);
		}
		self.next()?;
		self.optional_newlines()?;
		let yes = self.expr()?;
		self.expect(Tok::Colon)?;
		self.optional_newlines()?;
		let no = self.expr()?;
		Ok(Expr::Cond(Box::new(expr), Box::new(yes), Box::new(no)))
	}

	fn or(&mut self) -> PResult<Expr> {
		self.logical(Self::and, Tok::Or)
	}

	fn print_or(&mut self) -> PResult<Expr> {
		self.logical(Self::print_and, Tok::Or)
	}

	fn and(&mut self) -> PResult<Expr> {
		self.logical(Self::in_, Tok::And)
	}

	fn print_and(&mut self) -> PResult<Expr> {
		self.logical(Self::print_in, Tok::And)
	}

	fn logical(&mut self, higher: Level<'a>, op: Tok) -> PResult<Expr> {
		let mut expr = higher(self)?;
		while self.tok == op {
			self.next()?;
			self.optional_newlines()?;
			let right = higher(self)?;
			expr = if op == Tok::Or {
				Expr::Or(Box::new(expr), Box::new(right))
			} else {
				Expr::And(Box::new(expr), Box::new(right))
			};
		}
		Ok(expr)
	}

	fn in_(&mut self) -> PResult<Expr> {
		self.in_level(Self::match_)
	}

	fn print_in(&mut self) -> PResult<Expr> {
		self.in_level(Self::print_match)
	}

	fn in_level(&mut self, higher: Level<'a>) -> PResult<Expr> {
		let mut expr = higher(self)?;
		while self.tok == Tok::In {
			self.next()?;
			let (name, pos) = self.expect_name()?;
			expr = Expr::In(vec![expr], ArrayRef::new(name, pos));
		}
		Ok(expr)
	}

	fn match_(&mut self) -> PResult<Expr> {
		self.match_level(Self::compare)
	}

	fn print_match(&mut self) -> PResult<Expr> {
		self.match_level(Self::print_compare)
	}

	fn match_level(&mut self, higher: Level<'a>) -> PResult<Expr> {
		let expr = higher(self)?;
		if !self.matches(&[Tok::Match, Tok::NotMatch]) {
			return Ok(expr);
		}
		let negate = self.tok == Tok::NotMatch;
		self.next()?;
		let right = self.regex_str(higher)?;
		Ok(Expr::Match(Box::new(expr), negate, Box::new(right)))
	}

	fn compare(&mut self) -> PResult<Expr> {
		self.compare_level(&[Tok::Equals, Tok::NotEquals, Tok::Less, Tok::Lte, Tok::Gte, Tok::Greater])
	}

	fn print_compare(&mut self) -> PResult<Expr> {
		self.compare_level(&[Tok::Equals, Tok::NotEquals, Tok::Less, Tok::Lte, Tok::Gte])
	}

	fn compare_level(&mut self, ops: &[Tok]) -> PResult<Expr> {
		let expr = self.concat()?;
		if !self.matches(ops) {
			return Ok(expr);
		}
		let op = match self.tok {
			Tok::Equals => BinOp::Eq,
			Tok::NotEquals => BinOp::Ne,
			Tok::Less => BinOp::Lt,
			Tok::Lte => BinOp::Le,
			Tok::Gte => BinOp::Ge,
			_ => BinOp::Gt,
		};
		self.next()?;
		let right = self.concat()?;
		Ok(Expr::Binary(Box::new(expr), op, Box::new(right)))
	}

	fn concat(&mut self) -> PResult<Expr> {
		let mut expr = self.add()?;
		while self.matches(&[
			Tok::Dollar,
			Tok::Not,
			Tok::Name,
			Tok::Number,
			Tok::Str,
			Tok::LParen,
			Tok::Incr,
			Tok::Decr,
		]) || matches!(self.tok, Tok::Builtin(_))
		{
			let right = self.add()?;
			expr = Expr::Binary(Box::new(expr), BinOp::Concat, Box::new(right));
		}
		Ok(expr)
	}

	fn binary_left(&mut self, higher: Level<'a>, ops: &[(Tok, BinOp)]) -> PResult<Expr> {
		let mut expr = higher(self)?;
		while let Some(&(_, op)) = ops.iter().find(|(tok, _)| *tok == self.tok) {
			self.next()?;
			let right = higher(self)?;
			expr = Expr::Binary(Box::new(expr), op, Box::new(right));
		}
		Ok(expr)
	}

	fn add(&mut self) -> PResult<Expr> {
		self.binary_left(Self::mul, &[(Tok::Add, BinOp::Add), (Tok::Sub, BinOp::Sub)])
	}

	fn mul(&mut self) -> PResult<Expr> {
		self.binary_left(Self::pow, &[(Tok::Mul, BinOp::Mul), (Tok::Div, BinOp::Div), (Tok::Mod, BinOp::Mod)])
	}

	fn pow(&mut self) -> PResult<Expr> {
		let expr = self.post_incr()?;
		if self.tok != Tok::Pow {
			return Ok(expr);
		}
		self.next()?;
		let right = self.pow()?;
		Ok(Expr::Binary(Box::new(expr), BinOp::Pow, Box::new(right)))
	}

	fn post_incr(&mut self) -> PResult<Expr> {
		let expr = self.primary()?;
		if matches!(self.tok, Tok::Incr | Tok::Decr) && expr.is_lvalue() {
			let decr = self.tok == Tok::Decr;
			self.next()?;
			return Ok(Expr::Incr { target: Box::new(expr), decr, pre: false });
		}
		Ok(expr)
	}

	fn index_or_var(&mut self, name: Rc<str>, pos: Pos) -> PResult<Expr> {
		if self.tok == Tok::LBracket {
			self.next()?;
			let index = self.expr_list(Self::expr)?;
			if index.is_empty() {
				return Err(self.error("expected expression instead of ]"));
			}
			self.expect(Tok::RBracket)?;
			return Ok(Expr::Index(ArrayRef::new(name, pos), index));
		}
		Ok(Expr::Var(ScalarRef { name, pos, slot: Slot::Unresolved }))
	}

	fn primary(&mut self) -> PResult<Expr> {
		if let Some(left) = self.pending_left.take() {
			self.expect(Tok::Pipe)?;
			self.expect(Tok::Getline)?;
			let target = self.optional_lvalue()?.map(Box::new);
			return Ok(Expr::Getline { src: GetlineSrc::Command, target, from: Some(Box::new(left)) });
		}
		match self.tok {
			Tok::Number => {
				let text = String::from_utf8_lossy(&self.val);
				let n = text.trim_end_matches(['e', 'E']).parse().unwrap_or(0.0);
				self.next()?;
				Ok(Expr::Num(n))
			},
			Tok::Str => {
				let s = Rc::from(std::mem::take(&mut self.val));
				self.next()?;
				Ok(Expr::Str(s))
			},
			Tok::Div | Tok::DivAssign => {
				let (regex, _) = self.next_regex()?;
				Ok(Expr::RegexMatch(regex))
			},
			Tok::Dollar => {
				self.next()?;
				let mut expr = Expr::Field(Box::new(self.primary()?));
				if matches!(self.tok, Tok::Incr | Tok::Decr) {
					let decr = self.tok == Tok::Decr;
					self.next()?;
					expr = Expr::Incr { target: Box::new(expr), decr, pre: false };
				}
				Ok(expr)
			},
			Tok::Not | Tok::Add | Tok::Sub => {
				let op = match self.tok {
					Tok::Not => UnOp::Not,
					Tok::Add => UnOp::Plus,
					_ => UnOp::Neg,
				};
				self.next()?;
				Ok(Expr::Unary(op, Box::new(self.pow()?)))
			},
			Tok::Incr | Tok::Decr => {
				let op = self.tok;
				let decr = op == Tok::Decr;
				self.next()?;
				let pos = self.pos;
				let Some(target) = self.optional_lvalue()? else {
					return Err(Self::error_at(pos, format!("expected lvalue after {op}")));
				};
				Ok(Expr::Incr { target: Box::new(target), decr, pre: true })
			},
			Tok::Name => {
				let (name, pos) = self.expect_name()?;
				if self.tok == Tok::LParen && !self.lexer.had_space() {
					return self.user_call(name, pos);
				}
				self.index_or_var(name, pos)
			},
			Tok::LParen => {
				let paren_pos = self.pos;
				self.next()?;
				let mut exprs = self.expr_list(Self::expr)?;
				match exprs.len() {
					0 => Err(self.error(format!("expected expression, not {}", self.tok))),
					1 => {
						self.expect(Tok::RParen)?;
						Ok(Expr::Group(Box::new(exprs.pop().unwrap_or(Expr::Num(0.0)))))
					},
					_ => {
						self.expect(Tok::RParen)?;
						if self.tok == Tok::In {
							self.next()?;
							let (name, pos) = self.expect_name()?;
							return Ok(Expr::In(exprs, ArrayRef::new(name, pos)));
						}
						let id = self.next_multi;
						self.next_multi += 1;
						self.multis.push((id, paren_pos));
						Ok(Expr::Multi(exprs, id))
					},
				}
			},
			Tok::Getline => {
				self.next()?;
				let target = self.optional_lvalue()?.map(Box::new);
				if self.tok == Tok::Less {
					self.next()?;
					let from = self.primary()?;
					return Ok(Expr::Getline { src: GetlineSrc::File, target, from: Some(Box::new(from)) });
				}
				Ok(Expr::Getline { src: GetlineSrc::Main, target, from: None })
			},
			Tok::Builtin(func) => self.builtin(func),
			tok => Err(self.error(format!("expected expression instead of {tok}"))),
		}
	}

	fn builtin(&mut self, func: Func) -> PResult<Expr> {
		self.next()?;
		match func {
			Func::Sub | Func::Gsub => {
				self.expect(Tok::LParen)?;
				let regex = self.regex_str(Self::expr)?;
				self.comma_newlines()?;
				let repl = self.expr()?;
				let mut args = vec![regex, repl];
				if self.tok == Tok::Comma {
					self.comma_newlines()?;
					let pos = self.pos;
					let target = self.expr()?;
					if !target.is_lvalue() {
						return Err(Self::error_at(pos, "3rd arg to sub/gsub must be lvalue"));
					}
					args.push(target);
				}
				self.expect(Tok::RParen)?;
				Ok(Expr::Call(func, args))
			},
			Func::Split => {
				self.expect(Tok::LParen)?;
				let s = self.expr()?;
				self.comma_newlines()?;
				let (name, pos) = self.expect_name()?;
				let mut sep = None;
				if self.tok == Tok::Comma {
					self.comma_newlines()?;
					sep = Some(Box::new(self.regex_str(Self::expr)?));
				}
				self.expect(Tok::RParen)?;
				Ok(Expr::Split(Box::new(s), ArrayRef::new(name, pos), sep))
			},
			Func::Match => {
				self.expect(Tok::LParen)?;
				let s = self.expr()?;
				self.comma_newlines()?;
				let regex = self.regex_str(Self::expr)?;
				self.expect(Tok::RParen)?;
				Ok(Expr::Call(func, vec![s, regex]))
			},
			Func::Rand | Func::Systime => {
				self.expect(Tok::LParen)?;
				self.expect(Tok::RParen)?;
				Ok(Expr::Call(func, Vec::new()))
			},
			Func::Srand | Func::Fflush => {
				self.expect(Tok::LParen)?;
				let mut args = Vec::new();
				if self.tok != Tok::RParen {
					args.push(self.expr()?);
				}
				self.expect(Tok::RParen)?;
				Ok(Expr::Call(func, args))
			},
			Func::Length => {
				let mut args = Vec::new();
				if self.tok == Tok::LParen {
					self.next()?;
					if self.tok != Tok::RParen {
						args.push(self.expr()?);
					}
					self.expect(Tok::RParen)?;
				}
				Ok(Expr::Call(func, args))
			},
			Func::Substr => {
				self.expect(Tok::LParen)?;
				let s = self.expr()?;
				self.comma_newlines()?;
				let start = self.expr()?;
				let mut args = vec![s, start];
				if self.tok == Tok::Comma {
					self.comma_newlines()?;
					args.push(self.expr()?);
				}
				self.expect(Tok::RParen)?;
				Ok(Expr::Call(func, args))
			},
			Func::Sprintf => {
				self.expect(Tok::LParen)?;
				let mut args = vec![self.expr()?];
				while self.tok == Tok::Comma {
					self.comma_newlines()?;
					args.push(self.expr()?);
				}
				self.expect(Tok::RParen)?;
				Ok(Expr::Call(func, args))
			},
			Func::Strftime => {
				self.expect(Tok::LParen)?;
				let mut args = Vec::new();
				while self.tok != Tok::RParen && args.len() < 3 {
					if !args.is_empty() {
						self.comma_newlines()?;
					}
					args.push(self.expr()?);
				}
				self.expect(Tok::RParen)?;
				Ok(Expr::Call(func, args))
			},
			Func::Cos
			| Func::Sin
			| Func::Exp
			| Func::Log
			| Func::Sqrt
			| Func::Int
			| Func::Tolower
			| Func::Toupper
			| Func::System
			| Func::Close => {
				self.expect(Tok::LParen)?;
				let arg = self.expr()?;
				self.expect(Tok::RParen)?;
				Ok(Expr::Call(func, vec![arg]))
			},
			Func::Atan2 | Func::Index => {
				self.expect(Tok::LParen)?;
				let first = self.expr()?;
				self.comma_newlines()?;
				let second = self.expr()?;
				self.expect(Tok::RParen)?;
				Ok(Expr::Call(func, vec![first, second]))
			},
		}
	}

	fn optional_lvalue(&mut self) -> PResult<Option<Expr>> {
		match self.tok {
			Tok::Name => {
				if self.lexer.peek_byte() == b'(' {
					return Ok(None);
				}
				let (name, pos) = self.expect_name()?;
				Ok(Some(self.index_or_var(name, pos)?))
			},
			Tok::Dollar => {
				self.next()?;
				Ok(Some(Expr::Field(Box::new(self.primary()?))))
			},
			_ => Ok(None),
		}
	}

	/// `/regex/` or an expression, for regex-argument positions.
	fn regex_str(&mut self, parse: Level<'a>) -> PResult<Expr> {
		if self.matches(&[Tok::Div, Tok::DivAssign]) {
			let (regex, src) = self.next_regex()?;
			return Ok(Expr::RegexArg(regex, src));
		}
		parse(self)
	}

	/// Scans the regex after a `/` or `/=` token and compiles it.
	fn next_regex(&mut self) -> PResult<(Rc<AwkRegex>, Rc<[u8]>)> {
		let token = self.lexer.scan_regex();
		self.pos = token.pos;
		self.tok = token.tok;
		if token.tok == Tok::Illegal {
			return Err(self.error(String::from_utf8_lossy(&token.val).into_owned()));
		}
		let regex = AwkRegex::new(&token.val).map_err(|message| self.error(message))?;
		self.next()?;
		Ok((Rc::new(regex), Rc::from(token.val)))
	}

	fn user_call(&mut self, name: Rc<str>, pos: Pos) -> PResult<Expr> {
		self.expect(Tok::LParen)?;
		let mut args = Vec::new();
		while !self.matches(&[Tok::Newline, Tok::RParen]) {
			if !args.is_empty() {
				self.comma_newlines()?;
			}
			args.push(self.expr()?);
		}
		self.expect(Tok::RParen)?;
		Ok(Expr::UserCall { name, pos, func: usize::MAX, args })
	}
}
