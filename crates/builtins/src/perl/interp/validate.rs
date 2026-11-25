//! Lexical declaration and strict-pragma validation before program execution.

use super::{vars::forced_main, *};

struct Validator<'a, 'h> {
	interp: &'a mut Interp<'h>,
	package: Rc<str>,
	bindings: Vec<(Sigil, Rc<str>)>,
	declarations: Vec<(Sigil, Rc<str>)>,
	operands: Vec<(Sigil, Rc<str>)>,
	hints: Hints,
	diagnostics: PStr,
	depth: u32,
	pending_captures: Vec<(usize, usize, FxHashSet<(u8, Rc<str>)>)>,
	captures: FxHashMap<usize, FxHashSet<(u8, Rc<str>)>>,
}

impl Interp<'_> {
	pub(super) fn validate(&mut self, p: &Program, hints: Hints, inherits_pad: bool) -> PResult<()> {
		let bindings = if inherits_pad { self.pad_snapshot().into_iter().map(|(sig, name, _)| (sig, name)).collect() } else { Vec::new() };
		let mut validator = Validator { interp: self, package: p.package.clone(), bindings, declarations: Vec::new(), hints, diagnostics: PStr::default(),
			depth: 0, operands: Vec::new(), pending_captures: Vec::new(), captures: FxHashMap::default() };
		validator.statements(&p.body);
		if validator.diagnostics.is_empty() {
			// Install operands only for live, successfully validated code. In particular,
			// repeated failing string evals do not leave dangling operand-site metadata.
			for (sigil, name) in validator.operands { validator.interp.lexicals.resolve(sigil, &name); }
			for (site, names) in validator.captures {
				let mut ids: Vec<_> = names.into_iter().map(|(sigil, name)| validator.interp.lexicals.resolve_name(sigil, &name)).collect();
				ids.sort_unstable();
				validator.interp.captures.insert(site, ids);
			}
			return Ok(());
		}
		if !p.file.starts_with("(eval ") {
			validator.diagnostics.push(&PStr::from_str(&format!("Execution of {} aborted due to compilation errors.\n", p.file)));
		}
		Err(Flow::Die(Value::Str(validator.diagnostics)))
	}
}

/// A `my` declaration (possibly parenthesized), the target of perl's "my() in false conditional" error.
fn is_my_declaration(e: &Expr) -> bool { matches!(&ungroup(e).kind, ExprKind::Declare(DeclKind::My, ..)) }

/// The truth of a literal constant condition, if it is one.
fn constant_truth(e: &Expr) -> Option<bool> {
	match &ungroup(e).kind {
		ExprKind::Int(n) => Some(*n != 0),
		ExprKind::UInt(n) => Some(*n != 0),
		ExprKind::Float(n) => Some(*n != 0.0),
		ExprKind::String(s) => Some(!(s.is_empty() || s.bytes == b"0")),
		_ => None,
	}
}

impl Validator<'_, '_> {
	fn complain(&mut self, loc: &Location, message: &str) {
		self.diagnostics.push(&PStr::from_str(&format!("{message} at {} line {}.\n", loc.file, loc.line)));
	}

	fn scope(&mut self, f: impl FnOnce(&mut Self)) {
		let package = self.package.clone();
		let hints = self.hints.clone();
		let bindings = self.bindings.len();
		let outside = std::mem::take(&mut self.declarations);
		f(self);
		self.declarations = outside;
		self.package = package;
		self.hints = hints;
		self.bindings.truncate(bindings);
	}

	fn commit_declarations(&mut self) { self.bindings.append(&mut self.declarations); }

	fn statements(&mut self, block: &Block) {
		for stmt in &block.stmts { self.stmt(stmt); }
	}

	fn block(&mut self, block: &Block) { self.scope(|this| this.statements(block)); }

	fn capture(&mut self, block: &Block, f: impl FnOnce(&mut Self)) {
		self.pending_captures.push((block as *const Block as usize, self.bindings.len(), FxHashSet::default()));
		f(self);
		if let Some((site, _, vars)) = self.pending_captures.pop() { self.captures.insert(site, vars); }
	}

	fn record_capture(&mut self, sigil: Sigil, name: &Rc<str>) {
		if self.pending_captures.is_empty() || name.contains("::") { return; }
		let sigil = if sigil == Sigil::LastIndex { Sigil::Array } else { sigil };
		let binding = self.bindings.iter().rposition(|(s, n)| *s == sigil && n == name);
		for (_, start, vars) in &mut self.pending_captures {
			if binding.is_none_or(|n| n < *start) { vars.insert((sigil as u8, name.clone())); }
		}
	}

