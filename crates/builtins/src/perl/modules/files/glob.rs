//! File::Glob: BSD glob(3) expansion with flags, plus its csh-style and `:bsd_glob` override forms.

use std::{collections::{HashMap, VecDeque}, rc::Rc};

use crate::perl::{
	func::sys::{bsd_glob, glob},
	interp::{Cx, Interp, PResult, Ret},
	modules::{alias, arg, constant, define, exporter, export_tag, set_exports, version},
	value::{PStr, Sv, Value, new_sv},
};

const GLOB_ERR: i64 = 0x0004;
const GLOB_MARK: i64 = 0x0008;
const GLOB_NOCHECK: i64 = 0x0010;
const GLOB_NOSORT: i64 = 0x0020;
const GLOB_ALTDIRFUNC: i64 = 0x0040;
const GLOB_BRACE: i64 = 0x0080;
const GLOB_NOMAGIC: i64 = 0x0200;
const GLOB_QUOTE: i64 = 0x0400;
const GLOB_TILDE: i64 = 0x0800;
const GLOB_NOCASE: i64 = 0x1000;
const GLOB_ALPHASORT: i64 = 0x2000;
const GLOB_LIMIT: i64 = 0x4000;
const GLOB_NOSPACE: i64 = -1;
const GLOB_ABEND: i64 = -2;
const GLOB_CSH: i64 = GLOB_BRACE | GLOB_NOMAGIC | GLOB_QUOTE | GLOB_TILDE | GLOB_ALPHASORT;
/// Request bits bsd_glob ignores from its caller (GLOB_APPEND, GLOB_DOOFFS, GLOB_ALTDIRFUNC, GLOB_MAGCHAR).
const IGNORED_FLAGS: i64 = 0x0001 | 0x0002 | GLOB_ALTDIRFUNC | 0x0100;

const TAG: &[&str] = &[
	"GLOB_ABEND", "GLOB_ALPHASORT", "GLOB_ALTDIRFUNC", "GLOB_BRACE", "GLOB_CSH", "GLOB_ERR", "GLOB_ERROR", "GLOB_LIMIT",
	"GLOB_MARK", "GLOB_NOCASE", "GLOB_NOCHECK", "GLOB_NOMAGIC", "GLOB_NOSORT", "GLOB_NOSPACE", "GLOB_QUOTE", "GLOB_TILDE",
	"bsd_glob",
];

/// GLOB_ERROR of the last bsd_glob, and the remaining results of scalar-context `:bsd_glob` globs per call site.
#[derive(Default)]
pub(in crate::perl::modules) struct GlobState {
	error: i64,
	pending: HashMap<(Rc<str>, u32), VecDeque<Value>>,
}

pub(super) fn load(interp: &mut Interp<'_>, module: &str) -> PResult<()> {
	version(interp, module, "1.33");
	for (name, value) in [
		("GLOB_ABEND", GLOB_ABEND), ("GLOB_ALPHASORT", GLOB_ALPHASORT), ("GLOB_ALTDIRFUNC", GLOB_ALTDIRFUNC),
		("GLOB_BRACE", GLOB_BRACE), ("GLOB_CSH", GLOB_CSH), ("GLOB_ERR", GLOB_ERR), ("GLOB_LIMIT", GLOB_LIMIT),
		("GLOB_MARK", GLOB_MARK), ("GLOB_NOCASE", GLOB_NOCASE), ("GLOB_NOCHECK", GLOB_NOCHECK),
		("GLOB_NOMAGIC", GLOB_NOMAGIC), ("GLOB_NOSORT", GLOB_NOSORT), ("GLOB_NOSPACE", GLOB_NOSPACE),
		("GLOB_QUOTE", GLOB_QUOTE), ("GLOB_TILDE", GLOB_TILDE),
	] {
		constant(interp, &format!("File::Glob::{name}"), Value::Int(value));
	}
	define(interp, module, &[
		("GLOB_ERROR", |i, _, _| Ok(Ret::One(Value::Int(i.modules.file_glob.error)))),
		("bsd_glob", bsd), ("csh_glob", csh), ("bsd_glob_override", bsd_override), ("import", import),
	]);
	let defaults = if cfg!(windows) { GLOB_CSH | GLOB_NOCASE } else { GLOB_CSH };
	interp.sv("File::Glob::DEFAULT_FLAGS").set(Value::Int(defaults));
	*interp.av("File::Glob::ISA").elems_mut() = vec![new_sv(Value::str("Exporter"))];
	let optional: Vec<&str> = TAG.iter().copied().chain(["csh_glob"]).collect();
	set_exports(interp, module, &[], &optional);
	export_tag(interp, module, "glob", TAG);
	export_tag(interp, module, "bsd_glob", TAG);
	Ok(())
}

