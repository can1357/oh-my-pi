//! Perl object method lookup and destruction (perlobj, mro).

use super::*;

fn next_method_sub(interp: &mut Interp<'_>, args: Vec<Sv>, cx: Cx) -> PResult<Ret> { interp.next_method_call(args, "next::method", cx) }
fn next_can_sub(interp: &mut Interp<'_>, args: Vec<Sv>, cx: Cx) -> PResult<Ret> { interp.next_method_call(args, "next::can", cx) }
fn maybe_next_method_sub(interp: &mut Interp<'_>, args: Vec<Sv>, cx: Cx) -> PResult<Ret> { interp.next_method_call(args, "maybe::next::method", cx) }

fn count_ref(r: &Ref) -> usize {
	match r {
		Ref::Scalar(v) => Rc::strong_count(v), Ref::Array(v) => Rc::strong_count(v), Ref::Hash(v) => Rc::strong_count(v),
		Ref::Code(v) => Rc::strong_count(v), Ref::Glob(v) => Rc::strong_count(v), Ref::Regexp(v) => Rc::strong_count(v),
		Ref::Io(v) => Rc::strong_count(v),
	}
}

impl Interp<'_> {
	pub(super) fn install_universal(&mut self) {
		for (name, f) in [("UNIVERSAL::isa", universal_isa as NativeFn), ("UNIVERSAL::can", universal_can),
			("UNIVERSAL::DOES", universal_does), ("UNIVERSAL::VERSION", universal_version),
			("next::method", next_method_sub), ("next::can", next_can_sub), ("maybe::next::method", maybe_next_method_sub)] {
			self.define_native(name, f);
		}
	}

	/// `next::method` and friends called as subs (`goto &next::method`, `next::can($self)`): the first argument is the invocant.
	fn next_method_call(&mut self, mut args: Vec<Sv>, op: &str, cx: Cx) -> PResult<Ret> {
		if args.is_empty() { return Err(self.die_msg(format!("Not enough arguments for {op}"))); }
		let invocant = args.remove(0);
		let class = match self.read_sv(&invocant)? {
			Value::Ref(r) => r.blessed().unwrap_or_else(|| Rc::from("main")),
			v => Rc::from(v.to_pstr().to_string_lossy().as_ref()),
		};
		let class = self.normalize_class(&class);
		self.next_method(invocant, &class, op, args, cx)
	}

	fn parents(&self, class: &str) -> Vec<Rc<str>> {
		self.lookup_glob(&format!("{class}::ISA")).map_or_else(Vec::new, |glob| {
			// An undefined or empty @ISA entry names the main stash (perl keeps this for compatibility).
			glob.array.borrow().elems().iter().map(|sv| {
				let s = sv.get().to_pstr();
				if s.is_empty() { Rc::from("main") } else { Rc::from(s.to_string_lossy().as_ref()) }
			}).collect()
		})
	}

	pub(super) fn mro_order(&self, class: &str) -> &'static str {
		if self.lookup_glob("mro::MRO").is_some_and(|g| g.hash.borrow().entries().get(&hash_key(class))
			.is_some_and(|sv| sv.get().to_pstr().bytes == b"c3")) { "c3" } else { "dfs" }
	}

	/// Compute the requested linear inheritance order, detecting cycles and inconsistent C3 order.
	pub fn linear_isa(&self, class: &str, order: &str) -> Result<Vec<Rc<str>>, String> {
		match order {
			"dfs" => {
				let mut seen = FxHashSet::default();
				let mut path = FxHashSet::default();
				let mut result = Vec::new();
				let mut pending = vec![(Rc::<str>::from(class), true)];
				while let Some((name, entering)) = pending.pop() {
					if !entering { path.remove(&name); continue; }
					if path.contains(&name) { return Err(format!("Recursive inheritance detected in package '{name}'")); }
					if !seen.insert(name.clone()) { continue; }
					result.push(name.clone());
					let parents = self.parents(&name);
					path.insert(name.clone());
					pending.push((name, false));
					pending.extend(parents.into_iter().rev().map(|parent| (parent, true)));
				}
				Ok(result)
			}
			"c3" => self.c3(Rc::from(class), &mut FxHashSet::default(), &mut FxHashMap::default()),
			_ => Err(format!("Invalid mro name: '{order}'")),
		}
	}

	fn c3(&self, class: Rc<str>, active: &mut FxHashSet<Rc<str>>, done: &mut FxHashMap<Rc<str>, Vec<Rc<str>>>) -> Result<Vec<Rc<str>>, String> {
		if let Some(path) = done.get(&class) { return Ok(path.clone()); }
		if active.len() >= 512 || !active.insert(class.clone()) { return Err(format!("Recursive inheritance detected in package '{class}'")); }
		let result = stacker::maybe_grow(128 * 1024, 2 * 1024 * 1024, || {
			let parents = self.parents(&class);
			let mut lines = Vec::with_capacity(parents.len() + 1);
			for parent in &parents { lines.push((self.c3(parent.clone(), active, done)?, 0)); }
			lines.push((parents, 0));
			let mut result = vec![class.clone()];
			loop {
				lines.retain(|(line, pos)| *pos < line.len());
				if lines.is_empty() { break; }
				let candidate = lines.iter().find_map(|(line, pos)| {
					let head = line.get(*pos)?;
					(!lines.iter().any(|(line, pos)| line[*pos + 1..].contains(head))).then(|| head.clone())
				});
				let Some(head) = candidate else { return Err(format!("Inconsistent hierarchy during C3 merge of class '{class}'")); };
				for (line, pos) in &mut lines {
					if line.get(*pos) == Some(&head) { *pos += 1; }
				}
				result.push(head);
			}
			Ok(result)
		});
		active.remove(&class);
		if let Ok(out) = &result { done.insert(class, out.clone()); }
		result
	}

	fn normalize_class(&self, class: &str) -> Rc<str> {
		let tail = class.strip_prefix("main::").or_else(|| class.strip_prefix("::")).unwrap_or(class);
		Rc::from(tail.strip_suffix("::").unwrap_or(tail))
	}

	fn next_method(&mut self, invocant: Sv, class: &str, op: &str, mut args: Vec<Sv>, cx: Cx) -> PResult<Ret> {
		let called_from = self.frames.iter().rev().find_map(|frame| {
			let name = frame.info.sub.as_deref()?;
			let (package, sub) = name.rsplit_once("::")?;
			(sub != "__ANON__").then(|| (Rc::<str>::from(package), Rc::<str>::from(sub)))
		});
		let Some((package, name)) = called_from else {
			return Err(self.die_msg("next::method/next::can/maybe::next::method must be used in method context"));
		};
		let path = self.linear_isa(class, "c3").map_err(|error| self.die_msg(error))?;
		let mut path = path.iter();
		let found = path.any(|item| item == &package);
		let next = found.then(|| {
			path.find_map(|package| {
				let cv = self.lookup_glob(&format!("{package}::{name}"))?.code.borrow().clone()?;
				let defined = !matches!(*cv.body.borrow(), CodeImpl::Undefined);
				defined.then_some(cv)
			})
		}).flatten();
		if op == "next::can" {
			return Ok(Ret::One(next.map_or(Value::Undef, |cv| Value::Ref(Ref::Code(cv)))));
		}
		if let Some(next) = next {
			args.insert(0, invocant);
			return self.call_sub(&next, args, cx);
		}
		if op == "maybe::next::method" { return Ok(Ret::no_value(cx)); }
		Err(self.die_msg(format!("No next::method '{name}' found for {class}")))
	}

	fn method_parts<'m>(&self, class: &str, method: &'m str) -> (Rc<str>, &'m str, bool) {
		if let Some((pkg, name)) = method.rsplit_once("::") {
			if pkg == "SUPER" { (self.package(), name, true) }
			else if let Some(pkg) = pkg.strip_suffix("::SUPER") { (Rc::from(pkg), name, true) }
			else { (Rc::from(pkg.strip_prefix("::").unwrap_or(pkg)), name, false) }
		} else { (Rc::from(class), method, false) }
	}

	fn method_lookup(&self, class: &str, method: &str, skip: bool) -> Result<Option<Cv>, String> {
		self.method_search(class, method, skip, |cv| !matches!(*cv.body.borrow(), CodeImpl::Undefined))
	}

	/// MRO walk (then UNIVERSAL) for the first code slot `accept`s; `skip` starts after `class` (SUPER::).
	fn method_search(&self, class: &str, method: &str, skip: bool, accept: impl Fn(&Cv) -> bool) -> Result<Option<Cv>, String> {
		let defined = |pkg: &str| self.lookup_code(&format!("{pkg}::{method}")).filter(|cv| accept(cv));
		if !skip && let Some(cv) = defined(class) { return Ok(Some(cv)); }
		if self.lookup_glob(&format!("{class}::ISA")).is_some() {
			for pkg in self.linear_isa(class, self.mro_order(class))?.into_iter().skip(1) {
				if let Some(cv) = defined(&pkg) { return Ok(Some(cv)); }
			}
		}
		if class != "UNIVERSAL" {
			if let Some(cv) = defined("UNIVERSAL") { return Ok(Some(cv)); }
			if self.lookup_glob("UNIVERSAL::ISA").is_some() {
				for pkg in self.linear_isa("UNIVERSAL", self.mro_order("UNIVERSAL"))?.into_iter().skip(1) {
					if let Some(cv) = defined(&pkg) { return Ok(Some(cv)); }
				}
			}
		}
		Ok(None)
	}

	/// Look up a defined method in the class's active MRO, including `UNIVERSAL`.
	pub fn find_method(&mut self, class: &str, method: &str) -> Option<Cv> {
		let class = self.normalize_class(class);
		let (start, method, super_) = self.method_parts(&class, method);
		match self.method_lookup(&start, method, super_) {
			Ok(c) => c,
			Err(msg) => { let err = self.die_msg(msg); self.defer(err); None }
		}
	}

	pub(super) fn isa(&mut self, class: &str, parent: &str) -> PResult<bool> {
		if parent == "UNIVERSAL" || parent == class { return Ok(true); }
		let class = self.normalize_class(class);
		let parent = self.normalize_class(parent);
		if class == parent { return Ok(true); }
		let lineage = self.linear_isa(&class, self.mro_order(&class)).map_err(|err| self.die_msg(err))?;
		if lineage.iter().any(|p| p == &parent) { return Ok(true); }
		let universal = self.linear_isa("UNIVERSAL", self.mro_order("UNIVERSAL")).map_err(|err| self.die_msg(err))?;
		Ok(universal.iter().any(|p| p == &parent))
	}

	/// Invoke a method on a class or an object.
	pub fn call_method(&mut self, invocant: Value, method: &str, args: Vec<Value>, cx: Cx) -> PResult<Ret> {
		self.call_method_aliases(invocant, method, aliases(args), cx)
	}

	pub(super) fn call_method_aliases(&mut self, invocant: Value, method: &str, args: Vec<Sv>, cx: Cx) -> PResult<Ret> {
		self.invoke_method(new_sv(invocant), method, args, cx)
	}

	pub(super) fn invoke_method(&mut self, mut invocant: Sv, method: &str, mut args: Vec<Sv>, cx: Cx) -> PResult<Ret> {
		let mut value = self.read_sv(&invocant)?;
		// pp_method: a string naming no package but a glob with an IO slot is that filehandle (`STDOUT->autoflush`).
		if let Value::Str(name) = &value && !name.is_empty() {
			let name = name.to_string_lossy().into_owned();
			if !self.has_package(name.strip_prefix("::").unwrap_or(&name))
				&& let Some(gv) = self.find_glob(&name) && gv.io.borrow().is_some() {
				value = Value::Ref(Ref::Glob(gv));
				invocant = new_sv(value.clone());
			}
		}
		let class = match &value {
			Value::Glob(_) => Ok(Rc::from("IO::File")),
			Value::Ref(r @ (Ref::Io(_) | Ref::Glob(_))) => Ok(r.blessed().unwrap_or_else(|| Rc::from("IO::File"))),
			Value::Ref(r) => r.blessed().ok_or_else(|| format!("Can't call method \"{method}\" on unblessed reference")),
			Value::Undef => Err(format!("Can't call method \"{method}\" on an undefined value")),
			v => {
				let name = v.to_pstr();
				if name.is_empty() { Err(format!("Can't call method \"{method}\" without a package or object reference")) }
				else { Ok(Rc::from(name.to_string_lossy().as_ref())) }
			}
		};
		let class = class.map_err(|msg| self.die_msg(msg))?;
		let class = self.normalize_class(&class);
		if matches!(method, "next::method" | "next::can" | "maybe::next::method") {
			return self.next_method(invocant, &class, method, args, cx);
		}
		if matches!(class.as_ref(), "IO::File" | "IO::Handle") { self.require_module(&class)?; }
		let (start, name, super_) = self.method_parts(&class, method);
		if let Some(cv) = self.method_lookup(&start, name, super_).map_err(|err| self.die_msg(err))? {
			args.insert(0, invocant);
			return self.call_sub(&cv, args, cx);
		}
		// gv_fetchmethod: a missing import/unimport is a no-op even when AUTOLOAD exists.
		if matches!(name, "import" | "unimport") { return Ok(Ret::no_value(cx)); }
		if name != "AUTOLOAD"
			&& let Some(cv) = self.method_lookup(&start, "AUTOLOAD", super_).map_err(|err| self.die_msg(err))? {
			let package = cv.name.borrow().as_deref().and_then(|n| n.rsplit_once("::")).map_or_else(|| cv.pkg.clone(), |(pkg, _)| Rc::from(pkg));
			self.sv(&format!("{package}::AUTOLOAD")).replace(Value::str(&format!("{start}::{name}")));
			args.insert(0, invocant);
			return self.call_sub(&cv, args, cx);
		}
		if name == "DESTROY" { return Ok(Ret::no_value(cx)); }
		Err(self.die_msg(format!("Can't locate object method \"{name}\" via package \"{start}\"")))
	}

	/// Bless a referent into a package and enroll it for automatic destruction.
	pub fn bless_ref(&mut self, r: &Ref, class: Rc<str>) {
		self.stash(&class);
		r.bless(class);
		self.track_object(r);
	}

	fn track_object(&mut self, r: &Ref) {
		let addr = r.addr();
		if self.objects.contains_key(&addr) || self.destroying.contains(&addr) { return; }
		if let Some(class) = r.blessed() && (!matches!(r, Ref::Regexp(_)) || self.method_lookup(&class, "DESTROY", false).ok().flatten().is_some()) {
			self.objects.insert(addr, r.clone());
		}
	}

	pub(super) fn track_ret(&mut self, r: &Ret) {
		match r {
			Ret::One(Value::Ref(r)) => self.track_object(r),
			Ret::Many(values) => for v in values { if let Value::Ref(r) = v { self.track_object(r); } },
			_ => {}
		}
	}

	pub(super) fn object_owners(&self, r: &Ref) -> usize {
		count_ref(r).saturating_sub(usize::from(self.objects.contains_key(&r.addr())))
	}

	pub(super) fn object_shared(&self, r: &Ref) -> bool {
		// The caller holds a temporary `Value` in addition to the lvalue's actual reference.
		count_ref(r) > 2 + usize::from(self.objects.contains_key(&r.addr()))
	}

	pub(super) fn drain_destructors(&mut self, global: bool) -> PResult<()> {
		if self.destroy_draining { return Ok(()); }
		if !self.tied_handles.is_empty() { self.tied_handles.retain(|_, (io, _)| io.strong_count() > 0); }
		if self.objects.is_empty() { return Ok(()); }
		self.destroy_draining = true;
		let result = self.drain_objects(global);
		self.destroy_draining = false;
		result
	}

	fn drain_objects(&mut self, global: bool) -> PResult<()> {
		let mut ready = Vec::new();
		let mut rounds = 0;
		loop {
			self.objects.retain(|_, r| {
				if global || count_ref(r) == 1 { ready.push(r.clone()); false } else { true }
			});
			if ready.is_empty() { return Ok(()); }
			rounds += 1;
			if rounds > 2048 { return Err(self.die_msg("Recursive object destruction")); }
			while let Some(object) = ready.pop() {
				let Some(class) = object.blessed() else { continue; };
				let destroy = self.method_lookup(&class, "DESTROY", false).map_err(|err| self.die_msg(err))?;
				let cv = if let Some(cv) = destroy { Some(cv) } else {
					let autoload = self.method_lookup(&class, "AUTOLOAD", false).map_err(|err| self.die_msg(err))?;
					if let Some(cv) = &autoload { self.sv(&format!("{}::AUTOLOAD", cv.pkg)).replace(Value::str(&format!("{class}::DESTROY"))); }
					autoload
				};
				let Some(cv) = cv else { continue; };
				let addr = object.addr();
				self.destroying.insert(addr);
				let saved_exception = self.special_value("main::@");
				let alias = self.readonly_alias(Value::Ref(object.clone()));
				let result = self.call_sub(&cv, vec![alias], Cx::Void).map(|_| ());
				self.destroying.remove(&addr);
				self.sv("main::@").replace(saved_exception);
				if !global && count_ref(&object) > 1 { self.track_object(&object); }
				match result {
					// die_unwind with G_KEEPERR: a `misc` warning under the hints where the exception was raised.
					Err(Flow::Die(_)) if !self.die_misc_warnings => {}
					Err(Flow::Die(v)) => {
						let mut message = PStr::from_bytes(b"\t(in cleanup) ");
						message.push(&v.to_pstr());
						self.emit_warning(message);
					}
					Err(Flow::Exit(n)) => return Err(Flow::Exit(n)),
					_ => {}
				}
			}
		}
	}
}

