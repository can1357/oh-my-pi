//! Per-invocation process state and diagnostics (perlvar, perlrun, perldiag).

use super::*;

/// `SIGPIPE`'s number; libc spells it on Unix only, and perl's death
/// status (128 + 13) is the same everywhere.
pub(super) const SIGPIPE: i32 = 13;

#[cfg(target_os = "macos")]
const DEFAULT_INC: &[&str] = &[
	"/Library/Perl/5.34/darwin-thread-multi-2level", "/Library/Perl/5.34",
	"/Network/Library/Perl/5.34/darwin-thread-multi-2level", "/Network/Library/Perl/5.34",
	"/Library/Perl/Updates/5.34.1", "/System/Library/Perl/5.34/darwin-thread-multi-2level", "/System/Library/Perl/5.34",
	"/System/Library/Perl/Extras/5.34/darwin-thread-multi-2level", "/System/Library/Perl/Extras/5.34",
];
#[cfg(not(target_os = "macos"))]
const DEFAULT_INC: &[&str] = &["/usr/local/lib/perl5", "/usr/share/perl5", "/usr/lib/perl5"];

#[derive(Default)]
pub(super) struct HostSpecials {
	env: Cell<Option<std::rc::Weak<value::GlobBody>>>,
	locale: Cell<Option<std::rc::Weak<value::GlobBody>>>,
}

fn utf8_locale(host: &Host) -> bool {
	["LC_ALL", "LC_CTYPE", "LANG"].into_iter().find_map(|n| host.var(n).filter(|v| !v.is_empty())).is_some_and(|s| {
		let s = s.as_bytes();
		s.windows(4).any(|w| w.eq_ignore_ascii_case(b"utf8")) || s.windows(5).any(|w| w.eq_ignore_ascii_case(b"utf-8"))
	})
}

#[cfg(unix)]
fn group_value(primary: u32, groups: &std::cell::OnceCell<Vec<u32>>) -> Value {
	use std::fmt::Write as _;
	let mut text = primary.to_string();
	for gid in groups.get_or_init(crate::perl::io::supplementary_groups) {
		write!(text, " {gid}").expect("writing to a String");
	}
	Value::Str(PStr::new(text.into_bytes(), false))
}

