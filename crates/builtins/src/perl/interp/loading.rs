//! Perl compilation-unit loading and `@INC` hooks (perlfunc: require, do; perlvar).

use super::*;

struct ModuleSource {
	display: String,
	bytes: Vec<u8>,
	inc_value: Value,
}

impl Interp<'_> {
	/// Compile and execute a module source unit, returning its final value.
	pub fn load_source(&mut self, file: &str, src: &[u8]) -> PResult<Value> {
		match self.run_file_source(file, src, Cx::Scalar) {
			Ok(v) | Err(Flow::Return(v)) => Ok(v.scalar()), Err(flow) => Err(flow),
		}
	}

	fn run_file_source(&mut self, file: &str, src: &[u8], cx: Cx) -> PResult<Ret> {
		let saved = std::mem::take(&mut self.scopes);
		let persistent = std::mem::take(&mut self.persistent);
		let location = self.location();
		// A required or `do` file is compiled in the caller's current package.
		let package = self.package();
		let result = self.scoped(|this| {
			let program = this.parse_unit(this.default_hints.clone(), false, |this| parser::parse_program(src, file, &package, this))?;
			this.install_data(&program, false);
			this.package = program.package.clone();
			this.active_hints = Rc::new(this.default_hints.clone());
			this.run_statements(&program.body, cx)
		});
		self.loc = location;
		self.scopes = saved;
		self.persistent = persistent;
		result
	}

	/// Load a package through the native registry, then through `@INC`.
	pub fn require_module(&mut self, module: &str) -> PResult<()> {
		self.stash(module);
		self.require_file(&format!("{}.pm", module.replace("::", "/")), Some(module)).map(|_| ())
	}

	pub(super) fn require_file(&mut self, name: &str, module: Option<&str>) -> PResult<Value> {
		if name.is_empty() { return Err(self.die_msg("Missing or undefined argument to require")); }
		if self.loading.contains(name) { return Ok(Value::Int(1)); }
		let inc = self.hv("main::INC");
		let key = hash_key(name);
		let known = inc.entries().get(&key).map(read_sv);
		if let Some(value) = known {
			if value.is_undef() { return Err(self.die_msg(format!("Attempt to reload {name} aborted.\nCompilation failed in require"))); }
			return Ok(Value::Int(1));
		}
		self.loading.insert(Rc::from(name));
		let result = self.require_uncached(name, module, &inc, &key);
		self.loading.remove(name);
		result
	}

	fn require_uncached(&mut self, name: &str, module: Option<&str>, inc: &Hv, key: &HKey) -> PResult<Value> {
		let direct = direct_file(name);
		let inferred = if module.is_none() && !direct { name.strip_suffix(".pm").map(|s| s.replace('/', "::")) } else { None };
		let module = module.or(inferred.as_deref());
		if let Some(result) = module.and_then(|module| modules::require(self, module)) {
			if result.is_ok() { inc.entries_mut().entry(key.clone()).or_insert_with(|| new_sv(Value::str(name))); }
			return result.map(|()| Value::Int(1));
		}
		let Some(source) = self.find_source(name, direct)? else {
			if direct { return Err(self.die_msg(format!("Can't locate {name}"))); }
			let hint = module.filter(|v| v.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b':' | b'_')))
				.map_or_else(String::new, |module| format!(" (you may need to install the {module} module)"));
			let dirs: Vec<_> = self.av("main::INC").elems().iter().map(|v| v.get().to_pstr().to_string_lossy().into_owned()).collect();
			return Err(self.die_msg(format!("Can't locate {name} in @INC{hint} (@INC contains: {})", dirs.join(" "))));
		};
		inc.entries_mut().entry(key.clone()).or_insert_with(|| new_sv(source.inc_value));
		let result = self.with_eval(Cx::Scalar, Some(PStr::from_str(name)), true, |this| {
			this.run_file_source(&source.display, &source.bytes, Cx::Scalar)
		});
		match result {
			Ok(ret) => {
				let value = ret.scalar();
				if self.truthy(&value)? { return Ok(value); }
				inc.entries_mut().shift_remove(key);
				Err(self.die_msg(format!("{name} did not return a true value")))
			}
			Err(Flow::Die(Value::Str(mut text))) => {
				inc.entries_mut().insert(key.clone(), new_sv(Value::Undef));
				text.push(&self.message_with_location(PStr::from_bytes(b"Compilation failed in require")));
				Err(Flow::Die(Value::Str(text)))
			}
			Err(flow) => {
				inc.entries_mut().insert(key.clone(), new_sv(Value::Undef));
				Err(flow)
			}
		}
	}

	fn find_source(&mut self, name: &str, direct: bool) -> PResult<Option<ModuleSource>> {
		let open = |this: &Self, display: &str| {
			let path = this.resolve_path(display.as_bytes());
			this.host.fs().read(&path).ok().map(|bytes| ModuleSource {
				display: display.to_owned(), bytes, inc_value: Value::str(display),
			})
		};
		if direct && let Some(source) = open(self, name) { return Ok(Some(source)); }
		let dirs = self.av("main::INC").elems().clone();
		for dir in dirs {
			self.poll()?;
			let value = read_sv(&dir);
			if matches!(value, Value::Ref(_)) {
				if let Some(src) = self.inc_hook(value, name)? { return Ok(Some(src)); }
				continue;
			}
			if direct { continue; }
			let directory = self.stringify(&value)?;
			let directory = directory.to_string_lossy();
			let display = if directory.is_empty() { name.to_owned() } else if directory.ends_with('/') {
				format!("{directory}{name}")
			} else { format!("{directory}/{name}") };
			if let Some(src) = open(self, &display) { return Ok(Some(src)); }
		}
		Ok(None)
	}

	fn inc_hook(&mut self, hook: Value, name: &str) -> PResult<Option<ModuleSource>> {
		let Value::Ref(reference) = &hook else { return Ok(None); };
		let filename = Value::str(name);
		let out = if reference.blessed().is_some() {
			self.call_method(hook.clone(), "INC", vec![filename], Cx::List)?
		} else {
			let cv = match reference {
				Ref::Code(cv) => Some(cv.clone()),
				Ref::Array(av) => av.elems().first().and_then(|sv| match &sv.get() {
					Value::Ref(Ref::Code(cv)) => Some(cv.clone()), _ => None,
				}),
				_ => None,
			};
			let Some(cv) = cv else { return Ok(None); };
			self.call_sub(&cv, vec![new_sv(hook.clone()), new_sv(filename)], Cx::List)?
		};
		let returned = out.list();
		let mut returned = returned.as_slice();
		let mut content = PStr::default();
		let mut provided = false;
		if let Some(Value::Ref(Ref::Scalar(initial))) = returned.first() {
			content.push(&read_sv(initial).to_pstr());
			returned = &returned[1..];
			provided = true;
		}
		let io = match returned.first() {
			Some(Value::Ref(Ref::Io(io))) => Some(io.clone()),
			Some(Value::Glob(g) | Value::Ref(Ref::Glob(g))) => g.io.borrow().clone(),
			_ => None,
		};
		if io.is_some() || returned.first().is_some_and(Value::is_undef) { returned = &returned[1..]; }
		let filter = match returned.first() { Some(Value::Ref(Ref::Code(cv))) => Some(cv.clone()), _ => None };
		if filter.is_some() || io.is_some() {
			provided = true;
			let state = returned.get(1).cloned().unwrap_or(Value::Undef);
			let sep = RecordSep::default();
			let topic = new_sv(Value::Undef);
			loop {
				self.poll()?;
				let line = if let Some(io) = &io {
					let line = io.borrow_mut().read_record(&sep);
					let line = line.map_err(|err| self.die_msg(err.to_string()))?;
					let Some(line) = line else { break; };
					line
				} else { PStr::default() };
				let line = if let Some(filter) = &filter {
					topic.replace(Value::Str(line));
					let result = self.with_topic(topic.clone(), |this| {
						this.call_sub(filter, vec![new_sv(Value::Int(0)), new_sv(state.clone())], Cx::Scalar)
					})?.scalar();
					if !self.truthy(&result)? { break; }
					read_sv(&topic).to_pstr()
				} else { line };
				content.push(&line);
			}
		}
		Ok(provided.then(|| ModuleSource { display: name.to_owned(), bytes: content.bytes, inc_value: hook }))
	}

	pub(super) fn do_file(&mut self, file: &str, cx: Cx) -> PResult<Ret> {
		let direct = direct_file(file);
		let Some(source) = self.find_source(file, direct)? else {
			self.set_errno_code(2);
			self.sv("main::@").replace(Value::bytes(b""));
			if !direct && self.host.fs().metadata(&self.resolve_path(file.as_bytes())).is_ok() {
				self.warn(format!("do \"{file}\" failed, '.' is no longer in @INC; did you mean do \"./{file}\"?"));
			}
			return Ok(Ret::no_value(cx));
		};
		if !direct { self.hv("main::INC").entries_mut().insert(hash_key(file), new_sv(source.inc_value)); }
		self.with_eval(cx, Some(PStr::from_str(file)), false, |this| this.run_file_source(&source.display, &source.bytes, cx))
	}
}

fn direct_file(name: &str) -> bool {
	name.starts_with("./") || name.starts_with("../") || name.contains("://") || std::path::Path::new(name).is_absolute()
}
