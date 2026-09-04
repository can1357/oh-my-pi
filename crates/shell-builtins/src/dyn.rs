//! Schema-derived `dyn` discovery and invocation builtin.
//!
//! `dyn` is the only discovery path for long-tail devices: it lists and
//! searches the host's live catalog, synthesizes `--help` from each device's
//! JSON schema, and binds command-line arguments to that schema. No device
//! carries a hand-written CLI definition.
//!
//! # Argument binding
//!
//! Every binding rule is derived from the argument object's JSON schema:
//!
//! - **Positionals** are the root properties that are `required` and scalar
//!   (`string`, `integer`, `number`, or any `enum`), in the schema's property
//!   declaration order: the first such property is the first positional, and so
//!   on. Bare arguments fill the next positional that no earlier flag,
//!   positional, or merged object has set. Booleans and objects are never
//!   positional. `--` ends option parsing; everything after it is a bare
//!   argument.
//! - **Flags** exist for every leaf: `--name VALUE` or `--name=VALUE`,
//!   `--flag`/`--no-flag` for booleans, repeated `--item VALUE` for arrays, and
//!   dotted keys (`--settings.label VALUE`) for nested objects. Underscores in
//!   property names become dashes. A flag may also set a positional property.
//! - **`-j`/`--json JSON`** merges one raw JSON object into the arguments.
//! - **`@FILE` and `-` (stdin)** feed the same targets a bare literal does.
//!   Content that parses as a JSON object merges into the arguments — unless
//!   the schema's sole required root property is a free-form object that the
//!   content does not itself mention, in which case the object is that
//!   property's value. Any other content is text: one trailing newline is
//!   dropped and it binds to the next positional exactly like a bare literal.
//!
//! Required properties are validated after every source has been applied, so
//! `dyn report_issue "$session" "$device" --rev 1 --verdict '{"summary":"result
//! contradicted docs"}'` and `dyn report_issue "$session" "$device" 1 --verdict
//! @verdict.json` bind identically.

use std::{
	collections::{BTreeMap, BTreeSet},
	fmt::Write as _,
	fs,
	io::{self, Read, Write as _},
	path::{Path, PathBuf},
	sync::Arc,
};

use omp_core::Str;
use omp_shell::{
	ShellExtensions,
	builtins::{ContentOptions, ContentType, Registration},
	commands::{CommandArg, ExecutionContext},
	error,
	results::ExecutionResult,
};
use serde_json::{Map, Value};
use thiserror::Error;
use tokio_util::sync::CancellationToken;

use crate::{
	graphics::encode_image_passthrough,
	host::{DynDevice, DynFault, DynHost, DynOutput, DynSchema},
};

const HELP: &str = "dyn — discover and invoke live dynamic devices\n\nUsage:\n  dyn\n  dyn --q \
                    <TEXT>\n  dyn <NAMESPACE>/<TOOL> --help\n  dyn <NAMESPACE>/<TOOL> [ARGS] \
                    [--FLAG VALUE ...] [@FILE] [-]\n\nPositionals, flags, and --help are derived \
                    from each device's JSON schema. @FILE and - merge a JSON object from a file \
                    or stdin, or bind other text to the next positional. Flags override merged \
                    values.\n";

/// Builds the dynamic-device builtin around one environment-owned host.
pub(crate) fn registration<SE: ShellExtensions>(host: Arc<dyn DynHost>) -> Registration<SE> {
	Registration {
		execute_func: Arc::new(move |context, args| {
			let host = Arc::clone(&host);
			Box::pin(async move { run(host, context, args).await })
		}),
		content_func: content,
		disabled: false,
		special_builtin: false,
		declaration_builtin: false,
		transparent_background_wrapper: false,
	}
}

fn content(
	_name: &str,
	_content_type: ContentType,
	_options: &ContentOptions,
) -> Result<String, error::Error> {
	Ok(HELP.to_owned())
}

async fn run<SE: ShellExtensions>(
	host: Arc<dyn DynHost>,
	context: ExecutionContext<'_, SE>,
	args: Vec<CommandArg>,
) -> Result<ExecutionResult, error::Error> {
	let argv = args
		.into_iter()
		.skip(1)
		.map(|argument| match argument {
			CommandArg::String(value) => Str::from(value),
			CommandArg::Assignment(value) => Str::from(value.to_string()),
		})
		.collect::<Vec<_>>();

	if argv.len() == 1 && is_help(argv[0].as_str()) {
		write_message(context.stdout(), HELP)?;
		return Ok(ExecutionResult::success());
	}

	let Some(first) = argv.first() else {
		let devices = match host.list().await {
			Ok(devices) => devices,
			Err(fault) => return host_fault(&context, &fault),
		};
		write_message(context.stdout(), &render_catalog(&devices))?;
		return Ok(ExecutionResult::success());
	};
	if first == "--q" {
		let devices = match host.list().await {
			Ok(devices) => devices,
			Err(fault) => return host_fault(&context, &fault),
		};
		let Some(query) = argv.get(1) else {
			write_error(&context, "--q requires search text")?;
			return Ok(ExecutionResult::new(2));
		};
		if argv.len() != 2 {
			write_error(&context, "--q accepts exactly one search string")?;
			return Ok(ExecutionResult::new(2));
		}
		write_message(context.stdout(), &render_search(&devices, query))?;
		return Ok(ExecutionResult::success());
	}
	if first.starts_with('-') {
		write_error(&context, "unknown option; run `dyn --help`")?;
		return Ok(ExecutionResult::new(2));
	}

	if argv[1..].iter().any(|argument| is_help(argument)) {
		if argv.len() != 2 {
			write_error(&context, "--help cannot be combined with invocation arguments")?;
			return Ok(ExecutionResult::new(2));
		}
		let schema = match host.schema(first).await {
			Ok(schema) => schema,
			Err(fault) => return host_fault(&context, &fault),
		};
		write_message(context.stdout(), &render_help(&schema))?;
		return Ok(ExecutionResult::success());
	}

	let schema = match host.schema(first).await {
		Ok(schema) => schema,
		Err(fault) => return host_fault(&context, &fault),
	};
	let mut stdin = context.stdin();
	let cwd = context.shell.working_dir();
	let mut parsed = match parse_args(
		&schema.schema,
		&argv[1..],
		cwd,
		context.params.path_policy().map(AsRef::as_ref),
		&mut stdin,
	) {
		Ok(parsed) => parsed,
		Err(parse_error) => {
			write_error(&context, &parse_error)?;
			write_error(&context, &format!("run `dyn {first} --help`"))?;
			return Ok(ExecutionResult::new(2));
		},
	};
	if has_protocol_intent(&schema.schema) {
		parsed.insert("i".to_owned(), Value::String(format!("Invoking {first}")));
	}

	let cancel = context
		.cancel_token()
		.unwrap_or_else(CancellationToken::new);
	match host.call(first, Value::Object(parsed), cancel).await {
		Ok(call) => {
			let mut stdout = context.stdout();
			write_output(&mut stdout, &call.output)?;
		},
		Err(fault) => return host_fault(&context, &fault),
	}
	Ok(ExecutionResult::success())
}

