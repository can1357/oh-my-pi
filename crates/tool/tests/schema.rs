//! Typed schema generation contract tests.

use std::str;

use futures::executor::block_on;
use omp_core::Str;
use omp_tool::{
	IncomingParams, ProtocolSchemaError, decode_params, inject_protocol_schema, schema,
};
use schemars::JsonSchema;
use serde::Deserialize;
use serde_json::{Value, json};

#[allow(dead_code, reason = "fields are inspected by schema generation tests")]
#[derive(Deserialize, JsonSchema)]
struct Nested {
	enabled: bool,
}

#[allow(dead_code, reason = "fields are inspected by schema generation tests")]
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct Params {
	/// Required input value.
	required: String,
	/// Optional nested settings.
	#[schemars(default, skip_serializing_if = "Option::is_none", with = "Nested")]
	optional: Option<Nested>,
}

#[test]
fn generated_schema_is_compact_inlined_and_model_facing() {
	let first = schema::<Params>();
	let second = schema::<Params>();
	assert_eq!(first, second, "schema generation must be deterministic");
	assert!(!first.contains(&b'\n'), "schema must use compact JSON encoding");

	let value: Value = serde_json::from_slice(&first).expect("generated schema is valid JSON");
	assert_eq!(
		value,
		json!({
			"type": "object",
			"properties": {
				"required": {
					"description": "Required input value.",
					"type": "string"
				},
				"optional": {
					"description": "Optional nested settings.",
					"type": "object",
					"properties": {
						"enabled": {"type": "boolean"}
					},
					"required": ["enabled"]
				},
				"i": {
					"type": "string",
					"description": "Short present-participle intent for this call."
				},
				"notrunc": {
					"type": "boolean",
					"description": "Prefer complete output inline up to the host security ceiling; overflow or transport backpressure remains available through its artifact."
				}
			},
			"required": ["i", "required"],
			"additionalProperties": false
		}),
		"generator settings and serde annotations must project exactly"
	);
	let required = value["required"].as_array().expect("required names");
	assert_eq!(required.first(), Some(&json!("i")));
	assert!(!required.contains(&json!("notrunc")), "notrunc is caller-optional");
	assert!(value["properties"]["notrunc"].get("default").is_none());

	let encoded = str::from_utf8(&first).expect("JSON is UTF-8");
	for forbidden in ["$schema", "$ref", "$defs", "title"] {
		assert!(!encoded.contains(forbidden), "schema must not contain {forbidden}");
	}
}
#[allow(dead_code, reason = "fields are inspected by schema generation tests")]
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct StrParams {
	/// Required compact text.
	id:    Str,
	/// Optional compact text.
	#[schemars(default, skip_serializing_if = "Option::is_none")]
	label: Option<Str>,
	/// Compact text list.
	items: Vec<Str>,
}

#[allow(dead_code, reason = "fields are inspected by schema generation tests")]
#[derive(Deserialize, JsonSchema)]
#[serde(deny_unknown_fields)]
struct StringParams {
	/// Required compact text.
	id:    String,
	/// Optional compact text.
	#[schemars(default, skip_serializing_if = "Option::is_none")]
	label: Option<String>,
	/// Compact text list.
	items: Vec<String>,
}

#[test]
fn str_fields_project_exactly_like_string_fields() {
	assert_eq!(
		schema::<StrParams>(),
		schema::<StringParams>(),
		"Str fields must emit the same schema as String fields without `with` overrides"
	);
}

#[test]
fn arbitrary_schema_injection_normalizes_protocol_fields() {
	let injected = inject_protocol_schema(
		br#"{
			"type":"object",
			"properties":{
				"path":{"type":"string"},
				"i":{"type":"integer"},
				"notrunc":{"type":"string"}
			},
			"required":["path","notrunc","i"]
		}"#,
	)
	.expect("valid object schema");
	assert_eq!(
		injected.as_ref(),
		br#"{"type":"object","properties":{"path":{"type":"string"},"i":{"type":"string","description":"Short present-participle intent for this call."},"notrunc":{"type":"boolean","description":"Prefer complete output inline up to the host security ceiling; overflow or transport backpressure remains available through its artifact."}},"required":["i","path"]}"#
	);
	assert_eq!(
		inject_protocol_schema(&injected).expect("protocol injection is idempotent"),
		injected
	);
}

#[test]
fn arbitrary_schema_injection_rejects_invalid_shapes() {
	assert!(matches!(inject_protocol_schema(br"{"), Err(ProtocolSchemaError::Json(_))));
	for schema in [br"[]".as_slice(), br#"{"type":"string"}"#] {
		assert!(matches!(inject_protocol_schema(schema), Err(ProtocolSchemaError::Object)));
	}
	assert!(matches!(
		inject_protocol_schema(br#"{"type":"object","properties":[]}"#),
		Err(ProtocolSchemaError::Properties)
	));
	for schema in
		[br#"{"type":"object","required":{}}"#.as_slice(), br#"{"type":"object","required":[1]}"#]
	{
		assert!(matches!(inject_protocol_schema(schema), Err(ProtocolSchemaError::Required)));
	}
}

#[allow(dead_code, reason = "fields verify protocol stripping during deserialization")]
#[derive(Debug, Deserialize, Eq, PartialEq)]
#[serde(deny_unknown_fields)]
struct DomainParams {
	required: String,
}

#[test]
fn decode_strips_protocol_fields_but_invocation_metadata_retains_them() {
	let raw =
		Str::new_static(r#"{"i":"Reading protocol fields","notrunc":true,"required":"value"}"#);
	let (feed, mut incoming) = IncomingParams::channel();
	feed
		.args_committed(raw.clone())
		.expect("invocation remains connected");

	let decoded = block_on(incoming.whole::<DomainParams>()).expect("domain parameters decode");
	assert_eq!(decoded, DomainParams { required: "value".to_owned() });

	let finalized = feed
		.take_finalized_args()
		.expect("finalized metadata receipt");
	assert_eq!(finalized.raw(), &raw);
	assert_eq!(finalized.effective()["i"].as_str(), Some("Reading protocol fields"));
	assert_eq!(finalized.effective()["notrunc"].as_bool(), Some(true));
}

#[test]
fn absent_and_false_notrunc_preserve_default_domain_decode() {
	let absent = decode_params::<DomainParams>(r#"{"i":"Reading defaults","required":"value"}"#)
		.expect("absent notrunc decodes");
	let false_value = decode_params::<DomainParams>(
		r#"{"i":"Reading defaults","notrunc":false,"required":"value"}"#,
	)
	.expect("false notrunc decodes");
	assert_eq!(absent, false_value);
}
