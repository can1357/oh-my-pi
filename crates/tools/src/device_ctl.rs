//! Schema-derived command-line mappings for devices invoked through `dyn`.

use std::{fmt, fmt::Write as _, io};

use omp_core::Str;
use serde_json::{Map, Value};
use thiserror::Error;

const RESERVED_SHORT_FLAGS: [char; 2] = ['h', 'j'];
const BLOB_NAMES: [&str; 7] = ["content", "body", "sql", "text", "data", "message", "query_text"];

/// A blob-capable value reference resolved by the embedding shell.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BlobSource<'a> {
	/// A literal command-line value.
	Literal(&'a str),
	/// A UTF-8 file path following `@`.
	File(&'a str),
	/// The builtin's standard input, selected by `-`.
	Stdin,
}

/// A compiled schema-to-command-line mapping for one device.
pub struct DeviceCli {
	mapping: Mapping,
}

/// Schema shapes that cannot be represented as device flags.
#[derive(Debug, Error)]
pub enum CliShapeError {
	/// The root is not an object schema.
	#[error("device schema is not a flag-mappable object")]
	RootNotObject,
	/// A root `oneOf` does not define one constant discriminator per branch.
	#[error("device schema has an invalid subcommand shape")]
	InvalidSubcommands,
}

/// Command-line errors produced before a device is dispatched.
#[derive(Debug, Error)]
pub enum CliParseError {
	/// A flag is absent from the compiled schema.
	#[error("unknown flag `{flag}`{suggestion}", suggestion = FlagSuggestion(suggestion))]
	UnknownFlag {
		/// The unrecognized spelling.
		flag:       Str,
		/// The nearest known flag when one is sufficiently close.
		suggestion: Option<Str>,
	},
	/// A value-taking option had no following value.
	#[error("flag `{flag}` requires a value")]
	MissingValue {
		/// The option missing its value.
		flag: Str,
	},
	/// Required schema leaves were not provided.
	#[error("missing required argument(s): {names}")]
	MissingRequired {
		/// Comma-separated command-line names in schema order.
		names: Str,
	},
	/// A value did not satisfy its scalar schema.
	#[error("invalid value for `{flag}`: expected {expected}, found `{found}`")]
	InvalidValue {
		/// The positional or flag name.
		flag:     Str,
		/// The accepted value shape.
		expected: Str,
		/// The rejected source text.
		found:    Str,
	},
	/// A root `oneOf` subcommand token was missing or unknown.
	#[error("unknown subcommand `{given}`; expected one of {expected}")]
	UnknownSubcommand {
		/// The supplied token, or `<missing>`.
		given:    Str,
		/// Pipe-separated accepted tokens.
		expected: Str,
	},
	/// An argument remained after all positionals were filled.
	#[error("unexpected argument `{argument}`")]
	UnexpectedArgument {
		/// The unconsumed argument.
		argument: Str,
	},
	/// A raw `--json` payload was malformed.
	#[error("invalid JSON payload")]
	Json(#[from] serde_json::Error),
	/// A file or stdin blob source could not be read.
	#[error("failed to read blob source `{source}`")]
	Blob {
		/// The file path or `<stdin>` marker.
		source: Str,
		/// The underlying read failure.
		#[source]
		error:  io::Error,
	},
}

struct FlagSuggestion<'a>(&'a Option<Str>);

impl fmt::Display for FlagSuggestion<'_> {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		if let Some(suggestion) = self.0 {
			write!(formatter, "; did you mean `{suggestion}`?")?;
		}
		Ok(())
	}
}

enum Mapping {
	Single(Variant),
	Subcommands(Vec<Subcommand>),
}

struct Subcommand {
	token:         Str,
	discriminator: Str,
	constant:      Value,
	variant:       Variant,
}

struct Variant {
	leaves: Vec<Leaf>,
}

struct Leaf {
	path:        Vec<Str>,
	long:        Str,
	short:       Option<char>,
	description: Option<Str>,
	required:    bool,
	positional:  bool,
	kind:        LeafKind,
}

enum LeafKind {
	Scalar(ScalarSpec),
	Array(ScalarSpec),
	Map(ScalarSpec),
}

#[derive(Clone, Copy, Eq, PartialEq)]
enum ScalarKind {
	String,
	Integer,
	Number,
	Boolean,
	Fallback,
}

struct ScalarSpec {
	kind:   ScalarKind,
	values: Option<Vec<Value>>,
	blob:   bool,
}