fn host_fault<SE: ShellExtensions>(
	context: &ExecutionContext<'_, SE>,
	fault: &DynFault,
) -> Result<ExecutionResult, error::Error> {
	write_error(context, fault.message.as_str())?;
	Ok(ExecutionResult::general_error())
}

fn write_error<SE: ShellExtensions>(
	context: &ExecutionContext<'_, SE>,
	message: &(impl std::fmt::Display + ?Sized),
) -> Result<(), error::Error> {
	let mut stderr = context.stderr();
	writeln!(stderr, "dyn: {message}")?;
	Ok(())
}

fn write_message(mut output: impl io::Write, message: &str) -> io::Result<()> {
	output.write_all(message.as_bytes())?;
	if !message.ends_with('\n') {
		output.write_all(b"\n")?;
	}
	Ok(())
}

/// Writes one device result to stdout: plain and Markdown text verbatim, JSON
/// compact, images as terminal graphics passthrough, other media as raw bytes.
fn write_output(stdout: &mut dyn io::Write, output: &DynOutput) -> io::Result<()> {
	match output {
		DynOutput::Text(text) | DynOutput::Markdown(text) => {
			write_message(&mut *stdout, text.as_str())
		},
		DynOutput::Json(value) => write_message(&mut *stdout, &value.to_string()),
		DynOutput::Blob { mime, bytes } => {
			if mime.starts_with("image/") {
				let mut encoded = Vec::new();
				encode_image_passthrough(mime, bytes, &mut encoded);
				encoded.push(b'\n');
				stdout.write_all(&encoded)
			} else {
				stdout.write_all(bytes)
			}
		},
		DynOutput::Parts(parts) => {
			for part in parts {
				write_output(stdout, part)?;
			}
			Ok(())
		},
	}
}

fn is_help(argument: &str) -> bool {
	matches!(argument, "-h" | "--help")
}

fn render_catalog(devices: &[DynDevice]) -> String {
	let mut namespaces = BTreeMap::<&str, Vec<&DynDevice>>::new();
	for device in devices {
		let namespace = device
			.name
			.split_once('/')
			.map_or("other", |(namespace, _)| namespace);
		namespaces.entry(namespace).or_default().push(device);
	}
	let mut rendered = String::new();
	for (namespace, mut members) in namespaces {
		members.sort_unstable_by(|left, right| left.name.cmp(&right.name));
		let _ = writeln!(rendered, "{namespace}/");
		for device in members {
			let leaf = device
				.name
				.rsplit('/')
				.next()
				.unwrap_or(device.name.as_str());
			let _ = write!(rendered, "  {leaf}");
			if let Some(description) = &device.description {
				let _ = write!(rendered, " — {description}");
			}
			rendered.push('\n');
		}
	}
	rendered
}

fn render_search(devices: &[DynDevice], query: &str) -> String {
	let query = query.trim().to_ascii_lowercase();
	let mut matches = devices
		.iter()
		.filter_map(|device| search_score(device, &query).map(|score| (score, device)))
		.collect::<Vec<_>>();
	matches.sort_unstable_by(|left, right| {
		left
			.0
			.cmp(&right.0)
			.then_with(|| left.1.name.cmp(&right.1.name))
	});
	let mut rendered = String::new();
	for (_, device) in matches {
		let _ = write!(rendered, "{}", device.name);
		if let Some(description) = &device.description {
			let _ = write!(rendered, " — {description}");
		}
		rendered.push('\n');
	}
	rendered
}

fn search_score(device: &DynDevice, query: &str) -> Option<(u8, usize)> {
	if query.is_empty() {
		return Some((0, 0));
	}
	let name = device.name.to_ascii_lowercase();
	let leaf = name.rsplit('/').next().unwrap_or(&name);
	if leaf == query || name == query {
		return Some((0, 0));
	}
	if leaf.starts_with(query) || name.starts_with(query) {
		return Some((1, 0));
	}
	if leaf.contains(query) || name.contains(query) {
		return Some((2, 0));
	}
	if device
		.description
		.as_ref()
		.is_some_and(|description| description.to_ascii_lowercase().contains(query))
	{
		return Some((3, 0));
	}
	let distance = levenshtein(query, leaf);
	(distance <= 3 || distance.saturating_mul(3) <= leaf.chars().count()).then_some((4, distance))
}

fn levenshtein(left: &str, right: &str) -> usize {
	let mut row = (0..=right.chars().count()).collect::<Vec<_>>();
	for (left_index, left_char) in left.chars().enumerate() {
		let mut diagonal = row[0];
		row[0] = left_index + 1;
		for (right_index, right_char) in right.chars().enumerate() {
			let above = row[right_index + 1];
			row[right_index + 1] = (above + 1)
				.min(row[right_index] + 1)
				.min(diagonal + usize::from(left_char != right_char));
			diagonal = above;
		}
	}
	row[right.chars().count()]
}

fn render_help(schema: &DynSchema) -> String {
	let normalized = normalize_schema(&schema.schema);
	let leaves = schema_leaves(&normalized);
	let mut rendered = String::new();
	let _ = writeln!(
		rendered,
		"{} — {}",
		schema.name,
		schema.description.as_deref().unwrap_or("dynamic device")
	);
	let _ = write!(rendered, "\nUsage:\n  dyn {}", schema.name);
	for leaf in leaves.iter().filter(|leaf| leaf.positional) {
		let _ = write!(rendered, " <{}>", leaf.path[0]);
	}
	rendered.push_str(" [OPTIONS] [@FILE] [-]\n");
	if leaves.iter().any(|leaf| leaf.positional) {
		rendered.push_str("\nArguments:\n");
		for leaf in leaves.iter().filter(|leaf| leaf.positional) {
			let _ = write!(rendered, "  <{}> {}", leaf.path[0], value_usage(leaf));
			if let Some(description) = leaf.description {
				let _ = write!(rendered, "  {description}");
			}
			rendered.push('\n');
		}
	}
	if !leaves.is_empty() {
		rendered.push_str("\nOptions:\n");
		for leaf in &leaves {
			let flag = flag_name(&leaf.path);
			let _ = write!(rendered, "  --{flag}");
			if !leaf.repeatable && leaf.kind == ScalarKind::Boolean && leaf.values.is_none() {
				let _ = write!(rendered, " / --no-{flag}");
			} else {
				let _ = write!(rendered, " {}", value_usage(leaf));
			}
			if let Some(description) = leaf.description {
				let _ = write!(rendered, "  {description}");
			}
			if leaf.required {
				rendered.push_str("  (required)");
			}
			if leaf.repeatable {
				rendered.push_str("  (repeatable)");
			}
			rendered.push('\n');
		}
	}
	rendered.push_str(concat!(
		"  -j, --json <JSON>  Merge one raw JSON object.\n",
		"  @FILE             Merge a JSON object from FILE, or bind its text to the next argument.\n",
		"  -                 Same as @FILE, read from stdin.\n",
		"  -h, --help        Show this help.\n",
	));
	rendered
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum ScalarKind {
	String,
	Integer,
	Number,
	Boolean,
	Object,
	Fallback,
}

struct SchemaLeaf<'a> {
	path:        Vec<&'a str>,
	kind:        ScalarKind,
	values:      Option<&'a [Value]>,
	description: Option<&'a str>,
	required:    bool,
	repeatable:  bool,
	positional:  bool,
	schema:      &'a Value,
}

