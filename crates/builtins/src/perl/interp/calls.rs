//! Calls and compile-time effects (perlsub, perlmod, perlobj, perlfunc).

use super::{vars::Slot, *};

/// A Perl subroutine body with its lexical environment and persistent pad.
pub(in crate::perl) struct PerlBody {
	block: Rc<Block>,
	package: Rc<str>,
	lexical_name: Option<Rc<str>>,
	anon_name: std::cell::OnceCell<Rc<str>>,
	signature: Option<Rc<[Parameter]>>,
	pad: Pad,
	hints: Rc<Hints>,
	persistent: Rc<RefCell<Persistent>>,
	lvalue: bool,
}

// Lexical subs and globs captured by a closure would otherwise free each other recursively (sub capturing sub
// capturing sub …); route them through the iterative release queue. Scalar captures do so on their own.
impl Drop for PerlBody {
	fn drop(&mut self) {
		for (_, _, slot) in self.pad.drain(..) {
			match slot {
				Slot::Code(cv) => value::release(Value::Ref(Ref::Code(cv))),
				Slot::Glob(gv) => value::release(Value::Glob(gv)),
				_ => {}
			}
		}
	}
}

enum InvokeArgs {
	Number(Num), // one fresh, non-aliasing arithmetic result
	Explicit(Vec<Sv>),
	Shared(Av, bool), // true when this is a tail call following an explicit argument list
}
impl InvokeArgs {
	fn has_args(&self) -> bool { !matches!(self, Self::Shared(_, false)) }
	fn into_array(self, pool: &mut Vec<Av>) -> Av {
		match self {
			Self::Number(n) => {
				let array = pool.pop().unwrap_or_else(|| new_av(Vec::new()));
				{
					let mut elems = array.elems_mut();
					if let Some(cell) = elems.first() { cell.set(n.into_value()); cell.set_pos(None); }
					else { elems.push(new_sv(n.into_value())); }
				}
				array
			}
			Self::Explicit(args) => {
				let array = pool.pop().unwrap_or_else(|| new_av(Vec::new()));
				array.replace_elems(args);
				array
			}
			Self::Shared(array, _) => array,
		}
	}
	fn into_vec(self) -> Vec<Sv> {
		match self { Self::Number(n) => vec![new_sv(n.into_value())], Self::Explicit(args) => args, Self::Shared(array, _) => array.elems().clone() }
	}
}