impl DeviceCli {
	/// Compiles a device parameter schema; constant root `oneOf` branches become
	/// subcommands.
	pub fn compile(schema: &Value) -> Result<Self, CliShapeError> {
		if let Some(branches) = schema.get("oneOf") {
			let branches = branches
				.as_array()
				.ok_or(CliShapeError::InvalidSubcommands)?;
			if branches.is_empty() {
				return Err(CliShapeError::InvalidSubcommands);
			}

			let mut commands = Vec::with_capacity(branches.len());
			for branch in branches {
				let properties = properties(branch).ok_or(CliShapeError::InvalidSubcommands)?;
				let mut constants = properties
					.iter()
					.filter_map(|(name, spec)| spec.get("const").map(|value| (name, value)));
				let (name, constant) = constants.next().ok_or(CliShapeError::InvalidSubcommands)?;
				if constants.next().is_some() {
					return Err(CliShapeError::InvalidSubcommands);
				}
				let token = const_token(constant).ok_or(CliShapeError::InvalidSubcommands)?;
				commands.push(Subcommand {
					token,
					discriminator: Str::new(name),
					constant: constant.clone(),
					variant: compile_variant(branch, Some(name))?,
				});
			}
			return Ok(Self { mapping: Mapping::Subcommands(commands) });
		}

		Ok(Self { mapping: Mapping::Single(compile_variant(schema, None)?) })
	}

	/// Renders deterministic usage and flags for appending to device
	/// documentation.
	pub fn usage(&self, invocation: &str) -> String {
		let mut output = String::new();
		match &self.mapping {
			Mapping::Single(variant) => append_variant_usage(&mut output, invocation, variant),
			Mapping::Subcommands(commands) => {
				let _ = writeln!(output, "  {invocation} <COMMAND> [ARGS…]");
				output.push_str("\nCommands:\n");
				for command in commands {
					let _ = writeln!(output, "  {}", command.token);
				}
				for command in commands {
					let _ = write!(output, "\n{}:\n", command.token);
					let branch_invocation = format!("{invocation} {}", command.token);
					append_variant_usage(&mut output, &branch_invocation, &command.variant);
				}
			},
		}
		output
	}

	/// Parses command arguments into the nested JSON object accepted by a
	/// device.
	pub fn parse(
		&self,
		argv: &[Str],
		blob: &mut dyn FnMut(BlobSource<'_>) -> Result<String, CliParseError>,
	) -> Result<Map<String, Value>, CliParseError> {
		match &self.mapping {
			Mapping::Single(variant) => parse_variant(variant, argv, blob),
			Mapping::Subcommands(commands) => {
				let Some(token) = argv.first() else {
					return Err(unknown_subcommand("<missing>", commands));
				};
				let Some(command) = commands.iter().find(|command| command.token == *token) else {
					return Err(unknown_subcommand(token, commands));
				};
				let mut parsed = parse_variant(&command.variant, &argv[1..], blob)?;
				parsed.insert(command.discriminator.to_string(), command.constant.clone());
				Ok(parsed)
			},
		}
	}
}

fn properties(schema: &Value) -> Option<&Map<String, Value>> {
	let object_like = schema
		.get("type")
		.is_none_or(|kind| kind.as_str().is_some_and(|kind| kind == "object"));
	object_like
		.then(|| schema.get("properties").and_then(Value::as_object))
		.flatten()
}

fn compile_variant(schema: &Value, excluded: Option<&str>) -> Result<Variant, CliShapeError> {
	let object_like = schema
		.get("type")
		.is_none_or(|kind| kind.as_str().is_some_and(|kind| kind == "object"));
	if !object_like {
		return Err(CliShapeError::RootNotObject);
	}
	let Some(root_properties) = schema.get("properties").and_then(Value::as_object) else {
		return Ok(Variant { leaves: Vec::new() });
	};

	let positionals = positional_names(schema, root_properties, excluded);
	let mut leaves = Vec::new();
	let mut path = Vec::new();
	flatten_properties(
		schema,
		root_properties,
		excluded,
		true,
		&positionals,
		&mut path,
		&mut leaves,
	);
	assign_short_flags(&mut leaves);
	Ok(Variant { leaves })
}

fn positional_names(
	schema: &Value,
	root_properties: &Map<String, Value>,
	excluded: Option<&str>,
) -> Vec<Str> {
	let mut names = Vec::with_capacity(2);
	let Some(required) = schema.get("required").and_then(Value::as_array) else {
		return names;
	};
	for name in required.iter().filter_map(Value::as_str) {
		if excluded == Some(name) {
			continue;
		}
		if root_properties.get(name).is_some_and(is_positional_spec) {
			names.push(Str::new(name));
			if names.len() == 2 {
				break;
			}
		}
	}
	names
}

fn is_positional_spec(schema: &Value) -> bool {
	if schema.get("enum").is_some_and(Value::is_array) {
		return true;
	}
	matches!(
		schema.get("type").and_then(Value::as_str),
		Some("string" | "integer" | "number" | "boolean")
	)
}

#[allow(
	clippy::too_many_arguments,
	reason = "schema traversal carries the parent-required and output state explicitly"
)]
fn flatten_properties(
	parent_schema: &Value,
	properties: &Map<String, Value>,
	excluded: Option<&str>,
	parent_required: bool,
	positionals: &[Str],
	path: &mut Vec<Str>,
	leaves: &mut Vec<Leaf>,
) {
	let required = parent_schema.get("required").and_then(Value::as_array);
	for (name, schema) in properties {
		if path.is_empty() && excluded == Some(name.as_str()) {
			continue;
		}
		let required_here = parent_required
			&& required.is_some_and(|names| names.iter().any(|item| item.as_str() == Some(name)));
		path.push(Str::new(name));

		if let Some(children) = schema.get("properties").and_then(Value::as_object) {
			flatten_properties(schema, children, None, required_here, positionals, path, leaves);
			path.pop();
			continue;
		}

		let positional = path.len() == 1 && positionals.iter().any(|item| item.as_str() == name);
		leaves.push(Leaf {
			path: path.clone(),
			long: long_name(path),
			short: None,
			description: schema
				.get("description")
				.and_then(Value::as_str)
				.map(Str::new),
			required: required_here,
			positional,
			kind: leaf_kind(schema, name),
		});
		path.pop();
	}
}