impl<'h> Interp<'h> {
	/// Initialize the execution environment and standard Perl variables.
	pub fn new(host: &'h mut Host, setup: Setup) -> Self {
		let cycle_tracker = value::begin_cycle_tracking();
		let Setup { script, argv, inc, warn, inplace, input_sep, output_sep, unicode, switches } = setup;
		let mut stdin = Handle::stdin(host);
		let mut stdout = Handle::stdout(host);
		let mut stderr = Handle::stderr(host);
		let unicode_raw = unicode;
		let locale = (unicode & 64 != 0).then(|| utf8_locale(host));
		let unicode = if locale == Some(false) { 0 } else { unicode };
		if unicode & 1 != 0 { let _ = stdin.binmode(b":utf8"); }
		if unicode & 2 != 0 { let _ = stdout.binmode(b":utf8"); }
		if unicode & 4 != 0 { let _ = stderr.binmode(b":utf8"); }
		let selected = Rc::new(RefCell::new(stdout));
		stdin.set_prompt_output(&selected);
		let cwd = host.cwd().to_owned();
		let loc = Location { file: Rc::from(script.to_string_lossy().as_ref()), line: 1 };
		let start = SystemTime::now();
		let mut default_hints = Hints::default();
		if unicode & 24 != 0 {
			default_hints.open_layers = Some((PStr::from_bytes(if unicode & 8 != 0 { b":utf8" } else { b"" }), PStr::from_bytes(if unicode & 16 != 0 { b":utf8" } else { b"" })));
		}
		let mut this = Self {
			cycle_tracker, host, cwd, rx: Default::default(), sys: Default::default(), data: Default::default(), modules: Default::default(), last_match: None,
			symbols: FxHashMap::default(), symbol_generation: 0, core_global: Cell::new(None), names: RefCell::default(), special_globs: RefCell::default(), magic_cells: FxHashMap::default(), stashes: FxHashMap::default(), handles: Vec::new(), selected: selected.clone(), last_read: None,
			startup_host: HostSpecials::default(), global_sites: Vec::new(), tie_suspended: FxHashSet::default(),
			exposed_stashes: FxHashSet::default(), tied_handles: FxHashMap::default(),
			package_generations: FxHashMap::default(), isa_globs: Vec::new(), code_attr: FxHashMap::default(),
			line_seen: Cell::new(0), autoflush_seen: Cell::new(false),
			argv: ArgvState { inplace: inplace.as_deref().map(InPlace::new), ext: inplace, ..ArgvState::default() },
			start, alarm: None, alarm_interval: None, warn_switch: warn, phase: "BOOT",
			active_hints: Rc::new(default_hints.clone()), compile_hints: default_hints.clone(), default_hints,
			parse_scopes: Vec::new(), compile_pads: Vec::new(), compile_pad_base: 0,
			use_hints: FxHashMap::default(), captures: FxHashMap::default(), imported_symbols: FxHashSet::default(),
			package: Rc::from("main"), loc, scopes: vec![Scope::default()], scope_pool: Vec::new(), scope_stacks: Vec::new(),
			lexicals: Default::default(), topics: Vec::new(), persistent: Rc::default(),
			frames: Vec::new(), active_subs: Vec::new(), eval_contexts: Vec::new(), sub_depth: Default::default(),
			perl_calls: Vec::new(), arg_arrays: Vec::new(),
			tail_args: None, eval_serial: 0, in_given: 0, die_misc_warnings: false, given_value: None, given_cx: Cx::Void, in_when: 0,
			hole: new_sv(Value::Undef), programs: Vec::new(), pending: None, depth: 0, compile_depth: 0, compile_failure: None, compile_interrupted: false, compile_status: 255,
			in_die: false, in_warn: false, in_sigpipe: false, killed: false, overloads: FxHashMap::default(), in_overload: 0, in_constant: false,
			objects: Default::default(), destroying: Default::default(), destroy_draining: false,
			loading: FxHashSet::default(), unitchecks: Vec::new(), checks: Vec::new(), inits: Vec::new(), ends: Vec::new(), exit_hooks: Vec::new(),
		};
		// The names (and their insertion order) are visible in %main:: before any user code runs.
		// Install the globs, not three empty aggregate/scalar slots and a CV for every name.
		this.symbols.reserve(128);
		this.stashes.reserve(16);
		this.stash("main").entries_mut().reserve(64);
		for (name, io) in [("main::STDIN", Rc::new(RefCell::new(stdin))), ("main::STDOUT", selected), ("main::STDERR", Rc::new(RefCell::new(stderr)))] {
			let gv = this.definition_glob(name);
			this.set_handle(&gv, io);
		}
		let env = this.definition_glob("main::ENV");
		this.startup_host.env.set(Some(Rc::downgrade(&env)));
		#[cfg(unix)]
		this.definition_glob("main::SIG").hash.defer(|| {
			let sig = new_hv();
			let mut entries = sig.entries_mut();
			for signal in nix::sys::signal::Signal::iterator() {
				let name = signal.as_str();
				entries.insert(HKey::from_pstr(PStr::from_str(name.strip_prefix("SIG").unwrap_or(name))), new_sv(Value::Undef));
			}
			drop(entries);
			sig
		});
		this.definition_glob("main::ARGV").array.defer(move || {
			let array = new_av(Vec::new());
			array.replace_elems(argv.into_iter().map(|mut s| {
				if unicode & 32 != 0 { s.utf8 = std::str::from_utf8(&s.bytes).is_ok(); }
				new_sv(Value::Str(s))
			}).collect());
			array
		});
		this.definition_glob("main::INC").array.defer(move || {
			let mut paths = Vec::with_capacity(inc.len() + DEFAULT_INC.len());
			paths.extend(inc.into_iter().map(|dir| new_sv(Value::Str(dir))));
			paths.extend(DEFAULT_INC.iter().map(|&dir| new_sv(Value::str(dir))));
			let array = new_av(Vec::new());
			array.replace_elems(paths);
			array
		});
		macro_rules! scalars {
			($($name:literal => $value:expr),+ $(,)?) => { $(
				this.definition_glob(concat!("main::", $name)).scalar.defer(move || new_sv($value));
			)+ };
		}
		scalars! {
			"0" => Value::Str(script),
			"/" => match input_sep.unwrap_or_default() {
				RecordSep::Text(s) => Value::Str(s), RecordSep::Paragraph => Value::bytes(b""), RecordSep::Slurp => Value::Undef,
				RecordSep::Fixed(n) => Value::Ref(Ref::Scalar(new_sv(Value::Int(n as i64)))),
			},
			"\\" => output_sep.map_or(Value::Undef, Value::Str), "\"" => Value::bytes(b" "), ";" => Value::bytes(b"\x1c"),
			"@" => Value::bytes(b""), "?" => Value::Int(0), "^CHILD_ERROR_NATIVE" => Value::Int(0),
			"^W" => Value::Int(i64::from(matches!(warn, WarnSwitch::W | WarnSwitch::All))),
			"^T" => Value::Int(start.duration_since(SystemTime::UNIX_EPOCH).unwrap_or_default().as_secs() as i64),
			"^O" => Value::str(modules::osname()), "^X" => Value::str("/usr/bin/perl"), "]" => Value::Num(5.034001),
			"^V" => Value::bytes(b"\x05\x22\x01"), "^C" => Value::Int(0), "^D" => Value::Int(0),
		}
		let inplace_sv = this.definition_glob("main::^I").scalar.borrow().clone();
		inplace_sv.set(this.argv.ext.as_deref().map_or(Value::Undef, Value::bytes));
		scalars! {
			"^L" => Value::bytes(b"\x0c"), "^H" => Value::Int(0), "^A" => Value::bytes(b""), ":" => Value::bytes(b" \n-"),
			"^TAINT" => Value::Int(0), "^UNICODE" => Value::Int(i64::from(unicode_raw)), "^UTF8CACHE" => Value::Int(1),
		}
		let locale_glob = this.definition_glob("main::^UTF8LOCALE");
		if let Some(utf8) = locale {
			locale_glob.scalar.defer(move || new_sv(Value::Int(i64::from(utf8))));
		} else {
			this.startup_host.locale.set(Some(Rc::downgrade(&locale_glob)));
		}
		scalars! {
			"^OPEN" => Value::Undef, "^WARNING_BITS" => Value::Undef, "^LAST_FH" => Value::Undef,
			"[" => Value::Int(0), "|" => Value::Int(0), "$" => Value::Int(i64::from(std::process::id())),
		}
		#[cfg(unix)]
		{
			use nix::unistd::{getegid, geteuid, getgid, getuid};
			let real = Rc::new(std::cell::OnceCell::new());
			let effective = real.clone();
			scalars! {
				"<" => Value::Int(i64::from(getuid().as_raw())), ">" => Value::Int(i64::from(geteuid().as_raw())),
				"(" => group_value(getgid().as_raw(), &real), ")" => group_value(getegid().as_raw(), &effective),
			}
		}
		#[cfg(not(unix))]
		{ scalars! { "<" => Value::Int(0), ">" => Value::Int(0), "(" => Value::Int(0), ")" => Value::Int(0) } }
		scalars! {
			"^F" => Value::Int(2), "^P" => Value::Int(0), "^M" => Value::Undef, "^R" => Value::Undef, "^SAFE_LOCALES" => Value::Int(1),
		}
		for (name, full) in [("!", "main::!"), ("^E", "main::^E"), ("|", "main::|"), (".", "main::."), ("~", "main::~"),
			("^", "main::^"), ("=", "main::="), ("-", "main::-"), ("%", "main::%"), ("[", "main::["), ("^I", "main::^I")] {
			let sv = this.definition_glob(full).scalar.borrow().clone();
			sv.register();
			this.magic_cells.insert(Rc::as_ptr(&sv) as usize, (name, Rc::downgrade(&sv)));
		}
		this.set_errno_code(0);
		for (name, value) in switches { this.sv(&format!("main::{}", name.to_string_lossy())).replace(Value::Str(value)); }
		this.install_universal();
		modules::install_core(&mut this);
		this.phase = "START";
		this
	}

