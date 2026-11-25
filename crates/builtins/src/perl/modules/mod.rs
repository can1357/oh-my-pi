//! In-process pragmas and Perl core libraries (perlmod, perlmodlib).

mod carp;
mod codec;
mod dumper;
mod exporter;
mod extras;
mod files;
mod getopt;
mod infra;
mod json;
mod list_util;
mod normalize;
mod pragmas;
#[cfg(unix)]
mod socket;
mod storable;
mod text;
mod time;

use std::{collections::{HashMap, HashSet}, rc::{Rc, Weak}};

use super::{
	ast::Sigil,
	interp::{Cx, Interp, NativeFn, PResult, Ret},
	value::{ArrayBody, Av, HKey, PStr, Ref, Sv, Value, new_av, new_sv},
};

/// Per-interpreter state for native and embedded core libraries.
#[derive(Default)]
pub(in crate::perl) struct State {
	vars: HashMap<String, u8>,
	english: HashMap<String, &'static str>,
	readonly_arrays: HashMap<usize, Weak<ArrayBody>>,
	hash_locks: extras::HashLocks,
	errno: Option<extras::ErrnoState>,
	warning_categories: HashSet<String>,
	file_glob: files::GlobState,
}

/// Refresh the aliases in `%!` after a change to `$!`.
pub(in crate::perl) use extras::update_errno;
/// Platform identity (`$^O`, `$Config{osname}`, `$Config{archname}`) and `perl -V` output.
pub(in crate::perl) use extras::{archname, osname, show_config};

/// Operations on potentially restricted hash keys.
#[derive(Clone, Copy, PartialEq, Eq)]
pub(in crate::perl) enum HashAccess {
	/// Read an ordinary element or slice.
	Read,
	/// Assign an element.
	Write,
	/// Remove an element.
	Delete,
}

/// Validate operations on restricted hashes and their keys.
pub(in crate::perl) use extras::{check_hash_access, check_hash_clear};
/// Whether a hash is restricted by `Internals::SvREADONLY` or `Hash::Util`.
pub(in crate::perl) use extras::readonly_hash;