fn leaf_kind(schema: &Value, name: &str) -> LeafKind {
	let blob = blob_capable(schema, name);
	match schema.get("type").and_then(Value::as_str) {
		Some("array") => {
			let items = schema.get("items").unwrap_or(&Value::Null);
			if is_scalar_spec(items) {
				LeafKind::Array(scalar_spec(items, blob))
			} else {
				LeafKind::Scalar(ScalarSpec {
					kind:   ScalarKind::Fallback,
					values: None,
					blob:   false,
				})
			}
		},
		Some("object")
			if schema
				.get("additionalProperties")
				.is_some_and(|value| value != false) =>
		{
			let values = schema.get("additionalProperties").unwrap_or(&Value::Null);
			LeafKind::Map(scalar_spec(values, blob))
		},
		_ => LeafKind::Scalar(scalar_spec(schema, blob)),
	}
}

fn is_scalar_spec(schema: &Value) -> bool {
	schema.get("enum").is_some_and(Value::is_array)
		|| matches!(
			schema.get("type").and_then(Value::as_str),
			Some("string" | "integer" | "number" | "boolean")
		)
}

fn scalar_spec(schema: &Value, blob: bool) -> ScalarSpec {
	let values = schema.get("enum").and_then(Value::as_array).cloned();
	let kind = match schema.get("type").and_then(Value::as_str) {
		Some("string") => ScalarKind::String,
		Some("integer") => ScalarKind::Integer,
		Some("number") => ScalarKind::Number,
		Some("boolean") => ScalarKind::Boolean,
		_ if values
			.as_ref()
			.is_some_and(|values| values.iter().all(Value::is_string)) =>
		{
			ScalarKind::String
		},
		_ => ScalarKind::Fallback,
	};
	ScalarSpec { kind, values, blob: blob && kind == ScalarKind::String }
}

fn blob_capable(schema: &Value, name: &str) -> bool {
	BLOB_NAMES.contains(&name)
		|| schema
			.get("maxLength")
			.and_then(Value::as_u64)
			.is_some_and(|maximum| maximum > 1024)
}

fn long_name(path: &[Str]) -> Str {
	let mut rendered = String::new();
	for (index, segment) in path.iter().enumerate() {
		if index != 0 {
			rendered.push('.');
		}
		for character in segment.chars() {
			rendered.push(if character == '_' { '-' } else { character });
		}
	}
	Str::new(rendered)
}

fn assign_short_flags(leaves: &mut [Leaf]) {
	let mut taken = RESERVED_SHORT_FLAGS.to_vec();
	for leaf in leaves.iter_mut().filter(|leaf| !leaf.positional) {
		for candidate in leaf.long.chars().filter(char::is_ascii_alphabetic) {
			let candidate = candidate.to_ascii_lowercase();
			if !taken.contains(&candidate) {
				taken.push(candidate);
				leaf.short = Some(candidate);
				break;
			}
		}
	}
}

fn const_token(value: &Value) -> Option<Str> {
	match value {
		Value::String(value) => Some(Str::new(value)),
		Value::Number(value) => Some(Str::new(value.to_string())),
		Value::Bool(value) => Some(Str::new(if *value { "true" } else { "false" })),
		Value::Null | Value::Array(_) | Value::Object(_) => None,
	}
}

fn unknown_subcommand(given: &str, commands: &[Subcommand]) -> CliParseError {
	let expected = commands
		.iter()
		.map(|command| command.token.as_str())
		.collect::<Vec<_>>()
		.join("|");
	CliParseError::UnknownSubcommand { given: Str::new(given), expected: Str::new(expected) }
}

