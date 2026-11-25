//! Lexical and package pragmas (perlpragma, perllexwarn, perlunicode, perlvar).

mod class;
mod version_object;

/// Obtain the original components of a version object for sprintf `%v`.
pub(in crate::perl) use version_object::version_vector;

use std::{cell::RefCell, path::Path, rc::Rc};

use super::{alias, arg, arg_pstr, boolean, define, text, version};
use crate::perl::{
	ast::Sigil,
	code::{CodeBody, CodeImpl},
	interp::{Cx, Interp, NativeFn, PResult, Ret, Warnings},
	value::{HKey, PStr, Ref, Sv, Value, new_sv},
};

fn metadata(module: &str) -> Option<(&'static str, NativeFn, Option<NativeFn>)> {
	Some(match module {
		"strict" => ("1.12", strict, Some(no_strict)),
		"warnings" => ("1.51", warnings, Some(no_warnings)),
		"warnings::register" => ("1.04", warnings_register, None),
		"feature" => ("1.64", feature, Some(no_feature)),
		"utf8" => ("1.24", utf8, Some(no_utf8)),
		"integer" => ("1.01", integer, Some(no_integer)),
		"bytes" => ("1.08", bytes, Some(no_bytes)),
		"lib" => ("0.65", lib, Some(no_lib)),
		"vars" => ("1.05", vars, None),
		"subs" => ("1.04", subs, None),
		"constant" => ("1.33", constants, None),
		"parent" => ("0.238", class::parent, None),
		"base" => ("2.27", class::base, None),
		"fields" => ("2.24", class::fields, None),
		"overload" => ("1.33", class::overload, Some(class::no_overload)),
		"mro" => ("1.25_001", class::mro, None),
		"re" => ("0.41", re, Some(no_re)),
		"open" => ("1.12", open, None),
		"sort" => ("2.04", sort, Some(sort)),
		"less" => ("0.03", less, Some(no_less)),
		"locale" => ("1.10", inert, Some(inert)),
		"diagnostics" => ("1.37", inert, Some(inert)),
		"autodie" => ("2.34", class::autodie, Some(class::no_autodie)),
		"English" => ("1.11", english, None),
		"experimental" => ("0.024", experimental, Some(no_experimental)),
		"version" => ("0.9928", version_object::import, None),
		"if" => ("0.0609", conditional, Some(no_conditional)),
		"deprecate" => ("0.04", deprecate, None),
		"charnames" => ("1.48", version_object::charnames_import, None),
		_ => return None,
	})
}

/// Whether the module has pragma registration.
pub(super) fn provides(module: &str) -> bool { metadata(module).is_some() }

/// Install pragma package/version and its import and auxiliary functions.
pub(super) fn load(interp: &mut Interp<'_>, module: &str) -> PResult<()> {
	let Some((v, import, unimport)) = metadata(module) else { return Ok(()) };
	version(interp, module, v);
	define(interp, module, &[("import", import)]);
	if let Some(unimport) = unimport { define(interp, module, &[("unimport", unimport)]); }
	match module {
		"warnings" => {
			define(interp, module, &[("enabled", warnings_enabled), ("fatal_enabled", fatal_enabled),
				("warn", emit_warning), ("warnif", warnif), ("register_categories", register_categories), ("bits", warnings_bits),
				("enabled_at_level", enabled_at_level), ("fatal_enabled_at_level", fatal_enabled_at_level),
				("warn_at_level", warn_at_level), ("warnif_at_level", warnif_at_level)]);
			warning_tables(interp);
		}
		"warnings::register" => interp.require_module("warnings")?,
		"experimental" => { interp.require_module("feature")?; interp.require_module("warnings")?; }
		"re" => {
			define(interp, module, &[("regexp_pattern", regexp_pattern), ("regname", regname),
				("regnames", regnames), ("regnames_count", regnames_count)]);
			super::set_exports(interp, module, &[], RE_EXPORTS);
		}
		"lib" => {
			let inc = interp.av("main::INC").elems().iter().map(|sv| new_sv(sv.get())).collect();
			*interp.av("lib::ORIG_INC").elems_mut() = inc;
		}
		"English" => english_symbols(interp),
		"less" => define(interp, module, &[("of", less_of)]),
		"sort" => define(interp, module, &[("current", sort_current)]),
		"bytes" => {
			let methods: &[(&str, NativeFn, &str)] = &[("length", bytes_length, "_"), ("ord", bytes_ord, "_"), ("chr", bytes_chr, "_"),
				("substr", bytes_substr, "$$;$$"), ("index", bytes_index, "$$;$"), ("rindex", bytes_rindex, "$$;$")];
			for &(name, func, proto) in methods { interp.define_native_proto(&format!("bytes::{name}"), func, proto); }
		}
		"fields" | "overload" | "mro" | "autodie" => class::install(interp, module),
		"version" | "charnames" => version_object::install(interp, module),
		_ => {}
	}
	Ok(())
}

/// Register functions available independently of pragma import.
pub(super) fn install_core(interp: &mut Interp<'_>) {
	define(interp, "utf8", &[("upgrade", upgrade), ("downgrade", downgrade), ("encode", utf8_encode),
		("decode", utf8_decode), ("is_utf8", is_utf8), ("valid", utf8_valid),
		("native_to_unicode", identity), ("unicode_to_native", identity)]);
	interp.define_native_proto("Internals::SvREADONLY", readonly, "\\[$%@];$");
	interp.define_native_proto("Internals::SvREFCNT", refcount, "\\[$%@];$");
	define(interp, "re", &[("is_regexp", is_regexp)]);
	// Perl's core (universal.c) provides version objects without `use version`.
	version_object::install(interp, "version");
}

