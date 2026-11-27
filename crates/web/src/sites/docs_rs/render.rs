use std::{collections::HashSet, fmt::Write as _};

use serde_json::Value;

use super::{Index, arr_of, lookup};

const GROUPS: [(&str, &str); 9] = [
	("module", "Modules"),
	("macro_def", "Macros"),
	("struct", "Structs"),
	("enum", "Enums"),
	("trait", "Traits"),
	("function", "Functions"),
	("type_alias", "Type Aliases"),
	("constant", "Constants"),
	("static", "Statics"),
];

pub(super) fn module(
	module: &Value,
	index: &Index,
	version: Option<&str>,
	path: &[String],
) -> String {
	let mut out = String::from("# ");
	for (i, name) in path.iter().enumerate() {
		if i != 0 {
			out.push_str("::");
		}
		out.push_str(name);
	}
	out.push_str("\n\n");
	write_docs(&mut out, module);

	let Some(ids) = module["inner"]["module"]["items"].as_array() else {
		return out;
	};
	let mut groups = [const { Vec::new() }; GROUPS.len()];
	for mut item in ids.iter().filter_map(|id| lookup(index, id)) {
		let name = if let Some(reexport) = item["inner"].get("use") {
			let Some(resolved) = lookup(index, &reexport["id"]) else {
				continue;
			};
			item = resolved;
			text(reexport, "name")
		} else {
			text(item, "name")
		};
		let Some(name) = name else { continue };
		let visibility = &item["visibility"];
		if visibility.as_str() == Some("crate") || visibility.get("restricted").is_some() {
			continue;
		}
		let Some((kind, data)) = variant(&item["inner"]) else {
			continue;
		};
		if let Some(i) = GROUPS.iter().position(|(group, _)| *group == kind) {
			groups[i].push((name, item, data));
		}
	}

	for ((kind, title), entries) in GROUPS.into_iter().zip(groups) {
		section(&mut out, title, entries.into_iter(), |out, (name, item, data)| {
			if kind == "function" {
				out.push_str("- `");
				write_function(out, item["name"].as_str().unwrap_or("?"), data);
				out.push('`');
			} else {
				let _ = write!(out, "- **{name}**");
			}
			if let Some(docs) = item["docs"].as_str() {
				let summary = first_line(docs);
				if !summary.is_empty() {
					write_summary(out, summary);
				}
			}
			out.push('\n');
		});
	}
	write_version(&mut out, version);
	out
}

pub(super) fn item(item: &Value, index: &Index, version: Option<&str>) -> String {
	let (kind, data) = variant(&item["inner"]).unwrap_or(("unknown", &Value::Null));
	let name = item["name"].as_str().unwrap_or("null");
	let mut out = format!("# {kind} {name}\n\n");
	if let Some(deprecation) = present(item, "deprecation") {
		out.push_str("> **Deprecated**");
		if let Some(note) = text(deprecation, "note") {
			let _ = write!(out, ": {note}");
		}
		out.push_str("\n\n");
	}
	write_declaration(&mut out, kind, item["name"].as_str(), data);
	write_docs(&mut out, item);

	if matches!(kind, "struct" | "enum" | "trait" | "union") {
		write_trait_items(&mut out, index, arr_of(data, "items"));
		write_impls(&mut out, index, arr_of(data, "impls"));
	}
	if kind == "enum" {
		let variants = arr_of(data, "variants")
			.iter()
			.filter_map(|id| lookup(index, id))
			.filter_map(|variant| Some((text(variant, "name")?, variant)));
		section(&mut out, "Variants", variants, |out, (name, variant)| {
			let _ = write!(out, "- `{name}`");
			write_short_docs(out, variant);
		});
	}
	write_version(&mut out, version);
	out
}

fn variant(value: &Value) -> Option<(&str, &Value)> {
	let (kind, data) = value.as_object()?.iter().next()?;
	Some((kind, data))
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
	value[key].as_str().filter(|s| !s.is_empty())
}

fn present<'a>(value: &'a Value, key: &str) -> Option<&'a Value> {
	value.get(key).filter(|v| !v.is_null())
}

fn flag(value: &Value, key: &str) -> bool {
	value[key].as_bool().unwrap_or(false)
}

fn write_docs(out: &mut String, item: &Value) {
	if let Some(docs) = text(item, "docs") {
		let _ = write!(out, "{docs}\n\n");
	}
}

fn write_short_docs(out: &mut String, item: &Value) {
	if let Some(docs) = text(item, "docs") {
		write_summary(out, first_line(docs));
	}
	out.push('\n');
}

fn first_line(docs: &str) -> &str {
	let line = docs.split_once('\n').map_or(docs, |(first, _)| first);
	line.trim_matches(|c: char| c == '\u{feff}' || (c.is_whitespace() && c != '\u{85}'))
}