fn schema_leaves(schema: &Value) -> Vec<SchemaLeaf<'_>> {
	let mut leaves = Vec::new();
	let mut path = Vec::new();
	collect_leaves(schema, true, &mut path, &mut leaves);
	let required = schema
		.get("required")
		.and_then(Value::as_array)
		.into_iter()
		.flatten()
		.filter_map(Value::as_str)
		.collect::<Vec<_>>();
	leaves.sort_by_key(|leaf| {
		if leaf.positional {
			required
				.iter()
				.position(|name| *name == leaf.path[0])
				.unwrap_or(usize::MAX)
		} else {
			usize::MAX
		}
	});
	leaves
}

fn collect_leaves<'a>(
	schema: &'a Value,
	parent_required: bool,
	path: &mut Vec<&'a str>,
	leaves: &mut Vec<SchemaLeaf<'a>>,
) {
	let Some(properties) = schema.get("properties").and_then(Value::as_object) else {
		return;
	};
	let required = schema
		.get("required")
		.and_then(Value::as_array)
		.map(|items| {
			items
				.iter()
				.filter_map(Value::as_str)
				.collect::<BTreeSet<_>>()
		})
		.unwrap_or_default();
	for (name, child) in properties {
		let required_here = parent_required && required.contains(name.as_str());
		path.push(name);
		if child.get("properties").and_then(Value::as_object).is_some() {
			collect_leaves(child, required_here, path, leaves);
		} else {
			let kind = scalar_kind(child);
			let repeatable = matches!(child.get("type").and_then(Value::as_str), Some("array"));
			let values = if repeatable {
				child
					.get("items")
					.and_then(|items| items.get("enum"))
					.and_then(Value::as_array)
					.map(Vec::as_slice)
			} else {
				child
					.get("enum")
					.and_then(Value::as_array)
					.map(Vec::as_slice)
			};
			let positional = path.len() == 1
				&& required_here
				&& !repeatable
				&& (values.is_some()
					|| matches!(kind, ScalarKind::String | ScalarKind::Integer | ScalarKind::Number));
			leaves.push(SchemaLeaf {
				path: path.clone(),
				kind,
				values,
				description: child.get("description").and_then(Value::as_str),
				required: required_here,
				repeatable,
				positional,
				schema: child,
			});
		}
		path.pop();
	}
}

/// Resolves local references and folds schema combinators into the effective
/// shape used by the CLI. The device still performs authoritative validation;
/// this projection exists only to derive flags, positionals, and coercions.
fn normalize_schema(schema: &Value) -> Value {
	let mut normalized = normalize_node(schema, schema, &mut BTreeSet::new());
	if has_protocol_intent(schema)
		&& let Some(object) = normalized.as_object_mut()
	{
		if let Some(properties) = object.get_mut("properties").and_then(Value::as_object_mut) {
			properties.remove("i");
			properties.remove("notrunc");
		}
		if let Some(required) = object.get_mut("required").and_then(Value::as_array_mut) {
			required.retain(|name| !matches!(name.as_str(), Some("i" | "notrunc")));
		}
	}
	normalized
}

fn has_protocol_intent(schema: &Value) -> bool {
	schema
		.get("properties")
		.and_then(|properties| properties.get("i"))
		.and_then(|intent| intent.get("description"))
		.and_then(Value::as_str)
		== Some("Short present-participle intent for this call.")
}

fn normalize_node(root: &Value, schema: &Value, resolving: &mut BTreeSet<String>) -> Value {
	let Some(source) = schema.as_object() else {
		return schema.clone();
	};
	let mut result = Map::new();

	if let Some(reference) = source.get("$ref").and_then(Value::as_str)
		&& let Some(pointer) = reference.strip_prefix('#')
		&& resolving.insert(reference.to_owned())
	{
		if let Some(target) = root.pointer(pointer) {
			result = normalize_node(root, target, resolving)
				.as_object()
				.cloned()
				.unwrap_or_default();
		}
		resolving.remove(reference);
	}

	for key in ["allOf"] {
		if let Some(parts) = source.get(key).and_then(Value::as_array) {
			for part in parts {
				let normalized = normalize_node(root, part, resolving);
				merge_schema(&mut result, normalized.as_object().cloned().unwrap_or_default(), true);
			}
		}
	}

	for key in ["anyOf", "oneOf"] {
		let Some(parts) = source.get(key).and_then(Value::as_array) else {
			continue;
		};
		let alternatives = parts
			.iter()
			.map(|part| normalize_node(root, part, resolving))
			.filter(|part| !is_null_schema(part))
			.collect::<Vec<_>>();
		if alternatives.len() == 1 {
			if let Some(alternative) = alternatives[0].as_object() {
				merge_schema(&mut result, alternative.clone(), false);
			}
		} else if !alternatives.is_empty() {
			let combined = combine_alternatives(&alternatives);
			merge_schema(&mut result, combined, false);
		}
	}

	for (key, value) in source {
		if matches!(key.as_str(), "$ref" | "allOf" | "anyOf" | "oneOf" | "$defs" | "definitions") {
			continue;
		}
		let normalized = match key.as_str() {
			"properties" => Value::Object(
				value
					.as_object()
					.map(|properties| {
						properties
							.iter()
							.map(|(name, child)| (name.clone(), normalize_node(root, child, resolving)))
							.collect()
					})
					.unwrap_or_default(),
			),
			"items" => normalize_node(root, value, resolving),
			_ => value.clone(),
		};
		if key == "required" {
			merge_required(&mut result, &normalized, true);
		} else if key == "properties" {
			merge_properties(&mut result, normalized.as_object().cloned().unwrap_or_default());
		} else {
			result.insert(key.clone(), normalized);
		}
	}
	Value::Object(result)
}

