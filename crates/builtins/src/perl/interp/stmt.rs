//! Statements, run scopes and Perl program phases (perlsyn, perlmod, perlrun).

use super::{vars::Slot, *};

const WHEN_EXIT: &str = "\0when exit";
const WHEN_CONTINUE: &str = "\0when continue";

enum Loop<T> { Value(T), Next, Last, Redo }

fn matches_label(target: &Option<Rc<str>>, label: Option<&str>) -> bool {
	target.as_deref().is_none_or(|target| Some(target) == label)
}

fn loop_flow<T>(result: PResult<T>, label: Option<&str>) -> PResult<Loop<T>> {
	match result {
		Ok(value) => Ok(Loop::Value(value)),
		Err(Flow::Next(l)) if matches_label(&l, label) => Ok(Loop::Next),
		Err(Flow::Last(l)) if matches_label(&l, label) => Ok(Loop::Last),
		Err(Flow::Redo(l)) if matches_label(&l, label) => Ok(Loop::Redo),
		Err(flow) => Err(flow),
	}
}

fn has_label(block: &Block, label: &str) -> bool {
	stacker::maybe_grow(128 * 1024, 2 * 1024 * 1024, || {
		block.stmts.iter().any(|stmt| stmt.label.as_deref() == Some(label) || nested_label(stmt, label))
	})
}

fn nested_label(stmt: &Stmt, label: &str) -> bool {
	match &stmt.kind {
		StmtKind::Block(b, c) | StmtKind::For(_, _, _, b, c) | StmtKind::Foreach(_, _, b, c) =>
			has_label(b, label) || c.as_ref().is_some_and(|b| has_label(b, label)),
		StmtKind::While(test, until, b, c) => {
			let folded = match &test.kind {
				ExprKind::Int(n) => Some(*n != 0),
				ExprKind::String(s) => Some(Value::Str(s.clone()).truthy()),
				_ => None,
			};
			folded != Some(*until) && (has_label(b, label) || c.as_ref().is_some_and(|b| has_label(b, label)))
		}
		StmtKind::If(branches, other) => branches.iter().any(|(test, negate, b)| {
			!matches!(&test.kind, ExprKind::Int(n) if (*n != 0) == *negate) && has_label(b, label)
		}) || other.as_ref().is_some_and(|b| has_label(b, label)),
		StmtKind::Package(p) => p.block.as_ref().is_some_and(|b| has_label(b, label)),
		StmtKind::Expr(Expr { kind: ExprKind::Block(b, false), .. }) => has_label(b, label),
		_ => false,
	}
}

/// Whether any statement of a compiled unit, including sub bodies, carries `label`.
fn label_anywhere(block: &Block, label: &str) -> bool {
	stacker::maybe_grow(128 * 1024, 2 * 1024 * 1024, || block.stmts.iter().any(|stmt| {
		stmt.label.as_deref() == Some(label) || match &stmt.kind {
			StmtKind::Block(b, c) | StmtKind::For(_, _, _, b, c) | StmtKind::Foreach(_, _, b, c) | StmtKind::While(_, _, b, c) =>
				label_anywhere(b, label) || c.as_ref().is_some_and(|b| label_anywhere(b, label)),
			StmtKind::If(branches, other) => branches.iter().any(|(_, _, b)| label_anywhere(b, label)) || other.as_ref().is_some_and(|b| label_anywhere(b, label)),
			StmtKind::Sub(sub) => sub.body.as_ref().is_some_and(|b| label_anywhere(b, label)),
			StmtKind::Package(p) => p.block.as_ref().is_some_and(|b| label_anywhere(b, label)),
			StmtKind::Expr(Expr { kind: ExprKind::Block(b, _), .. }) => label_anywhere(b, label),
			_ => false,
		}
	}))
}

fn assigns_topic(expr: &Expr) -> bool {
	matches!(&ungroup(expr).kind, ExprKind::Readline(_) | ExprKind::Quote(QuoteKind::Glob, _)
		| ExprKind::Call(Call { target: CallTarget::Builtin(Builtin::Readline | Builtin::Glob | Builtin::Readdir | Builtin::Each, _), .. }))
}

fn tests_definedness(expr: &Expr) -> bool { assigns_topic(expr) }

