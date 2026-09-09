use std::{collections::BTreeMap, fmt::Write as _, io::Read as _};

use flate2::read::GzDecoder;
use omp_core::Str;
use omp_tool::{Diag, DiagKind};
use serde_json::{Map, Value};
use smallvec::SmallVec;
use url::Url;

use crate::read::web::{
	scrapers::utils::build_result,
	types::{HttpClient, HttpRequest, RenderResult, WebError},
};

const MAX_RUSTDOC_GUNZIP_BYTES: usize = 256 * 1024 * 1024;
const ITEM_KINDS: [&str; 12] = [
	"struct",
	"trait",
	"fn",
	"enum",
	"macro",
	"type",
	"constant",
	"static",
	"attr",
	"derive",
	"union",
	"primitive",
];

#[derive(Debug)]
struct Target {
	crate_name:  Str,
	version:     Str,
	module_path: SmallVec<Str, 8>,
	item_name:   Option<Str>,
}

/// Returns whether the URL names a rustdoc crate root, module, or item page.
pub(super) fn matches(url: &Url) -> bool {
	parse_target(url).is_some()
}

/// Renders docs.rs rustdoc JSON, returning `None` so the common HTML path can
/// fall back.
pub(super) async fn render<C: HttpClient + Sync>(
	client: &C,
	url: &Url,
) -> Result<Option<RenderResult>, WebError> {
	let Some(target) = parse_target(url) else {
		return Ok(None);
	};
	let json_url = format!("https://docs.rs/crate/{}/{}/json.gz", target.crate_name, target.version);
	let request = HttpRequest::new(json_url).with_header("Accept", "application/gzip");
	let response = match client.get(request).await {
		Ok(response) if response.is_success() => response,
		Ok(_) | Err(_) => return Ok(None),
	};

	Ok(render_response(&response.body, &target))
}

fn render_response(body: &[u8], target: &Target) -> Option<RenderResult> {
	let crate_doc = decode_rustdoc_crate(body)?;
	let content = render_target(&crate_doc, target)?;
	let mut result = build_result(&content, "docs.rs");
	result
		.diags
		.push(Diag::info(DiagKind::Provenance, "Fetched via docs.rs rustdoc JSON"));
	Some(result)
}

fn parse_target(url: &Url) -> Option<Target> {
	if url.host_str()? != "docs.rs" {
		return None;
	}
	let mut segments: Vec<String> = url
		.path_segments()?
		.filter(|segment| !segment.is_empty())
		.map(str::to_owned)
		.collect();
	if segments.first().is_some_and(|segment| segment == "crate") || segments.len() < 3 {
		return None;
	}

	let crate_name = segments[0].clone();
	let version = segments[1].clone();
	let mut module_path = segments.split_off(2);
	let mut item_name = None;

	if module_path.last().is_some_and(|last| last == "index.html") {
		module_path.pop();
	} else if let Some(last) = module_path.last()
		&& let Some((kind, rest)) = last.split_once('.')
		&& let Some(name) = rest.strip_suffix(".html")
		&& !name.is_empty()
		&& ITEM_KINDS.contains(&kind)
	{
		item_name = Some(Str::new(name));
		module_path.pop();
	}

	Some(Target {
		crate_name: crate_name.into(),
		version: version.into(),
		module_path: module_path.into_iter().map(Str::new).collect(),
		item_name,
	})
}

fn decode_rustdoc_json(body: &[u8]) -> Option<Vec<u8>> {
	decode_rustdoc_json_with_limit(body, MAX_RUSTDOC_GUNZIP_BYTES)
}

fn decode_rustdoc_json_with_limit(body: &[u8], max_output_bytes: usize) -> Option<Vec<u8>> {
	if body
		.iter()
		.copied()
		.find(|byte| !byte.is_ascii_whitespace())
		== Some(b'{')
	{
		return (body.len() <= max_output_bytes).then(|| body.to_vec());
	}

	let mut decoded = Vec::new();
	let limit = u64::try_from(max_output_bytes).ok()?.saturating_add(1);
	GzDecoder::new(body)
		.take(limit)
		.read_to_end(&mut decoded)
		.ok()?;
	(decoded.len() <= max_output_bytes).then_some(decoded)
}