fn combine_alternatives(alternatives: &[Value]) -> Map<String, Value> {
	let mut combined = Map::new();
	let objects = alternatives
		.iter()
		.filter_map(Value::as_object)
		.collect::<Vec<_>>();
	if objects.is_empty() {
		return combined;
	}

	let types = objects
		.iter()
		.filter_map(|object| object.get("type"))
		.filter(|kind| !kind.is_null())
		.collect::<Vec<_>>();
	if let Some(first) = types.first()
		&& types.iter().all(|kind| *kind == *first)
	{
		combined.insert("type".to_owned(), (*first).clone());
	}

	let mut enum_values = Vec::new();
	for object in &objects {
		if let Some(values) = object.get("enum").and_then(Value::as_array) {
			for value in values {
				if !enum_values.contains(value) {
					enum_values.push(value.clone());
				}
			}
		} else if let Some(value) = object.get("const") {
			if !enum_values.contains(value) {
				enum_values.push(value.clone());
			}
		}
	}
	if !enum_values.is_empty() {
		combined.insert("enum".to_owned(), Value::Array(enum_values));
	}

	let mut properties = Map::new();
	for object in &objects {
		if let Some(branch) = object.get("properties").and_then(Value::as_object) {
			for (name, schema) in branch {
				match properties.entry(name.clone()) {
					serde_json::map::Entry::Vacant(entry) => {
						entry.insert(schema.clone());
					},
					serde_json::map::Entry::Occupied(mut entry) => {
						let merged = combine_alternatives(&[entry.get().clone(), schema.clone()]);
						entry.insert(Value::Object(merged));
					},
				}
			}
		}
	}
	if !properties.is_empty() {
		combined.insert("type".to_owned(), Value::String("object".to_owned()));
		combined.insert("properties".to_owned(), Value::Object(properties));
		let required_sets = objects
			.iter()
			.map(|object| {
				object
					.get("required")
					.and_then(Value::as_array)
					.map(|values| {
						values
							.iter()
							.filter_map(Value::as_str)
							.collect::<BTreeSet<_>>()
					})
					.unwrap_or_default()
			})
			.collect::<Vec<_>>();
		if let Some(first) = required_sets.first() {
			let required = first
				.iter()
				.filter(|name| required_sets.iter().skip(1).all(|set| set.contains(**name)))
				.map(|name| Value::String((*name).to_owned()))
				.collect::<Vec<_>>();
			if !required.is_empty() {
				combined.insert("required".to_owned(), Value::Array(required));
			}
		}
	}
	combined
}

fn merge_schema(target: &mut Map<String, Value>, source: Map<String, Value>, union_required: bool) {
	for (key, value) in source {
		match key.as_str() {
			"required" => merge_required(target, &value, union_required),
			"properties" => {
				merge_properties(target, value.as_object().cloned().unwrap_or_default());
			},
			_ => {
				target.insert(key, value);
			},
		}
	}
}

fn merge_properties(target: &mut Map<String, Value>, source: Map<String, Value>) {
	let properties = target
		.entry("properties".to_owned())
		.or_insert_with(|| Value::Object(Map::new()));
	let Value::Object(properties) = properties else {
		*properties = Value::Object(source);
		return;
	};
	for (name, schema) in source {
		properties.insert(name, schema);
	}
}

fn merge_required(target: &mut Map<String, Value>, value: &Value, union: bool) {
	let Some(incoming) = value.as_array() else {
		return;
	};
	if !union {
		target.insert("required".to_owned(), Value::Array(incoming.clone()));
		return;
	}
	let required = target
		.entry("required".to_owned())
		.or_insert_with(|| Value::Array(Vec::new()));
	let Value::Array(required) = required else {
		*required = Value::Array(incoming.clone());
		return;
	};
	for name in incoming {
		if !required.contains(name) {
			required.push(name.clone());
		}
	}
}

fn is_null_schema(schema: &Value) -> bool {
	schema.get("type").and_then(Value::as_str) == Some("null")
		|| schema
			.get("enum")
			.and_then(Value::as_array)
			.is_some_and(|values| values.iter().all(Value::is_null))
}

fn scalar_kind(schema: &Value) -> ScalarKind {
	match schema.get("type").and_then(Value::as_str) {
		Some("string") => ScalarKind::String,
		Some("integer") => ScalarKind::Integer,
		Some("number") => ScalarKind::Number,
		Some("boolean") => ScalarKind::Boolean,
		Some("object") => ScalarKind::Object,
		Some("array") => schema
			.get("items")
			.map(scalar_kind)
			.unwrap_or(ScalarKind::Fallback),
		_ => ScalarKind::Fallback,
	}
}

fn flag_name(path: &[&str]) -> String {
	path
		.iter()
		.map(|segment| segment.replace('_', "-"))
		.collect::<Vec<_>>()
		.join(".")
}

fn value_usage(leaf: &SchemaLeaf<'_>) -> String {
	if let Some(values) = leaf.values {
		let values = format!(
			"{{{}}}",
			values
				.iter()
				.map(|value| value
					.as_str()
					.map_or_else(|| value.to_string(), str::to_owned))
				.collect::<Vec<_>>()
				.join("|")
		);
		return if leaf.repeatable {
			format!("{values}...")
		} else {
			values
		};
	}
	let kind = match leaf.kind {
		ScalarKind::String => "<STRING>",
		ScalarKind::Integer => "<INTEGER>",
		ScalarKind::Number => "<NUMBER>",
		ScalarKind::Boolean => "<BOOLEAN>",
		ScalarKind::Object => "<JSON_OBJECT>",
		ScalarKind::Fallback => "<JSON>",
	};
	if leaf.repeatable {
		format!("{kind}...")
	} else {
		kind.to_owned()
	}
}