fn parse_variant(
	variant: &Variant,
	argv: &[Str],
	blob: &mut dyn FnMut(BlobSource<'_>) -> Result<String, CliParseError>,
) -> Result<Map<String, Value>, CliParseError> {
	if let Some(raw) = raw_json(argv)? {
		let value: Value = serde_json::from_str(raw)?;
		return value
			.as_object()
			.cloned()
			.ok_or_else(|| CliParseError::InvalidValue {
				flag:     Str::new_static("--json"),
				expected: Str::new_static("a JSON object"),
				found:    Str::new(raw),
			});
	}

	let positional_indices = variant
		.leaves
		.iter()
		.enumerate()
		.filter_map(|(index, leaf)| leaf.positional.then_some(index))
		.collect::<Vec<_>>();
	let mut next_positional = 0;
	let mut seen = vec![false; variant.leaves.len()];
	let mut output = Map::new();
	let mut index = 0;
	while index < argv.len() {
		let argument = argv[index].as_str();
		if json_flag(argument) {
			return Err(CliParseError::InvalidValue {
				flag:     Str::new_static("--json"),
				expected: Str::new_static("the first argument"),
				found:    Str::new(argument),
			});
		}

		if let Some(flag) = argument.strip_prefix("--") {
			let (name, inline) = flag
				.split_once('=')
				.map_or((flag, None), |(name, value)| (name, Some(value)));
			let (name, negative) = name
				.strip_prefix("no-")
				.map_or((name, false), |name| (name, true));
			let Some(leaf_index) = variant
				.leaves
				.iter()
				.rposition(|leaf| !leaf.positional && leaf.long == name)
			else {
				return Err(unknown_flag(argument, variant));
			};
			let leaf = &variant.leaves[leaf_index];
			if is_boolean_flag(leaf) {
				if let Some(value) = inline {
					return Err(invalid_value(argument, "no value", value));
				}
				set_scalar(&mut output, leaf, Value::Bool(!negative));
				seen[leaf_index] = true;
				index += 1;
				continue;
			}
			if negative {
				return Err(unknown_flag(argument, variant));
			}
			let value = if let Some(value) = inline {
				value
			} else {
				index += 1;
				argv
					.get(index)
					.map(Str::as_str)
					.ok_or_else(|| CliParseError::MissingValue { flag: Str::new(argument) })?
			};
			set_value(&mut output, leaf, value, argument, blob)?;
			seen[leaf_index] = true;
			index += 1;
			continue;
		}

		if let Some((short, inline)) = parse_short_flag(argument) {
			let Some(leaf_index) = variant
				.leaves
				.iter()
				.position(|leaf| !leaf.positional && leaf.short == Some(short))
			else {
				return Err(unknown_flag(argument, variant));
			};
			let leaf = &variant.leaves[leaf_index];
			if is_boolean_flag(leaf) {
				if let Some(value) = inline {
					return Err(invalid_value(argument, "no value", value));
				}
				set_scalar(&mut output, leaf, Value::Bool(true));
				seen[leaf_index] = true;
				index += 1;
				continue;
			}
			let value = if let Some(value) = inline {
				value
			} else {
				index += 1;
				argv
					.get(index)
					.map(Str::as_str)
					.ok_or_else(|| CliParseError::MissingValue { flag: Str::new(argument) })?
			};
			set_value(&mut output, leaf, value, argument, blob)?;
			seen[leaf_index] = true;
			index += 1;
			continue;
		}

		let Some(leaf_index) = positional_indices.get(next_positional).copied() else {
			return Err(CliParseError::UnexpectedArgument { argument: Str::new(argument) });
		};
		let leaf = &variant.leaves[leaf_index];
		set_value(&mut output, leaf, argument, leaf.long.as_str(), blob)?;
		seen[leaf_index] = true;
		next_positional += 1;
		index += 1;
	}

	let missing = variant
		.leaves
		.iter()
		.zip(seen)
		.filter_map(|(leaf, seen)| (leaf.required && !seen).then_some(leaf.long.as_str()))
		.collect::<Vec<_>>();
	if !missing.is_empty() {
		return Err(CliParseError::MissingRequired { names: Str::new(missing.join(", ")) });
	}
	Ok(output)
}

fn raw_json(argv: &[Str]) -> Result<Option<&str>, CliParseError> {
	let Some(first) = argv.first().map(Str::as_str) else {
		return Ok(None);
	};
	let raw = if matches!(first, "--json" | "-j") {
		argv
			.get(1)
			.map(Str::as_str)
			.ok_or_else(|| CliParseError::MissingValue { flag: Str::new(first) })?
	} else if let Some(raw) = first
		.strip_prefix("--json=")
		.or_else(|| first.strip_prefix("-j="))
	{
		raw
	} else {
		return Ok(None);
	};
	let consumed = if matches!(first, "--json" | "-j") {
		2
	} else {
		1
	};
	if let Some(argument) = argv.get(consumed) {
		return Err(CliParseError::UnexpectedArgument { argument: argument.clone() });
	}
	Ok(Some(raw))
}

fn json_flag(argument: &str) -> bool {
	matches!(argument, "--json" | "-j")
		|| argument.starts_with("--json=")
		|| argument.starts_with("-j=")
}

fn parse_short_flag(argument: &str) -> Option<(char, Option<&str>)> {
	let rest = argument.strip_prefix('-')?;
	if rest.starts_with('-') || rest.is_empty() {
		return None;
	}
	let (name, inline) = rest
		.split_once('=')
		.map_or((rest, None), |(name, value)| (name, Some(value)));
	let mut characters = name.chars();
	let short = characters.next()?;
	(short.is_ascii_alphabetic() && characters.next().is_none()).then_some((short, inline))
}

fn is_boolean_flag(leaf: &Leaf) -> bool {
	matches!(&leaf.kind, LeafKind::Scalar(spec) if spec.kind == ScalarKind::Boolean && spec.values.is_none())
}

fn set_value(
	output: &mut Map<String, Value>,
	leaf: &Leaf,
	raw: &str,
	flag: &str,
	blob: &mut dyn FnMut(BlobSource<'_>) -> Result<String, CliParseError>,
) -> Result<(), CliParseError> {
	match &leaf.kind {
		LeafKind::Scalar(spec) => {
			let value = coerce(spec, raw, flag, blob)?;
			set_scalar(output, leaf, value);
		},
		LeafKind::Array(spec) => {
			for item in raw.split(',') {
				let value = coerce(spec, item, flag, blob)?;
				append_array(output, &leaf.path, value);
			}
		},
		LeafKind::Map(spec) => {
			let Some((key, value)) = raw.split_once('=') else {
				return Err(invalid_value(flag, "KEY=VALUE", raw));
			};
			if key.is_empty() {
				return Err(invalid_value(flag, "a non-empty KEY=VALUE", raw));
			}
			let value = coerce(spec, value, flag, blob)?;
			insert_map_value(output, &leaf.path, key, value);
		},
	}
	Ok(())
}

fn coerce(
	spec: &ScalarSpec,
	raw: &str,
	flag: &str,
	blob: &mut dyn FnMut(BlobSource<'_>) -> Result<String, CliParseError>,
) -> Result<Value, CliParseError> {
	let resolved = if spec.blob {
		let source = if raw == "-" {
			BlobSource::Stdin
		} else if let Some(path) = raw.strip_prefix('@') {
			BlobSource::File(path)
		} else {
			BlobSource::Literal(raw)
		};
		Some(blob(source)?)
	} else {
		None
	};
	let value = resolved.as_deref().unwrap_or(raw);

	if let Some(values) = &spec.values {
		if let Some(member) = values.iter().find(|member| enum_matches(member, value)) {
			return Ok(member.clone());
		}
		return Err(invalid_value(flag, &enum_usage(values), value));
	}

	match spec.kind {
		ScalarKind::String => Ok(Value::String(value.to_owned())),
		ScalarKind::Integer => {
			let parsed = serde_json::from_str::<Value>(value)
				.ok()
				.filter(|value| value.as_i64().is_some() || value.as_u64().is_some());
			parsed.ok_or_else(|| invalid_value(flag, "an integer", value))
		},
		ScalarKind::Number => {
			let parsed = serde_json::from_str::<Value>(value)
				.ok()
				.filter(Value::is_number);
			parsed.ok_or_else(|| invalid_value(flag, "a number", value))
		},
		ScalarKind::Boolean => match value {
			"true" => Ok(Value::Bool(true)),
			"false" => Ok(Value::Bool(false)),
			_ => Err(invalid_value(flag, "true or false", value)),
		},
		ScalarKind::Fallback => {
			Ok(serde_json::from_str(value).unwrap_or_else(|_| Value::String(value.to_owned())))
		},
	}
}

fn enum_matches(member: &Value, raw: &str) -> bool {
	member
		.as_str()
		.map_or_else(|| member == raw, |member| member == raw)
}

fn invalid_value(flag: &str, expected: &str, found: &str) -> CliParseError {
	CliParseError::InvalidValue {
		flag:     Str::new(flag),
		expected: Str::new(expected),
		found:    Str::new(found),
	}
}

fn unknown_flag(flag: &str, variant: &Variant) -> CliParseError {
	let normalized = flag
		.strip_prefix("--no-")
		.or_else(|| flag.strip_prefix("--"))
		.unwrap_or(flag);
	let suggestion = variant
		.leaves
		.iter()
		.filter(|leaf| !leaf.positional)
		.map(|leaf| (levenshtein(normalized, leaf.long.as_str()), &leaf.long))
		.min_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(right.1)))
		.filter(|(distance, name)| *distance <= 3 || *distance * 3 <= name.len())
		.map(|(_, name)| Str::new(format!("--{name}")));
	CliParseError::UnknownFlag { flag: Str::new(flag), suggestion }
}

fn set_scalar(output: &mut Map<String, Value>, leaf: &Leaf, value: Value) {
	insert_path(output, &leaf.path, value);
}

fn insert_path(output: &mut Map<String, Value>, path: &[Str], value: Value) {
	let Some((last, parents)) = path.split_last() else {
		return;
	};
	let target = nested_object(output, parents);
	target.insert(last.to_string(), value);
}

fn append_array(output: &mut Map<String, Value>, path: &[Str], value: Value) {
	let Some((last, parents)) = path.split_last() else {
		return;
	};
	let target = nested_object(output, parents);
	let entry = target
		.entry(last.to_string())
		.or_insert_with(|| Value::Array(Vec::new()));
	if !entry.is_array() {
		*entry = Value::Array(Vec::new());
	}
	if let Value::Array(values) = entry {
		values.push(value);
	}
}

fn insert_map_value(output: &mut Map<String, Value>, path: &[Str], key: &str, value: Value) {
	let Some((last, parents)) = path.split_last() else {
		return;
	};
	let target = nested_object(output, parents);
	let entry = target
		.entry(last.to_string())
		.or_insert_with(|| Value::Object(Map::new()));
	if !entry.is_object() {
		*entry = Value::Object(Map::new());
	}
	if let Value::Object(values) = entry {
		values.insert(key.to_owned(), value);
	}
}

fn nested_object<'a>(
	mut output: &'a mut Map<String, Value>,
	parents: &[Str],
) -> &'a mut Map<String, Value> {
	for parent in parents {
		let entry = output
			.entry(parent.to_string())
			.or_insert_with(|| Value::Object(Map::new()));
		if !entry.is_object() {
			*entry = Value::Object(Map::new());
		}
		let Value::Object(next) = entry else {
			unreachable!("entry was normalized to an object")
		};
		output = next;
	}
	output
}