impl Interp<'_> {
	pub(super) fn make_sub(&mut self, sub: &Subroutine, name: Option<Rc<str>>, pad: Pad) -> Cv {
		let pkg = self.package();
		let body = self.perl_body(sub, pad, Rc::default(), pkg.clone());
		let cv = Rc::new(CodeBody { name: RefCell::new(name), pkg, prototype: RefCell::new(sub.prototype.clone()), body: RefCell::new(body), blessed: RefCell::new(None) });
		value::track_code(&cv);
		self.apply_code_attributes(&cv, sub);
		cv
	}

	fn apply_code_attributes(&mut self, cv: &Cv, sub: &Subroutine) {
		if sub.attributes.is_empty() { return; }
		let names = sub.attributes.iter().filter(|attr| attr.name.as_ref() != "prototype").map(|attr| {
			let mut name = PStr::from_str(&attr.name);
			if let Some(args) = &attr.args { name.push_bytes(b"("); name.push(args); name.push_bytes(b")"); }
			name
		}).collect();
		self.code_attr.insert(Rc::as_ptr(cv) as usize, (Rc::downgrade(cv), names));
	}

	/// Get the declared attributes of a live code reference.
	pub fn code_attributes(&self, cv: &Cv) -> Vec<PStr> {
		self.code_attr.get(&(Rc::as_ptr(cv) as usize)).map_or_else(Vec::new, |(_, attrs)| attrs.clone())
	}

	/// Set or clear one intrinsic subroutine attribute.
	pub fn modify_code_attribute(&mut self, cv: &Cv, name: &str, on: bool) -> bool {
		if !matches!(name, "lvalue" | "method") { return false; }
		let attrs = &mut self.code_attr.entry(Rc::as_ptr(cv) as usize).or_insert_with(|| (Rc::downgrade(cv), Vec::new())).1;
		if let Some(ix) = attrs.iter().position(|attr| attr.bytes == name.as_bytes()) {
			if !on { attrs.remove(ix); }
		} else if on {
			attrs.push(PStr::from_str(name));
		}
		true
	}

	fn code_is_lvalue(&self, cv: &Cv, default: bool) -> bool {
		self.code_attr.get(&(Rc::as_ptr(cv) as usize)).map_or(default, |(_, attrs)| attrs.iter().any(|attr| attr.bytes == b"lvalue"))
	}

	fn perl_body(&self, sub: &Subroutine, pad: Pad, persistent: Rc<RefCell<Persistent>>, package: Rc<str>) -> CodeImpl {
		let Some(block) = &sub.body else { return CodeImpl::Undefined; };
		let hints = if self.compile_depth != 0 { Rc::new(self.compile_hints.clone()) } else { self.active_hints.clone() };
		let lexical_name = if matches!(sub.scope, Some(DeclKind::My | DeclKind::State)) { sub.name.clone() } else { None };
		CodeImpl::Perl(Rc::new(PerlBody { block: block.clone(), package, lexical_name, signature: sub.signature.clone(),
			anon_name: Default::default(), pad, hints, persistent, lvalue: sub.is_lvalue() }))
	}

	pub(super) fn code_slot(&mut self, g: &Gv) -> Cv {
		if let Some(cv) = g.code.borrow().clone() { return cv; }
		let name = Rc::from(format!("{}::{}", g.pkg, g.name));
		let cv = Rc::new(CodeBody { name: RefCell::new(Some(name)), pkg: g.pkg.clone(), prototype: RefCell::new(None), body: RefCell::new(CodeImpl::Undefined), blessed: RefCell::new(None) });
		g.code.replace(Some(cv.clone()));
		cv
	}

	pub(super) fn named_code(&self, name: &str) -> Option<Cv> {
		if let Some(Slot::Code(cv)) = self.pad_slot(Sigil::Code, name) { return Some(cv.clone()); }
		// `lookup_code` without the stash-entry upgrade when the glob exists (memoized lookup).
		if let Some(gv) = self.find_glob(name) { return gv.code.borrow().clone(); }
		self.lookup_code(&self.qualify(name))
	}

	pub(super) fn code_value(&mut self, value: &Value, required: bool) -> PResult<Option<Cv>> {
		let cv = match value {
			Value::Ref(Ref::Code(cv)) => Some(cv.clone()),
			Value::Glob(g) | Value::Ref(Ref::Glob(g)) => g.code.borrow().clone(),
			Value::Undef => None,
			Value::Ref(_) => { if required { return Err(self.die_msg("Not a CODE reference")); } None }
			_ => {
				let name = value.to_pstr();
				if required && self.hints().strict_refs {
					return Err(self.die_msg(format!("Can't use string (\"{}\") as a subroutine ref while \"strict refs\" in use", name.to_string_lossy())));
				}
				self.named_code(&name.to_string_lossy())
			}
		};
		if required && cv.is_none() {
			return Err(if value.is_undef() { self.die_msg("Can't use an undefined value as a subroutine reference") }
			else { self.die_msg(format!("Undefined subroutine &{} called", self.qualify(&value.to_pstr().to_string_lossy()))) });
		}
		Ok(cv)
	}

	pub(super) fn install_runtime_sub(&mut self, sub: &Subroutine) -> PResult<()> {
		let Some(name) = &sub.name else { return Ok(()); };
		if matches!(sub.scope, Some(DeclKind::My | DeclKind::State)) {
			let site = sub as *const Subroutine as usize;
			if sub.scope == Some(DeclKind::State) {
				let pad = self.persistent.borrow().vars.get(&site).cloned();
				if let Some(pad) = pad {
					self.extend_pad(pad);
					return Ok(());
				}
			}
			let q = self.qualify(name);
			let cv = match self.lookup_pad(Sigil::Code, name) {
				Some(Slot::Code(cv)) if matches!(*cv.body.borrow(), CodeImpl::Undefined) => cv,
				_ => self.make_sub(sub, Some(q), Pad::new()),
			};
			self.put_pad(Sigil::Code, name.clone(), Slot::Code(cv.clone()));
			let mut capture = self.capture_pad(sub.body.as_deref());
			capture.retain(|(_, _, slot)| !matches!(slot, Slot::Code(c) if Rc::ptr_eq(c, &cv)));
			let body = self.perl_body(sub, capture, Rc::default(), self.package());
			cv.body.replace(body);
			if sub.scope == Some(DeclKind::State) {
				self.persistent.borrow_mut().vars.insert(site, vec![(Sigil::Code, name.clone(), Slot::Code(cv))]);
			}
			return Ok(());
		}
		let glob = self.glob(name);
		let cv = self.code_slot(&glob);
		if let Some(block) = &sub.body {
			let persistent = match &*cv.body.borrow() {
				CodeImpl::Perl(b) if Rc::ptr_eq(&b.block, block) => b.persistent.clone(),
				_ => return Ok(()), // the compiler (or a glob assignment) installed a later definition
			};
			let body = self.perl_body(sub, self.capture_pad(sub.body.as_deref()), persistent, self.package());
			cv.body.replace(body);
		}
		Ok(())
	}

	/// Install a native Perl subroutine with ordinary argument parsing.
	pub fn define_native(&mut self, qualified: &str, f: NativeFn) { self.define_code(qualified, CodeImpl::Native(f), None); }
	/// Install a native subroutine and its call-site prototype.
	pub fn define_native_proto(&mut self, qualified: &str, f: NativeFn, prototype: &str) { self.define_code(qualified, CodeImpl::Native(f), Some(PStr::from_str(prototype))); }
	/// Install a constant expression subroutine, with an empty prototype.
	pub fn define_constant(&mut self, qualified: &str, values: Vec<Value>) { self.define_code(qualified, CodeImpl::Constant(Rc::from(values)), Some(PStr::default())); }

	fn define_code(&mut self, qualified: &str, imp: CodeImpl, proto: Option<PStr>) {
		let g = self.glob(qualified);
		let cv = self.code_slot(&g);
		cv.prototype.replace(proto);
		cv.body.replace(imp);
		self.mark_package_changed(&g.pkg);
	}

	/// Call a Perl or native code value with aliased argument cells.
	pub fn call_sub(&mut self, cv: &Cv, args: Vec<Sv>, cx: Cx) -> PResult<Ret> {
		self.call_sub_kind(cv, InvokeArgs::Explicit(args), cx, false)
	}

	fn call_sub_kind(&mut self, cv: &Cv, args: InvokeArgs, cx: Cx, as_lvalue: bool) -> PResult<Ret> {
		let result = self.nested(|this| this.call_sub_loop(cv.clone(), args, cx, as_lvalue));
		if let Ok(ret) = &result { self.track_ret(ret); }
		result
	}

	fn call_sub_loop(&mut self, mut cv: Cv, mut args: InvokeArgs, cx: Cx, as_lvalue: bool) -> PResult<Ret> {
		loop {
			self.poll()?;
			let imp = cv.body.borrow().clone();
			let explicit = args.has_args();
			let out = match imp {
				CodeImpl::Undefined => {
					let name = cv.name.borrow().clone().unwrap_or_else(|| Rc::from("__ANON__"));
					return self.call_undefined(&name, args, cx);
				}
				CodeImpl::Constant(values) => return Ok(if cx == Cx::List { Ret::Many(values.to_vec()) }
				else if values.len() > 1 { Ret::One(Value::Int(values.len() as i64)) }
				else { Ret::One(values.first().cloned().unwrap_or(Value::Undef)) }),
				CodeImpl::Native(callback) => {
					let av = args.into_array(&mut self.arg_arrays);
					let native_args = av.elems().clone();
					self.active_subs.push((cv.clone(), av.clone(), cx));
					self.eval_contexts.push((cx, false));
					let result = callback(self, native_args, cx);
					self.eval_contexts.pop();
					self.active_subs.pop();
					(result, av)
				}
				CodeImpl::Perl(body) => {
					if as_lvalue && !self.code_is_lvalue(&cv, body.lvalue) { return Err(self.die_msg("Can't modify non-lvalue subroutine call")); }
					let address = Rc::as_ptr(&cv) as usize;
					let sub = cv.name.borrow().clone();
					if self.enter_sub_depth(address) {
						let msg = sub.as_deref().map_or_else(|| "Deep recursion on anonymous subroutine".to_owned(),
							|name| format!("Deep recursion on subroutine \"{name}\""));
						self.warn_category("recursion", msg);
						if let Some(flow) = self.take_pending() {
							self.leave_sub_depth(address);
							return Err(flow);
						}
					}
					let av = args.into_array(&mut self.arg_arrays);
					let outer = self.enter_pad(&body.pad);
					let name = sub.unwrap_or_else(|| body.anon_name.get_or_init(|| Rc::from(format!("{}::__ANON__", body.package))).clone());
					let frame = self.frame(Some(name), cx, explicit, None, false, Some(av.clone()));
					let saved_loc = self.loc.clone();
					let persistent = std::mem::replace(&mut self.persistent, body.persistent.clone());
					self.active_subs.push((cv.clone(), av.clone(), cx));
					self.frames.push(frame);
					self.eval_contexts.push((cx, as_lvalue));
					let result = self.scoped(|this| {
						this.package = body.package.clone();
						this.active_hints = body.hints.clone();
						if let Some(name) = &body.lexical_name { this.put_pad(Sigil::Code, name.clone(), Slot::Code(cv.clone())); }
						if let Some(signature) = &body.signature { this.bind_signature(signature, &av, &cv)?; }
						if as_lvalue { this.run_lvalue_body(&body.block, cx) } else { this.run_statements(&body.block, cx) }
					});
					self.eval_contexts.pop();
					self.frames.pop();
					self.active_subs.pop();
					self.persistent = persistent;
					self.leave_pad(outer);
					self.loc = saved_loc;
					self.leave_sub_depth(address);
					(result, av)
				}
			};
			match out.0 {
				Ok(v) | Err(Flow::Return(v)) => {
					self.recycle_args(out.1);
					return Ok(v.in_context(cx));
				}
				Err(Flow::Goto(GotoTarget::Sub(next))) => { cv = next; args = InvokeArgs::Shared(self.tail_args.take().unwrap_or(out.1), explicit); }
				Err(flow) => return Err(flow),
			}
		}
	}

	/// Most calls cannot possibly be the 100th activation of their CV. Maintain the
	/// per-CV counts only while the Perl call stack is actually that deep.
	fn enter_sub_depth(&mut self, address: usize) -> bool {
		self.perl_calls.push(address);
		if self.perl_calls.len() < 100 { return false; }
		if self.perl_calls.len() == 100 {
			for &cv in &self.perl_calls[..99] { *self.sub_depth.entry(cv).or_default() += 1; }
		}
		let depth = self.sub_depth.entry(address).or_default();
		*depth += 1;
		*depth == 100
	}

	fn leave_sub_depth(&mut self, address: usize) {
		self.perl_calls.pop();
		match self.perl_calls.len() {
			0..99 => {}
			99 => self.sub_depth.clear(),
			_ => if let Some(depth) = self.sub_depth.get_mut(&address) {
				*depth -= 1;
				if *depth == 0 { self.sub_depth.remove(&address); }
			}
		}
	}

	fn recycle_args(&mut self, mut av: Av) {
		// An escaped argument array, including a weak reference, a bless, tie or
		// address-keyed registration, must keep exactly its old identity and contents.
		if self.arg_arrays.len() >= 64 || Rc::get_mut(&mut av).is_none()
			|| av.blessed.borrow().is_some() || av.tie().is_some() { return; }
		{
			let mut elems = av.elems_mut();
			if elems.capacity() > 32 { return; }
			// A single anonymous number can supply both the vector and the scalar of
			// the next arithmetic argument. Never prolong the life of a referent.
			if !matches!(elems.as_slice(), [sv] if Rc::strong_count(sv) == 1 && Rc::weak_count(sv) == 0
				&& !sv.registered() && !sv.is_blessed()
				&& sv.plain_value().is_some_and(|v| matches!(*v, Value::Int(_) | Value::UInt(_) | Value::Num(_)))) {
				elems.clear();
			}
		}
		self.arg_arrays.push(av);
	}

	/// An lvalue sub's result: a reference to the returned scalar container (scalar context); in list context one
	/// reference per returned item, whole arrays and hashes as `Ref::Array`/`Ref::Hash` so list assignment can fill them.
	fn lvalue_result(&mut self, e: &Expr, cx: Cx) -> PResult<Ret> {
		if cx != Cx::List { return self.eval_lvalue(e).map(|sv| Ret::One(Value::Ref(Ref::Scalar(sv)))); }
		let mut out = Vec::new();
		self.lvalue_items(e, &mut out)?;
		Ok(Ret::Many(out))
	}

	fn lvalue_items(&mut self, e: &Expr, out: &mut Vec<Value>) -> PResult<()> {
		let e = ungroup(e);
		match &e.kind {
			ExprKind::List(items) => for item in items { self.lvalue_items(item, out)?; },
			ExprKind::Variable(Sigil::Array, _) | ExprKind::Deref(Sigil::Array, _) => out.push(Value::Ref(Ref::Array(self.eval_array(e)?))),
			ExprKind::Variable(Sigil::Hash, _) | ExprKind::Deref(Sigil::Hash, _) => out.push(Value::Ref(Ref::Hash(self.eval_hash(e)?))),
			_ => out.extend(self.eval_aliases(e)?.into_iter().map(|sv| Value::Ref(Ref::Scalar(sv)))),
		}
		Ok(())
	}

	fn run_lvalue_body(&mut self, block: &Block, cx: Cx) -> PResult<Ret> {
		let Some((last, before)) = block.stmts.split_last() else { return Err(self.die_msg("Can't return undef from lvalue subroutine")); };
		for stmt in before {
			self.loc = stmt.location.clone();
			self.poll()?;
			self.run_statement(stmt, Cx::Void)?;
		}
		self.loc = last.location.clone();
		self.poll()?;
		match &last.kind {
			StmtKind::Expr(e) => {
				if matches!(&e.kind, ExprKind::Call(Call { target: CallTarget::Builtin(Builtin::Return, _), .. })) {
					return self.eval(e, Cx::Scalar);
				}
				self.lvalue_result(e, cx)
			}
			StmtKind::If(branches, otherwise) => {
				for (test, negate, block) in branches {
					let value = self.eval_scalar(test)?;
					self.commit_declarations();
					if self.truthy(&value)? != *negate { return self.scoped(|i| i.run_lvalue_body(block, cx)); }
				}
				if let Some(block) = otherwise { return self.scoped(|i| i.run_lvalue_body(block, cx)); }
				Err(self.die_msg("Can't return undef from lvalue subroutine"))
			}
			_ => Err(self.die_msg("Can't return a temporary from lvalue subroutine")),
		}
	}

	fn bind_signature(&mut self, signature: &[Parameter], av: &Av, cv: &Cv) -> PResult<()> {
		// Exact-arity scalar signatures need no argument snapshot when every FETCH is
		// plain: binding cannot call Perl or mutate @_ before subsequent parameters.
		if av.elems().len() == signature.len() && signature.iter().all(|p| p.sigil == Sigil::Scalar)
			&& av.elems().iter().all(|sv| !sv.has_read_magic()) {
			let args = av.elems();
			for (p, arg) in signature.iter().zip(args.iter()) {
				if let Some(name) = &p.name { self.put_pad(Sigil::Scalar, name.clone(), Slot::Scalar(new_sv(arg.get()))); }
			}
			return Ok(());
		}
		let args = av.elems().clone();
		let required = signature.iter().filter(|p| p.sigil == Sigil::Scalar && p.default.is_none()).count();
		let maximum = signature.len();
		let got = args.len();
		let slurpy = signature.last().filter(|p| matches!(p.sigil, Sigil::Array | Sigil::Hash));
		let sub_name = || cv.name.borrow().clone().unwrap_or_else(|| Rc::from(format!("{}::__ANON__", cv.pkg)));
		if got < required || (slurpy.is_none() && got > maximum) {
			let name = sub_name();
			// pp_argcheck: "at least"/"at most" whenever the arity is a range.
			let wanted = if got < required {
				if slurpy.is_some() || maximum > required { format!("at least {required}") } else { required.to_string() }
			} else if maximum > required { format!("at most {maximum}") } else { maximum.to_string() };
			let amount = if got < required { "few" } else { "many" };
			return Err(self.die_msg(format!("Too {amount} arguments for subroutine '{name}' (got {got}; expected {wanted})")));
		}
		if slurpy.is_some_and(|p| p.sigil == Sigil::Hash) && got.saturating_sub(maximum.saturating_sub(1)) % 2 != 0 {
			let name = sub_name();
			return Err(self.die_msg(format!("Odd name/value argument for subroutine '{name}'")));
		}
		let mut i = 0;
		for p in signature {
			let slot = match p.sigil {
				Sigil::Array => {
					let values = args[i.min(got)..].iter().map(|a| self.read_sv(a)).collect::<PResult<Vec<_>>>()?;
					Slot::Array(new_av(values))
				}
				Sigil::Hash => {
					let values = args[i.min(got)..].iter().map(|a| self.read_sv(a)).collect::<PResult<Vec<_>>>()?;
					let h = new_hv(); self.fill_hash(&h, values)?; Slot::Hash(h)
				}
				_ => {
					let v = if let Some(a) = args.get(i) { self.read_sv(a)? }
					else if let Some(default) = &p.default { self.eval_scalar(default)? } else { Value::Undef };
					i += 1;
					Slot::Scalar(new_sv(v))
				}
			};
			if let Some(name) = &p.name { self.put_pad(p.sigil, name.clone(), slot); }
		}
		Ok(())
	}

	fn frame(&self, sub: Option<Rc<str>>, cx: Cx, has_args: bool, eval_text: Option<PStr>, is_require: bool, args: Option<Av>) -> CallFrame {
		let info = Frame { package: self.package(), file: self.loc.file.clone(), line: self.loc.line, sub, has_args,
			wantarray: context_flag(cx), eval_text, is_require, args: None };
		CallFrame { info, hints: self.active_hints.clone(), outer: self.active_subs.is_empty(), args }
	}

	/// Capture the requested caller frame (zero is the nearest Perl caller).
	pub fn caller_frame(&self, level: usize) -> Option<Frame> {
		let current = self.frames.iter().rev().nth(level)?;
		let mut frame = current.info.clone();
		frame.args = current.args.as_ref().map(|av| av.elems().iter().map(read_sv).collect());
		Some(frame)
	}

	/// Lexical hints in effect at the requested caller location.
	pub fn caller_hints(&self, level: usize) -> Option<&Hints> { self.frames.iter().rev().nth(level).map(|frame| &*frame.hints) }

	/// Fully qualified name on the currently executing CV, including native calls.
	pub fn current_sub_name(&self) -> Option<Rc<str>> { self.active_subs.last()?.0.name.borrow().clone() }

	fn call_undefined(&mut self, name: &str, args: InvokeArgs, cx: Cx) -> PResult<Ret> {
		let qualified = self.qualify(name);
		let (pkg, func) = qualified.rsplit_once("::").unwrap_or(("main", name));
		if func != "AUTOLOAD" && let Some(cv) = self.named_code(&format!("{pkg}::AUTOLOAD")) && !matches!(*cv.body.borrow(), CodeImpl::Undefined) {
			self.sv(&format!("{pkg}::AUTOLOAD")).replace(Value::str(&qualified));
			return self.call_sub_kind(&cv, args, cx, false);
		}
		Err(self.die_msg(format!("Undefined subroutine &{qualified} called")))
	}

	fn call_args(&mut self, call: &Call, inherit: bool, proto: Option<&PStr>) -> PResult<InvokeArgs> {
		let mut out = Vec::new();
		if let Some(CallSlot::Block(b)) = &call.slot {
			// Block-prototype calls use an anonymous code value. The front end supplies
			// a distinct block here rather than an ordinary argument expression.
			let sub = Subroutine { name: None, scope: None, prototype: None, signature: None, attributes: Vec::new(), body: Some(b.clone()) };
			out.push(new_sv(Value::Ref(Ref::Code(self.make_sub(&sub, None, self.capture_pad(Some(b)))))));
		}
		let Some(args) = &call.args else {
			if inherit {
				let arr = self.active_subs.last().map(|(_, arr, _)| arr.clone()).unwrap_or_else(|| self.av("main::_"));
				return Ok(InvokeArgs::Shared(arr, false));
			}
			if proto.is_some_and(|p| p.bytes.starts_with(b"_")) { out.push(self.topic()); }
			return Ok(InvokeArgs::Explicit(out));
		};
		if proto.is_none() && call.slot.is_none() {
			let mut arg = ungroup(args);
			if let ExprKind::List(items) = &arg.kind && let [one] = items.as_slice() { arg = ungroup(one); }
			if matches!(arg.kind, ExprKind::Binary(Binary::Add | Binary::Sub | Binary::Mul | Binary::Div | Binary::Mod, ..))
				&& let Some(n) = self.plain_numeric_expr(arg) {
				return Ok(InvokeArgs::Number(n));
			}
		}
		if let Some(proto) = proto {
			let mut specs = proto.bytes.iter().copied().filter(|b| !b.is_ascii_whitespace() && *b != b';').peekable();
			let items: &[Expr] = match &args.kind { ExprKind::List(v) => v, _ => std::slice::from_ref(args.as_ref()) };
			if !out.is_empty() && specs.peek() == Some(&b'&') { specs.next(); }
			for e in items {
				let spec = specs.next();
				match spec {
					Some(b'\\') => {
						let mut spec = specs.next();
						if spec == Some(b'[') {
							let kind = match &ungroup(e).kind {
								ExprKind::Variable(Sigil::Array, _) | ExprKind::Deref(Sigil::Array, _) => b'@',
								ExprKind::Variable(Sigil::Hash, _) | ExprKind::Deref(Sigil::Hash, _) => b'%',
								ExprKind::Variable(Sigil::Glob, _) | ExprKind::Deref(Sigil::Glob, _) => b'*',
								ExprKind::Variable(Sigil::Code, _) | ExprKind::Deref(Sigil::Code, _) => b'&',
								_ => b'$',
							};
							spec = None;
							for candidate in specs.by_ref() {
								if candidate == b']' { break; }
								if candidate == kind { spec = Some(kind); }
							}
							if spec.is_none() { return Err(self.die_msg("Invalid argument type for subroutine prototype")); }
						}
						let value = match spec {
							Some(b'@') => Value::Ref(Ref::Array(self.eval_array(e)?)),
							Some(b'%') => Value::Ref(Ref::Hash(self.eval_hash(e)?)),
							Some(b'$') => Value::Ref(Ref::Scalar(self.eval_lvalue(e)?)),
							_ => self.reference(e, Cx::Scalar)?.scalar(),
						};
						out.push(new_sv(value));
					}
					Some(b'$' | b'_') => {
						if matches!(&ungroup(e).kind, ExprKind::Variable(Sigil::Scalar, _) | ExprKind::Deref(Sigil::Scalar, _) | ExprKind::Select(_, Select::ArrayElement(_) | Select::HashElement(_), _)
							| ExprKind::Int(_) | ExprKind::UInt(_) | ExprKind::Float(_) | ExprKind::String(_) | ExprKind::Version(_)) {
						let mut aliases = self.eval_aliases(e)?;
						out.append(&mut aliases);
						} else { out.push(new_sv(self.eval_scalar(e)?)); }
					}
					Some(b'*') => {
						let v = if let ExprKind::Bareword(name) = &ungroup(e).kind { Value::Glob(self.glob(name)) } else { self.eval_scalar(e)? };
						out.push(new_sv(v));
					}
					Some(b'+' ) => {
						let v = match &ungroup(e).kind {
							ExprKind::Variable(Sigil::Array, _) | ExprKind::Deref(Sigil::Array, _) => Value::Ref(Ref::Array(self.eval_array(e)?)),
							ExprKind::Variable(Sigil::Hash, _) | ExprKind::Deref(Sigil::Hash, _) => Value::Ref(Ref::Hash(self.eval_hash(e)?)),
							_ => self.eval_scalar(e)?,
						};
						out.push(new_sv(v));
					}
					Some(b'@' | b'%') => { out.extend(self.eval_aliases(e)?); }
					_ => out.extend(self.eval_aliases(e)?),
				}
			}
			if specs.peek() == Some(&b'_') && !proto.bytes.contains(&b';') { out.push(self.topic()); }
		} else if out.is_empty() { out = self.eval_aliases(args)?; } else { out.extend(self.eval_aliases(args)?); }
		Ok(InvokeArgs::Explicit(out))
	}

	pub(super) fn builtin_uses_core(&self, b: Builtin, origin: BuiltinOrigin) -> bool {
		origin == BuiltinOrigin::Core || origin == BuiltinOrigin::Implicit && self.global_override(b).is_none()
	}

	/// The `CORE::GLOBAL::NAME` override of a builtin, if one is defined.
	pub(super) fn global_override(&self, b: Builtin) -> Option<Cv> {
		// No such stash means no override (the common case): skip building and qualifying the name.
		let generation = self.symbol_generation;
		let exists = match self.core_global.get() {
			Some((seen, exists)) if seen == generation => exists,
			_ => { let exists = self.stashes.contains_key("CORE::GLOBAL"); self.core_global.set(Some((generation, exists))); exists }
		};
		if !exists { return None; }
		self.named_code(&format!("CORE::GLOBAL::{}", b.name()))
	}

	pub(super) fn eval_call(&mut self, call: &Call, cx: Cx) -> PResult<Ret> {
		match &call.target {
			CallTarget::Builtin(b, origin) => {
				if *origin != BuiltinOrigin::Core && let Some(cv) = self.global_override(*b) {
					let args = self.call_args(call, false, call.prototype.as_ref())?;
					return self.call_sub_kind(&cv, args, cx, false);
				}
				if *origin == BuiltinOrigin::Global { return Err(self.die_msg(format!("Undefined subroutine &CORE::GLOBAL::{} called", b.name()))); }
				if let Some(result) = self.core_call(*b, call, cx) { return result; }
				func::call(self, *b, call, cx)
			}
			CallTarget::Named(name, amp) => {
				let args = self.call_args(call, *amp, call.prototype.as_ref())?;
				if let Some(cv) = self.named_code(name) { self.call_sub_kind(&cv, args, cx, false) } else { self.call_undefined(name, args, cx) }
			}
			CallTarget::Code(code, amp) => {
				let value = self.eval_scalar(code)?;
				let value = self.overload_deref(Sigil::Code, value)?;
				let Some(cv) = self.code_value(&value, true)? else { return Err(self.die_msg("Not a CODE reference")); };
				let args = self.call_args(call, *amp, None)?;
				self.call_sub_kind(&cv, args, cx, false)
			}
			CallTarget::Method(object, method) => {
				let invocant = match &ungroup(object).kind {
					ExprKind::Bareword(class) => new_sv(Value::str(class.strip_suffix("::").unwrap_or(class))),
					ExprKind::Variable(Sigil::Scalar, _) | ExprKind::Deref(Sigil::Scalar, _)
					| ExprKind::Select(_, Select::ArrayElement(_) | Select::HashElement(_), _) => {
						self.eval_match_cell(object)?.unwrap_or_else(|| new_sv(Value::Undef))
					}
					_ => new_sv(self.eval_scalar(object)?),
				};
				let dynamic = if let Method::Dynamic(e) = method { Some(self.eval_scalar(e)?) } else { None };
				let mut args = self.call_args(call, false, None)?.into_vec();
				match (method, dynamic) {
					(Method::Name(name), _) => self.invoke_method(invocant, name, args, cx),
					(_, Some(Value::Ref(Ref::Code(cv)))) => {
						args.insert(0, invocant);
						self.call_sub(&cv, args, cx)
					}
					(_, Some(value)) => {
						let name = self.stringify(&value)?;
						self.invoke_method(invocant, &name.to_string_lossy(), args, cx)
					}
					_ => Err(self.die_msg("Invalid method call")),
				}
			}
		}
	}

	pub(super) fn named_lvalue(&self, name: &str) -> bool {
		self.named_code(name).is_some_and(|cv| {
			let default = matches!(&*cv.body.borrow(), CodeImpl::Perl(body) if body.lvalue);
			self.code_is_lvalue(&cv, default)
		})
	}

	pub(super) fn call_lvalue(&mut self, call: &Call) -> PResult<Option<Sv>> {
		let (cv, inherit) = match &call.target {
			CallTarget::Named(name, amp) => (self.named_code(name), *amp),
			CallTarget::Code(source, amp) => { let value = self.eval_scalar(source)?; (self.code_value(&value, true)?, *amp) }
			// `CLASS->method = ...` / `$obj->method = ...` with an lvalue method.
			CallTarget::Method(object, Method::Name(method)) => {
				let invocant = match &ungroup(object).kind {
					ExprKind::Bareword(class) => Value::str(class.strip_suffix("::").unwrap_or(class)),
					_ => self.eval_scalar(object)?,
				};
				let class = match &invocant {
					Value::Ref(r) => r.blessed().ok_or_else(|| self.die_msg(format!("Can't call method \"{method}\" on unblessed reference")))?,
					v => Rc::from(v.to_pstr().to_string_lossy().as_ref()),
				};
				let Some(cv) = self.find_method(&class, method) else {
					return Err(self.die_msg(format!("Can't locate object method \"{method}\" via package \"{class}\"")));
				};
				let mut args = self.call_args(call, false, None)?.into_vec();
				args.insert(0, new_sv(invocant));
				let result = self.call_sub_kind(&cv, InvokeArgs::Explicit(args), Cx::Scalar, true)?.scalar();
				return Ok(match result { Value::Ref(Ref::Scalar(s)) => Some(s), _ => None });
			}
			_ => return Ok(None),
		};
		let Some(cv) = cv else { return Ok(None); };
		let args = self.call_args(call, inherit, call.prototype.as_ref())?;
		Ok(match self.call_sub_kind(&cv, args, Cx::Scalar, true)?.scalar() { Value::Ref(Ref::Scalar(s)) => Some(s), _ => None })
	}

	/// Calls a named lvalue sub in list context: references to the scalars, arrays and hashes it returns (see `lvalue_result`).
	pub(super) fn call_lvalue_list(&mut self, call: &Call) -> PResult<Vec<Value>> {
		let CallTarget::Named(name, inherit) = &call.target else { return Ok(Vec::new()); };
		let Some(cv) = self.named_code(name) else { return Ok(Vec::new()); };
		let args = self.call_args(call, *inherit, call.prototype.as_ref())?;
		Ok(self.call_sub_kind(&cv, args, Cx::List, true)?.list())
	}

	fn core_call(&mut self, b: Builtin, call: &Call, cx: Cx) -> Option<PResult<Ret>> {
		use Builtin as B;
		Some(match b {
			B::Defined | B::Scalar | B::Undef | B::Exists | B::Delete | B::Wantarray | B::Next | B::Last | B::Redo | B::Return | B::Goto |
			B::Exit | B::Dump | B::Die | B::Warn | B::Eval | B::Evalbytes | B::Require | B::Do | B::Caller | B::Bless | B::Prototype |
			B::Break | B::Continue | B::Map | B::Grep | B::Sort | B::Import | B::Tie | B::Tied | B::Untie | B::Lock => self.core_builtin(b, call, cx),
			_ => return None,
		})
	}

	fn core_builtin(&mut self, b: Builtin, call: &Call, cx: Cx) -> PResult<Ret> {
		use Builtin as B;
		let expr = call.args.as_deref().filter(|e| !matches!(&ungroup(e).kind, ExprKind::List(items) if items.is_empty()));
		let value = match b {
			B::Defined => {
				let is_defined = match expr.map(ungroup).map(|e| &e.kind) {
					Some(ExprKind::Variable(Sigil::Code, name) | ExprKind::Call(Call { target: CallTarget::Named(name, true), args: None, .. })) =>
						self.named_code(name).is_some_and(|c| !matches!(*c.body.borrow(), CodeImpl::Undefined)),
					Some(ExprKind::Deref(Sigil::Glob, source)) => self.defined_glob_deref(source)?,
					Some(ExprKind::Deref(Sigil::Code, source) | ExprKind::Call(Call { target: CallTarget::Code(source, true), args: None, .. })) =>
						self.exempt_code(source, false)?.is_some_and(|c| !matches!(*c.body.borrow(), CodeImpl::Undefined)),
					_ => !self.scalar_or_topic(expr)?.is_undef(),
				};
				perl_bool(is_defined)
			}
			B::Scalar => if let Some(e) = expr { self.eval_scalar(e)? } else { Value::Undef },
			B::Undef => { if let Some(e) = expr { self.undef_target(e)?; } Value::Undef }
			B::Exists => perl_bool(if let Some(e) = expr { self.exists(e)? } else { false }),
			B::Delete => return if let Some(e) = expr { self.delete(e, cx) } else { Ok(Ret::no_value(cx)) },
			B::Wantarray => self.eval_contexts.last().and_then(|&(cx, _)| context_flag(cx)).map_or(Value::Undef, perl_bool),
			B::Return => {
				let (cx, lvalue) = self.eval_contexts.last().copied().ok_or_else(|| self.die_msg("Can't return outside a subroutine"))?;
				let result = if lvalue {
					let e = expr.ok_or_else(|| self.die_msg("Can't return undef from lvalue subroutine"))?;
					self.lvalue_result(e, cx)?
				} else if let Some(e) = expr { self.eval(e, cx)? } else { Ret::no_value(cx) };
				return Err(Flow::Return(result));
			}
			B::Next | B::Last | B::Redo => {
				let label = if let Some(e) = expr { let v = self.eval_scalar(e)?; Some(Rc::from(self.stringify(&v)?.to_string_lossy().as_ref())) } else { None };
				return Err(match b { B::Next => Flow::Next(label), B::Last => Flow::Last(label), _ => Flow::Redo(label) });
			}
			B::Goto => {
				let Some(e) = expr else { return Err(self.die_msg("goto must have label")); };
				let v = if let ExprKind::Deref(Sigil::Code, source) = &ungroup(e).kind {
					let value = self.eval_scalar(source)?;
					match self.exempt_code_value(value.clone(), false)? {
						Some(cv) => Value::Ref(Ref::Code(cv)),
						None => return Err(self.die_msg(format!("Goto undefined subroutine &{}", self.qualify(&value.to_pstr().to_string_lossy())))),
					}
				} else { self.eval_scalar(e)? };
				if let Value::Ref(Ref::Code(cv)) = v {
					self.tail_args = self.active_subs.last().map(|(_, av, _)| av.clone());
					return Err(Flow::Goto(GotoTarget::Sub(cv)));
				}
				return Err(Flow::Goto(GotoTarget::Label(Rc::from(self.stringify(&v)?.to_string_lossy().as_ref()))));
			}
			B::Break | B::Continue => return Err(self.break_when(b == B::Continue)),
			B::Exit => return Err(Flow::Exit(if let Some(e) = expr { self.eval_scalar(e)?.to_i64() as i32 } else { 0 })),
			B::Dump => return Err(self.die_msg("dump is not supported")),
			B::Die | B::Warn => {
				let values = if let Some(e) = expr { self.eval_list(e)? } else { Vec::new() };
				if let [v @ Value::Ref(_)] = values.as_slice() {
					if b == B::Die { return Err(self.die_value(v.clone())); }
					self.emit_warning_value(v.clone());
					return Ok(Ret::One(Value::Int(1)));
				}
				let mut message = PStr::default();
				for v in &values { message.push(&self.stringify(v)?); }
				if message.is_empty() {
					let prior = self.special_value("main::@");
					if let Value::Ref(r) = &prior {
						if b == B::Warn {
							self.emit_warning_value(prior);
							return Ok(Ret::One(Value::Int(1)));
						}
						let propagated = if let Some(pkg) = r.blessed()
							&& let Some(method) = self.find_method(&pkg, "PROPAGATE") {
							let loc = self.location();
							let args = vec![new_sv(prior), new_sv(Value::str(&loc.file)), new_sv(Value::Int(i64::from(loc.line)))];
							self.with_eval(Cx::Scalar, None, false, |this| this.call_sub(&method, args, Cx::Scalar))?.scalar()
						} else { prior };
						return Err(self.die_value(propagated));
					}
					let prior = prior.to_pstr();
					if prior.is_empty() {
						message = PStr::from_bytes(if b == B::Warn { b"Warning: something's wrong" } else { b"Died" });
					} else {
						message = prior;
						message.push_bytes(if b == B::Warn { b"\t...caught" } else { b"\t...propagated" });
					}
				}
				if b == B::Die { return Err(self.die_value(Value::Str(message))); }
				self.emit_warning(message);
				Value::Int(1)
			}
			B::Eval | B::Evalbytes => {
				let v = self.scalar_or_topic(expr)?;
				let mut source = self.stringify(&v)?;
				if b == B::Evalbytes {
					let Some(bytes) = source.downgraded() else { return Err(self.die_msg("Wide character in evalbytes")); };
					source = PStr::new(bytes, false);
				}
				return self.eval_string_mode(&source, cx, b == B::Evalbytes);
			}
			B::Require => {
				if let Some(e) = expr {
					match &ungroup(e).kind {
						ExprKind::Bareword(name) => {
							self.stash(name);
							return self.require_file(&format!("{}.pm", name.replace("::", "/")), Some(name)).map(Ret::One);
						}
						ExprKind::Int(_) | ExprKind::UInt(_) | ExprKind::Float(_) | ExprKind::Version(_) => {
							let version = self.eval_scalar(e)?;
							self.check_perl_version(&version)?;
						}
						_ => {
							let v = self.eval_scalar(e)?;
							// pp_require: a numeric operand is a version check, not a file name.
							if matches!(v, Value::Int(_) | Value::UInt(_) | Value::Num(_)) {
								self.check_perl_version(&v)?;
								return Ok(Ret::One(Value::Int(1)));
							}
							let name = self.stringify(&v)?;
							return self.require_file(&name.to_string_lossy(), None).map(Ret::One);
						}
					}
				} else {
					let topic = self.topic();
					let v = self.read_sv(&topic)?;
					let filename = self.stringify(&v)?;
					return self.require_file(&filename.to_string_lossy(), None).map(Ret::One);
				}
				Value::Int(1)
			}
			B::Do => {
				let v = self.scalar_or_topic(expr)?;
				let file = self.stringify(&v)?;
				return self.do_file(&file.to_string_lossy(), cx);
			}
			B::Caller => {
				let level = if let Some(e) = expr { self.eval_scalar(e)?.to_i64() } else { 0 };
				return self.caller_builtin(expr.is_some(), level, cx);
			}
			B::Bless => {
				let args = expr.map(|e| self.eval_list(e)).transpose()?.unwrap_or_default();
				let Some(Value::Ref(reference)) = args.first() else { return Err(self.die_msg("Can't bless non-reference value")); };
				let package = if let Some(class) = args.get(1) { Rc::from(self.stringify(class)?.to_string_lossy().as_ref()) } else { self.package() };
				self.bless_ref(reference, if package.is_empty() { Rc::from("main") } else { package });
				Value::Ref(reference.clone())
			}
			B::Prototype => {
				let v = if let Some(e) = expr {
					if let ExprKind::Bareword(name) = &ungroup(e).kind { Value::str(name) } else { self.eval_scalar(e)? }
				} else { let topic = self.topic(); self.read_sv(&topic)? };
				let core_name = match &v { Value::Ref(_) => None, v => v.to_pstr().to_string_lossy().strip_prefix("CORE::").map(str::to_owned) };
				if let Some(keyword) = core_name {
					match core_prototype(&keyword) {
						Some(proto) => proto.map_or(Value::Undef, Value::str),
						None => return Err(self.die_msg(format!("Can't find an opnumber for \"{keyword}\""))),
					}
				} else if let Some(cv) = self.code_value(&v, false)? {
					cv.prototype.borrow().clone().map_or(Value::Undef, Value::Str)
				} else { Value::Undef }
			}
			B::Sort => return self.sort_values(call, cx),
			B::Map | B::Grep => return self.transform(b == B::Grep, call, cx),
			B::Lock => if let Some(e) = expr {
				match &ungroup(e).kind {
					ExprKind::Variable(Sigil::Array, _) | ExprKind::Deref(Sigil::Array, _) => Value::Ref(Ref::Array(self.eval_array(e)?)),
					ExprKind::Variable(Sigil::Hash, _) | ExprKind::Deref(Sigil::Hash, _) => Value::Ref(Ref::Hash(self.eval_hash(e)?)),
					// `lock &sub` returns a reference to the sub without calling it.
					ExprKind::Variable(Sigil::Code, name) | ExprKind::Call(Call { target: CallTarget::Named(name, true), args: None, .. }) =>
						match self.variable_slot(Sigil::Code, name)? { Slot::Code(cv) => Value::Ref(Ref::Code(cv)), _ => Value::Undef },
					_ => self.eval_scalar(e)?,
				}
			} else { Value::Undef },
			B::Tie | B::Tied | B::Untie => self.tie_builtin(b, expr)?,
			B::Import => {
				let args = expr.map(|e| self.eval_list(e)).transpose()?.unwrap_or_default();
				let mut args = args.into_iter();
				if let Some(invocant) = args.next() { return self.call_method(invocant, "import", args.collect(), cx); }
				Value::Undef
			}
			_ => return Err(self.die_msg(format!("Unsupported function {}", b.name()))),
		};
		Ok(Ret::One(value))
	}

	fn scalar_or_topic(&mut self, expr: Option<&Expr>) -> PResult<Value> {
		if let Some(e) = expr { self.eval_scalar(e) }
		else { let topic = self.topic(); self.read_sv(&topic) }
	}

	fn caller_builtin(&mut self, explicit: bool, level: i64, cx: Cx) -> PResult<Ret> {
		let Some(level) = usize::try_from(level).ok() else { return Ok(Ret::no_value(cx)); };
		let frame = if explicit && cx == Cx::List && self.package.as_ref() == "DB" { self.caller_frame(level) }
			else { self.frames.iter().rev().nth(level).map(|f| f.info.clone()) };
		let Some(frame) = frame else { return Ok(Ret::no_value(cx)); };
		if cx != Cx::List { return Ok(Ret::One(Value::str(&frame.package))); }
		let mut out = vec![Value::str(&frame.package), Value::str(&frame.file), Value::Int(i64::from(frame.line))];
		if explicit {
			if self.package.as_ref() == "DB" && let Some(args) = frame.args { self.av("DB::args").replace_elems(aliases(args)); }
			let hint_bits = self.frames.iter().rev().nth(level).map_or(0, |frame| frame.hints.bitmask(frame.outer));
			let hints = self.caller_hints(level);
			let warnings = hints.and_then(|h| h.warnings.packed()).map_or(Value::Undef, Value::Str);
			let entries = hints.map_or_else(Vec::new, Hints::lexical_entries);
			let hash = if entries.is_empty() { Value::Undef } else {
				let h = new_hv();
				h.entries_mut().extend(entries.into_iter().map(|(key, value)| (hash_key(&key), new_sv(value))));
				Value::Ref(Ref::Hash(h))
			};
			out.extend([
				frame.sub.as_deref().map_or(Value::Undef, Value::str), perl_bool(frame.has_args), frame.wantarray.map_or(Value::Undef, perl_bool),
				frame.eval_text.map_or(Value::Undef, Value::Str),
				if frame.sub.as_deref() == Some("(eval)") { perl_bool(frame.is_require) } else { Value::Undef },
				Value::Int(hint_bits), warnings, hash,
			]);
		}
		Ok(Ret::Many(out))
	}

	pub(super) fn eval_block(&mut self, block: &Block, cx: Cx) -> PResult<Ret> {
		self.with_eval(cx, None, false, |this| this.run_block(block, cx))
	}

	/// Capture a regex action's lexical environment in a callable block.
	pub fn regex_code(&mut self, block: Rc<Block>) -> Cv {
		let pad = self.capture_pad(Some(&block));
		let sub = Subroutine { name: None, scope: None, prototype: None, signature: None, attributes: Vec::new(), body: Some(block) };
		self.make_sub(&sub, None, pad)
	}

	/// Execute a regex action in its lexical environment but using the caller's `@_` and match.
	pub fn run_regex_code(&mut self, cv: &Cv) -> PResult<Value> {
		let body = cv.body.borrow().clone();
		let CodeImpl::Perl(body) = body else { return self.call_sub(cv, Vec::new(), Cx::Scalar).map(Ret::scalar); };
		let pad = self.enter_pad(&body.pad);
		let loc = self.location();
		let persistent = std::mem::replace(&mut self.persistent, body.persistent.clone());
		let result = self.scoped(|i| {
			i.package = body.package.clone();
			i.active_hints = body.hints.clone();
			i.run_statements(&body.block, Cx::Scalar)
		});
		self.leave_pad(pad);
		self.persistent = persistent;
		self.loc = loc;
		result.map(Ret::scalar)
	}

	/// Compile dynamically interpolated regex code with the caller's lexical hints.
	pub fn compile_regex_text(&mut self, source: &PStr, extended: bool) -> PResult<Rc<Program>> {
		let package = self.package();
		let hints = Hints::clone(&self.active_hints);
		let parse_hints = parser_hints(&hints);
		self.eval_serial += 1;
		let file = format!("(eval {})", self.eval_serial);
		self.parse_unit(hints, true, |this| parser::parse_regex_eval(source, &file, 1, &package, parse_hints, extended, this))
	}

	/// Compile and evaluate a string in the caller's package and lexical scope.
	pub fn eval_string(&mut self, source: &PStr, cx: Cx) -> PResult<Ret> {
		self.eval_string_mode(source, cx, false)
	}

	fn eval_string_mode(&mut self, source: &PStr, cx: Cx, bytes: bool) -> PResult<Ret> {
		let package = self.package();
		let hints = Hints::clone(&self.active_hints);
		let mut parse_hints = parser_hints(&hints);
		if bytes || hints.features.unicode_eval { parse_hints.utf8 = false; }
		self.eval_serial += 1;
		let file = format!("(eval {})", self.eval_serial);
		self.with_eval(cx, Some(source.clone()), false, |this| {
			let program = this.parse_unit(hints, true, |this| parser::parse_eval(source, &file, 1, &package, parse_hints, this))?;
			this.run_block(&program.body, cx)
		})
	}

	pub(super) fn with_eval(&mut self, cx: Cx, source: Option<PStr>, require: bool, f: impl FnOnce(&mut Self) -> PResult<Ret>) -> PResult<Ret> {
		self.frames.push(self.frame(Some(Rc::from("(eval)")), cx, false, source, require, None));
		self.eval_contexts.push((cx, false));
		let error = self.sv("main::@");
		error.replace(Value::bytes(b""));
		let saved_location = self.location();
		let out = f(self);
		self.loc = saved_location;
		self.eval_contexts.pop();
		self.frames.pop();
		// A `goto`/`last`/`next`/`redo` whose label no compiled code has dies where it was raised, inside this eval.
		let out = match out {
			Err(Flow::Goto(GotoTarget::Label(label))) if !self.label_known(&label) => Err(self.die_msg(format!("Can't find label {label}"))),
			Err(flow @ (Flow::Last(Some(_)) | Flow::Next(Some(_)) | Flow::Redo(Some(_)))) => {
				let (action, label) = match &flow {
					Flow::Last(Some(l)) => ("last", l.clone()), Flow::Next(Some(l)) => ("next", l.clone()), Flow::Redo(Some(l)) => ("redo", l.clone()),
					_ => ("last", Rc::from("")),
				};
				if self.label_known(&label) { Err(flow) } else { Err(self.die_msg(format!("Label not found for \"{action} {label}\""))) }
			}
			out => out,
		};
		match out {
			Err(Flow::Die(v)) if !require => { error.replace(v); Ok(Ret::no_value(cx)) }
			Ok(v) | Err(Flow::Return(v)) => { error.replace(Value::bytes(b"")); Ok(v.in_context(cx)) }
			out => out,
		}
	}

	fn check_perl_version(&mut self, v: &Value) -> PResult<()> {
		let parts = if let Value::Str(s) = v { s.chars().map(u64::from).collect::<Vec<_>>() }
		else { super::object::version_parts(v).map_or_else(Vec::new, |(_, parts)| parts) };
		let want: Vec<_> = parts.into_iter().chain(std::iter::repeat(0)).take(3).collect();
		if want.as_slice() > [5, 34, 1].as_slice() {
			let version = want.iter().map(u64::to_string).collect::<Vec<_>>().join(".");
			return Err(self.die_msg(format!("Perl v{version} required--this is only v5.34.1, stopped")));
		}
		Ok(())
	}

	fn use_stmt(&mut self, pkg: &str, use_: &Rc<Use>) -> PResult<Vec<parser::Imported>> {
		let existing: FxHashMap<_, _> = self.symbols.iter().filter(|(_, g)| g.pkg.as_ref() == pkg)
			.filter_map(|(name, g)| Some((name.clone(), g.code.borrow().clone()?))).collect();
		if let Some(module) = &use_.module {
			self.require_module(module)?;
			let method = if use_.negated { "unimport" } else { "import" };
			if let Some(version) = &use_.version {
				self.call_method(Value::str(module), "VERSION", vec![Value::Str(version.clone())], Cx::Void)?;
			}
			let explicit = use_.args.as_ref().map(|e| self.eval_list(e)).transpose()?;
			if explicit.as_ref().is_none_or(|values| !values.is_empty()) {
				self.call_method(Value::str(module), method, explicit.unwrap_or_default(), Cx::Void)?;
			}
		} else if let Some(version) = &use_.version {
			let text = version.to_string_lossy();
			let v = if text.starts_with('v') || text.bytes().filter(|&b| b == b'.').count() > 1 {
				Value::Str(PStr::from_codepoints(text.trim_start_matches('v').split('.').filter_map(|s| s.parse::<u32>().ok())))
			} else { Value::Num(text.parse().unwrap_or(0.0)) };
			self.check_perl_version(&v)?;
			self.compile_hints.features.from_version(&version.bytes);
			if self.compile_hints.features.unicode_strings && !matches!(v, Value::Num(n) if n < 5.012) {
				self.compile_hints.strict_refs = true;
				self.compile_hints.strict_vars = true;
				self.compile_hints.strict_subs = true;
			}
		}
		let key = Rc::as_ptr(use_) as usize;
		self.use_hints.insert(key, Rc::new(self.compile_hints.clone()));
		let imported: Vec<_> = self.symbols.iter().filter(|(_, g)| g.pkg.as_ref() == pkg).filter_map(|(name, g)| {
			let code = g.code.borrow();
			let code = code.as_ref()?;
			if existing.get(name).is_some_and(|old| Rc::ptr_eq(old, code)) { return None; }
			Some(parser::Imported { name: name.clone(), prototype: code.prototype.borrow().clone() })
		}).collect();
		self.imported_symbols.extend(imported.iter().map(|sub| sub.name.clone()));
		Ok(imported)
	}

	fn begin_result<T>(&mut self, result: PResult<T>) -> Result<T, String> {
		let result = result.map_err(|flow| match flow {
			Flow::Die(v) => {
				let mut message = v.to_pstr();
				if message.bytes.last() != Some(&b'\n') { message.push_bytes(b"\n"); }
				message.push(&self.message_with_location(PStr::from_bytes(b"BEGIN failed--compilation aborted")));
				Flow::Die(Value::Str(message))
			}
			flow => flow,
		});
		self.hook_result(result)
	}

	fn hook_result<T>(&mut self, result: PResult<T>) -> Result<T, String> {
		result.map_err(|flow| {
			let error = match &flow { Flow::Die(value) => value.to_pstr().to_string_lossy().into_owned(), _ => "Control transfer during compilation".into() };
			self.compile_failure = Some(flow);
			error
		})
	}
}