	fn stmt(&mut self, stmt: &Stmt) {
		if self.depth >= 2048 { self.complain(&stmt.location, "Excessively nested expression"); return; }
		self.depth += 1;
		stacker::maybe_grow(128 * 1024, 2 * 1024 * 1024, || self.stmt_inner(stmt));
		self.commit_declarations();
		self.depth -= 1;
	}

	fn stmt_inner(&mut self, stmt: &Stmt) {
		match &stmt.kind {
			StmtKind::Expr(e) => {
				if let ExprKind::Binary(Binary::And, first, second) = &e.kind
					&& constant_truth(first) == Some(false) && is_my_declaration(second) {
					self.complain(&e.location, "This use of my() in false conditional is no longer allowed");
				}
				self.expr(e);
			}
			StmtKind::Empty | StmtKind::Format => {}
			StmtKind::Block(body, cont) => self.scope(|this| {
				this.statements(body);
				if let Some(cont) = cont { this.block(cont); }
			}),
			StmtKind::If(branches, otherwise) => self.scope(|this| {
				for (e, _, body) in branches { this.expr(e); this.commit_declarations(); this.block(body); }
				if let Some(body) = otherwise { this.block(body); }
			}),
			StmtKind::While(e, _, body, cont) => self.scope(|this| {
				this.expr(e);
				this.commit_declarations();
				this.statements(body);
				if let Some(cont) = cont { this.block(cont); }
			}),
			StmtKind::For(init, cond, step, body, cont) => self.scope(|this| {
				for e in [init, cond, step].into_iter().flatten() { this.expr(e); this.commit_declarations(); }
				this.statements(body);
				if let Some(cont) = cont { this.block(cont); }
			}),
			StmtKind::Foreach(var, list, body, cont) => self.scope(|this| {
				this.expr(list);
				if let Some(e) = var { this.expr(e); }
				this.commit_declarations();
				this.statements(body);
				if let Some(cont) = cont { this.block(cont); }
			}),
			StmtKind::Modifier(body, modifier, e) => {
				let declares = matches!(&body.kind, StmtKind::Expr(d) if is_my_declaration(d));
				let skipped = match modifier { Modifier::If => constant_truth(e) == Some(false), Modifier::Unless => constant_truth(e) == Some(true), _ => false };
				if declares && skipped { self.complain(&stmt.location, "This use of my() in false conditional is no longer allowed"); }
				self.expr(e);
				self.stmt(body);
			}

			StmtKind::Sub(sub) => self.sub(sub),
			StmtKind::Package(package) => {
				if let Some(body) = &package.block { self.scope(|this| { this.package = package.name.clone(); this.statements(body); }); }
				else { self.package = package.name.clone(); }
			}
			StmtKind::Use(use_) => {
				if let Some(hints) = self.interp.use_hints.get(&(Rc::as_ptr(use_) as usize)) { self.hints = Hints::clone(hints); }
			}
			StmtKind::Phase(_, body) => self.capture(body, |this| this.block(body)),
			StmtKind::Given(e, body) => self.scope(|this| { this.expr(e); this.commit_declarations(); this.statements(body); }),
			StmtKind::When(e, body) => {
				if let Some(e) = e { self.expr(e); }
				self.block(body);
			}
			StmtKind::Try(body, exception, catch) => {
				self.block(body);
				self.scope(|this| { this.bind(exception, true); this.statements(catch); });
			}
		}
	}

	fn sub(&mut self, sub: &Subroutine) {
		if let Some(name) = &sub.name && matches!(sub.scope, Some(DeclKind::My | DeclKind::State | DeclKind::Our)) {
			self.bindings.push((Sigil::Code, name.clone()));
		}
		let Some(block) = &sub.body else { return; };
		self.capture(block, |this| this.scope(|this| {
			if let Some((pkg, _)) = sub.name.as_deref().and_then(|s| s.rsplit_once("::")) { this.package = Rc::from(pkg); }
			if let Some(signature) = &sub.signature {
				for p in signature.iter() {
					if let Some(default) = &p.default { this.expr(default); }
					if let Some(name) = &p.name { this.bindings.push((p.sigil, name.clone())); }
				}
			}
			this.statements(block);
		}));
	}