/// op.c `looks_like_bool`: a `when` condition used as a plain boolean instead of a smartmatch against `$_`.
fn looks_like_bool(e: &Expr) -> bool {
	let e = ungroup(e);
	match &e.kind {
		ExprKind::Binary(Binary::Or | Binary::DefinedOr, first, _) => looks_like_bool(first),
		ExprKind::Binary(Binary::And, first, second) => looks_like_bool(first) && looks_like_bool(second),
		ExprKind::Call(Call { target: CallTarget::Builtin(Builtin::Scalar, _), args: Some(inner), .. }) => looks_like_bool(inner),
		ExprKind::Call(Call { target: CallTarget::Named(..) | CallTarget::Code(..) | CallTarget::Method(..), .. })
		| ExprKind::Call(Call { target: CallTarget::Builtin(Builtin::Defined | Builtin::Exists | Builtin::Eof, _), .. })
		| ExprKind::Unary(Unary::Not, _) | ExprKind::CompareChain(..)
		| ExprKind::Regex(RegexExpr { kind: RegexKind::Match(_), .. }) => true,
		ExprKind::Binary(Binary::Bind(_), _, pattern) =>
			!matches!(&ungroup(pattern).kind, ExprKind::Regex(RegexExpr {
				kind: RegexKind::Compile | RegexKind::Substitute(_) | RegexKind::SubstituteEval(..) | RegexKind::Transliterate(_), .. })),
		ExprKind::Binary(Binary::Eq | Binary::Ne | Binary::Lt | Binary::Le | Binary::Gt | Binary::Ge | Binary::Xor
			| Binary::StrEq | Binary::StrNe | Binary::StrLt | Binary::StrLe | Binary::StrGt | Binary::StrGe
			| Binary::Isa | Binary::SmartMatch | Binary::Range(_), ..) => true,
		ExprKind::FileTest(op, _) => !matches!(op, b's' | b'M' | b'A' | b'C'),
		_ => false,
	}
}