fn append_variant_usage(output: &mut String, invocation: &str, variant: &Variant) {
	let _ = write!(output, "  {invocation}");
	for leaf in variant.leaves.iter().filter(|leaf| leaf.positional) {
		let _ = write!(output, " <{}>", leaf.long);
	}
	output.push_str(" [OPTIONS]\n");

	let positionals = variant
		.leaves
		.iter()
		.filter(|leaf| leaf.positional)
		.collect::<Vec<_>>();
	if !positionals.is_empty() {
		output.push_str("\nArguments:\n");
		for leaf in positionals {
			let _ = write!(output, "  <{}>", leaf.long);
			append_usage_note(output, leaf, false);
			output.push('\n');
		}
	}

	output.push_str("\nOptions:\n");
	for leaf in variant.leaves.iter().filter(|leaf| !leaf.positional) {
		output.push_str("  ");
		if let Some(short) = leaf.short {
			let _ = write!(output, "-{short}, ");
		}
		if is_boolean_flag(leaf) {
			let _ = write!(output, "--{} / --no-{}", leaf.long, leaf.long);
		} else {
			let _ = write!(output, "--{} {}", leaf.long, leaf_value_usage(leaf));
		}
		append_usage_note(output, leaf, matches!(leaf.kind, LeafKind::Array(_) | LeafKind::Map(_)));
		output.push('\n');
	}
	output.push_str("  -j, --json <JSON>  Pass one raw JSON object; must be first.\n");
	output.push_str("  -h, --help         Show device documentation and usage.\n");
}