	/// During boot all names are canonical, no stash has escaped, and every existing
	/// symbol is in `symbols`. Dynamic/module redefinitions use ordinary gv_fetch.
	pub(super) fn definition_glob(&mut self, qualified: &str) -> Gv {
		if self.phase != "BOOT" || qualified.ends_with("::") { return self.glob(qualified); }
		if let Some(g) = self.symbols.get(qualified) { return g.clone(); }
		let (pkg, name) = qualified.rsplit_once("::").expect("qualified bootstrap symbol");
		let stash = self.stash(pkg);
		let package = self.stashes.get_key_value(pkg).expect("installed stash").0.clone();
		self.insert_boot_symbol(Rc::from(qualified), package, name, &stash)
	}

	fn insert_boot_symbol(&mut self, full: Rc<str>, pkg: Rc<str>, name: &str, stash: &Hv) -> Gv {
		let g = new_gv(pkg, Rc::from(name));
		let key = HKey::from_pstr(PStr::from_str(name));
		stash.entries_mut().insert(key, new_sv(Value::Glob(g.clone())));
		self.symbols.insert(full, g.clone());
		self.symbol_generation = self.symbol_generation.wrapping_add(1);
		g
	}

	/// Keep builtin names discoverable (`defined &f`, `keys %Pkg::`), but do not
	/// allocate a CodeBody or construct its name until something asks for the CODE slot.
	pub(super) fn install_code_body(&mut self, g: &Gv, body: CodeImpl, proto: Option<PStr>) {
		if self.phase == "BOOT" && !g.code.initialized() && let CodeImpl::Native(f) = &body {
			let f = *f;
			let pkg = g.pkg.clone();
			let name = g.name.clone();
			g.code.defer(move || Some(Rc::new(CodeBody {
				name: RefCell::new(Some(Rc::from(format!("{pkg}::{name}")))), pkg,
				prototype: RefCell::new(proto), body: RefCell::new(CodeImpl::Native(f)), blessed: RefCell::new(None),
			})));
		} else {
			let cv = self.code_slot(g);
			cv.prototype.replace(proto);
			cv.body.replace(body);
		}
	}