fn decode_rustdoc_crate(body: &[u8]) -> Option<Value> {
	let json = decode_rustdoc_json(body)?;
	let crate_doc: Value = serde_json::from_slice(&json).ok()?;
	crate_doc.get("index")?.as_object()?;
	Some(crate_doc)
}

fn render_target(crate_doc: &Value, target: &Target) -> Option<String> {
	let index = crate_doc.get("index")?.as_object()?;
	let root_id = id_string(crate_doc.get("root")?)?;
	let mut current = index.get(&root_id)?;

	for segment in target.module_path.iter().skip(1) {
		let items = current.pointer("/inner/module/items")?.as_array()?;
		current = items.iter().find_map(|id| {
			let item = index.get(&id_string(id)?)?;
			(item.get("name")?.as_str()? == segment.as_str()
				&& item.pointer("/inner/module").is_some())
			.then_some(item)
		})?;
	}

	if let Some(name) = target.item_name.as_deref() {
		let item = find_item_in_module(current, name, index)?;
		Some(render_single_item(item, index, crate_doc))
	} else {
		Some(render_module(current, index, crate_doc, target))
	}
}

fn id_string(value: &Value) -> Option<String> {
	value
		.as_str()
		.map(str::to_owned)
		.or_else(|| value.as_u64().map(|id| id.to_string()))
		.or_else(|| value.as_i64().map(|id| id.to_string()))
}

fn find_item_in_module<'a>(
	module: &'a Value,
	name: &str,
	index: &'a Map<String, Value>,
) -> Option<&'a Value> {
	let items = module.pointer("/inner/module/items")?.as_array()?;
	for id in items {
		let Some(item) = id_string(id).and_then(|id| index.get(&id)) else {
			continue;
		};
		if item.get("name").and_then(Value::as_str) == Some(name) {
			return Some(item);
		}
		let Some(use_) = item.pointer("/inner/use") else {
			continue;
		};
		if use_.get("name").and_then(Value::as_str) == Some(name)
			&& let Some(target) = use_
				.get("id")
				.and_then(id_string)
				.and_then(|id| index.get(&id))
		{
			return Some(target);
		}
	}
	None
}

fn item_kind(item: &Value) -> Option<&str> {
	item
		.get("inner")?
		.as_object()?
		.keys()
		.next()
		.map(String::as_str)
}

fn item_name(item: &Value) -> &str {
	item.get("name").and_then(Value::as_str).unwrap_or("?")
}

fn docs(item: &Value) -> Option<&str> {
	item.get("docs").and_then(Value::as_str)
}