fn append_usage_note(output: &mut String, leaf: &Leaf, repeatable: bool) {
	if let Some(description) = &leaf.description {
		let _ = write!(output, "  {description}");
	}
	if leaf.required && !leaf.positional {
		output.push_str("  (required)");
	}
	if repeatable {
		output.push_str("  (repeatable)");
	}
}

fn leaf_value_usage(leaf: &Leaf) -> String {
	match &leaf.kind {
		LeafKind::Scalar(spec) => scalar_usage(spec),
		LeafKind::Array(spec) => format!("{}[,…]", scalar_usage(spec)),
		LeafKind::Map(spec) => format!("KEY={}", scalar_usage(spec)),
	}
}

fn scalar_usage(spec: &ScalarSpec) -> String {
	if let Some(values) = &spec.values {
		return enum_usage(values);
	}
	match spec.kind {
		ScalarKind::String => "<TEXT>".to_owned(),
		ScalarKind::Integer => "<INTEGER>".to_owned(),
		ScalarKind::Number => "<NUMBER>".to_owned(),
		ScalarKind::Boolean => "<BOOLEAN>".to_owned(),
		ScalarKind::Fallback => "<JSON|STRING>".to_owned(),
	}
}

fn enum_usage(values: &[Value]) -> String {
	let rendered = values
		.iter()
		.map(|value| {
			value
				.as_str()
				.map_or_else(|| value.to_string(), str::to_owned)
		})
		.collect::<Vec<_>>()
		.join("|");
	format!("{{{rendered}}}")
}