impl parser::ParseHooks for Interp<'_> {
	fn compile_warning(&mut self, category: &str, default_on: bool, text: String) -> Result<(), String> {
		let saved = std::mem::replace(&mut self.active_hints, Rc::new(self.compile_hints.clone()));
		let enabled = self.warning_enabled(category, default_on);
		let fatal = enabled && self.active_hints.warnings.fatal(category);
		self.active_hints = saved;
		if fatal { return Err(text); }
		if enabled { self.emit_warning(PStr::from_str(&text)); }
		Ok(())
	}
	fn package_exists(&self, name: &str) -> bool {
		let name = name.strip_prefix("::").unwrap_or(name);
		self.has_package(name.strip_prefix("main::").filter(|rest| !rest.is_empty()).unwrap_or(name))
	}

	fn custom_charname(&mut self, name: &str) -> Option<Result<PStr, String>> {
		let hints = self.lookup_glob("main::^H")?.hash.borrow().clone();
		let handler = hints.entries().get(&hash_key("charnames"))?.get();
		let Value::Ref(Ref::Code(cv)) = handler else { return None };
		let result = self.call_sub(&cv, vec![new_sv(Value::str(name))], Cx::Scalar).and_then(|r| { let v = r.scalar(); self.stringify(&v) });
		Some(result.map_err(|flow| match flow {
			Flow::Die(v) => v.to_pstr().to_string_lossy().into_owned(),
			_ => format!("Unknown charname '{name}'"),
		}))
	}

	fn use_module(&mut self, stmt: &Stmt, pkg: &str) -> Result<Vec<parser::Imported>, String> {
		let StmtKind::Use(use_) = &stmt.kind else { return Ok(Vec::new()); };
		self.glob(&format!("{pkg}::BEGIN"));
		let loc = std::mem::replace(&mut self.loc, stmt.location.clone());
		let result = self.scoped(|this| {
			this.package = Rc::from(pkg);
			this.active_hints = Rc::new(this.compile_hints.clone());
			let overlay = this.compile_overlay();
			this.extend_pad(overlay);
			this.use_stmt(pkg, use_)
		});
		let result = self.begin_result(result);
		self.loc = loc;
		result
	}

	fn begin_block(&mut self, block: &Rc<Block>, pkg: &str) -> Result<(), String> {
		// BEGIN is a real sub (perlmod): `return`, `__SUB__` and `caller` work inside it.
		let name: Rc<str> = Rc::from(format!("{pkg}::BEGIN"));
		self.glob(&name);
		let body = PerlBody { block: block.clone(), package: Rc::from(pkg), lexical_name: None, anon_name: Default::default(), signature: None,
			pad: self.compile_pad_snapshot(), hints: Rc::new(self.compile_hints.clone()), persistent: Rc::default(), lvalue: false };
		let cv = Rc::new(CodeBody { name: RefCell::new(Some(name)), pkg: Rc::from(pkg), prototype: RefCell::new(None),
			body: RefCell::new(CodeImpl::Perl(Rc::new(body))), blessed: RefCell::new(None) });
		let saved = std::mem::replace(&mut self.loc, block.location.clone());
		let result = self.call_sub(&cv, Vec::new(), Cx::Void).map(|_| ());
		self.loc = saved;
		self.begin_result(result)
	}

	fn phase_block(&mut self, phase: Phase, block: &Rc<Block>, pkg: &str) -> Result<(), String> {
		let result = self.queue_phase(phase, block, Rc::from(pkg));
		self.hook_result(result)
	}

	fn format_decl(&mut self, fmt: &Format, pkg: &str) -> Result<(), String> {
		let old = std::mem::replace(&mut self.package, Rc::from(pkg));
		let result = func::sys::define_format(self, fmt);
		self.package = old;
		result
	}

	fn sub_prototype(&self, qualified: &str) -> Option<Option<PStr>> { self.named_code(qualified).map(|cv| cv.prototype.borrow().clone()) }

	fn imported_sub_prototype(&self, pkg: &str, name: &str) -> Option<Option<PStr>> {
		let qualified = format!("{pkg}::{name}");
		if !self.imported_symbols.contains(qualified.as_str()) { return None; }
		self.sub_prototype(&qualified)
	}

	fn enter_scope(&mut self) {
		self.parse_scopes.push(self.compile_hints.clone());
		self.compile_pads.push(Pad::new());
	}

	fn leave_scope(&mut self) {
		if let Some(hints) = self.parse_scopes.pop() { self.compile_hints = hints; }
		self.compile_pads.pop();
	}

	fn lexical_decl(&mut self, declaration: &Expr, pkg: &str) { Interp::lexical_decl(self, declaration, pkg); }

	fn declare_package(&mut self, name: &str) { self.stash(name); }

	fn declare_sub(&mut self, sub: &Subroutine, pkg: &str) -> Result<(), String> {
		if matches!(sub.scope, Some(DeclKind::My | DeclKind::State)) { return Ok(()); }
		let Some(name) = &sub.name else { return Ok(()); };
		if matches!(name.rsplit("::").next().unwrap_or(name), "BEGIN" | "END" | "CHECK" | "UNITCHECK" | "INIT") { return Ok(()); }
		if sub.attributes.iter().any(|attr| attr.name.as_ref() == "const") {
			let flow = self.die_msg(":const is not permitted on named subroutines");
			return self.hook_result(Err::<(), Flow>(flow));
		}
		let written = name.clone();
		let name = if name.contains("::") { name.clone() } else { Rc::from(format!("{pkg}::{name}")) };
		let g = self.glob(&name);
		let existing = g.code.borrow().clone();
		if let Some(old) = existing {
			let location = sub.body.as_ref().map_or_else(|| self.loc.clone(), |b| b.location.clone());
			let at = |msg: String| format!("{msg} at {} line {}.\n", location.file, location.line);
			let old_proto = old.prototype.borrow().clone();
			// newATTRSUB: a stub declared without a prototype is assumed AUTOLOADed and not checked.
			let checked = old_proto.is_some() || !matches!(*old.body.borrow(), CodeImpl::Undefined);
			if checked && old_proto != sub.prototype {
				let shown = if sub.body.is_some() { name.clone() } else { written.clone() };
				let show = |p: &PStr| format!("({})", p.to_string_lossy());
				let msg = match (&old_proto, &sub.prototype) {
					(None, Some(new)) => format!("Prototype mismatch: sub {shown}: none vs {}", show(new)),
					(Some(old), None) => format!("Prototype mismatch: sub {shown} {} vs none", show(old)),
					(Some(old), Some(new)) => format!("Prototype mismatch: sub {shown} {} vs {}", show(old), show(new)),
					(None, None) => String::new(),
				};
				parser::ParseHooks::compile_warning(self, "prototype", true, at(msg))?;
			}
			if sub.body.is_some() && !matches!(*old.body.borrow(), CodeImpl::Undefined) {
				if is_constant_sub(&old) {
					parser::ParseHooks::compile_warning(self, "redefine", true, at(format!("Constant subroutine {written} redefined")))?;
				} else {
					parser::ParseHooks::compile_warning(self, "redefine", false, at(format!("Subroutine {written} redefined")))?;
				}
			}
		}
		let cv = self.code_slot(&g);
		if sub.prototype.is_some() { cv.prototype.replace(sub.prototype.clone()); }
		if sub.body.is_some() {
			let body = self.perl_body(sub, self.compile_pad_snapshot(), Rc::default(), Rc::from(pkg));
			cv.body.replace(body);
			self.apply_code_attributes(&cv, sub);
			self.mark_package_changed(&g.pkg);
		}
		// Attributes other than the built-in ones go through `use attributes PKG, \&sub, ATTRS` (MODIFY_CODE_ATTRIBUTES).
		let custom: Vec<Value> = sub.attributes.iter().filter(|attr| !matches!(attr.name.as_ref(), "lvalue" | "method" | "const" | "prototype"))
			.map(|attr| {
				let mut text = PStr::from_str(&attr.name);
				if let Some(args) = &attr.args { text.push_bytes(b"("); text.push(args); text.push_bytes(b")"); }
				Value::Str(text)
			}).collect();
		if !custom.is_empty() {
			let result = self.require_module("attributes").and_then(|()| {
				let mut args = vec![Value::str(pkg), Value::Ref(Ref::Code(cv.clone()))];
				args.extend(custom);
				self.call_method(Value::str("attributes"), "import", args, Cx::Void)
			});
			self.hook_result(result)?;
		}
		Ok(())
	}
}