fn unary_arg(args: &[Sv], ix: usize) -> Value { args.get(ix).map_or(Value::Undef, read_sv) }

fn universal_isa(i: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let inv = unary_arg(&args, 0);
	let parent = unary_arg(&args, 1).to_pstr();
	let parent = parent.to_string_lossy();
	let yes = match &inv {
		Value::Ref(r) if r.kind_name() == parent => true,
		Value::Ref(r) => if let Some(class) = r.blessed() { i.isa(&class, &parent)? } else { false },
		Value::Undef => false,
		_ => {
			let class = inv.to_pstr();
			let class = i.normalize_class(&class.to_string_lossy());
			// sv_derived_from: a name without a stash still derives from UNIVERSAL and its parents.
			if class.is_empty() { false }
			else if i.stashes.contains_key(&class) { i.isa(&class, &parent)? }
			else { i.isa("UNIVERSAL", &parent)? }
		}
	};
	Ok(Ret::One(perl_bool(yes)))
}

fn universal_does(i: &mut Interp<'_>, args: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	let inv = unary_arg(&args, 0);
	let role = unary_arg(&args, 1);
	if let Value::Ref(r) = &inv && let Some(class) = r.blessed() {
		if role.to_pstr() == PStr::from_str(&class) { return Ok(Ret::One(perl_bool(true))); }
		return i.call_method(inv, "isa", vec![role], cx);
	}
	if let Value::Ref(_) = inv { return Err(i.die_msg("Can't call method \"DOES\" on unblessed reference")); }
	universal_isa(i, args, cx)
}