fn write_summary(out: &mut String, line: &str) {
	out.push_str(" — ");
	if line.len() > 200 {
		// The TypeScript scraper's 200-character limit counts UTF-16 code units.
		let mut units = 0;
		let mut end = 0;
		for (i, ch) in line.char_indices() {
			units += ch.len_utf16();
			if units <= 197 {
				end = i + ch.len_utf8();
			} else if units > 200 {
				out.push_str(&line[..end]);
				out.push_str("...");
				return;
			}
		}
	}
	out.push_str(line);
}

fn write_version(out: &mut String, version: Option<&str>) {
	if let Some(version) = version {
		let _ = write!(out, "---\n*{version}*\n");
	}
}

fn section<T>(
	out: &mut String,
	title: &str,
	mut entries: impl Iterator<Item = T>,
	mut write_entry: impl FnMut(&mut String, T),
) {
	if let Some(first) = entries.next() {
		let _ = write!(out, "## {title}\n\n");
		write_entry(out, first);
		for entry in entries {
			write_entry(out, entry);
		}
		out.push('\n');
	}
}

fn write_trait_items(out: &mut String, index: &Index, ids: &[Value]) {
	let children = ids.iter().filter_map(|id| lookup(index, id));
	let required = children.clone().filter(|item| {
		let inner = &item["inner"];
		inner
			.get("function")
			.map_or_else(|| inner.get("assoc_type").is_some(), |data| !flag(data, "has_body"))
	});
	section(out, "Required Methods", required, |out, item| {
		if let Some(data) = item["inner"].get("function") {
			write_method(out, item, data);
		} else {
			let name = item["name"].as_str().unwrap_or("null");
			let _ = write!(out, "- `type {name}`");
			write_short_docs(out, item);
		}
	});
	let provided = children.filter_map(|item| {
		let data = item["inner"].get("function")?;
		flag(data, "has_body").then_some((item, data))
	});
	section(out, "Provided Methods", provided, |out, (item, data)| write_method(out, item, data));
}

fn write_impls(out: &mut String, index: &Index, ids: &[Value]) {
	let impls = ids
		.iter()
		.filter_map(|id| lookup(index, id)?.get("inner")?.get("impl"))
		.filter(|data| !flag(data, "is_synthetic") && data["blanket_impl"].is_null());
	let methods = impls
		.clone()
		.filter(|data| data["trait"].is_null())
		.flat_map(|data| arr_of(data, "items"))
		.filter_map(|id| lookup(index, id))
		.filter_map(|item| {
			text(item, "name")?;
			Some((item, item["inner"].get("function")?))
		});
	section(out, "Methods", methods, |out, (item, data)| write_method(out, item, data));

	let mut seen = HashSet::new();
	let mut name = String::new();
	for trait_path in impls.filter_map(|data| present(data, "trait")) {
		write_path(&mut name, trait_path, 0);
		if seen.contains(&name) {
			name.clear();
			continue;
		}
		if seen.is_empty() {
			out.push_str("## Trait Implementations\n\n");
		}
		let _ = writeln!(out, "- {name}");
		seen.insert(std::mem::take(&mut name));
	}
	if !seen.is_empty() {
		out.push('\n');
	}
}

fn write_method(out: &mut String, item: &Value, data: &Value) {
	out.push_str("- `");
	write_function(out, item["name"].as_str().unwrap_or("?"), data);
	out.push('`');
	write_short_docs(out, item);
}

fn write_declaration(out: &mut String, kind: &str, name: Option<&str>, data: &Value) {
	let keyword = match kind {
		"function" => {
			out.push_str("```rust\n");
			write_function(out, name.unwrap_or("?"), data);
			out.push_str("\n```\n\n");
			return;
		},
		"struct" | "enum" | "trait" => kind,
		"type_alias" => "type",
		"macro_def" => "macro",
		"constant" => "const",
		_ => return,
	};
	out.push_str("```rust\n");
	if kind == "trait" && flag(data, "is_unsafe") {
		out.push_str("unsafe ");
	}
	let _ = write!(out, "{keyword} {}", name.unwrap_or("null"));
	match kind {
		"struct" | "enum" | "trait" => write_generics(out, &data["generics"]),
		"type_alias" => {
			write_generics(out, &data["generics"]);
			if let Some(ty) = present(data, "type") {
				out.push_str(" = ");
				write_type(out, ty, 0);
			}
		},
		"macro_def" => out.push_str("!(...)"),
		"constant" => {
			out.push_str(": ");
			write_type(out, &data["type"], 0);
			if let Some(value) = text(data, "value") {
				let _ = write!(out, " = {value}");
			}
		},
		_ => {},
	}
	out.push_str("\n```\n\n");
}