type Loader = fn(&mut Interp<'_>, &str) -> PResult<()>;

fn library(module: &str) -> Option<Loader> {
	Some(match module {
		"Carp" => carp::load,
		"DynaLoader" | "XSLoader" | "attributes" | "Tie::Hash::NamedCapture" | "PerlIO" | "PerlIO::Layer"
		| "PerlIO::scalar" | "PerlIO::encoding" | "PerlIO::mmap" => infra::load,
		"Exporter" | "Exporter::Heavy" => exporter::load,
		"List::Util" | "Scalar::Util" => list_util::load,
		"MIME::Base64" | "MIME::QuotedPrint" | "Digest::MD5" | "Digest::SHA" | "Encode" => codec::load,
		"Data::Dumper" => dumper::load,
		"JSON::PP" => json::load,
		"Storable" => storable::load,
		"Cwd" | "FindBin" | "File::Basename" | "File::Spec" | "File::Spec::Unix" | "File::Spec::Functions" |
		"File::Path" | "File::Temp" | "File::Find" | "File::Copy" | "File::Compare" |
		"File::stat" | "File::Glob" | "IO" | "IO::Handle" | "IO::File" | "IO::Seekable" | "SelectSaver" => files::load,
		"Getopt::Long" | "Getopt::Std" => getopt::load,
		"POSIX" | "Time::HiRes" | "Time::Local" | "Time::Piece" | "Time::Seconds" | "Benchmark" => time::load,
		"Unicode::Normalize" => normalize::load,
		#[cfg(unix)]
		"Socket" => socket::load,
		"Text::Wrap" | "Text::Abbrev" | "Text::ParseWords" | "Text::Tabs" | "Term::ANSIColor" => text::load,
		"Config" | "Sys::Hostname" | "Fcntl" | "Errno" | "Hash::Util" | "Symbol" |
		"Tie::Hash" | "Tie::Array" | "Tie::Scalar" | "Env" | "IPC::Open2" | "IPC::Open3" => extras::load,
		m if pragmas::provides(m) => pragmas::load,
		_ => return None,
	})
}

fn inherits_exporter(module: &str) -> bool {
	matches!(module,
		"Benchmark" | "Carp" | "Cwd" | "Data::Dumper" | "Digest::SHA" | "English" | "Errno"
		| "Fcntl" | "File::Basename" | "File::Compare" | "File::Copy" | "File::Find"
		| "File::Path" | "File::Spec::Functions" | "FindBin" | "Getopt::Long" | "Getopt::Std"
		| "Hash::Util" | "IO::Handle" | "IO::Seekable" | "IO::File" | "IPC::Open2" | "IPC::Open3"
		| "JSON::PP" | "List::Util" | "MIME::Base64" | "MIME::QuotedPrint" | "Scalar::Util"
		| "Socket" | "Storable" | "Symbol" | "Sys::Hostname" | "Term::ANSIColor" | "Text::Abbrev" | "Text::ParseWords"
		| "Text::Tabs" | "Text::Wrap" | "Time::HiRes" | "Time::Local" | "Unicode::Normalize")
}

/// Builtin `require` registry; `None` lets Core search `@INC`.
pub(in crate::perl) fn require(interp: &mut Interp<'_>, module: &str) -> Option<PResult<()>> {
	let loader = library(module)?;
	Some((|| {
		let exporter = inherits_exporter(module);
		if exporter { interp.require_module("Exporter")?; }
		loader(interp, module)?;
		if exporter {
			let isa = interp.av(&format!("{module}::ISA"));
			let mut bases = isa.elems_mut();
			if !bases.iter().any(|sv| sv.get().to_pstr().bytes == b"Exporter") {
				bases.push(new_sv(Value::str("Exporter")));
			}
		}
		Ok(())
	})())
}

/// Whether a module has a builtin implementation.
pub(in crate::perl) fn provides(module: &str) -> bool { library(module).is_some() }

/// Registers subs that Perl makes available without loading a module.
pub(in crate::perl) fn install_core(interp: &mut Interp<'_>) {
	pragmas::install_core(interp);
	infra::install_core(interp);
	files::install_core(interp);
}

/// Construct the read-only match capture object for `%+` or `%-`.
pub(in crate::perl) use infra::named_capture_tie;
/// Obtain the original version components for vector formatting.
pub(in crate::perl) use pragmas::version_vector;

/// Whether `use vars` has predeclared a package variable.
pub(in crate::perl) fn declared_var(interp: &Interp<'_>, qualified: &str, sigil: Sigil) -> bool {
	pragmas::declared_var(interp, qualified, sigil)
}

/// Resolve a dynamic special variable's English synonym.
pub(in crate::perl) fn english_alias(interp: &Interp<'_>, qualified: &str) -> Option<&'static str> {
	pragmas::english_alias(interp, qualified)
}

/// Whether a scalar has been marked read-only by `Internals::SvREADONLY`.
pub(in crate::perl) fn readonly_sv(_: &Interp<'_>, sv: &Sv) -> bool { sv.module_readonly() }

/// Whether an array's structure has been marked read-only.
pub(in crate::perl) fn readonly_array(interp: &Interp<'_>, av: &Av) -> bool {
	readonly(&interp.modules.readonly_arrays, av)
}

fn readonly<T>(marks: &HashMap<usize, Weak<T>>, target: &Rc<T>) -> bool {
	marks.get(&(Rc::as_ptr(target) as usize)).is_some_and(|mark| mark.strong_count() != 0)
}

fn set_readonly<T>(marks: &mut HashMap<usize, Weak<T>>, target: &Rc<T>, on: bool) {
	let id = Rc::as_ptr(target) as usize;
	if on {
		if marks.len() >= 256 && marks.len() % 256 == 0 { marks.retain(|_, mark| mark.strong_count() != 0); }
		marks.insert(id, Rc::downgrade(target));
	} else { marks.remove(&id); }
}

/// Apply lexical `autodie` policy to a builtin result.
pub(in crate::perl) fn autodie_result(interp: &mut Interp<'_>, name: &str, result: PResult<Ret>) -> PResult<Ret> {
	pragmas::autodie_result(interp, name, result)
}

fn define(interp: &mut Interp<'_>, module: &str, defs: &[(&str, NativeFn)]) {
	interp.define_natives(module, defs);
}

fn version(interp: &mut Interp<'_>, module: &str, v: &str) {
	interp.sv(&format!("{module}::VERSION")).set(Value::str(v));
}

fn set_exports(interp: &mut Interp<'_>, module: &str, defaults: &[&str], optional: &[&str]) {
	for (suffix, names) in [("EXPORT", defaults), ("EXPORT_OK", optional)] {
		*interp.av(&format!("{module}::{suffix}")).elems_mut() = names.iter().map(|s| new_sv(Value::str(s))).collect();
	}
}

fn export(interp: &mut Interp<'_>, module: &str, defaults: &[&str], optional: &[&str]) {
	set_exports(interp, module, defaults, optional);
	interp.define_native(&format!("{module}::import"), exporter::import);
}

fn export_tag(interp: &mut Interp<'_>, module: &str, tag: &str, symbols: &[&str]) {
	let key = HKey::new(&PStr::from_str(tag));
	let items = new_av(symbols.iter().map(|s| Value::str(s)).collect());
	interp.hv(&format!("{module}::EXPORT_TAGS")).entries_mut().insert(key, new_sv(Value::Ref(Ref::Array(items))));
}

fn isa(interp: &mut Interp<'_>, module: &str, bases: &[&str]) {
	*interp.av(&format!("{module}::ISA")).elems_mut() = bases.iter().map(|s| new_sv(Value::str(s))).collect();
}

fn constant(interp: &mut Interp<'_>, qualified: &str, value: Value) { interp.define_constant(qualified, vec![value]); }

fn arg(args: &[Sv], index: usize) -> Value { args.get(index).map_or(Value::Undef, |s| s.get()) }
fn arg_pstr(args: &[Sv], index: usize) -> PStr {
	args.get(index).map_or_else(PStr::default, |s| s.get().to_pstr())
}
fn text(args: &[Sv], index: usize) -> String {
	args.get(index).map_or_else(String::new, |sv| match sv.get() {
		Value::Str(s) => s.to_string_lossy().into_owned(),
		Value::Dual(d) => d.str.to_string_lossy().into_owned(),
		v => v.to_pstr().to_string_lossy().into_owned(),
	})
}
fn boolean(on: bool) -> Ret { Ret::One(if on { Value::Int(1) } else { Value::str("") }) }
fn list(values: Vec<Value>, cx: Cx) -> Ret {
	if cx == Cx::List { Ret::Many(values) } else { Ret::One(Value::Int(values.len() as i64)) }
}

fn declare_slot(interp: &mut Interp<'_>, qualified: String, sigil: u8) {
	let mask = match sigil { b'$' => 1, b'@' => 2, b'%' => 4, b'&' => 8, b'*' => 31, _ => 0 };
	*interp.modules.vars.entry(qualified).or_default() |= mask;
}

fn alias(interp: &mut Interp<'_>, from: &str, to: &str, sigil: u8) {
	let from = interp.glob(from);
	let to = interp.glob(to);
	if Rc::ptr_eq(&from, &to) { return; }
	if matches!(sigil, b'$' | b'*') { *to.scalar.borrow_mut() = from.scalar.borrow().clone(); }
	if matches!(sigil, b'@' | b'*') { *to.array.borrow_mut() = from.array.borrow().clone(); }
	if matches!(sigil, b'%' | b'*') { *to.hash.borrow_mut() = from.hash.borrow().clone(); }
	if matches!(sigil, b'&' | b'*') { *to.code.borrow_mut() = from.code.borrow().clone(); }
	if sigil == b'*' { *to.io.borrow_mut() = from.io.borrow().clone(); }
}