	fn bind(&mut self, e: &Expr, immediate: bool) {
		match &ungroup(e).kind {
			ExprKind::Variable(sigil, name) => {
				self.operands.push((*sigil, name.clone()));
				if immediate { self.bindings.push((*sigil, name.clone())); }
				else { self.declarations.push((*sigil, name.clone())); }
			}
			ExprKind::List(v) => for e in v { self.bind(e, immediate); },
			ExprKind::Declare(_, _, e, _) | ExprKind::Unary(Unary::Reference, e) => self.bind(e, immediate),
			_ => self.expr(e),
		}
	}

	fn variable(&mut self, sigil: Sigil, name: &Rc<str>, loc: &Location) {
		self.operands.push((sigil, name.clone()));
		self.record_capture(sigil, name);
		let name = name.as_ref();
		let sigil = if sigil == Sigil::LastIndex { Sigil::Array } else { sigil };
		if !self.hints.strict_vars || name.contains("::") || forced_main(name) || !matches!(sigil, Sigil::Scalar | Sigil::Array | Sigil::Hash) { return; }
		if sigil == Sigil::Scalar && matches!(name, "a" | "b") { return; }
		if self.bindings.iter().rev().any(|(s, n)| *s == sigil && n.as_ref() == name) { return; }
		let qualified = format!("{}::{name}", self.package);
		if modules::declared_var(self.interp, &qualified, sigil) { return; }
		let symbol = match sigil { Sigil::Scalar => '$', Sigil::Array => '@', _ => '%' };
		self.complain(loc, &format!("Global symbol \"{symbol}{name}\" requires explicit package name (did you forget to declare \"my {symbol}{name}\"?)"));
	}

	fn expr(&mut self, e: &Expr) {
		if self.depth >= 2048 { self.complain(&e.location, "Excessively nested expression"); return; }
		self.depth += 1;
		stacker::maybe_grow(128 * 1024, 2 * 1024 * 1024, || self.expr_inner(e));
		self.depth -= 1;
	}

	fn expr_inner(&mut self, e: &Expr) {
		match &e.kind {
			ExprKind::Variable(sigil, name) => self.variable(*sigil, name, &e.location),
			ExprKind::Bareword(name) if self.hints.strict_subs && !name.ends_with("::") => {
				self.complain(&e.location, &format!("Bareword \"{name}\" not allowed while \"strict subs\" in use"));
			}
			ExprKind::Group(e) | ExprKind::Deref(_, e) | ExprKind::Array(e) | ExprKind::Hash(e) => self.expr(e),
			ExprKind::Unary(Unary::Minus, e) if matches!(&ungroup(e).kind, ExprKind::Bareword(_)) => {}
			ExprKind::Unary(_, e) => self.expr(e),
			ExprKind::Select(base, select, key) => {
				let sigil = match select {
					Select::ArrayElement(false) | Select::ArraySlice(false) | Select::ArrayPairs(false) => Some(Sigil::Array),
					Select::HashElement(false) | Select::HashSlice(false) | Select::HashPairs(false) => Some(Sigil::Hash),
					_ => None,
				};
				if let (Some(sigil), ExprKind::Variable(_, name)) = (sigil, &ungroup(base).kind) { self.variable(sigil, name, &base.location); }
				else { self.expr(base); }
				self.expr(key);
			}
			ExprKind::List(list) => for e in list { self.expr(e); },
			ExprKind::Declare(DeclKind::Local, _, target, _) => self.expr(target),
			ExprKind::Declare(kind, _, target, _) => self.bind(target, *kind == DeclKind::Our),
			ExprKind::Binary(Binary::Assign, left, right) if matches!(&ungroup(left).kind,
				ExprKind::Call(Call { target: CallTarget::Builtin(Builtin::Chomp | Builtin::Chop, _), .. })) => {
				if let ExprKind::Call(call) = &ungroup(left).kind && let CallTarget::Builtin(b, _) = call.target {
					let op = match call.args.as_deref().map(ungroup).map(|e| &e.kind) {
						Some(ExprKind::List(items)) if items.len() > 1 => b.name().to_owned(),
						_ => format!("scalar {}", b.name()),
					};
					self.complain(&e.location, &format!("Can't modify {op} in scalar assignment"));
				}
				self.expr(right);
			}
			ExprKind::Binary(Binary::Assign, left, right) if matches!(&ungroup(left).kind, ExprKind::Declare(..)) => { self.expr(right); self.expr(left); }
			ExprKind::Binary(Binary::Isa, left, right) if matches!(&ungroup(right).kind, ExprKind::Bareword(_)) => self.expr(left),
			ExprKind::Binary(_, left, right) => { self.expr(left); self.expr(right); }
			ExprKind::CompareChain(first, rest) => { self.expr(first); for (_, e) in rest { self.expr(e); } }
			ExprKind::Conditional(c, y, n) => { self.expr(c); self.expr(y); self.expr(n); }
			ExprKind::Call(call) => self.call(call),
			ExprKind::Sub(sub) => self.sub(sub),
			ExprKind::Block(b, _) => self.block(b),
			ExprKind::FileTest(_, Some(e)) => { if !matches!(&ungroup(e).kind, ExprKind::Bareword(_)) { self.expr(e); } }
			ExprKind::Readline(Readline::Scalar(e)) => self.expr(e),
			ExprKind::Quote(_, parts) => self.parts(parts),
			ExprKind::Regex(re) => {
				self.parts(&re.pattern);
				match &re.kind { RegexKind::Substitute(parts) => self.parts(parts), RegexKind::SubstituteEval(b, _) => self.block(b), _ => {} }
			}
			_ => {}
		}
	}