#[derive(Debug, Error)]
enum ArgError {
	#[error("unknown flag `{flag}`")]
	UnknownFlag { flag: Str },
	#[error("flag `{flag}` requires a value")]
	MissingValue { flag: Str },
	#[error("invalid value for `{flag}`; expected {expected}")]
	InvalidValue { flag: Str, expected: &'static str },
	#[error("`{origin}` is not a JSON object and no positional remains for its text")]
	NoLiteralTarget { origin: Str },
	#[error("failed to read argument source `{origin}`")]
	Read {
		origin: Str,
		#[source]
		error:  io::Error,
	},
	#[error("invalid JSON for `{origin}`")]
	Json {
		origin: Str,
		#[source]
		error:  serde_json::Error,
	},
	#[error("`{origin}` must be a JSON object")]
	NotObject { origin: Str },
	#[error("missing required argument `{name}`")]
	MissingRequired { name: Str },
	#[error("unexpected argument `{argument}`; every positional is already set")]
	UnexpectedPositional { argument: Str },
}

fn parse_args(
	schema: &Value,
	argv: &[Str],
	cwd: &Path,
	path_policy: Option<&dyn omp_shell::PathPolicy>,
	stdin: &mut impl Read,
) -> Result<Map<String, Value>, ArgError> {
	let normalized = normalize_schema(schema);
	let leaves = schema_leaves(&normalized);
	let mut output = Map::new();
	let mut overrides = Map::new();
	let mut options_ended = false;
	let mut index = 0;
	while index < argv.len() {
		let argument = argv[index].as_str();
		index += 1;
		if options_ended {
			bind_literal(&leaves, &mut output, &overrides, argument, argument)?;
			continue;
		}
		if argument == "--" {
			options_ended = true;
			continue;
		}
		if argument == "-" || (argument.starts_with('@') && argument.len() > 1) {
			let (origin, text) = read_argument_source(argument, cwd, path_policy, stdin)?
				.expect("source spelling was checked");
			bind_source(&leaves, &mut output, &overrides, &text, origin)?;
			continue;
		}
		if matches!(argument, "-j" | "--json") || argument.starts_with("--json=") {
			let raw = if let Some(raw) = argument.strip_prefix("--json=") {
				raw
			} else {
				let raw = argv
					.get(index)
					.ok_or_else(|| ArgError::MissingValue { flag: Str::new(argument) })?;
				index += 1;
				raw.as_str()
			};
			let source = read_argument_source(raw, cwd, path_policy, stdin)?;
			let raw = source.as_ref().map_or(raw, |(_, text)| text.as_str());
			merge_json_object(&mut output, raw, Str::new_static("--json"))?;
			continue;
		}
		let Some(raw_flag) = argument.strip_prefix("--") else {
			if argument.starts_with('-') {
				return Err(ArgError::UnknownFlag { flag: Str::new(argument) });
			}
			bind_literal(&leaves, &mut output, &overrides, argument, argument)?;
			continue;
		};
		let (raw_flag, inline) = raw_flag
			.split_once('=')
			.map_or((raw_flag, None), |(name, value)| (name, Some(value)));
		let (raw_flag, negative) = raw_flag
			.strip_prefix("no-")
			.map_or((raw_flag, false), |name| (name, true));
		let Some(leaf) = leaves.iter().find(|leaf| flag_name(&leaf.path) == raw_flag) else {
			return Err(ArgError::UnknownFlag { flag: Str::new(argument) });
		};
		if !leaf.repeatable && leaf.kind == ScalarKind::Boolean && leaf.values.is_none() {
			if inline.is_some() {
				return Err(ArgError::InvalidValue {
					flag:     Str::new(argument),
					expected: "a flag without a value",
				});
			}
			insert_value(&mut overrides, &leaf.path, Value::Bool(!negative), leaf.repeatable);
			continue;
		}
		if negative {
			return Err(ArgError::UnknownFlag { flag: Str::new(argument) });
		}
		let raw = if let Some(raw) = inline {
			raw
		} else {
			let raw = argv
				.get(index)
				.map(Str::as_str)
				.ok_or_else(|| ArgError::MissingValue { flag: Str::new(argument) })?;
			index += 1;
			raw
		};
		let source = read_argument_source(raw, cwd, path_policy, stdin)?;
		let raw = source
			.as_ref()
			.map_or(raw, |(_, text)| strip_one_newline(text));
		let value = coerce(leaf, raw, argument)?;
		insert_value(&mut overrides, &leaf.path, value, leaf.repeatable);
	}
	apply_overrides(&leaves, &mut output, &overrides);
	validate_required(&normalized, &Value::Object(output.clone()), &mut Vec::new())?;
	Ok(output)
}

fn read_argument_source(
	argument: &str,
	cwd: &Path,
	path_policy: Option<&dyn omp_shell::PathPolicy>,
	stdin: &mut impl Read,
) -> Result<Option<(Str, String)>, ArgError> {
	if argument == "-" {
		let mut text = String::new();
		stdin
			.read_to_string(&mut text)
			.map_err(|error| ArgError::Read { origin: Str::new_static("<stdin>"), error })?;
		return Ok(Some((Str::new_static("<stdin>"), text)));
	}
	let Some(raw_path) = argument.strip_prefix('@').filter(|path| !path.is_empty()) else {
		return Ok(None);
	};
	let path = resolve(cwd, raw_path);
	if let Some(policy) = path_policy {
		policy.check_read(&path).map_err(|error| ArgError::Read {
			origin: Str::new(raw_path),
			error:  io::Error::other(error),
		})?;
	}
	let text = fs::read_to_string(&path)
		.map_err(|error| ArgError::Read { origin: Str::new(raw_path), error })?;
	Ok(Some((Str::new(raw_path), text)))
}

fn strip_one_newline(text: &str) -> &str {
	text
		.strip_suffix('\n')
		.map(|text| text.strip_suffix('\r').unwrap_or(text))
		.unwrap_or(text)
}

/// The next positional the arguments have not set yet.
fn next_positional<'l, 'a>(
	leaves: &'l [SchemaLeaf<'a>],
	output: &Map<String, Value>,
	overrides: &Map<String, Value>,
) -> Option<&'l SchemaLeaf<'a>> {
	leaves.iter().find(|leaf| {
		leaf.positional && !output.contains_key(leaf.path[0]) && !overrides.contains_key(leaf.path[0])
	})
}

/// The sole required root property when it is a free-form object: the one
/// target a JSON-object source may fill instead of merging.
fn sole_object_target<'l, 'a>(leaves: &'l [SchemaLeaf<'a>]) -> Option<&'l SchemaLeaf<'a>> {
	let mut required = leaves.iter().filter(|leaf| leaf.required);
	let sole = required.next()?;
	(required.next().is_none() && sole.path.len() == 1 && sole.kind == ScalarKind::Object)
		.then_some(sole)
}