/// A constant sub: a `use constant` value or a `()`-prototyped body holding one literal (perlsub "Constant Functions").
pub(super) fn is_constant_sub(cv: &Cv) -> bool {
	match &*cv.body.borrow() {
		CodeImpl::Constant(_) => true,
		CodeImpl::Perl(body) => cv.prototype.borrow().as_ref().is_some_and(PStr::is_empty)
			&& matches!(body.block.stmts.as_slice(), [Stmt { kind: StmtKind::Expr(Expr {
				kind: ExprKind::Int(_) | ExprKind::UInt(_) | ExprKind::Float(_) | ExprKind::String(_), .. }), .. }]),
		_ => false,
	}
}

/// A format argument line compiled where its format is declared: formats close over the lexicals in scope there,
/// like named subs (perlform). Built by `Interp::compile_format_args`, run by `Interp::eval_format_args`.
pub(in crate::perl) struct FormatArgs {
	program: Rc<Program>,
	pad: Pad,
	package: Rc<str>,
	hints: Rc<Hints>,
}

impl Interp<'_> {
	/// Compiles one format argument line (call while the format declaration is compiled), capturing the
	/// enclosing lexical scope. Err is the compilation diagnostic.
	pub fn compile_format_args(&mut self, source: &PStr, file: &str, line: u32) -> Result<FormatArgs, String> {
		let package = self.package();
		let hints = if self.compile_depth != 0 { Rc::new(self.compile_hints.clone()) } else { self.active_hints.clone() };
		let parse_hints = parser_hints(&hints);
		let pad = self.compile_pad_snapshot();
		let unit_hints = Hints::clone(&hints);
		let result = self.scoped(|this| {
			let overlay = this.compile_overlay();
			this.extend_pad(overlay);
			this.parse_unit(unit_hints, true, |this| parser::parse_eval(source, file, line, &package, parse_hints, this))
		});
		match result {
			Ok(program) => Ok(FormatArgs { program, pad, package: self.package(), hints }),
			Err(Flow::Die(v)) => Err(v.to_pstr().to_string_lossy().into_owned()),
			Err(_) => Err(format!("Format argument line failed to compile at {file} line {line}.\n")),
		}
	}

	/// Evaluates a compiled format argument line in list context: aliases of the variables it names (so `^` fields
	/// can chop them), copies of other values.
	pub fn eval_format_args(&mut self, args: &FormatArgs) -> PResult<Vec<Sv>> {
		let outer = self.enter_pad(&args.pad);
		let package = std::mem::replace(&mut self.package, args.package.clone());
		let hints = std::mem::replace(&mut self.active_hints, args.hints.clone());
		// A format is sub-like: `return` in an argument line leaves it as Err(Flow::Return).
		self.eval_contexts.push((Cx::List, false));
		let result = self.scoped(|this| {
			let Some((last, before)) = args.program.body.stmts.split_last() else { return Ok(Vec::new()); };
			for stmt in before { this.run_statement(stmt, Cx::Void)?; }
			match &last.kind {
				StmtKind::Expr(e) => this.eval_aliases(e),
				_ => this.run_statement(last, Cx::List).map(|r| aliases(r.list())),
			}
		});
		self.eval_contexts.pop();
		self.active_hints = hints;
		self.package = package;
		self.leave_pad(outer);
		result
	}
}