fn write_function(out: &mut String, name: &str, data: &Value) {
	for (field, prefix) in [("is_const", "const "), ("is_async", "async "), ("is_unsafe", "unsafe ")]
	{
		if flag(data, field) {
			out.push_str(prefix);
		}
	}
	let _ = write!(out, "fn {name}");
	write_generics(out, &data["generics"]);
	out.push('(');
	let sig = &data["sig"];
	for (i, arg) in arr_of(sig, "inputs").iter().enumerate() {
		if i != 0 {
			out.push_str(", ");
		}
		let name = arg[0].as_str().unwrap_or("_");
		if name != "self" {
			let _ = write!(out, "{name}: ");
		}
		write_type(out, &arg[1], 0);
	}
	out.push(')');
	if let Some(output) = present(sig, "output") {
		out.push_str(" -> ");
		write_type(out, output, 0);
	}
}

fn write_generics(out: &mut String, generics: &Value) {
	let params = arr_of(generics, "params").iter().filter_map(|param| {
		let kind = present(param, "kind")?;
		kind
			.get("lifetime")
			.is_none()
			.then(|| param["name"].as_str().unwrap_or_default())
	});
	let mut params = params.peekable();
	if params.peek().is_some() {
		out.push('<');
		for (i, param) in params.enumerate() {
			if i != 0 {
				out.push_str(", ");
			}
			out.push_str(param);
		}
		out.push('>');
	}
}

fn write_type(out: &mut String, ty: &Value, depth: usize) {
	if depth > 10 {
		out.push('_');
		return;
	}
	if let Some(name) = ty.as_str() {
		out.push_str(name);
		return;
	}
	let next = depth + 1;
	match variant(ty) {
		Some(("primitive" | "generic", data)) => out.push_str(data.as_str().unwrap_or("_")),
		Some(("resolved_path", data)) => write_path(out, data, depth),
		Some(("borrowed_ref", data)) => {
			out.push('&');
			if let Some(lifetime) = text(data, "lifetime") {
				let _ = write!(out, "'{lifetime} ");
			}
			if flag(data, "is_mutable") {
				out.push_str("mut ");
			}
			write_type(out, &data["type"], next);
		},
		Some(("tuple", data)) => {
			out.push('(');
			if let Some(types) = data.as_array() {
				for (i, ty) in types.iter().enumerate() {
					if i != 0 {
						out.push_str(", ");
					}
					write_type(out, ty, next);
				}
			}
			out.push(')');
		},
		Some(("slice", data)) => {
			out.push('[');
			write_type(out, data, next);
			out.push(']');
		},
		Some(("array", data)) => {
			out.push('[');
			write_type(out, &data["type"], next);
			let _ = write!(out, "; {}]", data["len"].as_str().unwrap_or("_"));
		},
		Some(("raw_pointer", data)) => {
			out.push_str(if flag(data, "is_mutable") {
				"*mut "
			} else {
				"*const "
			});
			write_type(out, &data["type"], next);
		},
		Some(("qualified_path", data)) => {
			let self_type = &data["self_type"];
			if let Some(trait_type) = present(data, "trait_") {
				out.push('<');
				write_type(out, self_type, next);
				out.push_str(" as ");
				write_type(out, trait_type, next);
				out.push('>');
			} else {
				write_type(out, self_type, next);
			}
			let _ = write!(out, "::{}", data["name"].as_str().unwrap_or("_"));
		},
		Some(("impl_trait", data)) => {
			out.push_str("impl ");
			if let Some(bounds) = data.as_array() {
				for (i, bound) in bounds.iter().enumerate() {
					if i != 0 {
						out.push_str(" + ");
					}
					if let Some(trait_bound) = present(bound, "trait_bound") {
						write_type(out, &trait_bound["trait"], next);
					} else {
						out.push('?');
					}
				}
			}
		},
		Some(("dyn_trait", data)) => {
			out.push_str("dyn ");
			for (i, bound) in arr_of(data, "traits").iter().enumerate() {
				if i != 0 {
					out.push_str(" + ");
				}
				write_type(out, &bound["trait"], next);
			}
			if let Some(lifetime) = text(data, "lifetime") {
				let _ = write!(out, " + '{lifetime}");
			}
		},
		Some(("function_pointer", _)) => out.push_str("fn(...)"),
		_ => out.push('_'),
	}
}

fn write_path(out: &mut String, data: &Value, depth: usize) {
	out.push_str(data["path"].as_str().unwrap_or("_"));
	let args = arr_of(&data["args"]["angle_bracketed"], "args");
	if !args.is_empty() {
		out.push('<');
		for (i, arg) in args.iter().enumerate() {
			if i != 0 {
				out.push_str(", ");
			}
			if let Some(ty) = arg.get("type") {
				write_type(out, ty, depth + 1);
			} else if let Some(lifetime) = arg["lifetime"].as_str() {
				let _ = write!(out, "'{lifetime}");
			} else {
				out.push('_');
			}
		}
		out.push('>');
	}
}