/// Binds a bare literal to the next unset positional.
fn bind_literal(
	leaves: &[SchemaLeaf<'_>],
	output: &mut Map<String, Value>,
	overrides: &Map<String, Value>,
	raw: &str,
	origin: &str,
) -> Result<(), ArgError> {
	let Some(leaf) = next_positional(leaves, output, overrides) else {
		return Err(ArgError::UnexpectedPositional { argument: Str::new(origin) });
	};
	let value = coerce(leaf, raw, origin)?;
	insert_value(output, &leaf.path, value, leaf.repeatable);
	Ok(())
}

/// Applies `@FILE`/stdin content: a JSON object merges (or fills the sole
/// required object), anything else binds as literal text.
fn bind_source(
	leaves: &[SchemaLeaf<'_>],
	output: &mut Map<String, Value>,
	overrides: &Map<String, Value>,
	text: &str,
	origin: Str,
) -> Result<(), ArgError> {
	if let Ok(Value::Object(values)) = serde_json::from_str::<Value>(text) {
		if let Some(target) = sole_object_target(leaves)
			&& !output.contains_key(target.path[0])
			&& !overrides.contains_key(target.path[0])
			&& !values.contains_key(target.path[0])
		{
			insert_value(output, &target.path, Value::Object(values), false);
		} else {
			merge_objects(output, values);
		}
		return Ok(());
	}
	if next_positional(leaves, output, overrides).is_none() {
		return Err(ArgError::NoLiteralTarget { origin });
	}
	let literal = strip_one_newline(text);
	bind_literal(leaves, output, overrides, literal, origin.as_str())
}

fn merge_json_object(
	output: &mut Map<String, Value>,
	raw: &str,
	source: Str,
) -> Result<(), ArgError> {
	let parsed: Value = serde_json::from_str(raw)
		.map_err(|error| ArgError::Json { origin: source.clone(), error })?;
	let Value::Object(values) = parsed else {
		return Err(ArgError::NotObject { origin: source });
	};
	merge_objects(output, values);
	Ok(())
}

fn merge_objects(target: &mut Map<String, Value>, source: Map<String, Value>) {
	for (name, value) in source {
		match (target.get_mut(&name), value) {
			(Some(Value::Object(existing)), Value::Object(incoming)) => {
				merge_objects(existing, incoming);
			},
			(_, value) => {
				target.insert(name, value);
			},
		}
	}
}

fn apply_overrides(
	leaves: &[SchemaLeaf<'_>],
	output: &mut Map<String, Value>,
	overrides: &Map<String, Value>,
) {
	for leaf in leaves {
		let Some(value) = value_at(overrides, &leaf.path) else {
			continue;
		};
		insert_value(output, &leaf.path, value.clone(), false);
	}
}

fn value_at<'a>(root: &'a Map<String, Value>, path: &[&str]) -> Option<&'a Value> {
	let (first, rest) = path.split_first()?;
	let mut value = root.get(*first)?;
	for part in rest {
		value = value.as_object()?.get(*part)?;
	}
	Some(value)
}

fn resolve(cwd: &Path, path: &str) -> PathBuf {
	let path = PathBuf::from(path);
	if path.is_absolute() {
		path
	} else {
		cwd.join(path)
	}
}

fn coerce(leaf: &SchemaLeaf<'_>, raw: &str, flag: &str) -> Result<Value, ArgError> {
	if let Some(values) = leaf.values {
		if let Some(value) = values.iter().find(|value| {
			value
				.as_str()
				.map_or_else(|| value.to_string() == raw, |value| value == raw)
		}) {
			return Ok(value.clone());
		}
		return Err(ArgError::InvalidValue { flag: Str::new(flag), expected: "an enum member" });
	}
	let kind_schema = if leaf.repeatable {
		leaf.schema.get("items").unwrap_or(&Value::Null)
	} else {
		leaf.schema
	};
	let value = match scalar_kind(kind_schema) {
		ScalarKind::String => Value::String(raw.to_owned()),
		ScalarKind::Integer => serde_json::from_str(raw)
			.ok()
			.filter(|value: &Value| value.as_i64().is_some() || value.as_u64().is_some())
			.ok_or_else(|| ArgError::InvalidValue {
				flag:     Str::new(flag),
				expected: "an integer",
			})?,
		ScalarKind::Number => serde_json::from_str(raw)
			.ok()
			.filter(Value::is_number)
			.ok_or_else(|| ArgError::InvalidValue {
				flag:     Str::new(flag),
				expected: "a number",
			})?,
		ScalarKind::Boolean => match raw {
			"true" => Value::Bool(true),
			"false" => Value::Bool(false),
			_ => {
				return Err(ArgError::InvalidValue {
					flag:     Str::new(flag),
					expected: "true or false",
				});
			},
		},
		ScalarKind::Object => serde_json::from_str(raw)
			.ok()
			.filter(Value::is_object)
			.ok_or_else(|| ArgError::InvalidValue {
				flag:     Str::new(flag),
				expected: "a JSON object",
			})?,
		ScalarKind::Fallback => {
			serde_json::from_str(raw).unwrap_or_else(|_| Value::String(raw.to_owned()))
		},
	};
	Ok(value)
}

fn insert_value(output: &mut Map<String, Value>, path: &[&str], value: Value, repeatable: bool) {
	let Some((last, parents)) = path.split_last() else {
		return;
	};
	let mut target = output;
	for parent in parents {
		let entry = target
			.entry((*parent).to_owned())
			.or_insert_with(|| Value::Object(Map::new()));
		if !entry.is_object() {
			*entry = Value::Object(Map::new());
		}
		let Value::Object(next) = entry else {
			unreachable!()
		};
		target = next;
	}
	if repeatable {
		let entry = target
			.entry((*last).to_owned())
			.or_insert_with(|| Value::Array(Vec::new()));
		if !entry.is_array() {
			*entry = Value::Array(Vec::new());
		}
		let Value::Array(values) = entry else {
			unreachable!()
		};
		values.push(value);
	} else {
		target.insert((*last).to_owned(), value);
	}
}

fn validate_required<'a>(
	schema: &'a Value,
	value: &Value,
	path: &mut Vec<&'a str>,
) -> Result<(), ArgError> {
	let Some(object) = value.as_object() else {
		return Ok(());
	};
	if let Some(required) = schema.get("required").and_then(Value::as_array) {
		for name in required.iter().filter_map(Value::as_str) {
			if !object.contains_key(name) {
				let mut full = path.join(".");
				if !full.is_empty() {
					full.push('.');
				}
				full.push_str(name);
				return Err(ArgError::MissingRequired { name: Str::new(full) });
			}
		}
	}
	if let Some(properties) = schema.get("properties").and_then(Value::as_object) {
		for (name, child_schema) in properties {
			if let Some(child) = object.get(name) {
				path.push(name);
				validate_required(child_schema, child, path)?;
				path.pop();
			}
		}
	}
	Ok(())
}

#[cfg(test)]
mod tests {
	use std::{io, path::Path};

	use bytes::Bytes;
	use omp_core::Str;
	use serde_json::{Map, Value, json};

	use super::{ArgError, DynOutput, DynSchema, parse_args, render_help, write_output};
	use crate::graphics::extract_image_passthrough;

	/// `report_issue@1` as `dyn` sees it: three required strings and one
	/// required closed verdict object.
	fn report_issue_schema() -> Value {
		json!({
			"type": "object",
			"properties": {
				"i": {
					"type": "string",
					"description": "Short present-participle intent for this call."
				},
				"notrunc": {
					"type": "boolean",
					"description": "Prefer complete output inline up to the host security ceiling; overflow or transport backpressure remains available through its artifact."
				},
				"session_id": { "type": "string", "description": "Session filing the report." },
				"device": { "type": "string", "description": "Device whose result was inconsistent." },
				"rev": { "type": "string", "description": "Observed device revision." },
				"verdict": {
					"type": "object",
					"description": "Bounded structured verdict.",
					"properties": {
						"summary": { "type": "string" },
						"expected": { "type": "string" },
						"observed": { "type": "string" },
						"evidence": {
							"type": "array",
							"items": {
								"type": "object",
								"properties": {
									"kind": { "type": "string" },
									"detail": { "type": "string" }
								},
								"required": ["kind", "detail"],
								"additionalProperties": false
							}
						},
						"outcome": { "type": "object" },
						"fault": { "type": "object" }
					},
					"required": ["summary"],
					"additionalProperties": false
				}
			},
			"required": ["i", "session_id", "device", "rev", "verdict"]
		})
	}