fn render_type(ty: Option<&Value>, depth: usize) -> String {
	let Some(ty) = ty else {
		return "_".to_owned();
	};
	if depth > 10 {
		return "_".to_owned();
	}
	if let Some(text) = ty.as_str() {
		return text.to_owned();
	}
	let Some(object) = ty.as_object() else {
		return "_".to_owned();
	};
	if let Some(value) = object.get("generic").and_then(Value::as_str) {
		return value.to_owned();
	}
	if let Some(value) = object.get("primitive").and_then(Value::as_str) {
		return value.to_owned();
	}
	if object.contains_key("infer") {
		return "_".to_owned();
	}
	if let Some(path) = object.get("resolved_path") {
		let name = path.get("path").and_then(Value::as_str).unwrap_or("_");
		let args = path
			.pointer("/args/angle_bracketed/args")
			.and_then(Value::as_array);
		if let Some(args) = args.filter(|args| !args.is_empty()) {
			let rendered = args
				.iter()
				.map(|arg| {
					if let Some(ty) = arg.get("type") {
						render_type(Some(ty), depth + 1)
					} else if let Some(lifetime) = arg.get("lifetime").and_then(Value::as_str) {
						format!("'{lifetime}")
					} else {
						"_".to_owned()
					}
				})
				.collect::<Vec<_>>()
				.join(", ");
			return format!("{name}<{rendered}>");
		}
		return name.to_owned();
	}
	if let Some(reference) = object.get("borrowed_ref") {
		let lifetime = reference
			.get("lifetime")
			.and_then(Value::as_str)
			.map(|value| format!("'{value} "))
			.unwrap_or_default();
		let mutable = reference
			.get("is_mutable")
			.and_then(Value::as_bool)
			.unwrap_or(false);
		return format!(
			"&{lifetime}{}{}",
			if mutable { "mut " } else { "" },
			render_type(reference.get("type"), depth + 1)
		);
	}
	if let Some(tuple) = object.get("tuple").and_then(Value::as_array) {
		return format!(
			"({})",
			tuple
				.iter()
				.map(|ty| render_type(Some(ty), depth + 1))
				.collect::<Vec<_>>()
				.join(", ")
		);
	}
	if let Some(slice) = object.get("slice") {
		return format!("[{}]", render_type(Some(slice), depth + 1));
	}
	if let Some(array) = object.get("array") {
		return format!(
			"[{}; {}]",
			render_type(array.get("type"), depth + 1),
			array.get("len").and_then(Value::as_str).unwrap_or("_")
		);
	}
	if let Some(pointer) = object.get("raw_pointer") {
		let mutable = pointer
			.get("is_mutable")
			.and_then(Value::as_bool)
			.unwrap_or(false);
		return format!(
			"*{} {}",
			if mutable { "mut" } else { "const" },
			render_type(pointer.get("type"), depth + 1)
		);
	}
	if let Some(path) = object.get("qualified_path") {
		let self_type = render_type(path.get("self_type"), depth + 1);
		let name = path.get("name").and_then(Value::as_str).unwrap_or("_");
		if let Some(trait_) = path.get("trait_").filter(|value| !value.is_null()) {
			return format!("<{self_type} as {}>::{name}", render_type(Some(trait_), depth + 1));
		}
		return format!("{self_type}::{name}");
	}
	if let Some(bounds) = object.get("impl_trait").and_then(Value::as_array) {
		return format!(
			"impl {}",
			bounds
				.iter()
				.map(|bound| {
					bound
						.pointer("/trait_bound/trait")
						.map_or_else(|| "?".to_owned(), |trait_| render_type(Some(trait_), depth + 1))
				})
				.collect::<Vec<_>>()
				.join(" + ")
		);
	}
	if let Some(dyn_trait) = object.get("dyn_trait") {
		let mut result = format!(
			"dyn {}",
			dyn_trait
				.get("traits")
				.and_then(Value::as_array)
				.into_iter()
				.flatten()
				.filter_map(|entry| entry.get("trait"))
				.map(|trait_| render_type(Some(trait_), depth + 1))
				.collect::<Vec<_>>()
				.join(" + ")
		);
		if let Some(lifetime) = dyn_trait.get("lifetime").and_then(Value::as_str) {
			write!(result, " + '{lifetime}").expect("writing to String cannot fail");
		}
		return result;
	}
	if object.contains_key("function_pointer") {
		return "fn(...)".to_owned();
	}
	"_".to_owned()
}

fn render_generics(generics: Option<&Value>) -> String {
	let params = generics
		.and_then(|value| value.get("params"))
		.and_then(Value::as_array)
		.into_iter()
		.flatten()
		.filter(|param| {
			param
				.get("kind")
				.is_none_or(|kind| kind.get("lifetime").is_none())
		})
		.filter_map(|param| param.get("name").and_then(Value::as_str))
		.collect::<Vec<_>>();
	if params.is_empty() {
		String::new()
	} else {
		format!("<{}>", params.join(", "))
	}
}

fn render_function_sig(name: &str, function: &Value, generics: Option<&Value>) -> String {
	let mut parts = Vec::with_capacity(4);
	if function
		.get("is_const")
		.and_then(Value::as_bool)
		.unwrap_or(false)
	{
		parts.push("const");
	}
	if function
		.get("is_async")
		.and_then(Value::as_bool)
		.unwrap_or(false)
	{
		parts.push("async");
	}
	if function
		.get("is_unsafe")
		.and_then(Value::as_bool)
		.unwrap_or(false)
	{
		parts.push("unsafe");
	}
	parts.push("fn");
	let generics = render_generics(generics.or_else(|| function.get("generics")));
	let inputs = function
		.pointer("/sig/inputs")
		.and_then(Value::as_array)
		.into_iter()
		.flatten()
		.filter_map(Value::as_array)
		.filter(|input| input.len() >= 2)
		.map(|input| {
			let input_name = input[0].as_str().unwrap_or("?");
			let ty = render_type(Some(&input[1]), 0);
			if input_name == "self" {
				ty
			} else {
				format!("{input_name}: {ty}")
			}
		})
		.collect::<Vec<_>>()
		.join(", ");
	let output = function
		.pointer("/sig/output")
		.filter(|value| !value.is_null())
		.map(|value| format!(" -> {}", render_type(Some(value), 0)))
		.unwrap_or_default();
	format!("{} {name}{generics}({inputs}){output}", parts.join(" "))
}