impl Interp<'_> {
	/// Compile a Perl file, performing compile-time callbacks as parsing proceeds.
	pub fn compile(&mut self, src: &[u8], file: &str) -> Result<Rc<Program>, PStr> {
		self.phase = "START";
		self.compile_status = 255;
		self.compile_interrupted = false;
		let hints = self.default_hints.clone();
		let result = self.parse_unit(hints, false, |this| parser::parse_program(src, file, "main", this));
		let program = match result {
			Ok(program) => program,
			Err(flow) => return Err(self.compile_diagnostic(flow)),
		};
		self.install_data(&program, true);
		self.phase = "CHECK";
		if let Err(flow) = self.run_phase_queue(Phase::Check) { return Err(self.compile_diagnostic(flow)); }
		self.phase = "START";
		Ok(program)
	}

	/// Exit status selected by the most recent failed compilation.
	pub fn compile_status(&self) -> i32 { self.compile_status }

	fn compile_diagnostic(&mut self, flow: Flow) -> PStr {
		if self.compile_interrupted && !matches!(&flow, Flow::Cancelled) {
			let status = self.flow_status(flow);
			self.compile_status = if self.special_value("main::^C").truthy() { status }
			else {
				self.pop_scope();
				let _ = func::sys::finish_argv(self);
				self.finish_main(status)
			};
			return PStr::default();
		}
		match flow {
			Flow::Die(v) => v.to_pstr(),
			Flow::Exit(status) => { self.compile_status = status & 255; PStr::default() }
			Flow::Cancelled => { self.compile_status = 130; PStr::default() }
			_ => self.message_with_location(PStr::from_bytes(b"Control transfer during compilation")),
		}
	}

	pub(super) fn parse_unit(&mut self, hints: Hints, inherits_pad: bool, parse: impl FnOnce(&mut Self) -> Result<Program, parser::ParseError>) -> PResult<Rc<Program>> {
		let saved = std::mem::replace(&mut self.compile_hints, hints.clone());
		let saved_failure = self.compile_failure.take();
		let parse_scopes = self.parse_scopes.len();
		let compile_pads = self.compile_pads.len();
		let outer_base = std::mem::replace(&mut self.compile_pad_base, compile_pads);
		self.compile_pads.push(Pad::new());
		let unitchecks = self.unitchecks.len();
		self.compile_depth += 1;
		let parsed = stacker::maybe_grow(128 * 1024, 2 * 1024 * 1024, || parse(self));
		self.compile_depth -= 1;
		self.parse_scopes.truncate(parse_scopes);
		self.compile_pads.truncate(compile_pads);
		self.compile_pad_base = outer_base;
		self.compile_hints = saved;
		let failure = std::mem::replace(&mut self.compile_failure, saved_failure);
		if let Some(flow) = failure {
			self.unitchecks.truncate(unitchecks);
			if self.compile_depth == 0 { self.compile_interrupted = true; }
			return Err(flow);
		}
		let program = Rc::new(parsed.map_err(|err| {
			let mut diagnostic = err.to_string();
			if inherits_pad && let Some((line, _)) = diagnostic.split_once("\nExecution of ") {
				diagnostic.truncate(line.len() + 1);
			}
			self.apply_die_hook(Value::str(&diagnostic))
		})?);
		let checked = self.validate(&program, hints, inherits_pad);
		let mut checks = self.unitchecks.split_off(unitchecks);
		checked?;
		// Phase callbacks were registered while parsing, before their free-variable
		// sets were known. Drop the unused captured cells once validation completes.
		for (block, _, _, pad) in checks.iter_mut().chain(self.checks.iter_mut()).chain(self.inits.iter_mut()).chain(self.ends.iter_mut()) {
			if let Some(needed) = self.captures.get(&(Rc::as_ptr(block) as usize)) {
				pad.retain(|(sigil, name, _)| needed.contains(&(*sigil as u8, name.clone())));
			}
		}
		self.programs.push(program.clone());
		for check in checks.into_iter().rev() { self.run_phase_block(check)?; }
		Ok(program)
	}

	pub(super) fn install_data(&mut self, program: &Program, main: bool) {
		let Some(data) = &program.data else { return; };
		if data.end && !main { return; }
		let sv = new_sv(Value::bytes(&data.bytes));
		let mode = crate::perl::io::OpenMode { read: true, write: false, append: false, truncate: false, create: false };
		if let Ok(handle) = Handle::open(self.host, mode, crate::perl::io::OpenTarget::Scalar(sv), Default::default()) {
			let g = self.glob(&format!("{}::DATA", data.package));
			self.set_handle(&g, Rc::new(RefCell::new(handle)));
		}
	}

	/// Run INIT, the program and END, then release this invocation's handles.
	pub fn run_main(&mut self, program: &Program) -> i32 {
		self.phase = "INIT";
		let init = self.run_phase_queue(Phase::Init);
		self.phase = "RUN";
		self.package = program.package.clone();
		self.active_hints = Rc::new(self.default_hints.clone());
		self.loc = program.body.location.clone();
		let main = init.and_then(|()| self.run_statements(&program.body, Cx::Void).map(|_| ()));
		self.pop_scope();
		let cleanup = self.drain_destructors(false);
		let finish = func::sys::finish_argv(self);
		let status = main.and(cleanup).and(finish).err().map_or(0, |flow| self.flow_status(flow));
		self.finish_main(status)
	}

	fn finish_main(&mut self, status: i32) -> i32 {
		self.sv("main::?").replace(Value::Int(i64::from(status)));
		self.phase = "END";
		while let Some(end) = self.ends.pop() {
			if let Err(flow) = self.run_phase_block(end) {
				let status = self.flow_status(flow);
				self.sv("main::?").replace(Value::Int(i64::from(status)));
			}
		}
		self.phase = "DESTRUCT";
		if let Err(flow) = self.drain_destructors(true) {
			let status = self.flow_status(flow);
			self.sv("main::?").replace(Value::Int(i64::from(status)));
		}
		while !self.exit_hooks.is_empty() {
			for hook in std::mem::take(&mut self.exit_hooks) { hook(self); }
		}
		self.flush_outputs();
		for io in self.handles.iter().rev().filter_map(std::rc::Weak::upgrade) {
			if let Ok(mut handle) = io.try_borrow_mut() && handle.is_open() { let _ = handle.close(); }
		}
		self.special_value("main::?").to_i64() as i32 & 255
	}

	/// Evaluate a lexical block, restoring localized variables and match state on every exit path.
	pub fn run_block(&mut self, b: &Block, cx: Cx) -> PResult<Ret> {
		stacker::maybe_grow(128 * 1024, 2 * 1024 * 1024, || self.depth_guard(|this| this.scoped(|this| this.run_statements(b, cx))))
	}

	pub(super) fn scoped<T>(&mut self, f: impl FnOnce(&mut Self) -> PResult<T>) -> PResult<T> {
		let saved_match = self.last_match.clone();
		let result = self.scope_slots(f);
		self.last_match = saved_match;
		result
	}

	fn scope_slots<T>(&mut self, f: impl FnOnce(&mut Self) -> PResult<T>) -> PResult<T> {
		let package = self.package.clone();
		let hints = self.active_hints.clone();
		self.push_scope();
		let result = f(self);
		self.pop_scope();
		self.package = package;
		self.active_hints = hints;
		let cleanup = self.drain_destructors(false);
		match (result, self.take_pending()) {
			(Err(flow), _) | (Ok(_), Some(flow)) => Err(flow),
			(Ok(value), None) => cleanup.map(|()| value),
		}
	}

	pub(super) fn run_statements(&mut self, block: &Block, cx: Cx) -> PResult<Ret> {
		self.run_statements_at(block, cx, 0, Ret::no_value(cx))
	}

	fn run_statements_at(&mut self, block: &Block, cx: Cx, mut ix: usize, mut result: Ret) -> PResult<Ret> {
		let statements = &block.stmts;
		// In void context no statement's value is kept: skip locating the last executable one.
		let last_executable = if cx == Cx::Void { None } else { statements.iter().rposition(|stmt| !matches!(&stmt.kind,
			StmtKind::Empty | StmtKind::Use(_) | StmtKind::Sub(_) | StmtKind::Phase(..) | StmtKind::Format
			| StmtKind::Package(Package { block: None, .. }))) };
		while let Some(s) = statements.get(ix) {
			if self.loc.line != s.location.line || !Rc::ptr_eq(&self.loc.file, &s.location.file) { self.loc = s.location.clone(); }
			self.poll()?;
			let scx = if Some(ix) == last_executable { cx } else { Cx::Void };
			match self.run_statement(s, scx) {
				Err(Flow::Goto(GotoTarget::Label(label))) => {
					let (position, value) = self.resume_label(block, label, cx)?;
					ix = position;
					if let Some(v) = value { result = v; ix += 1; }
					continue;
				}
				Ok(value) if Some(ix) == last_executable => result = value,
				Ok(_) => {}
				Err(flow) => return Err(flow),
			}
			ix += 1;
		}
		Ok(result)
	}

	fn resume_label(&mut self, block: &Block, label: Rc<str>, cx: Cx) -> PResult<(usize, Option<Ret>)> {
		let mut target = label;
		loop {
			self.poll()?;
			if let Some(position) = block.stmts.iter().position(|s| s.label.as_deref() == Some(target.as_ref())) {
				return Ok((position, None));
			}
			let Some((ix, stmt)) = block.stmts.iter().enumerate().find(|(_, s)| nested_label(s, &target)) else {
				return Err(Flow::Goto(GotoTarget::Label(target)));
			};
			self.warn_category_default("deprecated", "Use of \"goto\" to jump into a construct is deprecated");
			self.poll()?;
			let cx = if ix + 1 == block.stmts.len() { cx } else { Cx::Void };
			let result = stacker::maybe_grow(128 * 1024, 2 * 1024 * 1024,
				|| self.depth_guard(|this| this.scoped(|this| this.enter_label(stmt, &target, cx))));
			match result {
				Ok(value) => return Ok((ix, Some(value))),
				Err(Flow::Goto(GotoTarget::Label(label))) if label != target => target = label,
				Err(flow) => return Err(flow),
			}
		}
	}

	fn run_from_label(&mut self, block: &Block, label: &Rc<str>, cx: Cx) -> PResult<Ret> {
		let (position, result) = self.resume_label(block, label.clone(), cx)?;
		let ix = position + usize::from(result.is_some());
		self.run_statements_at(block, cx, ix, result.unwrap_or_else(|| Ret::no_value(cx)))
	}

	fn enter_label(&mut self, stmt: &Stmt, label: &Rc<str>, cx: Cx) -> PResult<Ret> {
		let loop_label = stmt.label.as_deref();
		let result = match &stmt.kind {
			StmtKind::Block(body, cont) if has_label(body, label) => self.resume_loop_part(body, cont.as_ref(), loop_label, label, cx),
			StmtKind::Block(_, Some(cont)) if has_label(cont, label) => loop_flow(self.run_from_label(cont, label, cx), loop_label),
			StmtKind::If(branches, else_) => {
				for (_, _, body) in branches {
					if has_label(body, label) { return self.run_from_label(body, label, cx); }
				}
				if let Some(body) = else_ { return self.run_from_label(body, label, cx); }
				Err(Flow::Goto(GotoTarget::Label(label.clone())))
			}
			StmtKind::While(cond, until, body, cont) => {
				let first = if has_label(body, label) {
					self.resume_loop_part(body, cont.as_ref(), loop_label, label, cx)?
				} else if let Some(cont) = cont {
					loop_flow(self.run_from_label(cont, label, Cx::Void), loop_label)?
				} else { return Err(Flow::Goto(GotoTarget::Label(label.clone()))); };
				if matches!(first, Loop::Last) { return Ok(Ret::no_value(cx)); }
				let mut last = match first {
					Loop::Value(v) => v,
					Loop::Redo => match self.run_iteration(body, cont.as_ref(), loop_label, cx)? {
						Loop::Value(v) => v, Loop::Last => return Ok(Ret::no_value(cx)), _ => Ret::no_value(cx),
					},
					_ => Ret::no_value(cx),
				};
				loop {
					self.poll()?;
					if !self.condition(cond, *until, true)? { return Ok(last); }
					self.commit_declarations();
					match self.scoped(|this| this.run_iteration(body, cont.as_ref(), loop_label, cx))? {
						Loop::Last => return Ok(last), Loop::Value(v) => last = v, _ => {}
					}
				}
			}
			StmtKind::Foreach(..) => return Err(self.die_msg("Can't \"goto\" into the middle of a foreach loop")),
			StmtKind::For(_, cond, step, body, cont) => {
				let first = if has_label(body, label) {
					self.resume_loop_part(body, cont.as_ref(), loop_label, label, cx)?
				} else if let Some(cont) = cont {
					loop_flow(self.run_from_label(cont, label, Cx::Void), loop_label)?
				} else { return Err(Flow::Goto(GotoTarget::Label(label.clone()))); };
				if matches!(first, Loop::Last) { return Ok(Ret::no_value(cx)); }
				let mut last = match first { Loop::Value(v) => v, _ => Ret::no_value(cx) };
				loop {
					self.poll()?;
					if let Some(step) = step { self.eval(step, Cx::Void)?; self.commit_declarations(); }
					if let Some(cond) = cond {
						if !self.condition(cond, false, false)? { return Ok(last); }
						self.commit_declarations();
					}
					match self.scoped(|this| this.run_iteration(body, cont.as_ref(), loop_label, cx))? {
						Loop::Last => return Ok(last), Loop::Value(v) => last = v, _ => {}
					}
				}
			}
			StmtKind::Package(package) if let Some(body) = &package.block => {
				self.set_package(package)?;
				return self.run_from_label(body, label, cx);
			}
			StmtKind::Expr(Expr { kind: ExprKind::Block(body, false), .. }) => return self.run_from_label(body, label, cx),
			_ => return Err(Flow::Goto(GotoTarget::Label(label.clone()))),
		}?;
		Ok(match result { Loop::Value(v) => v, _ => Ret::no_value(cx) })
	}

	fn resume_loop_part(&mut self, body: &Block, cont: Option<&Block>, loop_label: Option<&str>, label: &Rc<str>, cx: Cx) -> PResult<Loop<Ret>> {
		let result = match loop_flow(self.run_from_label(body, label, cx), loop_label)? {
			Loop::Value(v) => v,
			Loop::Redo => return self.run_iteration(body, cont, loop_label, cx),
			Loop::Last => return Ok(Loop::Last),
			Loop::Next => Ret::no_value(cx),
		};
		if let Some(cont) = cont {
			match loop_flow(self.run_block(cont, Cx::Void), loop_label)? {
				Loop::Last => return Ok(Loop::Last),
				Loop::Redo => return self.run_iteration(body, Some(cont), loop_label, cx),
				_ => {}
			}
		}
		Ok(Loop::Value(result))
	}

	pub(super) fn run_statement(&mut self, stmt: &Stmt, cx: Cx) -> PResult<Ret> {
		let result = self.nested(|this| this.run_statement_inner(stmt, cx));
		// New my/state bindings enter scope after the statement, not after
		// their assignment alone: `my $x = 1 and $x++` still sees the outer $x.
		self.commit_declarations();
		result
	}

	fn run_statement_inner(&mut self, stmt: &Stmt, cx: Cx) -> PResult<Ret> {
		let label = stmt.label.as_deref();
		match &stmt.kind {
			StmtKind::Empty => Ok(Ret::no_value(cx)),
			StmtKind::Expr(e) => self.eval(e, cx),
			StmtKind::Block(body, continue_) => self.scoped(|this| {
				match this.run_iteration(body, continue_.as_ref(), label, cx)? {
					Loop::Value(v) => Ok(v), _ => Ok(Ret::no_value(cx)),
				}
			}),
			StmtKind::If(branches, otherwise) => self.scoped(|this| {
				let mut last = Value::Undef;
				for (condition, negate, body) in branches {
					let v = this.eval_scalar(condition)?;
					let succeeds = this.truthy(&v)? != *negate;
					this.commit_declarations();
					if succeeds { return this.run_block(body, cx); }
					last = v;
				}
				// `if (C) {...}` is `C && do {...}`: with no branch taken, its value is the last condition's.
				if let Some(b) = otherwise { this.run_block(b, cx) }
				else if cx == Cx::Void { Ok(Ret::no_value(cx)) }
				else { Ok(Ret::One(last)) }
			}),
			StmtKind::While(cond, until, body, cont) => self.scoped(|this| {
				loop {
					let mut exit_value = None;
					let step = this.scope_slots(|this| {
						this.poll()?;
						let (succeeds, value) = this.condition_value(cond, *until, true)?;
						this.commit_declarations();
						if !succeeds { exit_value = Some(value); return Ok(Loop::Last); }
						// The body runs in void context; the loop's own value is its final condition.
						this.run_iteration(body, cont.as_ref(), label, Cx::Void)
					})?;
					if let Loop::Last = step {
						return Ok(match exit_value { Some(value) if cx != Cx::Void => Ret::One(value), _ => Ret::no_value(cx) });
					}
				}
			}),
			StmtKind::For(init, cond, step, body, cont) => self.scoped(|this| {
				if let Some(init) = init { this.eval(init, Cx::Void)?; this.commit_declarations(); }
				loop {
					this.poll()?;
					if let Some(cond) = cond {
						let (succeeds, value) = this.condition_value(cond, false, false)?;
						this.commit_declarations();
						// Like `while`, the loop's value is its final (failing) condition.
						if !succeeds { return Ok(if cx == Cx::Void { Ret::no_value(cx) } else { Ret::One(value) }); }
					}
					if let Loop::Last = this.scope_slots(|this| this.run_iteration(body, cont.as_ref(), label, Cx::Void))? {
						return Ok(Ret::no_value(cx));
					}
					if let Some(step) = step { this.eval(step, Cx::Void)?; this.commit_declarations(); }
				}
			}),
			StmtKind::Foreach(var, list, body, continue_) => self.scoped(|this| {
				if var.as_ref().is_some_and(|e| matches!(&ungroup(e).kind, ExprKind::Unary(Unary::Reference, _))) {
					this.aliasing_enabled()?;
				}
				let aliases = this.foreach_items(list)?;
				this.commit_declarations();
				// `for my $x (...)`: bind each element directly (the general aliasing logic, resolved once).
				let lexical = var.as_ref().and_then(|v| match &v.kind {
					ExprKind::Declare(DeclKind::My | DeclKind::State, _, target, _) => match &ungroup(target).kind {
						ExprKind::Variable(Sigil::Scalar, name) => Some(name.clone()),
						_ => None,
					},
					_ => None,
				});
				for alias in aliases {
					let step = if let Some(name) = &lexical {
						this.scope_slots(|this| {
							this.put_pad(Sigil::Scalar, name.clone(), Slot::Scalar(alias));
							this.run_iteration(body, continue_.as_ref(), label, Cx::Void)
						})?
					} else {
						this.scope_slots(|this| this.foreach_alias(var.as_ref(), alias, |this| this.run_iteration(body, continue_.as_ref(), label, Cx::Void)))?
					};
					if let Loop::Last = step { return Ok(Ret::no_value(cx)); }
				}
				// The body runs in void context; the loop's own value is the exhausted iterator's false ('').
				Ok(if cx == Cx::Void { Ret::no_value(cx) } else { Ret::One(Value::Str(PStr::default())) })
			}),
			StmtKind::Modifier(inner, modifier, e) => self.modifier(inner, *modifier, e, cx, label),
			StmtKind::Sub(sub) => { self.install_runtime_sub(sub)?; Ok(Ret::no_value(cx)) }
			StmtKind::Package(package) => {
				if let Some(block) = &package.block {
					self.scoped(|this| {
						this.set_package(package)?;
						this.run_statements(block, cx)
					})
				} else {
					self.set_package(package)?;
					Ok(Ret::no_value(cx))
				}
			}
			StmtKind::Use(use_) => {
				let key = Rc::as_ptr(use_) as usize;
				if let Some(hints) = self.use_hints.get(&key) { self.active_hints = hints.clone(); }
				Ok(Ret::no_value(cx))
			}
			StmtKind::Phase(phase, block) => {
				if *phase == Phase::End
					&& let Some(i) = self.ends.iter().position(|phase| Rc::ptr_eq(&phase.0, block)) {
					self.ends[i].3 = self.capture_pad(Some(block));
				}
				Ok(Ret::no_value(cx))
			}
			StmtKind::Format => Ok(Ret::no_value(cx)),
			StmtKind::Given(topic, body) => self.scoped(|this| {
				let value = this.eval_scalar(topic)?;
				this.commit_declarations();
				this.in_given += 1;
				let outer_cx = std::mem::replace(&mut this.given_cx, cx);
				let out = this.with_topic(new_sv(value), |this| this.run_block(body, cx));
				this.given_cx = outer_cx;
				this.in_given -= 1;
				match out {
					Err(Flow::Last(Some(label))) if label.as_ref() == WHEN_EXIT =>
						Ok(this.given_value.take().map_or_else(|| Ret::no_value(cx), |v| v.in_context(cx))),
					out => out,
				}
			}),
			// Declarations in the condition are scoped to the `when` statement.
			StmtKind::When(e, block) => self.scoped(|this| {
				if let Some(e) = e && !this.when_test(e)? { return Ok(Ret::no_value(cx)); }
				this.commit_declarations();
				this.in_when += 1;
				let body_cx = if this.in_given != 0 { this.given_cx } else { cx };
				let out = this.run_block(block, body_cx);
				this.in_when -= 1;
				this.when_exit(out)
			}),
			StmtKind::Try(body, exception, catch) => match self.run_block(body, cx) {
				Err(Flow::Die(v)) => self.scoped(|this| {
					if let ExprKind::Variable(Sigil::Scalar, name) = &ungroup(exception).kind {
						this.put_pad(Sigil::Scalar, name.clone(), Slot::Scalar(new_sv(v)));
					} else {
						let s = this.eval_lvalue(exception)?;
						this.write_sv(&s, v)?;
					}
					this.run_statements(catch, cx)
				}),
				out => out,
			},
		}
	}

	fn set_package(&mut self, package: &Package) -> PResult<()> {
		self.package = package.name.clone();
		self.stash(&package.name);
		if let Some(version) = &package.version {
			// `package NAME VERSION` stores a version object (perlfunc package).
			self.require_module("version")?;
			let object = self.call_method(Value::str("version"), "new", vec![Value::Str(version.clone())], Cx::Scalar)?.scalar();
			self.sv(&format!("{}::VERSION", package.name)).replace(object);
		}
		Ok(())
	}

	fn condition(&mut self, e: &Expr, negate: bool, implicit: bool) -> PResult<bool> {
		self.condition_value(e, negate, implicit).map(|(truth, _)| truth)
	}

	/// A loop/branch condition's outcome and the value it produced (a `while` statement's own value is its final,
	/// failing condition).
	fn condition_value(&mut self, e: &Expr, negate: bool, implicit: bool) -> PResult<(bool, Value)> {
		let e = ungroup(e);
		let v = self.eval_scalar(e)?;
		let truth = if implicit && assigns_topic(e) {
			let topic = self.topic();
			let defined = !v.is_undef();
			self.write_sv(&topic, v.clone())?;
			defined
		} else if tests_definedness(e) || matches!(&e.kind,
			ExprKind::Binary(Binary::Assign, lhs, rhs) if !Self::list_target(lhs) && tests_definedness(rhs)) {
			// A scalar assignment preserves defined-but-false results such as key "0".
			// A list assignment instead returns a count, which is zero at exhaustion.
			!v.is_undef()
		} else { self.truthy(&v)? };
		Ok((truth != negate, v))
	}

	fn run_iteration(&mut self, body: &Block, cont: Option<&Block>, label: Option<&str>, cx: Cx) -> PResult<Loop<Ret>> {
		loop {
			self.poll()?;
			let mark = self.locals_mark();
			let result = loop_flow(self.run_statements(body, cx), label);
			if cont.is_some() { self.unwind_locals(mark); }
			let result = match result? {
				Loop::Value(v) => v,
				Loop::Last => return Ok(Loop::Last),
				Loop::Redo => continue,
				Loop::Next => Ret::no_value(cx),
			};
			if let Some(cont) = cont {
				match loop_flow(self.run_block(cont, Cx::Void), label)? {
					Loop::Last => return Ok(Loop::Last), Loop::Redo => continue, _ => {}
				}
			}
			return Ok(Loop::Value(result));
		}
	}

	/// The elements a foreach visits: aliases of the list, or fresh counters for a numeric range (perl iterates
	/// `for (1..N)` without building the list).
	fn foreach_items(&mut self, list: &Expr) -> PResult<ForeachItems> {
		let mut e = ungroup(list);
		if let ExprKind::List(items) = &e.kind && let [only] = items.as_slice() { e = ungroup(only); }
		if let ExprKind::Binary(Binary::Range(_), from, to) = &e.kind {
			let old = std::mem::replace(&mut self.loc, e.location.clone());
			let bounds = (|| {
				let start = self.eval_scalar(from)?;
				let end = self.eval_scalar(to)?;
				Ok(match ops::numeric_range_bounds(&start, &end) {
					Some(Ok((lo, hi))) => ForeachItems::Range(lo..=hi, None),
					Some(Err(message)) => return Err(self.die_msg(message)),
					None => ForeachItems::Aliases(aliases(ops::range(&start, &end).map_err(|m| self.die_msg(m))?).into_iter()),
				})
			})();
			self.loc = old;
			return bounds;
		}
		Ok(ForeachItems::Aliases(self.eval_aliases(list)?.into_iter()))
	}

	fn modifier(&mut self, stmt: &Stmt, modifier: Modifier, e: &Expr, cx: Cx, label: Option<&str>) -> PResult<Ret> {
		match modifier {
			// `STMT if COND` is `COND && STMT`: when skipped, its value is the condition's.
			Modifier::If | Modifier::Unless if cx != Cx::Void && !tests_definedness(ungroup(e)) => {
				let value = self.eval_scalar(e)?;
				if self.truthy(&value)? != (modifier == Modifier::Unless) { self.run_statement(stmt, cx) }
				else { Ok(Ret::One(value)) }
			}
			Modifier::If | Modifier::Unless => if self.condition(e, modifier == Modifier::Unless, false)? {
				self.run_statement(stmt, cx)
			} else { Ok(Ret::no_value(cx)) },
			Modifier::For => {
				let mut result = Ret::no_value(cx);
				for alias in self.foreach_items(e)? {
					let out = self.with_topic(alias, |this| loop {
						this.poll()?;
						match loop_flow(this.run_statement(stmt, cx), label)? {
							Loop::Redo => continue, step => return Ok(step),
						}
					})?;
					match out { Loop::Last => break, Loop::Value(v) => result = v, _ => {} }
				}
				Ok(result)
			}
			Modifier::While | Modifier::Until => {
				let post = matches!(&stmt.kind, StmtKind::Expr(Expr { kind: ExprKind::Block(_, false), .. }));
				let neg = modifier == Modifier::Until;
				let mut result = Ret::no_value(cx);
				let mut first = true;
				loop {
					self.poll()?;
					if !(first && post) && !self.condition(e, neg, true)? { return Ok(result); }
					first = false;
					loop {
						self.poll()?;
						match loop_flow(self.run_statement(stmt, cx), label)? {
							Loop::Value(v) => { result = v; break; }
							Loop::Last => return Ok(result), Loop::Next => break, Loop::Redo => continue,
						}
					}
				}
			}
			Modifier::When => if self.when_test(e)? {
				self.in_when += 1;
				let result = self.run_statement(stmt, cx);
				self.in_when -= 1;
				self.when_exit(result)
			} else { Ok(Ret::no_value(cx)) },
		}
	}

	fn when_test(&mut self, e: &Expr) -> PResult<bool> {
		let e = ungroup(e);
		let boolean = looks_like_bool(e);
		if boolean { let v = self.eval_scalar(e)?; return self.truthy(&v); }
		let value = self.smartmatch_operand(e)?;
		let topic = self.topic();
		let topic = self.read_sv(&topic)?;
		self.smartmatch(&topic, &value)
	}

	fn when_exit(&mut self, result: PResult<Ret>) -> PResult<Ret> {
		match result {
			Err(Flow::Next(Some(label))) if label.as_ref() == WHEN_CONTINUE => Ok(Ret::One(Value::Undef)),
			Ok(value) if self.in_given != 0 => {
				self.given_value = Some(value);
				Err(Flow::Last(Some(Rc::from(WHEN_EXIT))))
			}
			Ok(_) => Err(Flow::Next(None)),
			out => out,
		}
	}

	pub(super) fn break_when(&mut self, next: bool) -> Flow {
		if next && self.in_when != 0 { Flow::Next(Some(Rc::from(WHEN_CONTINUE))) }
		else if next { self.die_msg("Can't \"continue\" outside a when block") }
		else if self.in_given != 0 { self.given_value = None; Flow::Last(Some(Rc::from(WHEN_EXIT))) }
		else { self.die_msg("Can't \"break\" outside a given block") }
	}

	pub(super) fn queue_phase(&mut self, phase: Phase, block: &Rc<Block>, package: Rc<str>) -> PResult<()> {
		if phase == Phase::Begin { return Ok(()); }
		let hints = if self.compile_depth != 0 { self.compile_hints.clone() } else { Hints::clone(&self.active_hints) };
		let item = (block.clone(), package, hints, self.compile_pad_snapshot());
		match phase {
			Phase::Unitcheck => self.unitchecks.push(item), Phase::Check => self.checks.push(item),
			Phase::Init => self.inits.push(item), Phase::End => self.ends.push(item),
			Phase::Begin => {},
		}
		Ok(())
	}

	fn run_phase_queue(&mut self, phase: Phase) -> PResult<()> {
		let blocks = match phase { Phase::Check => std::mem::take(&mut self.checks), Phase::Init => std::mem::take(&mut self.inits), _ => return Ok(()) };
		if phase == Phase::Check { for b in blocks.into_iter().rev() { self.run_phase_block(b)?; } }
		else { for b in blocks { self.run_phase_block(b)?; } }
		Ok(())
	}

	fn run_phase_block(&mut self, block: PhaseBlock) -> PResult<()> {
		let (block, package, hints, pad) = block;
		self.scoped(|this| {
			this.package = package;
			this.active_hints = Rc::new(hints);
			if let Some(scope) = this.scopes.last_mut() { scope.pad = pad; }
			this.run_statements(&block, Cx::Void).map(|_| ())
		})
	}

	/// Whether some compiled unit has a statement labelled `label` (dynamic `goto`/`last` targets).
	pub(super) fn label_known(&self, label: &str) -> bool { self.programs.iter().any(|p| label_anywhere(&p.body, label)) }

	/// Most recent successful match in the current dynamic scope.
	pub fn last_match(&self) -> Option<Rc<rx::MatchState>> { self.last_match.clone() }
	/// Replace the current scope's successful match.
	pub fn set_last_match(&mut self, state: Option<Rc<rx::MatchState>>) { self.last_match = state; }
}

/// What a foreach loop iterates over (see `Interp::foreach_items`).
enum ForeachItems {
	Aliases(std::vec::IntoIter<Sv>),
	/// Counters of a numeric range; the previous counter's cell is recycled when nothing retained it.
	Range(std::ops::RangeInclusive<i64>, Option<Sv>),
}

impl Iterator for ForeachItems {
	type Item = Sv;
	fn next(&mut self) -> Option<Sv> {
		match self {
			Self::Aliases(items) => items.next(),
			Self::Range(range, last) => {
				let i = range.next()?;
				let sv = match last.take() {
					Some(sv) if Rc::strong_count(&sv) == 1 && Rc::weak_count(&sv) == 0 && !sv.is_magical() && !sv.registered()
						&& sv.blessed.borrow().is_none() => { sv.set(Value::Int(i)); sv.pos.set(None); sv }
					_ => new_sv(Value::Int(i)),
				};
				*last = Some(sv.clone());
				Some(sv)
			}
		}
	}
}