pub(crate) fn levenshtein(left: &str, right: &str) -> usize {
	let mut row: Vec<usize> = (0..=right.chars().count()).collect();
	for (left_index, left_char) in left.chars().enumerate() {
		let mut diagonal = row[0];
		row[0] = left_index + 1;
		for (right_index, right_char) in right.chars().enumerate() {
			let above = row[right_index + 1];
			row[right_index + 1] = (row[right_index + 1] + 1)
				.min(row[right_index] + 1)
				.min(diagonal + usize::from(left_char != right_char));
			diagonal = above;
		}
	}
	row[right.chars().count()]
}

#[cfg(test)]
mod tests {
	use omp_core::Str;
	use serde_json::{Value, json};

	use super::{BlobSource, CliParseError, DeviceCli};

	fn args(values: &[&str]) -> Vec<Str> {
		values.iter().map(|value| Str::new(*value)).collect()
	}

	fn literals(source: BlobSource<'_>) -> Result<String, CliParseError> {
		Ok(match source {
			BlobSource::Literal(value) => value.to_owned(),
			BlobSource::File(path) => format!("file:{path}"),
			BlobSource::Stdin => "stdin body".to_owned(),
		})
	}

	fn read_file_schema() -> Value {
		json!({
			"type": "object",
			"properties": {
				"path": { "type": "string", "description": "File path." },
				"mode": { "type": "string", "enum": ["text", "bytes"], "default": "text" }
			},
			"required": ["path"]
		})
	}

	fn write_file_schema() -> Value {
		json!({
			"type": "object",
			"properties": {
				"path": { "type": "string" },
				"content": { "type": "string", "maxLength": 4096 },
				"overwrite": { "type": "boolean" }
			},
			"required": ["path", "content"]
		})
	}

	fn create_pr_schema() -> Value {
		json!({
			"type": "object",
			"properties": {
				"title": { "type": "string" },
				"draft": { "type": "boolean" },
				"reviewers": { "type": "array", "items": { "type": "string" } },
				"pr_meta": {
					"type": "object",
					"properties": {
						"priority": { "type": "integer" },
						"notify": { "type": "boolean" }
					}
				}
			},
			"required": ["title"]
		})
	}

	fn query_schema() -> Value {
		json!({
			"type": "object",
			"properties": {
				"sql": { "type": "string" },
				"params": { "type": "object", "additionalProperties": true }
			},
			"required": ["sql"]
		})
	}

	fn infra_schema() -> Value {
		json!({
			"oneOf": [
				{
					"type": "object",
					"properties": {
						"kind": { "const": "volume" },
						"name": { "type": "string" },
						"size": { "type": "integer" },
						"labels": { "type": "object", "additionalProperties": { "type": "number" } }
					},
					"required": ["kind", "name"]
				},
				{
					"type": "object",
					"properties": {
						"kind": { "const": "network" },
						"name": { "type": "string" },
						"public": { "type": "boolean" }
					},
					"required": ["kind", "name"]
				}
			]
		})
	}

	#[test]
	fn sole_required_scalar_becomes_positional_without_default_injection() {
		let cli = DeviceCli::compile(&read_file_schema()).expect("read_file schema compiles");
		let parsed = cli
			.parse(&args(&["README.md"]), &mut literals)
			.expect("arguments parse");
		assert_eq!(Value::Object(parsed), json!({ "path": "README.md" }));
	}

	#[test]
	fn two_positionals_resolve_file_and_stdin_blobs() {
		let cli = DeviceCli::compile(&write_file_schema()).expect("write_file schema compiles");
		let file = cli
			.parse(&args(&["out.txt", "@fixture.txt"]), &mut literals)
			.expect("file blob parses");
		assert_eq!(Value::Object(file), json!({ "path": "out.txt", "content": "file:fixture.txt" }));
		let stdin = cli
			.parse(&args(&["out.txt", "-"]), &mut literals)
			.expect("stdin blob parses");
		assert_eq!(Value::Object(stdin), json!({ "path": "out.txt", "content": "stdin body" }));
	}

	#[test]
	fn enum_values_validate_and_optional_defaults_stay_absent() {
		let schema = json!({
			"type": "object",
			"properties": {
				"query": { "type": "string" },
				"state": { "type": "string", "enum": ["open", "closed", "all"], "default": "open" }
			},
			"required": ["query"]
		});
		let cli = DeviceCli::compile(&schema).expect("search_issues schema compiles");
		let parsed = cli
			.parse(&args(&["bug"]), &mut literals)
			.expect("default omission parses");
		assert_eq!(Value::Object(parsed), json!({ "query": "bug" }));
		assert!(matches!(
			cli.parse(&args(&["bug", "--state", "pending"]), &mut literals),
			Err(CliParseError::InvalidValue { .. })
		));
	}