	fn parts(&mut self, parts: &[QuotePart]) {
		for part in parts {
			match part { QuotePart::Expr(e, _) => self.expr(e), QuotePart::RegexCode(b, ..) => self.capture(b, |this| this.block(b)), _ => {} }
		}
	}

	fn call(&mut self, c: &Call) {
		let builtin = match &c.target {
			CallTarget::Code(from, _) => { self.expr(from); None }
			CallTarget::Method(e, m) => {
				if !matches!(&ungroup(e).kind, ExprKind::Bareword(_)) { self.expr(e); }
				if let Method::Dynamic(e) = m { self.expr(e); }
				None
			}
			CallTarget::Builtin(b, _) => {
				if matches!(b, Builtin::Eval | Builtin::Evalbytes) {
					// A string eval can name any lexical visible at this point.
					for (_, start, captured) in &mut self.pending_captures {
						captured.extend(self.bindings[..*start].iter().map(|(sigil, name)| (*sigil as u8, name.clone())));
					}
				}
				Some(*b)
			}
			CallTarget::Named(name, _) => { self.operands.push((Sigil::Code, name.clone())); self.record_capture(Sigil::Code, name); None }
		};
		if let Some(slot) = &c.slot {
			match slot {
				CallSlot::Handle(e) | CallSlot::Comparator(e) | CallSlot::Program(e) => if !matches!(&ungroup(e).kind, ExprKind::Bareword(_)) { self.expr(e); },
				CallSlot::Block(b) => self.capture(b, |this| this.block(b)),
				CallSlot::Expression(e) => self.expr(e),
			}
		}
		if let Some(args) = c.args.as_deref() {
			let ordinary: &[Expr] = if let ExprKind::List(v) = &ungroup(args).kind { v } else { std::slice::from_ref(args) };
			let handles = builtin.map_or(&[][..], |b| b.filehandle_arguments(ordinary.len()));
			let duplicate_open = builtin == Some(Builtin::Open) && ordinary.get(1).is_some_and(|mode| {
				matches!(&ungroup(mode).kind, ExprKind::String(s) if matches!(s.bytes.as_slice(), b">&" | b"<&" | b">&=" | b"<&="))
			});
			for (i, e) in ordinary.iter().enumerate() {
				if i == 0 && matches!(builtin, Some(Builtin::Push | Builtin::Unshift | Builtin::Pop | Builtin::Shift | Builtin::Splice))
					&& let Some(b) = builtin {
					match &ungroup(e).kind {
						ExprKind::Int(_) | ExprKind::UInt(_) | ExprKind::Float(_) | ExprKind::String(_) => {
							self.complain(&e.location, &format!("Type of arg 1 to {} must be array (not constant item)", b.name()));
						}
						ExprKind::Variable(Sigil::Scalar, _) | ExprKind::Deref(Sigil::Scalar, _) | ExprKind::Call(_) | ExprKind::Array(_) => {
							self.complain(&e.location, &format!("Experimental {} on scalar is now forbidden", b.name()));
						}
						_ => {}
					}
				}
				if matches!(&ungroup(e).kind, ExprKind::Bareword(_))
					&& (handles.contains(&i) || duplicate_open && i == 2 || matches!(builtin, Some(Builtin::Require | Builtin::Prototype))) { continue; }
				self.expr(e);
			}
		}
	}
}