	fn text_schema() -> Value {
		json!({
			"type": "object",
			"properties": {
				"text": { "type": "string", "description": "Speech text." },
				"voice": { "type": "string" },
				"loud": { "type": "boolean" }
			},
			"required": ["text"]
		})
	}

	fn args(values: &[&str]) -> Vec<Str> {
		values.iter().map(|value| Str::new(*value)).collect()
	}

	fn parse(schema: &Value, argv: &[&str], stdin: &str) -> Result<Map<String, Value>, ArgError> {
		let mut stdin = io::Cursor::new(stdin.as_bytes().to_vec());
		parse_args(schema, &args(argv), Path::new("/"), None, &mut stdin)
	}

	fn parse_in(schema: &Value, argv: &[&str], cwd: &Path) -> Result<Map<String, Value>, ArgError> {
		parse_args(schema, &args(argv), cwd, None, &mut io::empty())
	}

	#[test]
	fn positionals_bind_required_scalars_in_declaration_order() {
		let parsed = parse(
			&report_issue_schema(),
			&["sess-1", "read", "3", "--verdict.summary", "mismatch"],
			"",
		)
		.expect("positionals bind");
		assert_eq!(
			Value::Object(parsed),
			json!({ "session_id": "sess-1", "device": "read", "rev": "3", "verdict": { "summary": "mismatch" } })
		);
	}

	#[test]
	fn autoqa_prompt_invocation_binds() {
		let parsed = parse(
			&report_issue_schema(),
			&[
				"sess-1",
				"read",
				"--rev",
				"1",
				"--verdict.summary",
				"mismatch",
				"--verdict.observed",
				"x",
				"--verdict.expected",
				"y",
			],
			"",
		)
		.expect("AutoQA-shaped command binds");
		assert_eq!(
			Value::Object(parsed),
			json!({
				"session_id": "sess-1",
				"device": "read",
				"rev": "1",
				"verdict": { "summary": "mismatch", "observed": "x", "expected": "y" }
			})
		);
	}

	#[test]
	fn bare_literal_binds_the_sole_required_string() {
		let parsed =
			parse(&text_schema(), &["blueprint of a frog", "--loud"], "").expect("literal binds");
		assert_eq!(Value::Object(parsed), json!({ "text": "blueprint of a frog", "loud": true }));
	}

	#[test]
	fn flags_fill_positionals_and_surplus_literals_are_rejected() {
		let parsed = parse(&text_schema(), &["--text", "hi"], "").expect("flag binds positional");
		assert_eq!(Value::Object(parsed), json!({ "text": "hi" }));
		let error = parse(&text_schema(), &["--text", "hi", "extra"], "").expect_err("no slot");
		assert!(matches!(error, ArgError::UnexpectedPositional { argument } if argument == "extra"));
		let error = parse(&text_schema(), &["-x"], "").expect_err("short unknown");
		assert!(matches!(error, ArgError::UnknownFlag { flag } if flag == "-x"));
	}

	#[test]
	fn double_dash_ends_options() {
		let parsed = parse(&text_schema(), &["--", "--not-a-flag"], "").expect("literal after --");
		assert_eq!(Value::Object(parsed), json!({ "text": "--not-a-flag" }));
	}