fn inv_blessed(v: &Value) -> Option<Rc<str>> { if let Value::Ref(r) = v { r.blessed() } else { None } }

fn universal_can(i: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let inv = unary_arg(&args, 0);
	let method = unary_arg(&args, 1).to_pstr();
	// Handles (globs with an IO slot, or a bareword naming one but no package) dispatch in IO::File.
	let io_class = || Some(Rc::<str>::from("IO::File"));
	let class = match &inv {
		Value::Glob(g) | Value::Ref(Ref::Glob(g)) if g.io.borrow().is_some() => inv_blessed(&inv).or_else(io_class),
		Value::Ref(Ref::Io(_)) => inv_blessed(&inv).or_else(io_class),
		Value::Ref(r) => r.blessed(),
		Value::Undef => None,
		v => {
			let name = v.to_pstr().to_string_lossy().into_owned();
			if !i.has_package(&name) && i.find_glob(&name).is_some_and(|g| g.io.borrow().is_some()) { io_class() }
			else { Some(Rc::from(name.as_str())) }
		}
	};
	if class.as_deref() == Some("IO::File") { i.require_module("IO::File")?; }
	// gv_fetchmeth: a forward declaration (`sub foo;`) is found too, so can() reports AUTOLOADed methods.
	// A name without a stash still inherits from UNIVERSAL (universal.c XS_UNIVERSAL_can).
	let class = class.filter(|c| !c.is_empty()).map(|c| i.normalize_class(&c))
		.map(|c| if i.stashes.contains_key(&c) { c } else { Rc::from("UNIVERSAL") });
	let cv = match class {
		Some(c) => {
			let method = method.to_string_lossy();
			let (start, name, super_) = i.method_parts(&c, &method);
			i.method_search(&start, name, super_, |_| true).map_err(|msg| i.die_msg(msg))?
		}
		None => None,
	};
	Ok(Ret::One(cv.map_or(Value::Undef, |cv| Value::Ref(Ref::Code(cv)))))
}