	#[test]
	fn arrays_booleans_and_dotted_nested_flags_build_exact_payload() {
		let cli = DeviceCli::compile(&create_pr_schema()).expect("create_pr schema compiles");
		let parsed = cli
			.parse(
				&args(&[
					"Title",
					"--draft",
					"--reviewers",
					"a,b",
					"--reviewers",
					"c",
					"--pr-meta.priority",
					"3",
				]),
				&mut literals,
			)
			.expect("create_pr arguments parse");
		assert_eq!(
			Value::Object(parsed),
			json!({
				"title": "Title",
				"draft": true,
				"reviewers": ["a", "b", "c"],
				"pr_meta": { "priority": 3 }
			})
		);
	}

	#[test]
	fn no_boolean_flag_records_false() {
		let cli = DeviceCli::compile(&create_pr_schema()).expect("create_pr schema compiles");
		let parsed = cli
			.parse(&args(&["Title", "--no-draft"]), &mut literals)
			.expect("negative boolean parses");
		assert_eq!(Value::Object(parsed), json!({ "title": "Title", "draft": false }));
	}

	#[test]
	fn db_query_blob_and_typeless_map_values_are_coerced() {
		let cli = DeviceCli::compile(&query_schema()).expect("query schema compiles");
		let parsed = cli
			.parse(
				&args(&["@query.sql", "--params", "limit=5", "--params", "mode=fast"]),
				&mut literals,
			)
			.expect("query arguments parse");
		assert_eq!(
			Value::Object(parsed),
			json!({ "sql": "file:query.sql", "params": { "limit": 5, "mode": "fast" } })
		);
	}

	#[test]
	fn additional_property_maps_repeat_and_coerce_values() {
		let cli = DeviceCli::compile(&infra_schema()).expect("infra schema compiles");
		let parsed = cli
			.parse(
				&args(&["volume", "cache", "--labels", "iops=12", "--labels", "ratio=1.5"]),
				&mut literals,
			)
			.expect("volume map arguments parse");
		assert_eq!(
			Value::Object(parsed),
			json!({ "kind": "volume", "name": "cache", "labels": { "iops": 12, "ratio": 1.5 } })
		);
	}

	#[test]
	fn one_of_const_branches_become_subcommands() {
		let cli = DeviceCli::compile(&infra_schema()).expect("infra schema compiles");
		let parsed = cli
			.parse(&args(&["network", "frontend", "--public"]), &mut literals)
			.expect("network subcommand parses");
		assert_eq!(
			Value::Object(parsed),
			json!({ "kind": "network", "name": "frontend", "public": true })
		);
		assert!(matches!(
			cli.parse(&args(&["bucket"]), &mut literals),
			Err(CliParseError::UnknownSubcommand { .. })
		));
	}

	#[test]
	fn json_override_is_verbatim_and_reinjects_discriminator() {
		let cli = DeviceCli::compile(&infra_schema()).expect("infra schema compiles");
		let parsed = cli
			.parse(&args(&["volume", "--json", r#"{"name":"cache","size":20}"#]), &mut literals)
			.expect("raw JSON parses");
		assert_eq!(Value::Object(parsed), json!({ "name": "cache", "size": 20, "kind": "volume" }));
		assert!(matches!(
			cli.parse(&args(&["volume", "cache", "--json", "{}"]), &mut literals),
			Err(CliParseError::InvalidValue { .. })
		));
	}

	#[test]
	fn unknown_flag_reports_nearest_suggestion() {
		let cli = DeviceCli::compile(&create_pr_schema()).expect("create_pr schema compiles");
		let error = cli
			.parse(&args(&["Title", "--revieers", "a"]), &mut literals)
			.expect_err("typo must fail");
		match error {
			CliParseError::UnknownFlag { suggestion, .. } => {
				assert_eq!(suggestion.as_deref(), Some("--reviewers"));
			},
			other => panic!("expected unknown flag, got {other}"),
		}
	}

	#[test]
	fn missing_required_names_follow_schema_order() {
		let cli = DeviceCli::compile(&write_file_schema()).expect("write_file schema compiles");
		let error = cli
			.parse(&[], &mut literals)
			.expect_err("required arguments must fail");
		assert!(matches!(
			error,
			CliParseError::MissingRequired { names } if names == "path, content"
		));
	}

	#[test]
	fn usage_is_stable_and_exposes_schema_shapes() {
		let cli = DeviceCli::compile(&create_pr_schema()).expect("create_pr schema compiles");
		assert_eq!(
			cli.usage("dyn github/create_pr"),
			concat!(
				"  dyn github/create_pr <title> [OPTIONS]\n",
				"\n",
				"Arguments:\n",
				"  <title>\n",
				"\n",
				"Options:\n",
				"  -d, --draft / --no-draft\n",
				"  -r, --reviewers <TEXT>[,…]  (repeatable)\n",
				"  -p, --pr-meta.priority <INTEGER>\n",
				"  -m, --pr-meta.notify / --no-pr-meta.notify\n",
				"  -j, --json <JSON>  Pass one raw JSON object; must be first.\n",
				"  -h, --help         Show device documentation and usage.\n",
			)
		);
	}
}