	#[test]
	fn stdin_text_binds_positional_and_stdin_object_merges() {
		let parsed = parse(&text_schema(), &["-"], "hello world\n").expect("stdin text binds");
		assert_eq!(Value::Object(parsed), json!({ "text": "hello world" }));
		let parsed = parse(&text_schema(), &["-"], r#"{"text":"from json","voice":"a"}"#)
			.expect("stdin object merges");
		assert_eq!(Value::Object(parsed), json!({ "text": "from json", "voice": "a" }));
		let error =
			parse(&text_schema(), &["--text", "set", "-"], "plain\n").expect_err("no target for text");
		assert!(matches!(error, ArgError::NoLiteralTarget { origin } if origin == "<stdin>"));
	}

	#[test]
	fn at_file_text_and_object_feed_the_same_targets() {
		let root = tempfile::tempdir().expect("tempdir");
		std::fs::write(root.path().join("speech.txt"), "read me\r\n").expect("write text");
		std::fs::write(root.path().join("args.json"), r#"{"voice":"b"}"#).expect("write json");
		let parsed = parse_in(&text_schema(), &["@speech.txt", "@args.json"], root.path())
			.expect("file sources bind");
		assert_eq!(Value::Object(parsed), json!({ "text": "read me", "voice": "b" }));
		let error =
			parse_in(&text_schema(), &["@missing.txt"], root.path()).expect_err("missing file");
		assert!(matches!(error, ArgError::Read { origin, .. } if origin == "missing.txt"));
	}

	#[test]
	fn sole_required_object_takes_json_source_as_its_value() {
		let schema = json!({
			"type": "object",
			"properties": {
				"query": { "type": "object", "description": "Raw query." },
				"limit": { "type": "integer" }
			},
			"required": ["query"]
		});
		let parsed = parse(&schema, &["-", "--limit", "5"], r#"{"where":{"id":1}}"#)
			.expect("object source binds");
		assert_eq!(Value::Object(parsed), json!({ "query": { "where": { "id": 1 } }, "limit": 5 }));
		let parsed = parse(&schema, &["-"], r#"{"query":{"a":1},"limit":2}"#)
			.expect("object naming the target merges");
		assert_eq!(Value::Object(parsed), json!({ "query": { "a": 1 }, "limit": 2 }));
	}

	#[test]
	fn raw_json_merges_and_positionals_still_apply() {
		let parsed = parse(
			&report_issue_schema(),
			&["-j", r#"{"verdict":{"summary":"mismatch"},"rev":"2"}"#, "sess", "dev"],
			"",
		)
		.expect("json merge plus positionals");
		assert_eq!(
			Value::Object(parsed),
			json!({ "verdict": { "summary": "mismatch" }, "rev": "2", "session_id": "sess", "device": "dev" })
		);
		let error = parse(&report_issue_schema(), &["--json", "[1]"], "").expect_err("not object");
		assert!(matches!(error, ArgError::NotObject { .. }));
		let error = parse(&report_issue_schema(), &["sess"], "").expect_err("missing required");
		assert!(matches!(error, ArgError::MissingRequired { name } if name == "device"));
	}

	#[test]
	fn integer_and_enum_positionals_are_coerced() {
		let schema = json!({
			"type": "object",
			"properties": {
				"mode": { "type": "string", "enum": ["fast", "safe"] },
				"count": { "type": "integer" },
				"flag": { "type": "boolean" }
			},
			"required": ["mode", "count", "flag"]
		});
		let parsed = parse(&schema, &["safe", "4", "--flag"], "").expect("coerced positionals");
		assert_eq!(Value::Object(parsed), json!({ "mode": "safe", "count": 4, "flag": true }));
		let error = parse(&schema, &["slow", "4", "--flag"], "").expect_err("bad enum");
		assert!(matches!(error, ArgError::InvalidValue { flag, .. } if flag == "slow"));
		let error = parse(&schema, &["safe", "four", "--flag"], "").expect_err("bad integer");
		assert!(matches!(error, ArgError::InvalidValue { expected: "an integer", .. }));
	}

	#[test]
	fn help_lists_positionals_from_the_schema() {
		let help = render_help(&DynSchema {
			name:        Str::new_static("tts"),
			description: Some(Str::new_static("Speak text.")),
			schema:      text_schema(),
		});
		assert_eq!(
			help,
			"tts — Speak text.\n\nUsage:\n  dyn tts <text> [OPTIONS] [@FILE] [-]\n\nArguments:\n  \
			 <text> <STRING>  Speech text.\n\nOptions:\n  --text <STRING>  Speech text.  \
			 (required)\n  --voice <STRING>\n  --loud / --no-loud\n  -j, --json <JSON>  Merge one \
			 raw JSON object.\n  @FILE             Merge a JSON object from FILE, or bind its text \
			 to the next argument.\n  -                 Same as @FILE, read from stdin.\n  -h, \
			 --help        Show this help.\n"
		);
		let help = render_help(&DynSchema {
			name:        Str::new_static("report_issue"),
			description: None,
			schema:      report_issue_schema(),
		});
		assert!(
			help.contains("  dyn report_issue <session_id> <device> <rev> [OPTIONS] [@FILE] [-]\n")
		);
		assert!(!help.contains("<verdict>"));
		assert!(!help.contains("--i"));
		assert!(!help.contains("--notrunc"));
	}

	#[test]
	fn refs_nullable_combinators_repeatables_and_dotted_objects_share_one_cli() {
		let schema = json!({
			"type": "object",
			"properties": {
				"action": { "$ref": "#/$defs/Action" },
				"app": {
					"anyOf": [
						{ "$ref": "#/$defs/App" },
						{ "type": "null" }
					]
				},
				"tags": { "type": "array", "items": { "$ref": "#/$defs/Tag" } },
				"enabled": {
					"anyOf": [
						{ "type": "boolean" },
						{ "type": "null" }
					]
				}
			},
			"required": ["action"],
			"$defs": {
				"Action": {
					"oneOf": [
						{ "const": "open", "type": "string" },
						{ "const": "run", "type": "string" }
					]
				},
				"App": {
					"type": "object",
					"allOf": [
						{ "properties": { "cdp_url": { "type": "string" } } },
						{ "properties": { "relay": { "type": "boolean" } } }
					]
				},
				"Tag": { "type": "string", "enum": ["fast", "safe"] }
			}
		});
		let parsed = parse(
			&schema,
			&[
				"run",
				"--app.cdp-url",
				"http://localhost:9222",
				"--app.relay",
				"--tags",
				"fast",
				"--tags",
				"safe",
				"--enabled",
			],
			"",
		)
		.expect("composed schema binds");
		assert_eq!(
			Value::Object(parsed),
			json!({
				"action": "run",
				"app": { "cdp_url": "http://localhost:9222", "relay": true },
				"tags": ["fast", "safe"],
				"enabled": true
			})
		);
		let help =
			render_help(&DynSchema { name: Str::new_static("browser"), description: None, schema });
		assert!(help.contains("dyn browser <action>"));
		assert!(help.contains("--app.cdp-url <STRING>"));
		assert!(help.contains("--app.relay / --no-app.relay"));
		assert!(help.contains("--tags {fast|safe}...  (repeatable)"), "{help}");
	}

	#[test]
	fn file_and_stdin_are_valid_flag_and_raw_json_values_and_flags_win() {
		let root = tempfile::tempdir().expect("tempdir");
		std::fs::write(
			root.path().join("args.json"),
			r#"{"session_id":"file-session","device":"read","rev":"1","verdict":{"summary":"mismatch","observed":"bad"}}"#,
		)
		.expect("write args");
		let parsed = parse_in(
			&report_issue_schema(),
			&["--json", "@args.json", "--device", "bash"],
			root.path(),
		)
		.expect("file-backed flag values bind");
		assert_eq!(
			Value::Object(parsed),
			json!({
				"session_id": "file-session",
				"device": "bash",
				"rev": "1",
				"verdict": { "summary": "mismatch", "observed": "bad" }
			})
		);

		let parsed = parse(
			&report_issue_schema(),
			&["--json", "-"],
			r#"{"session_id":"session","device":"read","rev":"1","verdict":{"summary":"mismatch","expected":"complete"}}"#,
		)
		.expect("stdin flag value binds");
		assert_eq!(
			Value::Object(parsed),
			json!({
				"session_id": "session",
				"device": "read",
				"rev": "1",
				"verdict": { "summary": "mismatch", "expected": "complete" }
			})
		);
	}

	#[test]
	fn image_blobs_are_written_as_graphics_passthrough_and_other_media_raw() {
		let png = Bytes::from_static(b"\x89PNG\r\n\x1a\nfake");
		let mut stdout = Vec::new();
		write_output(
			&mut stdout,
			&DynOutput::Parts(vec![DynOutput::Text(Str::new_static("saved")), DynOutput::Blob {
				mime:  Str::new_static("image/png"),
				bytes: png.clone(),
			}]),
		)
		.expect("write parts");
		let (text, images) = extract_image_passthrough(&stdout);
		assert_eq!(text, b"saved\n\n");
		assert_eq!(images.len(), 1);
		assert_eq!(images[0].mime.as_str(), "image/png");
		assert_eq!(images[0].bytes, png);

		let mut stdout = Vec::new();
		write_output(&mut stdout, &DynOutput::Blob {
			mime:  Str::new_static("audio/mpeg"),
			bytes: Bytes::from_static(b"\xff\xfbID3"),
		})
		.expect("write audio");
		assert_eq!(stdout, b"\xff\xfbID3");

		let mut stdout = Vec::new();
		write_output(&mut stdout, &DynOutput::Markdown(Str::new_static("**render me**")))
			.expect("write Markdown");
		assert_eq!(stdout, b"**render me**\n");
	}
}
