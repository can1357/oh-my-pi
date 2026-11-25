//! Exporter and Exporter::Heavy: symbol lists, tags, and caller-level exporting.

use std::collections::HashSet;

use super::{alias, arg, define, export, text, version};
use crate::perl::{
	interp::{Cx, Interp, PResult, Ret},
	regex::{ExecOpts, Regex, RxFlags},
	value::{HKey, PStr, Ref, Sv, Value, new_sv},
};

/// Install the native Exporter implementation.
pub(super) fn load(interp: &mut Interp<'_>, module: &str) -> PResult<()> {
	version(interp, module, "5.76");
	if module == "Exporter" {
		export(interp, module, &[], &["import"]);
		define(interp, module, &[("export", export_sub), ("export_to_level", export_level),
			("export_fail", export_fail), ("export_tags", export_tags), ("export_ok_tags", export_ok_tags),
			("require_version", require_version)]);
	} else {
		interp.require_module("Exporter")?;
		define(interp, module, &[("heavy_export", export_sub), ("heavy_export_to_level", export_level),
			("heavy_export_tags", export_tags), ("heavy_export_ok_tags", export_ok_tags),
			("heavy_require_version", require_version)]);
	}
	Ok(())
}

/// Standard Exporter `import`, also installed in native libraries.
pub(super) fn import(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let module = text(&args, 0);
	let dest = interp.package();
	export_symbols(interp, &module, &dest, &args[1.min(args.len())..])?;
	Ok(Ret::empty())
}

fn export_sub(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let module = text(&args, 0);
	let dest = text(&args, 1);
	export_symbols(interp, &module, &dest, &args[2.min(args.len())..])?;
	Ok(Ret::empty())
}

fn export_level(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	let module = text(&args, 0);
	let level = arg(&args, 1).to_i64().max(0) as usize;
	let dest = if level == 0 { interp.package() } else {
		interp.caller_frame(level - 1).map_or_else(|| interp.package(), |f| f.package)
	};
	export_symbols(interp, &module, &dest, &args[3.min(args.len())..])?;
	Ok(Ret::empty())
}

fn export_fail(_: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	Ok(Ret::Many(args.into_iter().skip(1).map(|s| s.get()).collect()))
}

fn require_version(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	interp.call_method(arg(&args, 0), "VERSION", vec![arg(&args, 1)], Cx::Scalar)
}

fn export_tags(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	add_tags(interp, args, "EXPORT")
}

fn export_ok_tags(interp: &mut Interp<'_>, args: Vec<Sv>, _: Cx) -> PResult<Ret> {
	add_tags(interp, args, "EXPORT_OK")
}

fn add_tags(interp: &mut Interp<'_>, args: Vec<Sv>, array: &str) -> PResult<Ret> {
	let module = text(&args, 0);
	let tags = interp.hv(&format!("{module}::EXPORT_TAGS"));
	let requested: Vec<_> = if args.len() <= 1 {
		tags.entries().keys().map(HKey::to_pstr).collect()
	} else { args.iter().skip(1).map(|s| s.get().to_pstr()).collect() };
	let out = interp.av(&format!("{module}::{array}"));
	for tag in requested {
		if let Some(items) = tag_values(interp, &module, &tag) {
			out.elems_mut().extend(items.iter().map(|s| new_sv(Value::str(s))));
		} else { out.elems_mut().push(new_sv(Value::Str(tag))); }
	}
	Ok(Ret::empty())
}

fn tag_values(interp: &mut Interp<'_>, module: &str, tag: &PStr) -> Option<Vec<String>> {
	let tags = interp.hv(&format!("{module}::EXPORT_TAGS"));
	let map = tags.entries();
	let value = map.get(&HKey::new(tag))?.get();
	let Value::Ref(Ref::Array(items)) = value else { return None; };
	let values = items.elems().iter().map(|s| s.get().to_pstr().to_string_lossy().into_owned()).collect();
	Some(values)
}