fn default_flags(interp: &mut Interp<'_>) -> PResult<i64> {
	let sv = interp.sv("File::Glob::DEFAULT_FLAGS");
	Ok(interp.read_sv(&sv)?.to_i64())
}

/// One bsd_glob expansion; records GLOB_ERROR (GLOB_ABEND when GLOB_ERR stopped on a directory error).
fn expand(interp: &mut Interp<'_>, pattern: &PStr, flags: i64) -> PResult<Vec<Value>> {
	if flags & GLOB_ERR != 0 { interp.set_errno_code(0); }
	let found = bsd_glob(interp, &pattern.bytes, (flags & !IGNORED_FLAGS) as i32)?;
	let failed = flags & GLOB_ERR != 0 && {
		let errno = interp.sv("main::!");
		interp.read_sv(&errno)?.to_i64() != 0
	};
	interp.modules.file_glob.error = if failed { GLOB_ABEND } else { 0 };
	Ok(found)
}

fn bsd(interp: &mut Interp<'_>, args: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	let pattern = interp.stringify(&arg(&args, 0))?;
	let flags = if args.len() > 1 { interp.numify(&arg(&args, 1))?.wrapping_iv() } else { default_flags(interp)? };
	let found = expand(interp, &pattern, flags)?;
	Ok(if cx == Cx::List { Ret::Many(found) } else { Ret::One(found.into_iter().last().unwrap_or(Value::Undef)) })
}

fn pattern_or_topic(interp: &mut Interp<'_>, args: &[Sv]) -> PResult<PStr> {
	let value = match args.first() {
		Some(sv) => interp.read_sv(sv)?,
		None => { let topic = interp.topic(); interp.read_sv(&topic)? },
	};
	interp.stringify(&value)
}

fn csh(interp: &mut Interp<'_>, args: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	let pattern = pattern_or_topic(interp, &args)?;
	glob(interp, pattern, cx)
}

/// `glob` under `use File::Glob ':bsd_glob'`: bsd_glob semantics (no word splitting) with the
/// builtin's scalar-context iteration per call site.
fn bsd_override(interp: &mut Interp<'_>, args: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	let pattern = pattern_or_topic(interp, &args)?;
	let flags = default_flags(interp)?;
	if cx == Cx::List { return Ok(Ret::Many(expand(interp, &pattern, flags)?)); }
	let location = interp.location();
	let site = (location.file, location.line);
	if !interp.modules.file_glob.pending.contains_key(&site) {
		let found = expand(interp, &pattern, flags)?;
		interp.modules.file_glob.pending.insert(site.clone(), found.into());
	}
	let next = interp.modules.file_glob.pending.get_mut(&site).and_then(VecDeque::pop_front);
	if next.is_none() { interp.modules.file_glob.pending.remove(&site); }
	Ok(Ret::One(next.unwrap_or(Value::Undef)))
}

/// Handles `:case`, `:nocase`, `:globally`, and `:bsd_glob`, passing everything else (and `:bsd_glob`) to Exporter.
fn import(interp: &mut Interp<'_>, args: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	let mut passthrough = Vec::with_capacity(args.len());
	for (index, sv) in args.into_iter().enumerate() {
		let name = sv.get().to_pstr();
		if index == 0 { passthrough.push(sv); continue; }
		match name.bytes.as_slice() {
			b":case" | b":nocase" => {
				let flags = default_flags(interp)?;
				let flags = if name.bytes == b":case" { flags & !GLOB_NOCASE } else { flags | GLOB_NOCASE };
				interp.sv("File::Glob::DEFAULT_FLAGS").set(Value::Int(flags));
			},
			b":globally" => alias(interp, "File::Glob::csh_glob", "CORE::GLOBAL::glob", b'&'),
			b":bsd_glob" => {
				let package = interp.package();
				alias(interp, "File::Glob::bsd_glob_override", &format!("{package}::glob"), b'&');
				passthrough.push(sv);
			},
			_ => passthrough.push(sv),
		}
	}
	exporter::import(interp, passthrough, cx)
}