fn render_item_decl(item: &Value) -> Option<String> {
	let inner = item.get("inner")?;
	let name = item_name(item);
	if let Some(function) = inner.get("function") {
		return Some(render_function_sig(name, function, None));
	}
	if let Some(struct_) = inner.get("struct") {
		return Some(format!("struct {name}{}", render_generics(struct_.get("generics"))));
	}
	if let Some(enum_) = inner.get("enum") {
		return Some(format!("enum {name}{}", render_generics(enum_.get("generics"))));
	}
	if let Some(trait_) = inner.get("trait") {
		let unsafe_prefix = if trait_
			.get("is_unsafe")
			.and_then(Value::as_bool)
			.unwrap_or(false)
		{
			"unsafe "
		} else {
			""
		};
		return Some(format!(
			"{unsafe_prefix}trait {name}{}",
			render_generics(trait_.get("generics"))
		));
	}
	if let Some(alias) = inner.get("type_alias") {
		let assigned = alias
			.get("type")
			.filter(|value| !value.is_null())
			.map(|value| format!(" = {}", render_type(Some(value), 0)))
			.unwrap_or_default();
		return Some(format!("type {name}{}{assigned}", render_generics(alias.get("generics"))));
	}
	if inner.get("macro_def").is_some() {
		return Some(format!("macro {name}!(...)"));
	}
	if let Some(constant) = inner.get("constant") {
		let value = constant
			.get("value")
			.and_then(Value::as_str)
			.filter(|value| !value.is_empty())
			.map(|value| format!(" = {value}"))
			.unwrap_or_default();
		return Some(format!("const {name}: {}{value}", render_type(constant.get("type"), 0)));
	}
	None
}

fn impl_data<'a>(id: &Value, index: &'a Map<String, Value>) -> Option<&'a Value> {
	index.get(&id_string(id)?)?.pointer("/inner/impl")
}

fn inherent_method_lines(ids: &[Value], index: &Map<String, Value>) -> Vec<String> {
	let mut methods = Vec::new();
	for id in ids {
		let Some(impl_) = impl_data(id, index) else {
			continue;
		};
		if impl_
			.get("is_synthetic")
			.and_then(Value::as_bool)
			.unwrap_or(false)
			|| impl_.get("trait").is_some_and(|value| !value.is_null())
			|| impl_
				.get("blanket_impl")
				.is_some_and(|value| !value.is_null())
		{
			continue;
		}
		for method_id in impl_
			.get("items")
			.and_then(Value::as_array)
			.into_iter()
			.flatten()
		{
			let Some(method) = id_string(method_id).and_then(|id| index.get(&id)) else {
				continue;
			};
			let Some(function) = method.pointer("/inner/function") else {
				continue;
			};
			let signature = render_function_sig(item_name(method), function, None);
			methods.push(format!(
				"- `{signature}`{}",
				docs(method)
					.map(first_line)
					.filter(|line| !line.is_empty())
					.map(|line| format!(" — {line}"))
					.unwrap_or_default()
			));
		}
	}
	methods
}

fn explicit_trait_names(ids: &[Value], index: &Map<String, Value>) -> Vec<String> {
	let mut names = Vec::new();
	for id in ids {
		let Some(impl_) = impl_data(id, index) else {
			continue;
		};
		if impl_
			.get("is_synthetic")
			.and_then(Value::as_bool)
			.unwrap_or(false)
			|| impl_
				.get("blanket_impl")
				.is_some_and(|value| !value.is_null())
		{
			continue;
		}
		let Some(trait_) = impl_.get("trait").filter(|value| !value.is_null()) else {
			continue;
		};
		let name = render_type(
			Some(&serde_json::json!({
				 "resolved_path": {
					  "path": trait_.get("path").and_then(Value::as_str).unwrap_or("_"),
					  "args": trait_.get("args").cloned().unwrap_or(Value::Null)
				 }
			})),
			0,
		);
		if !names.contains(&name) {
			names.push(name);
		}
	}
	names
}