	pub(in crate::perl) fn define_natives(&mut self, module: &str, defs: &[(&str, NativeFn)]) {
		if self.phase != "BOOT" {
			for (name, f) in defs { self.define_native(&format!("{module}::{name}"), *f); }
			return;
		}
		let stash = self.stash(module);
		let pkg = self.stashes.get_key_value(module).expect("installed stash").0.clone();
		stash.entries_mut().reserve(defs.len());
		for &(name, f) in defs {
			let full: Rc<str> = Rc::from(format!("{module}::{name}"));
			let g = self.symbols.get(&full).cloned().unwrap_or_else(|| self.insert_boot_symbol(full, pkg.clone(), name, &stash));
			self.install_code_body(&g, CodeImpl::Native(f), None);
		}
		let generation = self.package_generations.entry(pkg).or_insert(1);
		*generation = generation.saturating_add(defs.len() as u64);
	}

	/// After the shell lends its environment to this invocation it does not change.
	/// Convert it into Perl values only before exporting the owning glob (including
	/// indirect access through the stash), never for an invocation that doesn't use it.
	pub(super) fn materialize_host_symbol(&self, qualified: &str) {
		match qualified {
			"main::ENV" => if let Some(g) = self.startup_host.env.take().and_then(|w| w.upgrade()) {
				let hash = g.hash.borrow();
				let mut entries = hash.entries_mut();
				entries.extend(self.host.env().map(|(k, v)| (HKey::from_pstr(PStr::from_str(k)), new_sv(Value::str(v)))));
			},
			"main::^UTF8LOCALE" => if let Some(g) = self.startup_host.locale.take().and_then(|w| w.upgrade()) {
				g.scalar.borrow().set(Value::Int(i64::from(utf8_locale(self.host))));
			},
			_ => {}
		}
	}

	pub(super) fn expose_boot_stash(&self, pkg: &str) {
		if pkg == "main" {
			self.materialize_host_symbol("main::ENV");
			self.materialize_host_symbol("main::^UTF8LOCALE");
		}
	}

	/// Borrow the shell host for external effects.
	pub fn host(&mut self) -> &mut Host { self.host }

	/// Resolve a path relative to Perl's cwd and the host's virtual filesystem.
	pub fn resolve_path(&self, path: &[u8]) -> PathBuf {
		#[cfg(unix)]
		let path = {
			use std::os::unix::ffi::OsStrExt;
			std::path::Path::new(std::ffi::OsStr::from_bytes(path))
		};
		#[cfg(not(unix))]
		let text = String::from_utf8_lossy(path);
		#[cfg(not(unix))]
		let path = std::path::Path::new(text.as_ref());
		if path.is_absolute() || path.as_os_str().as_encoded_bytes().windows(3).any(|w| w == b"://") {
			self.host.resolve(path)
		} else {
			self.host.resolve(self.cwd.join(path))
		}
	}

	/// Set Perl's cwd without changing the process cwd.
	pub fn set_cwd(&mut self, dir: PathBuf) { self.cwd = dir; }

	/// Register an output-capable handle in a glob and track its lifetime.
	pub fn set_handle(&mut self, gv: &Gv, io: Io) {
		self.track_handle(&io);
		gv.io.replace(Some(io));
	}

	/// Track an anonymous handle for flushing and shutdown.
	pub fn track_handle(&mut self, io: &Io) {
		let weak = Rc::downgrade(io);
		if !self.handles.iter().any(|p| p.ptr_eq(&weak)) {
			self.handles.retain(|p| p.strong_count() != 0);
			self.handles.push(weak);
		}
	}

	/// Fetch the handle slot of a named symbol, optionally creating it.
	pub fn handle(&mut self, qualified: &str, create: bool) -> Option<Io> {
		let name = self.qualify(qualified);
		if name.as_ref() == "main::ARGV" {
			if let Some(io) = &self.argv.current { return Some(io.clone()); }
		}
		let gv = if create { self.glob(&name) } else { self.existing_glob(&name)? };
		let io = gv.io.borrow().clone();
		if io.is_some() || !create { return io; }
		let io = Rc::new(RefCell::new(Handle::closed()));
		self.set_handle(&gv, io.clone());
		Some(io)
	}

	/// Flush open handles (before starting a child process, and at exit);
	/// whether a flush found a pipe or socket nobody reads.
	pub fn flush_outputs(&mut self) -> bool {
		self.sync_selected();
		let mut broken = false;
		for io in self.handles.iter().filter_map(std::rc::Weak::upgrade) {
			if let Ok(mut handle) = io.try_borrow_mut() && let Err(err) = handle.flush() {
				broken |= err.kind() == std::io::ErrorKind::BrokenPipe;
			}
		}
		broken
	}

	/// Deliver `SIGPIPE` when the write that failed with `err` found a pipe
	/// or socket nobody reads, as the kernel does to the writing process:
	/// perl's default action ends the program (status 141), `IGNORE` leaves
	/// the write's `EPIPE`, and a handler runs before the write returns.
	/// While a handler runs the signal is blocked, so a write of its own to
	/// the same pipe only fails.
	pub fn broken_pipe(&mut self, err: &std::io::Error) -> PResult<()> {
		if err.kind() != std::io::ErrorKind::BrokenPipe || self.in_sigpipe { return Ok(()); }
		self.in_sigpipe = true;
		let result = self.raise_signal("PIPE", SIGPIPE);
		self.in_sigpipe = false;
		result
	}