pub(super) fn version_parts(value: &Value) -> Option<(PStr, Vec<u64>)> {
	let source = value.to_pstr();
	let version = source.to_string_lossy();
	let text = version.strip_prefix('v').unwrap_or(&version);
	let text = text.trim_end().replace('_', "");
	let dotted = version.starts_with('v') || text.bytes().filter(|&b| b == b'.').count() >= 2;
	let (major, rest) = text.split_once('.').unwrap_or((text.as_str(), ""));
	let mut parts = vec![if major.is_empty() { 0 } else { major.parse().ok()? }];
	if dotted { for part in rest.split('.').filter(|s| !s.is_empty()) { parts.push(part.parse().ok()?); } }
	else {
		for chunk in rest.as_bytes().chunks(3) {
			let mut component = 0u64;
			for b in chunk { if !b.is_ascii_digit() { return None; } component = component * 10 + u64::from(*b - b'0'); }
			parts.push(component * 10u64.pow(3 - chunk.len() as u32));
		}
	}
	while parts.len() < 3 { parts.push(0); }
	while parts.len() > 3 && parts.last() == Some(&0) { parts.pop(); }
	Some((source, parts))
}

fn universal_version(i: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let inv = unary_arg(&args, 0);
	let class = match inv {
		Value::Ref(r) => r.blessed().ok_or_else(|| i.die_msg("Cannot determine local package"))?,
		v => Rc::from(v.to_pstr().to_string_lossy().as_ref()),
	};
	let version = i.special_value(&format!("{class}::VERSION"));
	if let Some(required) = args.get(1) {
		let required = read_sv(required);
		if version.is_undef() { return Err(i.die_msg(format!("{class} does not define ${class}::VERSION--version check failed"))); }
		let version_value = Value::Str(i.stringify(&version)?);
		let required_value = Value::Str(i.stringify(&required)?);
		let Some((required_text, want)) = version_parts(&required_value) else { return Err(i.die_msg("Invalid version format (non-numeric data)")); };
		let Some((version_text, have)) = version_parts(&version_value) else { return Err(i.die_msg("Invalid version format (non-numeric data)")); };
		if want > have { return Err(i.die_msg(format!("{class} version {} required--this is only version {}", required_text.to_string_lossy(), version_text.to_string_lossy()))); }
	}
	Ok(Ret::One(version))
}