fn render_single_item(item: &Value, index: &Map<String, Value>, crate_doc: &Value) -> String {
	let kind = item_kind(item).unwrap_or("unknown");
	let mut output = format!("# {kind} {}\n\n", item_name(item));
	if let Some(deprecation) = item.get("deprecation").filter(|value| !value.is_null()) {
		let note = deprecation
			.get("note")
			.and_then(Value::as_str)
			.filter(|note| !note.is_empty())
			.map(|note| format!(": {note}"))
			.unwrap_or_default();
		writeln!(output, "> **Deprecated**{note}\n").expect("writing to String cannot fail");
	}
	if let Some(declaration) = render_item_decl(item) {
		writeln!(output, "```rust\n{declaration}\n```\n").expect("writing to String cannot fail");
	}
	if let Some(documentation) = docs(item).filter(|documentation| !documentation.is_empty()) {
		output.push_str(documentation);
		output.push_str("\n\n");
	}

	if matches!(kind, "struct" | "enum" | "trait" | "union") {
		let data = item.pointer(&format!("/inner/{kind}"));
		let impls: &[Value] = data
			.and_then(|value| value.get("impls"))
			.and_then(Value::as_array)
			.map_or(&[], Vec::as_slice);
		let trait_items: &[Value] = data
			.and_then(|value| value.get("items"))
			.and_then(Value::as_array)
			.map_or(&[], Vec::as_slice);
		let mut required = Vec::new();
		let mut provided = Vec::new();
		for id in trait_items {
			let Some(child) = id_string(id).and_then(|id| index.get(&id)) else {
				continue;
			};
			if let Some(function) = child.pointer("/inner/function") {
				let line = format!(
					"- `{}`{}",
					render_function_sig(item_name(child), function, None),
					docs(child)
						.map(first_line)
						.filter(|line| !line.is_empty())
						.map(|line| format!(" — {line}"))
						.unwrap_or_default()
				);
				if function
					.get("has_body")
					.and_then(Value::as_bool)
					.unwrap_or(false)
				{
					provided.push(line);
				} else {
					required.push(line);
				}
			} else if child.pointer("/inner/assoc_type").is_some() {
				required.push(format!(
					"- `type {}`{}",
					item_name(child),
					docs(child)
						.map(first_line)
						.filter(|line| !line.is_empty())
						.map(|line| format!(" — {line}"))
						.unwrap_or_default()
				));
			}
		}
		if !required.is_empty() {
			writeln!(output, "## Required Methods\n\n{}\n", required.join("\n"))
				.expect("writing to String cannot fail");
		}
		if !provided.is_empty() {
			writeln!(output, "## Provided Methods\n\n{}\n", provided.join("\n"))
				.expect("writing to String cannot fail");
		}
		let methods = inherent_method_lines(impls, index);
		if !methods.is_empty() {
			writeln!(output, "## Methods\n\n{}\n", methods.join("\n"))
				.expect("writing to String cannot fail");
		}
		let traits = explicit_trait_names(impls, index);
		if !traits.is_empty() {
			writeln!(
				output,
				"## Trait Implementations\n\n{}\n",
				traits
					.iter()
					.map(|name| format!("- {name}"))
					.collect::<Vec<_>>()
					.join("\n")
			)
			.expect("writing to String cannot fail");
		}
	}

	if kind == "enum" {
		let mut variants = Vec::new();
		for id in item
			.pointer("/inner/enum/variants")
			.and_then(Value::as_array)
			.into_iter()
			.flatten()
		{
			let Some(variant) = id_string(id).and_then(|id| index.get(&id)) else {
				continue;
			};
			variants.push(format!(
				"- `{}`{}",
				item_name(variant),
				docs(variant)
					.map(first_line)
					.filter(|line| !line.is_empty())
					.map(|line| format!(" — {line}"))
					.unwrap_or_default()
			));
		}
		if !variants.is_empty() {
			writeln!(output, "## Variants\n\n{}\n", variants.join("\n"))
				.expect("writing to String cannot fail");
		}
	}
	append_version(&mut output, crate_doc);
	output
}

