//! Verifies catalog vendor schemas retain their expected structure.
mod support;

use std::{collections::BTreeSet, fs, path::Path};

use omp_ai::codec::{cursor, devin};
use prost_types::FileDescriptorSet;
use serde::Deserialize;
use support::descriptors::{DescriptorShape, MessageShape, shape};

#[derive(Debug, Deserialize)]
struct DriftFixture {
	schema_version: u32,
	providers:      Providers,
}

#[derive(Debug, Deserialize)]
struct Providers {
	cursor: ProviderDrift,
	devin:  ProviderDrift,
}

#[derive(Debug, Deserialize)]
struct ProviderDrift {
	binding_conflict_count: usize,
	binding_conflicts: Vec<serde::de::IgnoredAny>,
	schema_omission_count: usize,
	schema_omissions_from_handwritten_binding: Vec<Omission>,
}

#[derive(Debug, Deserialize)]
#[serde(untagged)]
enum Omission {
	Message {
		message: String,
		schema_fields_omitted_from_handwritten_binding: Vec<OmittedField>,
	},
	Enum {
		#[serde(rename = "enum")]
		enumeration: String,
		schema_values_omitted_from_handwritten_binding: Vec<OmittedValue>,
	},
}

#[derive(Debug, Deserialize)]
struct OmittedField {
	field: String,
	tag:   i32,
}

#[derive(Debug, Deserialize)]
struct OmittedValue {
	value:  String,
	number: i32,
}

#[test]
fn recovered_cursor_and_devin_schemas_are_wire_compatible() {
	let vendor =
		Path::new(env!("CARGO_MANIFEST_DIR")).join("../../fixtures/llm-oracle/vendor-schemas");
	let fixture: DriftFixture = serde_json::from_slice(
		&fs::read(vendor.join("drift.json")).expect("checked-in drift fixture"),
	)
	.expect("typed drift fixture");
	assert_eq!(fixture.schema_version, 1);

	let cursor_recovered =
		protox::compile([&vendor.join("cursor/agent.proto")], [&vendor.join("cursor")])
			.expect("compile recovered Cursor descriptor set");
	verify_provider(
		"cursor",
		&cursor_recovered,
		&cursor::descriptor_set().expect("replacement Cursor descriptors"),
		&fixture.providers.cursor,
	);

	let devin_root = vendor.join("devin");
	let devin_roots = [
		"exa/api_server_pb/api_server.proto",
		"exa/auth_pb/auth.proto",
		"exa/chat_pb/chat.proto",
		"exa/codeium_common_pb/codeium_common.proto",
	]
	.map(|path| devin_root.join(path));
	let devin_recovered =
		protox::compile(&devin_roots, [&devin_root]).expect("compile recovered Devin descriptor set");
	verify_provider(
		"devin",
		&devin_recovered,
		&devin::descriptor_set().expect("replacement Devin descriptors"),
		&fixture.providers.devin,
	);
}

fn verify_provider(
	provider: &str,
	recovered: &FileDescriptorSet,
	replacement: &FileDescriptorSet,
	drift: &ProviderDrift,
) {
	assert_eq!(drift.binding_conflict_count, 0, "{provider} fixture records conflicts");
	assert!(drift.binding_conflicts.is_empty(), "{provider} fixture contains conflicts");

	let recovered = shape(recovered);
	let replacement = shape(replacement);
	assert_eq!(
		replacement.messages, recovered.messages,
		"{provider} message field tag/type/oneof drift"
	);
	assert_eq!(replacement.enums, recovered.enums, "{provider} enum number drift");
	verify_omission_census(provider, &recovered, drift);
}

fn verify_omission_census(provider: &str, recovered: &DescriptorShape, drift: &ProviderDrift) {
	let mut census = Vec::new();
	for omission in &drift.schema_omissions_from_handwritten_binding {
		match omission {
			Omission::Message { message, schema_fields_omitted_from_handwritten_binding: fields } => {
				let descriptor = resolve_message(provider, recovered, message, fields);
				for field in fields {
					let actual = descriptor.fields.get(&field.tag).unwrap_or_else(|| {
						panic!("{provider}: {message} has no field tag {}", field.tag)
					});
					assert_eq!(
						actual.name, field.field,
						"{provider}: omission field name drift at {message} tag {}",
						field.tag
					);
					census.push(format!("field:{message}:{}:{}", field.tag, field.field));
				}
			},
			Omission::Enum { enumeration, schema_values_omitted_from_handwritten_binding: values } => {
				let descriptor = resolve_enum(provider, recovered, enumeration, values);
				for value in values {
					assert!(
						descriptor.contains(&(value.number, value.value.clone())),
						"{provider}: omission enum number drift at {enumeration} {}",
						value.number
					);
					census.push(format!("enum:{enumeration}:{}:{}", value.number, value.value));
				}
			},
		}
	}
	census.sort();
	census.dedup();
	assert_eq!(
		census.len(),
		drift.schema_omission_count,
		"{provider}: documented omission census drift"
	);
}

fn resolve_message<'a>(
	provider: &str,
	recovered: &'a DescriptorShape,
	short_name: &str,
	fields: &[OmittedField],
) -> &'a MessageShape {
	let suffix = format!(".{short_name}");
	let mut matches = recovered.messages.iter().filter(|(full_name, descriptor)| {
		(*full_name == short_name || full_name.ends_with(&suffix))
			&& fields.iter().all(|field| {
				descriptor
					.fields
					.get(&field.tag)
					.is_some_and(|actual| actual.name == field.field)
			})
	});
	let (full_name, descriptor) = matches.next().unwrap_or_else(|| {
		panic!("{provider}: no fully-qualified descriptor matches omission record {short_name}")
	});
	assert!(
		matches.next().is_none(),
		"{provider}: omission record {short_name} is ambiguous after full descriptor matching \
		 (first match: {full_name})"
	);
	descriptor
}

fn resolve_enum<'a>(
	provider: &str,
	recovered: &'a DescriptorShape,
	short_name: &str,
	values: &[OmittedValue],
) -> &'a BTreeSet<(i32, String)> {
	let suffix = format!(".{short_name}");
	let mut matches = recovered.enums.iter().filter(|(full_name, descriptor)| {
		(*full_name == short_name || full_name.ends_with(&suffix))
			&& values
				.iter()
				.all(|value| descriptor.contains(&(value.number, value.value.clone())))
	});
	let (full_name, descriptor) = matches.next().unwrap_or_else(|| {
		panic!("{provider}: no fully-qualified descriptor matches omission record {short_name}")
	});
	assert!(
		matches.next().is_none(),
		"{provider}: omission record {short_name} is ambiguous after full descriptor matching \
		 (first match: {full_name})"
	);
	descriptor
}