fn inert(_: &mut Interp<'_>, _: Vec<Sv>, _: Cx) -> PResult<Ret> { Ok(Ret::empty()) }
fn identity(_: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { Ok(Ret::One(arg(&a, 0))) }
fn names(a: &[Sv]) -> impl Iterator<Item = String> + '_ { (1..a.len()).map(|n| text(a, n)) }

fn strict(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { strict_change(i, &a, true) }
fn no_strict(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { strict_change(i, &a, false) }
fn strict_change(i: &mut Interp<'_>, a: &[Sv], on: bool) -> PResult<Ret> {
	let tags: Vec<_> = if a.len() <= 1 { ["refs", "vars", "subs"].map(String::from).into() } else { names(a).collect() };
	let invalid: Vec<_> = tags.iter().filter(|tag| !matches!(tag.as_str(), "refs" | "vars" | "subs")).map(String::as_str).collect();
	if !invalid.is_empty() { return Err(i.die_msg(format!("Unknown 'strict' tag(s) '{}'", invalid.join(" ")))); }
	let hints = i.compiling_hints();
	for tag in tags {
		match tag.as_str() {
			"refs" => hints.strict_refs = on,
			"vars" => hints.strict_vars = on,
			_ => hints.strict_subs = on,
		}
	}
	Ok(Ret::empty())
}

fn warnings(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { warnings_change(i, &a, true) }
fn no_warnings(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { warnings_change(i, &a, false) }
fn warnings_change(i: &mut Interp<'_>, a: &[Sv], on: bool) -> PResult<Ret> {
	let mut fatal = false;
	let mut mode_only = a.len() <= 1;
	for category in names(a) {
		match category.as_str() {
			"FATAL" => { fatal = true; mode_only = true; }
			"NONFATAL" => { fatal = false; mode_only = true; }
			_ => { warning_change(i, &category, on, fatal)?; mode_only = false; }
		}
	}
	if mode_only { warning_change(i, "all", on, fatal)?; }
	Ok(Ret::empty())
}
fn warning_change(i: &mut Interp<'_>, category: &str, on: bool, fatal: bool) -> PResult<()> {
	let warnings = &mut i.compiling_hints().warnings;
	let found = if on { warnings.enable(category, fatal) } else { warnings.disable(category) };
	if i.modules.warning_categories.contains(category) || category == "all" {
		let registered = &mut i.compiling_hints().registered_warnings;
		if category == "all" { registered.clear(); }
		registered.insert(category.to_owned(), (on, on && fatal));
	} else if !found { return Err(i.die_msg(format!("Unknown warnings category '{category}'"))); }
	Ok(())
}
fn warnings_register(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let pkg = i.package();
	i.modules.warning_categories.insert(pkg.to_string());
	for name in names(&a) { i.modules.warning_categories.insert(format!("{pkg}::{name}")); }
	Ok(Ret::empty())
}
fn register_categories(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	for n in 0..a.len() { i.modules.warning_categories.insert(text(&a, n)); }
	Ok(Ret::empty())
}
fn warning_flags(i: &mut Interp<'_>, a: &[Sv]) -> PResult<(bool, bool, Option<crate::perl::interp::Frame>)> {
	let package = i.package();
	let value = arg(a, 0);
	let default = value.is_undef();
	let name: Rc<str> = match value {
		Value::Undef => package.clone(),
		Value::Ref(r) => r.blessed().unwrap_or_else(|| Rc::from("")),
		value => Rc::from(value.to_pstr().to_string_lossy().as_ref()),
	};
	let registered = i.modules.warning_categories.contains(name.as_ref());
	if !registered {
		if default { return Err(i.die_msg(format!("package '{name}' not registered for warnings"))); }
		let mut known = i.hints().warnings;
		if !known.enable(&name, false) { return Err(i.die_msg(format!("Unknown warnings category '{name}'"))); }
	}
	for level in 0..1024 {
		let Some(frame) = i.caller_frame(level) else { break; };
		if frame.package != package {
			let hints = i.caller_hints(level).unwrap_or_else(|| i.hints());
			let (enabled, fatal) = if registered {
				hints.registered_warnings.get(name.as_ref()).or_else(|| hints.registered_warnings.get("all"))
					.copied().unwrap_or_default()
			} else { (hints.warnings.enabled(&name), hints.warnings.fatal(&name)) };
			return Ok((enabled, fatal, Some(frame)));
		}
	}
	Ok((false, false, None))
}
fn warnings_enabled(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { Ok(boolean(warning_flags(i, &a)?.0)) }
fn fatal_enabled(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { Ok(boolean(warning_flags(i, &a)?.1)) }
fn warnif(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { warning_emit(i, &a, true) }
fn emit_warning(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { warning_emit(i, &a, false) }
fn warning_emit(i: &mut Interp<'_>, a: &[Sv], conditional: bool) -> PResult<Ret> {
	let (enabled, fatal, caller) = warning_flags(i, &a[..a.len().saturating_sub(1)])?;
	if !conditional || enabled {
		let mut message = text(a, a.len().saturating_sub(1));
		if !message.ends_with('\n') && let Some(frame) = caller {
			use std::fmt::Write as _;
			let _ = writeln!(message, " at {} line {}.", frame.file, frame.line);
		}
		if fatal { return Err(i.die_msg(message)); }
		i.warn(message);
	}
	Ok(Ret::empty())
}

/// Size of a lexical warning mask (`$warnings::BYTES`): two bits per category.
const WARNING_BYTES: usize = 19;
/// Categories in mask order (`%warnings::Offsets` is twice the index), as Perl 5.34 numbers them.
const WARNING_ORDER: &[&str] = &[
	"all", "closure", "deprecated", "exiting", "glob", "io", "closed", "exec", "layer", "newline",
	"pipe", "unopened", "misc", "numeric", "once", "overflow", "pack", "portable", "recursion", "redefine",
	"regexp", "severe", "debugging", "inplace", "internal", "malloc", "signal", "substr", "syntax",
	"ambiguous", "bareword", "digit", "parenthesis", "precedence", "printf", "prototype", "qw",
	"reserved", "semicolon", "taint", "threads", "uninitialized", "unpack", "untie", "utf8", "void",
	"imprecision", "illegalproto", "non_unicode", "nonchar", "surrogate", "experimental",
	"experimental::lexical_subs", "experimental::regex_sets", "experimental::smartmatch", "experimental::postderef",
	"experimental::signatures", "syscalls", "experimental::bitwise", "experimental::const_attr", "experimental::re_strict",
	"experimental::refaliasing", "experimental::win32_perlio", "locale", "missing", "redundant",
	"experimental::declared_refs", "experimental::alpha_assertions", "experimental::script_run", "shadow",
	"experimental::private_use", "experimental::uniprop_wildcards", "experimental::vlb", "experimental::isa",
	"experimental::try",
];
/// Categories enabled when no lexical warnings are in effect (`$warnings::DEFAULT`, oracle bytes).
const WARNING_DEFAULT: [u8; WARNING_BYTES] =
	[0x10, 0x01, 0, 0, 0, 0x50, 0x04, 0, 0, 0, 0, 0, 0, 0x55, 0x51, 0x55, 0x50, 0x51, 0x15];

/// Enabled-bit mask of a category and its subcategories; None for unknown categories.
fn category_mask(category: &str) -> Option<[u8; WARNING_BYTES]> {
	if category == "all" { return Some([0x55; WARNING_BYTES]); }
	let mut selected = Warnings::none();
	if !selected.enable(category, false) { return None; }
	let mut mask = [0; WARNING_BYTES];
	for (n, name) in WARNING_ORDER.iter().enumerate() {
		if selected.enabled(name) { mask[n / 4] |= 1 << (2 * (n % 4)); }
	}
	Some(mask)
}
/// `$warnings::BYTES`, `$LAST_BIT`, `$NONE`, `$DEFAULT`, `%Offsets`, `%Bits`, `%DeadBits`.
fn warning_tables(i: &mut Interp<'_>) {
	i.sv("warnings::BYTES").set(Value::Int(WARNING_BYTES as i64));
	i.sv("warnings::LAST_BIT").set(Value::Int(2 * WARNING_ORDER.len() as i64));
	i.sv("warnings::NONE").set(Value::Str(PStr::from_bytes(&[0; WARNING_BYTES])));
	i.sv("warnings::DEFAULT").set(Value::Str(PStr::from_bytes(&WARNING_DEFAULT)));
	let (offsets, bits, dead) = (i.hv("warnings::Offsets"), i.hv("warnings::Bits"), i.hv("warnings::DeadBits"));
	for (n, name) in WARNING_ORDER.iter().enumerate() {
		let key = HKey::new(&PStr::from_str(name));
		offsets.entries_mut().insert(key.clone(), new_sv(Value::Int(2 * n as i64)));
		if let Some(mask) = category_mask(name) {
			bits.entries_mut().insert(key.clone(), new_sv(Value::Str(PStr::from_bytes(&mask))));
			dead.entries_mut().insert(key, new_sv(Value::Str(PStr::from_bytes(&mask.map(|b| b << 1)))));
		}
	}
}
/// `warnings::bits(LIST)`: the mask `use warnings LIST` would add (FATAL/NONFATAL switch the fatal bits).
fn warnings_bits(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let mut mask = [0u8; WARNING_BYTES];
	let mut fatal = false;
	for word in (0..a.len()).map(|n| text(&a, n)) {
		match word.as_str() {
			"FATAL" => fatal = true,
			"NONFATAL" => fatal = false,
			_ => match category_mask(&word) {
				Some(bits) => for (slot, bit) in mask.iter_mut().zip(bits) {
					*slot |= bit;
					if fatal { *slot |= bit << 1; } else { *slot &= !(bit << 1); }
				},
				None if i.modules.warning_categories.contains(&word) => {}
				None => return Err(i.die_msg(format!("Unknown warnings category '{word}'"))),
			},
		}
	}
	Ok(Ret::One(Value::Str(PStr::from_bytes(&mask))))
}
/// Enabled/fatal state of a category at exactly caller frame `level` (0 = the immediate caller).
fn level_flags(i: &mut Interp<'_>, a: &[Sv]) -> PResult<(bool, bool, Option<crate::perl::interp::Frame>)> {
	let name: Rc<str> = match arg(a, 0) {
		Value::Ref(r) => r.blessed().unwrap_or_else(|| Rc::from("")),
		value => Rc::from(value.to_pstr().to_string_lossy().as_ref()),
	};
	let registered = i.modules.warning_categories.contains(name.as_ref());
	if !registered && !Warnings::none().enable(&name, false) {
		return Err(i.die_msg(format!("Unknown warnings category '{name}'")));
	}
	let level = usize::try_from(arg(a, 1).to_i64()).unwrap_or(0);
	let Some(frame) = i.caller_frame(level) else { return Ok((false, false, None)) };
	let hints = i.caller_hints(level).unwrap_or_else(|| i.hints());
	let (enabled, fatal) = if registered {
		hints.registered_warnings.get(name.as_ref()).or_else(|| hints.registered_warnings.get("all")).copied().unwrap_or_default()
	} else { (hints.warnings.enabled(&name), hints.warnings.fatal(&name)) };
	Ok((enabled, fatal, Some(frame)))
}
fn enabled_at_level(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { Ok(boolean(level_flags(i, &a)?.0)) }
fn fatal_enabled_at_level(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { Ok(boolean(level_flags(i, &a)?.1)) }
fn warn_at_level(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { level_emit(i, &a, false) }
fn warnif_at_level(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { level_emit(i, &a, true) }
fn level_emit(i: &mut Interp<'_>, a: &[Sv], conditional: bool) -> PResult<Ret> {
	if a.len() != 3 { return Err(i.die_msg("Usage: warnings::warn_at_level(category, level, message)")); }
	let (enabled, fatal, caller) = level_flags(i, a)?;
	if !conditional || enabled {
		let mut message = text(a, 2);
		if !message.ends_with('\n') && let Some(frame) = caller {
			use std::fmt::Write as _;
			let _ = writeln!(message, " at {} line {}.", frame.file, frame.line);
		}
		if fatal { return Err(i.die_msg(message)); }
		i.warn(message);
	}
	Ok(Ret::empty())
}

fn feature(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { feature_change(i, &a, true) }
fn no_feature(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { feature_change(i, &a, false) }
fn feature_change(i: &mut Interp<'_>, a: &[Sv], on: bool) -> PResult<Ret> {
	const ALL: &[&str] = &["say", "state", "switch", "fc", "signatures", "bitwise", "unicode_strings", "unicode_eval",
		"postderef_qq", "current_sub", "evalbytes", "isa", "try", "indirect", "multidimensional", "bareword_filehandles",
		"refaliasing", "declared_refs", "lexical_subs", "postderef", "array_base"];
	if a.len() <= 1 && !on { i.compiling_hints().features.bundle(5, 8); }
	if a.len() <= 1 && on { return Err(i.die_msg("No features specified")); }
	for name in names(a) {
		if let Some(bundle) = name.strip_prefix(':') {
			let features = &mut i.compiling_hints().features;
			match bundle {
				"all" => for feature in ALL { features.set(feature, on); },
				"default" => for f in ["indirect", "multidimensional", "bareword_filehandles"] { features.set(f, on); },
				_ => {
					let mut v = bundle.split('.');
					let major: Option<u32> = v.next().and_then(|s| s.parse().ok());
					let minor: Option<u32> = v.next().and_then(|s| s.parse().ok());
					let (Some(5), Some(minor @ 8..=34)) = (major, minor) else {
						return Err(i.die_msg(format!("Feature bundle \"{bundle}\" is not supported by Perl 5.34.1")));
					};
					let mut bundle = *features;
					bundle.bundle(5, minor);
					for f in ALL {
						if bundle.enabled(f) && !matches!(*f, "array_base" | "indirect" | "multidimensional" | "bareword_filehandles") {
							features.set(f, on);
						}
					}
				}
			}
		} else if !i.compiling_hints().features.set(&name, on) && !matches!(name.as_str(), "postderef" | "lexical_subs") {
			return Err(i.die_msg(format!("Feature \"{name}\" is not supported by Perl 5.34.1")));
		}
	}
	Ok(Ret::empty())
}
fn experimental(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { experimental_change(i, &a, true) }
fn no_experimental(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { experimental_change(i, &a, false) }
fn experimental_change(i: &mut Interp<'_>, a: &[Sv], on: bool) -> PResult<Ret> {
	for name in names(a) {
		let hints = i.compiling_hints();
		let had_feature = hints.features.set(&name, on);
		let category = format!("experimental::{name}");
		let known_warning = if on { hints.warnings.disable(&category) } else { hints.warnings.enable(&category, false) };
		if !had_feature && !known_warning && !matches!(name.as_str(), "lexical_subs" | "postderef") {
			return Err(i.die_msg(format!("Can't enable unknown feature {name}")));
		}
	}
	Ok(Ret::empty())
}

macro_rules! bool_pragma {
	($yes:ident, $no:ident, $key:ident) => {
		fn $yes(i: &mut Interp<'_>, _: Vec<Sv>, _: Cx) -> PResult<Ret> { i.compiling_hints().$key = true; Ok(Ret::empty()) }
		fn $no(i: &mut Interp<'_>, _: Vec<Sv>, _: Cx) -> PResult<Ret> { i.compiling_hints().$key = false; Ok(Ret::empty()) }
	};
}
bool_pragma!(utf8, no_utf8, utf8);
bool_pragma!(integer, no_integer, integer);
bool_pragma!(bytes, no_bytes, bytes);

fn lib(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { lib_change(i, &a, true) }
fn no_lib(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { lib_change(i, &a, false) }
fn lib_change(i: &mut Interp<'_>, a: &[Sv], on: bool) -> PResult<Ret> {
	let inc = i.av("main::INC");
	let mut paths = Vec::<PStr>::new();
	for sv in a.iter().skip(1) {
		let value = sv.get();
		let path = i.stringify(&value)?;
		let rendered = path.to_string_lossy();
		if rendered.is_empty() { i.warn("Empty compile time value given to use lib"); }
		let arch = super::archname();
		for sub in [format!("5.34.1/{arch}"), "5.34.1".to_owned(), arch] {
			let child = Path::new(rendered.as_ref()).join(sub);
			let path = PStr::from_str(&child.to_string_lossy());
			let resolved = i.resolve_path(&path.bytes);
			if !on || i.host().fs().metadata(&resolved).is_ok_and(|m| m.is_dir()) { paths.push(path); }
		}
		paths.push(path);
	}
	let mut seen = std::collections::HashSet::with_capacity(paths.len());
	paths.retain(|path| seen.insert(path.clone()));
	let mut entries = inc.elems_mut();
	entries.retain(|sv| !seen.contains(&sv.get().to_pstr()));
	if on { entries.splice(0..0, paths.into_iter().map(|path| new_sv(Value::Str(path)))); }
	Ok(Ret::empty())
}

/// Test import-time predeclarations of package variables.
pub(super) fn declared_var(i: &Interp<'_>, q: &str, s: Sigil) -> bool {
	let mask = match s { Sigil::Scalar => 1, Sigil::Array | Sigil::LastIndex => 2, Sigil::Hash => 4, Sigil::Code => 8, Sigil::Glob => 16 };
	i.modules.vars.get(q).is_some_and(|flags| *flags & mask != 0)
}
fn vars(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	for v in names(&a) {
		let Some((&sigil, rest)) = v.as_bytes().split_first() else { continue; };
		if !b"$@%*&".contains(&sigil) || rest.is_empty() { return Err(i.die_msg(format!("'{v}' is not a valid variable name"))); }
		let q = i.qualify(&v[1..]);
		super::declare_slot(i, q.to_string(), sigil);
		i.glob(&q);
	}
	Ok(Ret::empty())
}
fn subs(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	for name in names(&a) {
		let qualified = i.qualify(&name);
		let gv = i.glob(&qualified);
		let mut code = gv.code.borrow_mut();
		if code.is_none() {
			*code = Some(Rc::new(CodeBody {
				name: RefCell::new(Some(qualified)), pkg: gv.pkg.clone(),
				prototype: RefCell::new(None), body: RefCell::new(CodeImpl::Undefined), blessed: RefCell::new(None),
			}));
		}
	}
	Ok(Ret::empty())
}
fn constants(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	if let Value::Ref(Ref::Hash(h)) = arg(&a, 1) {
		let items: Vec<_> = h.entries().iter().map(|(key, value)| (key.to_pstr(), value.get())).collect();
		for (key, value) in items { define_constant(i, &key.to_string_lossy(), vec![value])?; }
	} else if a.len() > 1 {
		define_constant(i, &text(&a, 1), a.iter().skip(2).map(|sv| sv.get()).collect())?;
	}
	Ok(Ret::empty())
}
fn define_constant(i: &mut Interp<'_>, name: &str, values: Vec<Value>) -> PResult<()> {
	let bare = name.rsplit("::").next().unwrap_or(name);
	if bare.starts_with("__") { return Err(i.die_msg(format!("Constant name '{name}' begins with '__'"))); }
	if !name.split("::").all(|part| {
		let mut chars = part.chars();
		chars.next().is_some_and(|c| c == '_' || c.is_alphabetic()) && chars.all(|c| c == '_' || c.is_alphanumeric())
	}) { return Err(i.die_msg(format!("Constant name '{name}' has invalid characters"))); }
	let qualified = i.qualify(name);
	i.define_constant(&qualified, values);
	Ok(())
}

const RE_EXPORTS: &[&str] = &["is_regexp", "regexp_pattern", "regname", "regnames", "regnames_count"];
fn re(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { re_change(i, &a, true) }
fn no_re(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { re_change(i, &a, false) }
fn re_change(i: &mut Interp<'_>, a: &[Sv], on: bool) -> PResult<Ret> {
	if !on && a.len() <= 1 {
		let hints = i.compiling_hints();
		hints.re_mods.clear();
		hints.re_eval = false;
	}
	for s in names(a) {
		if s == "eval" {
			i.compiling_hints().re_eval = on;
		} else if let Some(mods) = s.strip_prefix('/') {
			re_modifiers(i, mods.as_bytes(), on);
		} else if RE_EXPORTS.contains(&s.as_str()) {
			let pkg = i.package();
			if on { alias(i, &format!("re::{s}"), &format!("{pkg}::{s}"), b'&'); }
		} else if !matches!(s.as_str(), "taint" | "strict" | "debug" | "debugcolor" | "Debug" | "Debugcolor") {
			i.warn(format!("Unknown \"re\" subpragma '{s}' (known ones are: 'debug', 'debugcolor', 'eval', 'taint')"));
		}
	}
	Ok(Ret::empty())
}
fn re_modifiers(i: &mut Interp<'_>, requested: &[u8], on: bool) {
	let mut modifiers = Vec::with_capacity(requested.len());
	let mut charset = None;
	let mut x = 0_usize;
	let mut ascii = 0_usize;
	for &b in requested {
		match b {
			b'm' | b's' | b'i' | b'n' | b'p' => if !modifiers.contains(&b) { modifiers.push(b); },
			b'x' => x = (x + 1).min(2),
			b'd' | b'l' | b'u' | b'a' => {
				if b == b'a' && charset == Some(b'a') { ascii = 2; }
				else { charset = Some(b); ascii = usize::from(b == b'a'); }
			}
			other => i.warn(format!("Unknown regular expression flag \"{}\"", char::from(other))),
		}
	}
	let active = &mut i.compiling_hints().re_mods;
	let old_charset = active.iter().copied().find(|b| b"adlu".contains(b));
	let old_ascii = active.iter().filter(|&&b| b == b'a').count();
	let old_x = active.iter().filter(|&&b| b == b'x').count();
	if on {
		for b in modifiers { if !active.contains(&b) { active.push(b); } }
		if let Some(b) = charset {
			active.retain(|b| !b"adlu".contains(b));
			if b != b'd' { active.extend(std::iter::repeat_n(b, ascii.max(1))); }
		}
		active.extend(std::iter::repeat_n(b'x', x.saturating_sub(old_x)));
	} else {
		let remove_charset = charset.is_some() && charset == old_charset && ascii == old_ascii;
		active.retain(|b| !modifiers.contains(b) && !(remove_charset && b"adlu".contains(b)));
		let mut remove_x = x;
		active.retain(|&b| {
			if b != b'x' || remove_x == 0 { return true; }
			remove_x -= 1;
			false
		});
	}
}
fn is_regexp(_: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { Ok(boolean(matches!(arg(&a, 0), Value::Ref(Ref::Regexp(_))))) }
fn regexp_pattern(_: &mut Interp<'_>, a: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	let Value::Ref(Ref::Regexp(r)) = arg(&a, 0) else {
		return Ok(if cx == Cx::List { Ret::Many(vec![]) } else { boolean(false) });
	};
	Ok(if cx != Cx::List { Ret::One(Value::Str(r.regex.stringify())) } else {
		use crate::perl::regex::Charset;
		let f = r.regex.flags();
		let mut mods = Vec::with_capacity(9);
		mods.extend_from_slice(match f.charset {
			Charset::Depends => b"", Charset::Locale => b"l", Charset::Unicode => b"u",
			Charset::Ascii => b"a", Charset::AsciiStrict => b"aa",
		});
		for (yes, flag) in [(f.m, b'm'), (f.s, b's'), (f.i, b'i'), (f.x || f.xx, b'x'), (f.xx, b'x'), (f.n, b'n'), (f.p, b'p')] {
			if yes { mods.push(flag); }
		}
		Ret::Many(vec![Value::Str(r.regex.source().clone()), Value::Str(PStr::new(mods, false))])
	})
}
fn regname(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let name = arg(&a, 0).to_pstr();
	Ok(Ret::One(crate::perl::rx::match_hash(i, if arg(&a, 1).truthy() { "-" } else { "+" })
		.and_then(|vs| vs.into_iter().find(|(k, _)| *k == name)).map_or(Value::Undef, |(_, v)| v)))
}
fn regnames(i: &mut Interp<'_>, a: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	let keys = crate::perl::rx::match_hash(i, if arg(&a, 0).truthy() { "-" } else { "+" })
		.unwrap_or_default().into_iter().map(|(k, _)| Value::Str(k));
	Ok(if cx == Cx::List { Ret::Many(keys.collect()) } else { Ret::One(keys.last().unwrap_or(Value::Undef)) })
}
fn regnames_count(i: &mut Interp<'_>, _: Vec<Sv>, _: Cx) -> PResult<Ret> {
	Ok(Ret::One(crate::perl::rx::named_count(i, true).map_or(Value::Undef, |n| Value::Int(n as i64))))
}

fn open(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let mut opened = i.compiling_hints().open_layers.clone().unwrap_or_default();
	let mut std = false;
	let mut names = names(&a);
	while let Some(which) = names.next() {
		if which == ":std" { std = true; continue; }
		let (streams, layers) = match which.as_str() {
			"IN" | "OUT" | "IO" => {
				let layers = names.next().ok_or_else(|| i.die_msg("open: needs explicit list of PerlIO layers"))?;
				(which.as_str(), layers)
			}
			":locale" => ("IO", ":encoding(UTF-8)".into()),
			":utf8" => ("IO", which.clone()),
			s if s.starts_with(":encoding(") && s.ends_with(')') => ("IO", which.clone()),
			_ => return Err(i.die_msg(format!("Unknown PerlIO layer class '{which}' (need IN, OUT or IO)"))),
		};
		let mut canonical = String::with_capacity(layers.len() + 1);
		for layer in layers.split_whitespace() {
			if !layer.starts_with(':') { canonical.push(':'); }
			canonical.push_str(layer);
		}
		let layers = PStr::new(canonical.into_bytes(), false);
		match streams {
			"IN" => opened.0 = layers,
			"OUT" => opened.1 = layers,
			_ => opened = (layers.clone(), layers),
		}
	}
	if std {
		for (name, layers) in [("STDIN", &opened.0), ("STDOUT", &opened.1), ("STDERR", &opened.1)] {
			if !layers.is_empty() && let Some(io) = i.handle(name, false) {
				let result = io.borrow_mut().binmode(&layers.bytes);
				result.map_err(|e| i.die_msg(e))?;
			}
		}
	}
	i.compiling_hints().open_layers = Some(opened);
	Ok(Ret::empty())
}
fn sort(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	for name in names(&a) {
		if !matches!(name.as_str(), "stable" | "_mergesort" | "_qsort" | "defaults" | "_quicksort") {
			return Err(i.die_msg(format!("sort: unknown subpragma '{name}'")));
		}
	}
	Ok(Ret::empty())
}
fn sort_current(_: &mut Interp<'_>, _: Vec<Sv>, _: Cx) -> PResult<Ret> { Ok(boolean(false)) }
fn less(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let options: Vec<_> = if a.len() == 1 { vec!["please".to_owned()] } else { names(&a).collect() };
	for s in options.into_iter().flat_map(|s| s.split_whitespace().map(str::to_owned).collect::<Vec<_>>()) {
		let less = &mut i.compiling_hints().less;
		if !less.contains(&s) { less.push(s); }
	}
	Ok(Ret::empty())
}
fn no_less(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let less = &mut i.compiling_hints().less;
	if a.len() <= 1 { less.clear(); } else { for s in names(&a) { less.retain(|k| k != &s); } }
	Ok(Ret::empty())
}
fn less_of(i: &mut Interp<'_>, a: Vec<Sv>, cx: Cx) -> PResult<Ret> {
	let less = &i.hints().less;
	Ok(if a.len() <= 1 && cx == Cx::List { Ret::Many(less.iter().map(|s| Value::str(s)).collect()) }
	else if a.len() <= 1 { Ret::One(Value::Int(less.len() as i64)) }
	else { boolean(names(&a).any(|s| less.contains(&s))) })
}
fn conditional(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { use_if(i, &a, true) }
fn no_conditional(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> { use_if(i, &a, false) }
fn use_if(i: &mut Interp<'_>, a: &[Sv], on: bool) -> PResult<Ret> {
	if a.len() < 3 { return Err(i.die_msg("Too few arguments to 'use if' (some code returning an empty list in list context?)")); }
	if i.truthy(&arg(a, 1))? {
		let module = text(a, 2);
		i.require_module(&module)?;
		if let Some(cv) = i.find_method(&module, if on { "import" } else { "unimport" }) {
			i.call_sub(&cv, a[2..].to_vec(), Cx::Void)?;
		}
	}
	Ok(Ret::empty())
}
/// `use deprecate`: warns only when the importing module was loaded from a core library directory
/// (`privlibexp`/`archlibexp` of `%deprecate::Config`, else `%Config`), reporting the `require` site.
fn deprecate(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	if !i.warn_on("deprecated") { return Ok(Ret::empty()); }
	let module = if a.len() > 1 { text(&a, 1) } else { i.package().to_string() };
	let key = format!("{}.pm", module.replace("::", "/"));
	let loaded = i.hv("main::INC").entries().get(&HKey::new(&PStr::from_str(&key))).map(|sv| sv.get().to_pstr().to_string_lossy().into_owned());
	let Some(dir) = loaded.as_deref().and_then(|file| file.strip_suffix(key.as_str())) else { return Ok(Ret::empty()) };
	let dir = dir.trim_end_matches('/');
	let overrides = i.hv("deprecate::Config");
	let config = if overrides.entries().is_empty() { i.hv("Config::Config") } else { overrides };
	let lookup = |name: &str| config.entries().get(&HKey::new(&PStr::from_str(name)))
		.map(|sv| sv.get().to_pstr().to_string_lossy().trim_end_matches('/').to_owned());
	let is = |names: &[&str]| names.iter().any(|name| lookup(name).is_some_and(|d| !d.is_empty() && d == dir));
	if !is(&["privlibexp", "archlibexp"][..]) || is(&["sitelibexp", "sitearchexp"][..]) { return Ok(Ret::empty()); }
	let site = (0..).map_while(|level| i.caller_frame(level)).find(|frame| frame.is_require);
	let mut msg = format!("{module} will be removed from the Perl core distribution in the next major release. Please install it from CPAN.");
	if let Some(frame) = site { msg.push_str(&format!(" at {} line {}.\n", frame.file, frame.line)); }
	i.warn(msg);
	Ok(Ret::empty())
}

macro_rules! english_aliases {
	($($name:literal => $target:literal),* $(,)?) => {
		const ENGLISH: &[(&str, &str)] = &[$(($name, concat!("main::", $target))),*];
	};
}
english_aliases! {
	"ARG" => "_", "LIST_SEPARATOR" => "\"", "SUBSCRIPT_SEPARATOR" => ";", "SUBSEP" => ";",
	"REAL_GROUP_ID" => "(", "GID" => "(", "EFFECTIVE_GROUP_ID" => ")", "EGID" => ")",
	"REAL_USER_ID" => "<", "UID" => "<", "EFFECTIVE_USER_ID" => ">", "EUID" => ">",
	"PROCESS_ID" => "$", "PID" => "$", "PROGRAM_NAME" => "0", "SYSTEM_FD_MAX" => "^F",
	"INPUT_LINE_NUMBER" => ".", "NR" => ".", "INPUT_RECORD_SEPARATOR" => "/", "RS" => "/",
	"OUTPUT_AUTOFLUSH" => "|", "OUTPUT_FIELD_SEPARATOR" => ",", "OFS" => ",", "OUTPUT_RECORD_SEPARATOR" => "\\", "ORS" => "\\",
	"FORMAT_FORMFEED" => "^L", "FORMAT_PAGE_NUMBER" => "%", "FORMAT_LINES_PER_PAGE" => "=", "FORMAT_LINES_LEFT" => "-",
	"FORMAT_NAME" => "~", "FORMAT_TOP_NAME" => "^", "FORMAT_LINE_BREAK_CHARACTERS" => ":", "ACCUMULATOR" => "^A",
	"CHILD_ERROR" => "?", "OS_ERROR" => "!", "ERRNO" => "!", "EVAL_ERROR" => "@", "EXTENDED_OS_ERROR" => "^E",
	"BASETIME" => "^T", "WARNING" => "^W", "DEBUGGING" => "^D", "OSNAME" => "^O", "PERL_VERSION" => "^V", "OLD_PERL_VERSION" => "]",
	"EXCEPTIONS_BEING_CAUGHT" => "^S", "COMPILING" => "^C", "EXECUTABLE_NAME" => "^X", "INPLACE_EDIT" => "^I",
	"PERLDB" => "^P", "LAST_PAREN_MATCH" => "+", "LAST_SUBMATCH_RESULT" => "^N", "LAST_REGEXP_CODE_RESULT" => "^R",
	"MATCH" => "&", "PREMATCH" => "`", "POSTMATCH" => "'", "LAST_MATCH_START" => "-", "LAST_MATCH_END" => "+",
}
fn english_sigil(name: &str) -> u8 {
	if matches!(name, "LAST_MATCH_START" | "LAST_MATCH_END") { b'@' } else { b'*' }
}
fn english_symbols(i: &mut Interp<'_>) {
	let mut exports = Vec::with_capacity(ENGLISH.len());
	for &(name, target) in ENGLISH {
		let sigil = english_sigil(name);
		let pkg_name = format!("English::{name}");
		alias(i, target, &pkg_name, sigil);
		if sigil != b'@' { i.modules.english.insert(pkg_name, target); }
		exports.push(new_sv(Value::str(&format!("{}{name}", char::from(sigil)))));
	}
	*i.av("English::EXPORT").elems_mut() = exports;
}
fn english(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let pkg = i.package();
	let opts: Vec<_> = names(&a).collect();
	let no_matches = opts.iter().any(|s| s == "-no_match_vars");
	let requested: Vec<_> = opts.iter().filter(|s| !s.starts_with('-')).map(|s| s.trim_start_matches(['$', '@'])).collect();
	for &(name, target) in ENGLISH {
		if (no_matches && matches!(name, "MATCH" | "PREMATCH" | "POSTMATCH")) || (!requested.is_empty() && !requested.contains(&name)) { continue; }
		let q = format!("{pkg}::{name}");
		let sigil = english_sigil(name);
		if sigil != b'@' { i.modules.english.insert(q.clone(), target); }
		alias(i, target, &q, sigil);
		super::declare_slot(i, q, sigil);
	}
	Ok(Ret::empty())
}

/// Return a special variable's actual name when imported via English.
pub(super) fn english_alias(i: &Interp<'_>, q: &str) -> Option<&'static str> {
	i.modules.english.get(q).copied()
}

/// Store a representation change (same characters, other encoding): read-only values change in place.
fn store_representation(i: &mut Interp<'_>, target: &Sv, value: Value) -> PResult<()> {
	if i.is_readonly_sv(target) { target.set(value); Ok(()) } else { i.write_sv(target, value) }
}
fn upgrade(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let Some(target) = a.first() else { return Ok(Ret::One(Value::Int(0))); };
	let value = i.read_sv(target)?;
	if value.is_undef() { return Ok(Ret::One(Value::Int(0))); }
	let mut s = value.to_pstr();
	if s.utf8 { return Ok(Ret::One(Value::Int(s.bytes.len() as i64))); }
	s.upgrade();
	let len = s.bytes.len();
	store_representation(i, target, Value::Str(s))?;
	Ok(Ret::One(Value::Int(len as i64)))
}
fn downgrade(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let Some(target) = a.first() else { return Ok(boolean(true)); };
	let s = i.read_sv(target)?.to_pstr();
	if !s.utf8 { return Ok(boolean(true)); }
	if let Some(bytes) = s.downgraded() {
		store_representation(i, target, Value::Str(PStr::new(bytes, false)))?;
		Ok(boolean(true))
	} else if arg(&a, 1).truthy() { Ok(boolean(false)) }
	else { Err(i.die_msg("Wide character in subroutine entry")) }
}
fn utf8_encode(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let Some(target) = a.first() else { return Ok(Ret::empty()); };
	let mut s = i.read_sv(target)?.to_pstr();
	s.upgrade();
	s.utf8 = false;
	i.write_sv(target, Value::Str(s))?;
	Ok(Ret::empty())
}
fn utf8_decode(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let Some(target) = a.first() else { return Ok(boolean(true)); };
	let mut s = i.read_sv(target)?.to_pstr();
	if s.utf8 {
		let Some(bytes) = s.downgraded() else { return Ok(boolean(false)); };
		s = PStr::new(bytes, false);
	}
	let valid = valid_extended_utf8(&s.bytes);
	s.utf8 = valid && !s.bytes.is_ascii();
	i.write_sv(target, Value::Str(s))?;
	Ok(boolean(valid))
}
fn utf8_value(v: &Value) -> Option<&PStr> {
	match v {
		Value::Str(s) if s.utf8 => Some(s),
		Value::Dual(d) if d.str.utf8 => Some(&d.str),
		_ => None,
	}
}
fn is_utf8(_: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	Ok(boolean(a.first().is_some_and(|sv| utf8_value(&sv.get()).is_some())))
}
fn utf8_valid(_: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	Ok(boolean(a.first().is_none_or(|sv| utf8_value(&sv.get()).is_none_or(|s| valid_extended_utf8(&s.bytes)))))
}
fn valid_extended_utf8(mut b: &[u8]) -> bool {
	while let Some(&head) = b.first() {
		if head.is_ascii() { b = &b[1..]; continue; }
		let (n, lead, min) = match head {
			0xc2..=0xdf => (2, head & 0x1f, 0x80_u32), 0xe0..=0xef => (3, head & 0x0f, 0x800),
			0xf0..=0xf7 => (4, head & 7, 0x10000), 0xf8..=0xfb => (5, head & 3, 0x200000),
			0xfc..=0xfd => (6, head & 1, 0x4000000), 0xfe => (7, 0, 0x80000000), _ => return false,
		};
		let Some(seq) = b.get(1..n) else { return false; };
		let mut cp = u32::from(lead);
		for &tail in seq {
			if tail & 0xc0 != 0x80 || cp > u32::MAX >> 6 { return false; }
			cp = (cp << 6) | u32::from(tail & 0x3f);
		}
		if cp < min { return false; }
		b = &b[n..];
	}
	true
}
fn readonly(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let flag = a.get(1).map(|slot| slot.get().truthy());
	let on = match arg(&a, 0) {
		Value::Ref(Ref::Scalar(sv)) => {
			if let Some(on) = flag { super::set_readonly(&mut i.modules.readonly, &sv, on); }
			super::readonly_sv(i, &sv)
		}
		Value::Ref(Ref::Array(av)) => {
			if let Some(on) = flag { super::set_readonly(&mut i.modules.readonly_arrays, &av, on); }
			super::readonly_array(i, &av)
		}
		Value::Ref(Ref::Hash(hv)) => {
			if let Some(on) = flag { super::extras::set_hash_readonly(i, &hv, on); }
			super::readonly_hash(i, &hv)
		}
		_ => false,
	};
	Ok(boolean(on))
}
fn refcount(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let Value::Ref(reference) = arg(&a, 0) else { return Err(i.die_msg("Usage: Internals::SvREFCNT(SCALAR[, REFCOUNT])")); };
	if a.len() > 1 { return Err(i.die_msg("Cannot modify reference counts in this interpreter")); }
	let count = match reference {
		Ref::Scalar(s) => Rc::strong_count(&s),
		Ref::Array(a) => Rc::strong_count(&a),
		Ref::Hash(h) => Rc::strong_count(&h),
		Ref::Code(c) => Rc::strong_count(&c),
		Ref::Glob(g) => Rc::strong_count(&g),
		Ref::Regexp(r) => Rc::strong_count(&r),
		Ref::Io(io) => Rc::strong_count(&io),
	};
	// Discount the reference cloned for inspection.
	Ok(Ret::One(Value::Int(count.saturating_sub(1) as i64)))
}
fn bytes_arg(i: &mut Interp<'_>, a: &[Sv]) -> Value {
	if a.is_empty() { i.topic().get() } else { arg(a, 0) }
}
fn bytes_length(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	Ok(Ret::One(match bytes_arg(i, &a) { Value::Undef => Value::Undef, v => Value::Int(v.to_pstr().bytes.len() as i64) }))
}
fn bytes_ord(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	Ok(Ret::One(Value::Int(bytes_arg(i, &a).to_pstr().bytes.first().copied().unwrap_or(0).into())))
}
fn bytes_chr(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	Ok(Ret::One(Value::bytes(&[bytes_arg(i, &a).to_i64() as u8])))
}
fn bytes_substr(i: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let mut s = arg_pstr(&a, 0);
	let n = s.bytes.len() as i64;
	let pos = arg(&a, 1).to_i64();
	let start = if pos < 0 { pos.saturating_add(n) } else { pos };
	let end = if a.len() < 3 { n } else {
		let len = arg(&a, 2).to_i64();
		if len < 0 { n.saturating_add(len).max(start) } else { start.saturating_add(len) }
	};
	if end < 0 || start > n {
		if a.len() >= 4 { return Err(i.die_msg("substr outside of string")); }
		i.warn_category("substr", "substr outside of string");
		return Ok(Ret::empty());
	}
	let start = start.max(0) as usize;
	let end = end.clamp(start as i64, n) as usize;
	let old = Value::bytes(&s.bytes[start..end]);
	if a.len() >= 4 {
		let replacement = arg_pstr(&a, 3);
		s.bytes.splice(start..end, replacement.bytes);
		s.utf8 = false;
		if let Some(target) = a.first() { i.write_sv(target, Value::Str(s))?; }
	}
	Ok(Ret::One(old))
}
fn bytes_index(_: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let hay = arg_pstr(&a, 0);
	let needle = arg_pstr(&a, 1);
	let start = (arg(&a, 2).to_i64().max(0) as usize).min(hay.bytes.len());
	let n = memchr::memmem::find(&hay.bytes[start..], &needle.bytes).map_or(-1, |n| (n + start) as i64);
	Ok(Ret::One(Value::Int(n)))
}
fn bytes_rindex(_: &mut Interp<'_>, a: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let hay = arg_pstr(&a, 0);
	let needle = arg_pstr(&a, 1);
	let n = if a.len() < 3 { hay.bytes.len() as i64 } else { arg(&a, 2).to_i64() };
	if n < 0 { return Ok(Ret::One(Value::Int(-1))); }
	let end = (n as usize).saturating_add(needle.bytes.len()).min(hay.bytes.len());
	Ok(Ret::One(Value::Int(memchr::memmem::rfind(&hay.bytes[..end], &needle.bytes).map_or(-1, |n| n as i64))))
}

/// Enforce `autodie` on native builtin return values with an exception object.
pub(super) fn autodie_result(i: &mut Interp<'_>, name: &str, result: PResult<Ret>) -> PResult<Ret> { class::autodie_result(i, name, result) }