	/// Materialize `%ENV` as native byte pairs for a child process.
	pub fn env_pairs(&self) -> Vec<(Vec<u8>, Vec<u8>)> {
		self.materialize_host_symbol("main::ENV");
		let Some(glob) = self.symbols.get("main::ENV") else { return Vec::new() };
		glob.hash.borrow().entries().iter().map(|(k, v)| (k.to_pstr().bytes, v.get().to_pstr().bytes)).collect()
	}

	/// Store an I/O error in the dual-valued `$!`.
	pub fn set_errno(&mut self, err: &std::io::Error) { self.set_errno_code(err.raw_os_error().unwrap_or(1)); }

	/// Store a native errno in `$!` and `$^E`.
	pub fn set_errno_code(&mut self, code: i32) {
		let s = if code == 0 { String::new() } else {
			let text = std::io::Error::from_raw_os_error(code).to_string();
			text.split_once(" (os error ").map_or(text.as_str(), |(text, _)| text).to_owned()
		};
		let value = Value::Dual(Rc::new(Dual { num: Num::Int(i64::from(code)), str: PStr::from_str(&s) }));
		self.sv("main::!").replace(value.clone());
		self.sv("main::^E").replace(value);
		modules::update_errno(self, code);
	}

	/// Store a native child wait status in `$?`.
	pub fn set_child_status(&mut self, status: i32) {
		let value = Value::Int(i64::from(status));
		self.sv("main::?").replace(value.clone());
		self.sv("main::^CHILD_ERROR_NATIVE").replace(value);
	}

	#[inline]
	pub(super) fn special_value(&self, qualified: &str) -> Value {
		self.with_special_scalar(qualified, |cell| cell.map_or(Value::Undef, |sv| sv.get()))
	}

	/// Interpret the current input record separator (`$/`).
	pub fn input_sep(&self) -> RecordSep {
		Self::record_sep_value(self.special_value("main::/"))
	}

	fn record_sep_value(value: Value) -> RecordSep {
		match value {
			Value::Undef => RecordSep::Slurp,
			Value::Ref(Ref::Scalar(s)) => RecordSep::Fixed(s.get().to_i64().max(0) as usize),
			Value::Str(s) => if s.is_empty() { RecordSep::Paragraph } else { RecordSep::Text(s) },
			v => { let s = v.to_pstr(); if s.is_empty() { RecordSep::Paragraph } else { RecordSep::Text(s) } }
		}
	}