/// `prototype("CORE::name")` for every keyword (perlsub "Overriding Built-in Functions"; oracle: t/op/cproto.t).
/// `None` = the keyword has no expressible prototype; names missing here are not keywords.
const CORE_PROTOTYPES: &[(&str, Option<&str>)] = &[
	("__FILE__", Some("")), ("__LINE__", Some("")), ("__PACKAGE__", Some("")), ("__DATA__", None), ("__END__", None), ("__SUB__", Some("")),
	("AUTOLOAD", None), ("BEGIN", None), ("DESTROY", None), ("END", None), ("INIT", None), ("CHECK", None),
	("abs", Some("_")), ("accept", Some("**")), ("alarm", Some("_")), ("and", None), ("atan2", Some("$$")), ("bind", Some("*$")),
	("binmode", Some("*;$")), ("bless", Some("$;$")), ("break", Some("")), ("caller", Some(";$")), ("chdir", Some(";$")), ("chmod", Some("@")),
	("chomp", None), ("chop", None), ("chown", Some("@")), ("chr", Some("_")), ("chroot", Some("_")), ("close", Some(";*")),
	("closedir", Some("*")), ("cmp", None), ("connect", Some("*$")), ("continue", Some("")), ("cos", Some("_")), ("crypt", Some("$$")),
	("dbmclose", Some("\\%")), ("dbmopen", Some("\\%$$")), ("default", None), ("defined", None), ("delete", None), ("die", Some("@")),
	("do", None), ("dump", Some("")), ("each", Some("\\[%@]")), ("else", None), ("elsif", None), ("endgrent", Some("")),
	("endhostent", Some("")), ("endnetent", Some("")), ("endprotoent", Some("")), ("endpwent", Some("")), ("endservent", Some("")), ("eof", Some(";*")),
	("eq", None), ("eval", None), ("evalbytes", Some("_")), ("exec", None), ("exists", None), ("exit", Some(";$")),
	("exp", Some("_")), ("fc", Some("_")), ("fcntl", Some("*$$")), ("fileno", Some("*")), ("flock", Some("*$")), ("for", None),
	("foreach", None), ("fork", Some("")), ("format", None), ("formline", Some("$@")), ("ge", None), ("getc", Some(";*")),
	("getgrent", Some("")), ("getgrgid", Some("$")), ("getgrnam", Some("$")), ("gethostbyaddr", Some("$$")), ("gethostbyname", Some("$")), ("gethostent", Some("")),
	("getlogin", Some("")), ("getnetbyaddr", Some("$$")), ("getnetbyname", Some("$")), ("getnetent", Some("")), ("getpeername", Some("*")), ("getpgrp", Some(";$")),
	("getppid", Some("")), ("getpriority", Some("$$")), ("getprotobyname", Some("$")), ("getprotobynumber", Some("$;")), ("getprotoent", Some("")), ("getpwent", Some("")),
	("getpwnam", Some("$")), ("getpwuid", Some("$")), ("getservbyname", Some("$$")), ("getservbyport", Some("$$")), ("getservent", Some("")), ("getsockname", Some("*")),
	("getsockopt", Some("*$$")), ("given", None), ("glob", Some("_;")), ("gmtime", Some(";$")), ("goto", None), ("grep", None),
	("gt", None), ("hex", Some("_")), ("if", None), ("index", Some("$$;$")), ("int", Some("_")), ("ioctl", Some("*$$")),
	("join", Some("$@")), ("keys", Some("\\[%@]")), ("kill", Some("@")), ("last", None), ("lc", Some("_")), ("lcfirst", Some("_")),
	("le", None), ("length", Some("_")), ("link", Some("$$")), ("listen", Some("*$")), ("local", None), ("localtime", Some(";$")),
	("lock", Some("\\[$@%&*]")), ("log", Some("_")), ("lstat", Some(";*")), ("lt", None), ("m", None), ("map", None),
	("mkdir", Some("_;$")), ("msgctl", Some("$$$")), ("msgget", Some("$$")), ("msgrcv", Some("$$$$$")), ("msgsnd", Some("$$$")), ("my", None),
	("ne", None), ("next", None), ("no", None), ("not", Some("$;")), ("oct", Some("_")), ("open", Some("*;$@")),
	("opendir", Some("*$")), ("or", None), ("ord", Some("_")), ("our", None), ("pack", Some("$@")), ("package", None),
	("pipe", Some("**")), ("pop", Some(";\\@")), ("pos", Some(";\\[$*]")), ("print", None), ("printf", None), ("prototype", Some("_")),
	("push", Some("\\@@")), ("q", None), ("qq", None), ("qr", None), ("quotemeta", Some("_")), ("qw", None),
	("qx", None), ("rand", Some(";$")), ("read", Some("*\\$$;$")), ("readdir", Some("*")), ("readline", Some(";*")), ("readlink", Some("_")),
	("readpipe", Some("_")), ("recv", Some("*\\$$$")), ("redo", None), ("ref", Some("_")), ("rename", Some("$$")), ("require", None),
	("reset", Some(";$")), ("return", None), ("reverse", Some("@")), ("rewinddir", Some("*")), ("rindex", Some("$$;$")), ("rmdir", Some("_")),
	("s", None), ("say", None), ("scalar", Some("$")), ("seek", Some("*$$")), ("seekdir", Some("*$")), ("select", None),
	("semctl", Some("$$$$")), ("semget", Some("$$$")), ("semop", Some("$$")), ("send", Some("*$$;$")), ("setgrent", Some("")), ("sethostent", Some("$")),
	("setnetent", Some("$")), ("setpgrp", Some(";$$")), ("setpriority", Some("$$$")), ("setprotoent", Some("$")), ("setpwent", Some("")), ("setservent", Some("$")),
	("setsockopt", Some("*$$$")), ("shift", Some(";\\@")), ("shmctl", Some("$$$")), ("shmget", Some("$$$")), ("shmread", Some("$$$$")), ("shmwrite", Some("$$$$")),
	("shutdown", Some("*$")), ("sin", Some("_")), ("sleep", Some(";$")), ("socket", Some("*$$$")), ("socketpair", Some("**$$$")), ("sort", None),
	("splice", Some("\\@;$$@")), ("split", None), ("sprintf", Some("$@")), ("sqrt", Some("_")), ("srand", Some(";$")), ("stat", Some(";*")),
	("state", None), ("study", Some("_")), ("sub", None), ("substr", Some("$$;$$")), ("symlink", Some("$$")), ("syscall", Some("$@")),
	("sysopen", Some("*$$;$")), ("sysread", Some("*\\$$;$")), ("sysseek", Some("*$$")), ("system", None), ("syswrite", Some("*$;$$")), ("tell", Some(";*")),
	("telldir", Some("*")), ("tie", Some("\\[$@%*]$@")), ("tied", Some("\\[$@%*]")), ("time", Some("")), ("times", Some("")), ("tr", None),
	("truncate", Some("$$")), ("uc", Some("_")), ("ucfirst", Some("_")), ("umask", Some(";$")), ("undef", Some(";\\[$@%&*]")), ("unless", None),
	("unlink", Some("@")), ("unpack", Some("$_")), ("unshift", Some("\\@@")), ("untie", Some("\\[$@%*]")), ("until", None), ("use", None),
	("utime", Some("@")), ("values", Some("\\[%@]")), ("vec", Some("$$$")), ("wait", Some("")), ("waitpid", Some("$$")), ("wantarray", Some("")),
	("warn", Some("@")), ("when", None), ("while", None), ("write", Some(";*")), ("x", None), ("xor", None),
	("y", None),
];

fn core_prototype(name: &str) -> Option<Option<&'static str>> {
	CORE_PROTOTYPES.iter().find(|(keyword, _)| *keyword == name).map(|&(_, proto)| proto)
}

fn parser_hints(hints: &Hints) -> parser::ParseHints {
	let mut parse = parser::ParseHints::default();
	parse.utf8 = hints.utf8;
	parse.strict = parser::StrictHints { refs: hints.strict_refs, vars: hints.strict_vars, subs: hints.strict_subs };
	for feature in ["say", "state", "switch", "fc", "signatures", "bitwise", "unicode_strings", "postderef_qq", "current_sub", "evalbytes", "isa", "try", "indirect", "declared_refs"] {
		parse.set_feature(feature.as_bytes(), hints.features.enabled(feature));
	}
	parse
}