fn render_module(
	module: &Value,
	index: &Map<String, Value>,
	crate_doc: &Value,
	target: &Target,
) -> String {
	let mut path = String::new();
	for (index, segment) in target.module_path.iter().enumerate() {
		if index != 0 {
			path.push_str("::");
		}
		path.push_str(segment);
	}
	let mut output = format!("# {path}\n\n");
	if let Some(documentation) = docs(module).filter(|documentation| !documentation.is_empty()) {
		output.push_str(documentation);
		output.push_str("\n\n");
	}
	let Some(items) = module
		.pointer("/inner/module/items")
		.and_then(Value::as_array)
	else {
		return output;
	};

	type ModuleItems = Vec<(String, String, Option<String>)>;
	type ModuleGroups<'a> = BTreeMap<&'a str, ModuleItems>;
	let mut groups: ModuleGroups<'_> = BTreeMap::new();
	for id in items {
		let Some(mut item) = id_string(id).and_then(|id| index.get(&id)) else {
			continue;
		};
		let mut display_name = item.get("name").and_then(Value::as_str);
		if let Some(use_) = item.pointer("/inner/use") {
			display_name = use_.get("name").and_then(Value::as_str);
			let Some(resolved) = use_
				.get("id")
				.and_then(id_string)
				.and_then(|id| index.get(&id))
			else {
				continue;
			};
			item = resolved;
		}
		let Some(display_name) = display_name else {
			continue;
		};
		let visibility = item.get("visibility");
		if visibility.and_then(Value::as_str) == Some("crate")
			|| visibility
				.and_then(Value::as_object)
				.is_some_and(|object| object.contains_key("restricted"))
		{
			continue;
		}
		let Some(kind) = item_kind(item) else {
			continue;
		};
		groups.entry(kind).or_default().push((
			display_name.to_owned(),
			docs(item).map(first_line).unwrap_or_default(),
			render_item_decl(item),
		));
	}

	let order = [
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
	for (kind, label) in order {
		let Some(items) = groups.get(kind).filter(|items| !items.is_empty()) else {
			continue;
		};
		writeln!(output, "## {label}\n").expect("writing to String cannot fail");
		for (name, documentation, declaration) in items {
			let suffix = if documentation.is_empty() {
				String::new()
			} else {
				format!(" — {documentation}")
			};
			if kind == "function"
				&& let Some(declaration) = declaration
			{
				writeln!(output, "- `{declaration}`{suffix}").expect("writing to String cannot fail");
				continue;
			}
			writeln!(output, "- **{name}**{suffix}").expect("writing to String cannot fail");
		}
		output.push('\n');
	}
	append_version(&mut output, crate_doc);
	output
}

fn append_version(output: &mut String, crate_doc: &Value) {
	if let Some(version) = crate_doc
		.get("crate_version")
		.and_then(Value::as_str)
		.filter(|version| !version.is_empty())
	{
		writeln!(output, "---\n*{version}*").expect("writing to String cannot fail");
	}
}

fn first_line(value: &str) -> String {
	let line = value.lines().next().unwrap_or("").trim();
	if line.chars().count() <= 200 {
		return line.to_owned();
	}
	let shortened: String = line.chars().take(197).collect();
	format!("{shortened}...")
}

#[cfg(test)]
mod tests {
	use std::io::Write as _;

	use flate2::{Compression, write::GzEncoder};
	use serde_json::Value;

	use super::{
		Target, decode_rustdoc_crate, decode_rustdoc_json_with_limit, render_response, render_target,
	};

	const RUSTDOC_FIXTURE: &str = r#"{
		"root": 0,
		"crate_version": "1.2.3",
		"index": {
			"0": {
				"name": "demo",
				"docs": "Module docs.",
				"visibility": "public",
				"inner": {"module": {"items": [1, 2, 3]}}
			},
			"1": {
				"name": "inner",
				"docs": "Inner docs.",
				"visibility": "public",
				"inner": {"module": {"items": []}}
			},
			"2": {
				"name": "parse",
				"docs": "Parse docs.\nAdditional detail.",
				"visibility": "public",
				"inner": {"function": {
					"sig": {
						"inputs": [["input", {"borrowed_ref": {
							"lifetime": null,
							"is_mutable": false,
							"type": {"primitive": "str"}
						}}]],
						"output": {"primitive": "bool"}
					},
					"generics": {
						"params": [{"name": "T", "kind": {"type": {}}}],
						"where_predicates": []
					},
					"has_body": true,
					"is_async": true,
					"is_unsafe": false,
					"is_const": false
				}}
			},
			"3": {
				"name": null,
				"docs": null,
				"visibility": "public",
				"inner": {"use": {"name": "Alias", "id": 4}}
			},
			"4": {
				"name": "Widget",
				"docs": "Widget docs.",
				"visibility": "public",
				"deprecation": null,
				"inner": {"struct": {
					"generics": {
						"params": [{"name": "T", "kind": {"type": {}}}],
						"where_predicates": []
					},
					"kind": {"unit": null},
					"impls": []
				}}
			}
		},
		"paths": {},
		"format_version": 37
	}"#;

	fn target(module_path: &[&str], item_name: Option<&str>) -> Target {
		Target {
			crate_name:  "demo".into(),
			version:     "1.2.3".into(),
			module_path: module_path.iter().copied().map(Into::into).collect(),
			item_name:   item_name.map(Into::into),
		}
	}

	#[test]
	fn port_docs_rs_scraper_parity_representative_fixture() {
		let fixture: Value =
			serde_json::from_str(RUSTDOC_FIXTURE).expect("fixture is valid rustdoc JSON");
		let rendered = render_response(RUSTDOC_FIXTURE.as_bytes(), &target(&["demo"], None))
			.expect("representative response renders");
		assert_eq!(rendered.method.as_str(), "docs.rs");
		assert_eq!(rendered.diags.len(), 1);
		assert_eq!(rendered.diags[0].native_kind(), Some(DiagKind::Provenance));
		assert_eq!(rendered.diags[0].severity, Severity::Info);
		assert_eq!(
			rendered.content.as_str(),
			"# demo\n\nModule docs.\n\n## Modules\n\n- **inner** — Inner docs.\n\n## Structs\n\n- \
			 **Alias** — Widget docs.\n\n## Functions\n\n- `async fn parse<T>(input: &str) -> bool` \
			 — Parse docs.\n\n---\n*1.2.3*"
		);
		assert_eq!(
			render_target(&fixture, &target(&["demo", "inner"], None)).as_deref(),
			Some("# demo::inner\n\nInner docs.\n\n---\n*1.2.3*\n")
		);
		assert_eq!(
			render_target(&fixture, &target(&["demo"], Some("Alias"))).as_deref(),
			Some(
				"# struct Widget\n\n```rust\nstruct Widget<T>\n```\n\nWidget docs.\n\n---\n*1.2.3*\n"
			)
		);
	}

	#[test]
	fn port_docs_rs_scraper_parity_gzip_raw_caps_and_malformed_fallback() {
		let raw = RUSTDOC_FIXTURE.as_bytes();
		assert!(decode_rustdoc_crate(raw).is_some());
		assert!(decode_rustdoc_json_with_limit(raw, raw.len() - 1).is_none());

		let mut encoder = GzEncoder::new(Vec::new(), Compression::fast());
		encoder.write_all(raw).expect("fixture gzip accepts bytes");
		let gzip = encoder.finish().expect("fixture gzip finishes");
		assert_eq!(decode_rustdoc_json_with_limit(&gzip, raw.len()).as_deref(), Some(raw));
		assert!(decode_rustdoc_json_with_limit(&gzip, raw.len() - 1).is_none());
		assert!(decode_rustdoc_crate(b"not gzip or JSON").is_none());
		assert!(decode_rustdoc_crate(br#"{"root":0,"index":[]}"#).is_none());

		let crate_doc = decode_rustdoc_crate(raw).expect("representative fixture decodes");
		assert_eq!(render_target(&crate_doc, &target(&["demo", "missing"], None)), None);
		assert!(render_response(br#"{"root":0,"index":[]}"#, &target(&["demo"], None)).is_none());
	}
}