	/// Snapshot `$/` before a potentially reentrant read, borrowing the usual newline.
	pub(in crate::perl) fn record_sep_for_read(&self) -> std::borrow::Cow<'static, RecordSep> {
		use std::borrow::Cow;
		static NEWLINE: std::sync::LazyLock<RecordSep> = std::sync::LazyLock::new(RecordSep::default);
		self.with_special_glob(SpecialGlob::InputSeparator, |glob| {
			let Some(glob) = glob else { return Cow::Borrowed(&RecordSep::Slurp); };
			let cell = glob.scalar.borrow();
			if let Ok(value) = cell.try_value()
				&& matches!(&*value, Value::Str(s) if !s.utf8 && s.bytes == b"\n")
			{
				return Cow::Borrowed(&*NEWLINE);
			}
			Cow::Owned(Self::record_sep_value(cell.get()))
		})
	}

	/// The separator between print arguments (`$,`).
	pub fn output_field_sep(&self) -> Option<PStr> { self.print_separator("main::,") }
	/// The separator appended by print (`$\`).
	pub fn output_record_sep(&self) -> Option<PStr> { self.print_separator("main::\\") }
	fn print_separator(&self, name: &str) -> Option<PStr> {
		match self.special_value(name) {
			Value::Undef => None,
			Value::Str(s) => Some(s),
			v => Some(v.to_pstr()),
		}
	}
	/// The current interpolated list separator (`$"`).
	pub fn list_sep(&self) -> PStr { self.special_value("main::\"").to_pstr() }
	/// The current multidimensional hash index separator (`$;`).
	pub fn subscript_sep(&self) -> PStr { self.special_value("main::;").to_pstr() }

	pub(super) fn sync_selected(&self) {
		let on = self.special_value("main::|").truthy();
		if self.autoflush_seen.replace(on) != on {
			if let Ok(mut selected) = self.selected.try_borrow_mut() { selected.set_autoflush(on); }
		}
	}

	/// The current default output handle.
	pub fn selected(&self) -> Io { self.sync_selected(); self.selected.clone() }

	/// Select a new default output handle and return the previous one.
	pub fn set_selected(&mut self, io: Io) -> Io {
		self.sync_selected();
		let on = io.borrow().autoflush();
		self.autoflush_seen.set(on);
		self.sv("main::|").replace(Value::Int(i64::from(on)));
		self.track_handle(&io);
		std::mem::replace(&mut self.selected, io)
	}

	pub(super) fn sync_line(&self) {
		if let Some(io) = &self.last_read {
			let n = self.special_value("main::.").to_i64();
			if self.line_seen.replace(n) != n {
				if let Ok(mut handle) = io.try_borrow_mut() { handle.set_line_no(n.max(0) as u64); }
			}
		}
	}

	/// Update the handle that supplies `$.`.
	pub fn set_last_read(&mut self, io: Io) {
		// `local` and typeglob aliases can replace the slot; cache the glob, not
		// the SV. Updating an integer payload avoids cloning/dropping a Value.
		let cell = self.with_special_glob(SpecialGlob::LineNumber, |gv| gv.map(|g| g.scalar.borrow().clone()))
			.unwrap_or_else(|| self.sv("main::."));
		let mut value = cell.try_value_mut().expect("last-read line number is not borrowed");
		if let Some(previous) = &self.last_read {
			let n = match &*value { Value::Int(n) => *n, other => other.to_i64() };
			if self.line_seen.get() != n && let Ok(mut h) = previous.try_borrow_mut() {
				h.set_line_no(n.max(0) as u64);
			}
		}
		let line = io.borrow().line_no() as i64;
		if let Value::Int(n) = &mut *value { *n = line; } else { *value = Value::Int(line); }
		self.line_seen.set(line);
		self.last_read = Some(io);
	}

	/// Forget the last-read handle (`readline` on an unopened handle leaves `${^LAST_FH}` undefined).
	pub fn clear_last_read(&mut self) {
		self.sync_line();
		self.last_read = None;
	}

	/// The last input handle, if one has been used.
	pub fn last_read(&self) -> Option<Io> { self.sync_line(); self.last_read.clone() }
	/// Mutable bookkeeping for magical ARGV processing.
	pub fn argv_state(&mut self) -> &mut ArgvState { &mut self.argv }
	/// The time this interpreter began (`$^T`).
	pub fn start_time(&self) -> SystemTime {
		let start = self.special_value("main::^T").to_i64();
		let seconds = Duration::from_secs(start.unsigned_abs());
		if start < 0 { SystemTime::UNIX_EPOCH.checked_sub(seconds).unwrap_or(self.start) }
		else { SystemTime::UNIX_EPOCH.checked_add(seconds).unwrap_or(self.start) }
	}
	/// Replace the alarm deadline and return the previous remaining seconds.
	pub fn set_alarm(&mut self, deadline: Option<Instant>) -> u64 {
		self.alarm_interval = None;
		std::mem::replace(&mut self.alarm, deadline).map_or(0, |t| {
			let d = t.saturating_duration_since(Instant::now());
			d.as_secs() + u64::from(d.subsec_nanos() != 0)
		})
	}
	/// Whether the shell is cancelling the operation.
	pub fn is_cancelled(&self) -> bool { self.host.is_cancelled() }

	/// The deferred flow (`defer`), if any; checks before moving the (large) value out.
	#[inline]
	pub(super) fn take_pending(&mut self) -> Option<Flow> { if self.pending.is_some() { self.pending.take() } else { None } }

	/// Poll pending exceptions, shell cancellation and alarm delivery.
	#[inline]
	pub fn poll(&mut self) -> PResult<()> {
		if let Some(flow) = self.take_pending() { return Err(flow); }
		if self.is_cancelled() { return Err(Flow::Cancelled); }
		if self.alarm.is_some() { self.poll_alarm()?; }
		if self.objects.is_empty() && self.tied_handles.is_empty() { Ok(()) } else { self.drain_destructors(false) }
	}

	/// Deliver a due alarm; return true if an alarm handler ran or ignored it.
	pub fn poll_alarm(&mut self) -> PResult<bool> {
		let Some(deadline) = self.alarm else { return Ok(false); };
		let now = Instant::now();
		if deadline > now { return Ok(false); }
		self.alarm = self.alarm_interval.and_then(|interval| {
			deadline.checked_add(interval).filter(|&t| t > now).or_else(|| now.checked_add(interval))
		});
		self.raise_signal("ALRM", 14)?;
		Ok(true)
	}

	/// Next scheduled alarm deadline.
	pub fn alarm_deadline(&self) -> Option<Instant> { self.alarm }

	/// Repetition interval for an active periodic alarm.
	pub fn alarm_interval(&self) -> Option<Duration> { self.alarm_interval }

	/// Install a possibly periodic alarm on the same state as Perl's `alarm`.
	pub fn set_alarm_interval(&mut self, deadline: Option<Instant>, interval: Option<Duration>) {
		self.alarm = deadline;
		self.alarm_interval = interval.filter(|t| !t.is_zero());
	}

	pub(super) fn apply_die_hook(&mut self, value: Value) -> Flow {
		self.die_misc_warnings = self.warn_on("misc");
		if !self.in_die {
			let handler = self.signal_handler("__DIE__");
			if !handler.is_undef() && !matches!(&handler, Value::Str(s) if s.bytes == b"DEFAULT" || s.bytes == b"IGNORE") {
				self.in_die = true;
				let result = self.invoke_handler(handler, value.clone());
				self.in_die = false;
				if let Err(flow) = result { return flow; }
			}
		}
		Flow::Die(value)
	}

	pub(super) fn defer(&mut self, flow: Flow) {
		if self.pending.is_none() { self.pending = Some(flow); }
	}

	/// Location of the currently executing expression or statement.
	pub fn location(&self) -> Location { self.loc.clone() }
	/// Current lexical hints.
	pub fn hints(&self) -> &Hints { &self.active_hints }
	/// The pragma state being edited by a compile-time callback.
	pub fn compiling_hints(&mut self) -> &mut Hints { &mut self.compile_hints }

	/// Determine whether a category is enabled, honoring lexical and command-line overrides.
	pub fn warn_on(&self, category: &str) -> bool { self.warning_enabled(category, false) }

	pub(super) fn warning_enabled(&self, category: &str, default_on: bool) -> bool {
		match self.warn_switch {
			WarnSwitch::All => true, WarnSwitch::Off => false,
			_ => if let Some(&(enabled, _)) = self.active_hints.registered_warnings.get(category) { enabled }
			else if self.active_hints.warnings.specified(category) { self.active_hints.warnings.enabled(category) }
			else { default_on || self.special_value("main::^W").truthy() },
		}
	}

	pub(super) fn message_with_location(&self, mut message: PStr) -> PStr {
		if message.bytes.last() == Some(&b'\n') { return message; }
		message.push(&PStr::from_str(&format!(" at {} line {}", self.loc.file, self.loc.line)));
		if let Some(io) = &self.last_read {
			if let Ok(handle) = io.try_borrow() {
				let n = handle.line_no();
				if n != 0 {
					let name: Rc<str> = if self.argv.current.as_ref().is_some_and(|argv| Rc::ptr_eq(argv, io)) { Rc::from("ARGV") } else {
						func::sys::display_name(self, io).unwrap_or_else(|| {
							self.symbols.values().find_map(|g| g.io.try_borrow().ok().filter(|p| p.as_ref().is_some_and(|p| Rc::ptr_eq(io, p))).map(|_| g.name.clone()))
								.unwrap_or_else(|| Rc::from(""))
						})
					};
					// perlvar: "chunk" unless $/ is the default newline.
					let unit = if matches!(self.input_sep(), RecordSep::Text(sep) if sep.bytes == b"\n") { "line" } else { "chunk" };
					message.push(&PStr::from_str(&format!(", <{name}> {unit} {n}")));
				}
			}
		}
		message.push_bytes(b".\n");
		message
	}

	/// Construct a Perl exception with location and invoke `$SIG{__DIE__}`.
	pub fn die_msg(&mut self, msg: impl Into<String>) -> Flow { self.die_value(Value::str(&msg.into())) }

	/// Throw an exception without stringifying reference values.
	pub fn die_value(&mut self, v: Value) -> Flow {
		let v = match v {
			Value::Ref(_) => v,
			_ => Value::Str(self.message_with_location(v.to_pstr())),
		};
		self.apply_die_hook(v)
	}

	/// Emit an unconditional warning, as the Perl `warn` builtin does.
	pub fn warn(&mut self, msg: impl Into<String>) { self.emit_warning(PStr::from_str(&msg.into())); }

	/// Emit a categorized warning only if enabled; fatal categories throw.
	pub fn warn_category(&mut self, category: &str, msg: impl Into<String>) {
		if self.warn_on(category) { self.emit_category_warning(category, msg); }
	}

	/// Emit a warning enabled by default, unless disabled by its lexical category or `-X`.
	pub fn warn_category_default(&mut self, category: &str, msg: impl Into<String>) {
		if self.warning_enabled(category, true) { self.emit_category_warning(category, msg); }
	}

	fn emit_category_warning(&mut self, category: &str, msg: impl Into<String>) {
		let registered = self.active_hints.registered_warnings.get(category).copied();
		let msg = msg.into();
		if registered.map_or_else(|| self.active_hints.warnings.fatal(category), |(_, fatal)| fatal) {
			let flow = self.die_msg(msg);
			self.defer(flow);
		} else {
			self.warn(msg);
		}
	}

	pub(super) fn emit_warning(&mut self, mut msg: PStr) {
		if self.phase == "DESTRUCT" && msg.bytes.last() != Some(&b'\n') { msg.push_bytes(b" during global destruction"); }
		let message = self.message_with_location(msg);
		self.emit_warning_value(Value::Str(message));
	}

	pub(super) fn emit_warning_value(&mut self, value: Value) {
		let handler = self.signal_handler("__WARN__");
		if self.in_warn || handler.is_undef() || matches!(&handler, Value::Str(s) if s.bytes == b"DEFAULT") {
			match self.stringify(&value) {
				Ok(message) => self.put_stderr(&message),
				Err(flow) => self.defer(flow),
			}
		} else if !matches!(&handler, Value::Str(s) if s.bytes == b"IGNORE") {
			self.in_warn = true;
			let result = self.invoke_handler(handler, value);
			self.in_warn = false;
			if let Err(flow) = result { self.defer(flow); }
		}
	}

	fn signal_handler(&self, signal: &str) -> Value {
		let Some(g) = self.symbols.get("main::SIG") else { return Value::Undef };
		// Until the hash slot is touched every handler is the default (undef).
		if !g.hash.initialized() { return Value::Undef; }
		g.hash.borrow().entries().get(&hash_key(signal)).map_or(Value::Undef, read_sv)
	}

	/// Deliver a signal to this Perl invocation, never to the embedding host process.
	pub fn raise_signal(&mut self, name: &str, number: i32) -> PResult<()> {
		let name = name.strip_prefix("SIG").unwrap_or(name);
		let handler = self.signal_handler(name);
		if matches!(&handler, Value::Str(v) if v.bytes == b"IGNORE") { return Ok(()); }
		if handler.is_undef() || matches!(&handler, Value::Str(v) if v.bytes == b"DEFAULT") {
			return if matches!(name, "CHLD" | "CLD" | "CONT" | "URG" | "WINCH" | "INFO" | "STOP" | "TSTP" | "TTIN" | "TTOU") {
				Ok(())
			} else {
				if name == "ALRM" { self.put_stderr(&PStr::from_bytes(b"Alarm clock\n")); }
				self.killed = true;
				// Gone before any later close or drop can flush them.
				for io in self.handles.iter().filter_map(std::rc::Weak::upgrade) {
					if let Ok(mut handle) = io.try_borrow_mut() { handle.discard_output(); }
				}
				Err(Flow::Exit(128i32.saturating_add(number)))
			};
		}
		// The handler must not clobber the interrupted operation's $! (perl saves errno around it).
		let errno = self.special_value("main::!").to_i64() as i32;
		let result = self.invoke_handler(handler, Value::str(name));
		self.set_errno_code(errno);
		result
	}

	fn invoke_handler(&mut self, handler: Value, arg: Value) -> PResult<()> {
		if let Some(cv) = self.code_value(&handler, false)? { self.call_sub(&cv, vec![new_sv(arg)], Cx::Void)?; }
		Ok(())
	}

	pub(super) fn put_stderr(&mut self, s: &PStr) {
		let Some(io) = self.handle("main::STDERR", false) else { return };
		// A tied STDERR receives diagnostics through its PRINT method (not re-entered for its own warnings).
		if !self.in_warn && let Some(object) = self.tied_handle(&io) {
			self.in_warn = true;
			let result = self.call_method(object, "PRINT", vec![Value::Str(s.clone())], Cx::Scalar);
			self.in_warn = false;
			if let Err(flow) = result { self.defer(flow); }
			return;
		}
		let _ = io.borrow_mut().write(s);
	}

	/// Adapter for APIs defined in terms of the context-dependent conversion trait.
	pub fn conv(&mut self) -> Conv<'_, 'h> { Conv { interp: self } }

	/// Register a finalizer to run after Perl END blocks.
	pub fn on_exit(&mut self, hook: Box<dyn FnOnce(&mut Interp<'_>)>) { self.exit_hooks.push(hook); }

	pub(super) fn flow_status(&mut self, flow: Flow) -> i32 {
		let message = match flow {
			Flow::Exit(code) => return code & 255,
			Flow::Cancelled => return 130,
			Flow::Die(v) => {
				let message = self.stringify(&v).unwrap_or_else(|_| v.to_pstr());
				if matches!(v, Value::Ref(_)) { self.message_with_location(message) } else { message }
			}
			Flow::Return(_) => self.message_with_location(PStr::from_bytes(b"Can't return outside a subroutine")),
			Flow::Goto(GotoTarget::Sub(_)) => self.message_with_location(PStr::from_bytes(b"Can't goto subroutine outside a subroutine")),
			Flow::Goto(GotoTarget::Label(label)) => self.message_with_location(PStr::from_str(&format!("Can't find label {label}"))),
			Flow::Next(label) => self.loop_error("next", label.as_deref()),
			Flow::Last(label) => self.loop_error("last", label.as_deref()),
			Flow::Redo(label) => self.loop_error("redo", label.as_deref()),
		};
		self.put_stderr(&message);
		let errno = self.special_value("main::!").to_i64() as i32 & 255;
		let child = (self.special_value("main::?").to_i64() >> 8) as i32 & 255;
		if errno != 0 { errno } else if child != 0 { child } else { 255 }
	}

	fn loop_error(&self, action: &str, label: Option<&str>) -> PStr {
		self.message_with_location(PStr::from_str(&if let Some(label) = label { format!("Label not found for \"{action} {label}\"") } else { format!("Can't \"{action}\" outside a loop block") }))
	}
}