fn names(interp: &mut Interp<'_>, module: &str, array: &str) -> Vec<String> {
	interp.av(&format!("{module}::{array}")).elems().iter()
		.map(|s| normalize(&s.get().to_pstr().to_string_lossy()).to_owned()).collect()
}

fn normalize(name: &str) -> &str { name.strip_prefix('&').unwrap_or(name) }

fn export_symbols(interp: &mut Interp<'_>, module: &str, dest: &str, specs: &[Sv]) -> PResult<()> {
	let defaults = names(interp, module, "EXPORT");
	let optional = names(interp, module, "EXPORT_OK");
	let allowed: HashSet<_> = defaults.iter().chain(&optional).map(String::as_str).collect();
	let mut selected = Vec::<String>::new();
	let mut errors = false;
	let first_is_removal = specs.first().is_some_and(|sv| sv.get().to_pstr().bytes.first() == Some(&b'!'));
	if specs.is_empty() || first_is_removal { selected.extend(defaults.iter().cloned()); }
	for spec in specs {
		let spec = spec.get().to_pstr();
		let s = spec.to_string_lossy();
		let (remove, s) = s.strip_prefix('!').map_or((false, s.as_ref()), |s| (true, s));
		let candidates = if s == ":DEFAULT" { defaults.clone() }
		else if let Some(tag) = s.strip_prefix(':') {
			if let Some(names) = tag_values(interp, module, &PStr::from_str(tag)) { names }
			else {
				interp.warn(format!("\"{tag}\" is not defined in %{module}::EXPORT_TAGS"));
				errors = true;
				continue;
			}
		} else if let Some(pat) = s.strip_prefix('/').and_then(|s| s.strip_suffix('/')) {
			let re = Regex::new(&PStr::from_str(pat), RxFlags::default()).map_err(|err| interp.die_msg(err))?;
			let mut matches = Vec::new();
			for candidate in defaults.iter().chain(&optional) {
				if re.exec(&PStr::from_str(candidate), 0, ExecOpts::default()).map_err(|err| interp.die_msg(err))?.is_some() {
					matches.push(candidate.clone());
				}
			}
			matches
		} else if s.as_bytes().first().is_some_and(u8::is_ascii_digit) && Value::str(s).looks_like_number() {
			interp.call_method(Value::str(module), "VERSION", vec![Value::str(s)], Cx::Scalar)?;
			continue;
		} else { vec![s.to_owned()] };
		for symbol in candidates {
			let name = normalize(&symbol);
			if remove { selected.retain(|n| n != name); }
			else if !allowed.contains(name) {
				interp.warn(format!("\"{name}\" is not exported by the {module} module\n"));
				errors = true;
			} else if !selected.iter().any(|s| s == name) { selected.push(name.to_owned()); }
		}
	}
	if errors { return Err(interp.die_msg("Can't continue after import errors")); }
	let fail = names(interp, module, "EXPORT_FAIL");
	let failures: Vec<_> = selected.iter().filter(|s| fail.contains(s)).map(|s| Value::str(s)).collect();
	if !failures.is_empty() {
		let args = if interp.find_method(module, "export_fail").is_some() {
			interp.call_method(Value::str(module), "export_fail", failures, Cx::List)?.list()
		} else { failures };
		if !args.is_empty() {
			for name in args { interp.warn(format!("\"{}\" is not implemented by the {module} module on this architecture\n", name.to_pstr().to_string_lossy())); }
			return Err(interp.die_msg("Can't continue after import errors"));
		}
	}
	for symbol in selected {
		let (sigil, name) = if symbol.as_bytes().first().is_some_and(|b| b"$@%*".contains(b)) {
			(symbol.as_bytes()[0], &symbol[1..])
		} else { (b'&', symbol.as_str()) };
		let source = if name.contains("::") { name.to_owned() } else { format!("{module}::{name}") };
		let basename = name.rsplit("::").next().unwrap_or(name);
		let qualified = format!("{dest}::{basename}");
		alias(interp, &source, &qualified, sigil);
		if sigil != b'&' { super::declare_slot(interp, qualified, sigil); }
	}
	Ok(())
}
