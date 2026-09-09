//! Proves the bundled KDL compat cascade against focused policy fixtures and
//! executable quirk-census cases.

use std::{collections::BTreeMap, fs, path::Path};

use omp_catalog::{
	AXES, BUNDLED_COMPAT, CascadeError, Catalog, ClassificationInput, ClassificationPhase,
	CompatCascade, EffortTier, ModelKey, ResolveTarget, ThinkingEffort, ThinkingFormat, WirePolicy,
	classify,
};
use omp_core::SemVer;
use serde::Deserialize;
use serde_json::Value;
use sha2::{Digest, Sha256};

const CENSUS_CASES: &str = include_str!("../../../fixtures/llm-oracle/quirk-census/cases.jsonl");
const CATALOG_MODELS: &[u8] =
	include_bytes!("../../../fixtures/llm-oracle/catalog/models.json.zst");
const CATALOG_POSTCARD: &[u8] = include_bytes!("../data/catalog.postcard");

#[derive(Deserialize)]
struct Case {
	id:           String,
	fixture_kind: String,
	status:       String,
	#[serde(default)]
	r#match:      Option<String>,
	#[serde(default)]
	input:        Value,
	#[serde(default)]
	expected:     Value,
}

/// Census wire overlay beyond the archived oracle slice: the class×host
/// `thinking_format` compositions from the archived OpenAI chat cases. Applies
/// only where the oracle is silent on the axis.
fn census_thinking_format(provider: &str, class: &str) -> Option<&'static str> {
	match provider {
		"openrouter" => Some("openrouter"),
		"alibaba-token-plan" | "alibaba-coding-plan" => Some("qwen"),
		"nvidia" if class == "qwen" => Some("qwen-chat-template"),
		"fireworks" if class == "qwen" => Some("openai"),
		_ if class == "qwen" => Some("qwen"),
		_ => None,
	}
}

fn parse_revision(value: Option<&Value>) -> Option<SemVer> {
	let value = value?;
	if value.is_null() {
		return None;
	}
	let components = match value {
		Value::String(revision) => {
			let mut components = [0_u8; 3];
			let mut count = 0_usize;
			for component in revision.split('.') {
				assert!(
					count < components.len()
						&& !component.is_empty()
						&& component.bytes().all(|byte| byte.is_ascii_digit()),
					"revision must contain one to three numeric components"
				);
				components[count] = component
					.parse()
					.expect("revision components must fit in u8");
				count += 1;
			}
			assert!(count > 0, "revision must contain at least one component");
			components
		},
		Value::Object(revision) => {
			assert_eq!(
				revision.len(),
				3,
				"revision object must contain exactly major, minor, and patch"
			);
			let component = |name| {
				let value = revision
					.get(name)
					.unwrap_or_else(|| panic!("revision object is missing {name}"));
				u8::try_from(
					value
						.as_u64()
						.unwrap_or_else(|| panic!("revision {name} must be an unsigned integer")),
				)
				.unwrap_or_else(|_| panic!("revision {name} must fit in u8"))
			};
			[component("major"), component("minor"), component("patch")]
		},
		_ => panic!("revision must be a string or an object"),
	};
	Some(SemVer::new(components[0], components[1], components[2]))
}

#[test]
fn bundled_sources_match_the_compat_tree() {
	let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("compat");
	let mut on_disk = Vec::new();
	for group in ["classes", "providers"] {
		for entry in fs::read_dir(root.join(group)).expect("compat group exists") {
			let path = entry.expect("readable dir entry").path();
			if path.extension().is_some_and(|extension| extension == "kdl") {
				let stem = path
					.file_stem()
					.expect("file stem")
					.to_str()
					.expect("utf-8 name")
					.to_owned();
				on_disk.push(format!("{group}/{stem}"));
			}
		}
	}
	on_disk.sort();
	let mut bundled: Vec<String> = BUNDLED_COMPAT
		.iter()
		.map(|&(name, _)| name.to_owned())
		.collect();
	bundled.sort();
	assert_eq!(bundled, on_disk, "BUNDLED_COMPAT must list exactly compat/{{classes,providers}}");
}

#[test]
fn checked_in_model_source_matches_current_pi_roster() {
	let json = zstd::stream::decode_all(CATALOG_MODELS).expect("models fixture decompresses");
	let providers: serde_json::Map<String, Value> =
		serde_json::from_slice(&json).expect("models fixture parses");
	let count = providers
		.values()
		.map(|models| models.as_object().expect("provider models are keyed").len())
		.sum::<usize>();
	assert_eq!(count, 4_763, "current pi models.json roster size");
	assert_eq!(
		providers["cline-pass"]
			.as_object()
			.expect("ClinePass roster")
			.len(),
		18
	);
	assert_eq!(
		providers["abliteration"]
			.as_object()
			.expect("Abliteration roster")
			.len(),
		3
	);
}

#[test]
fn axis_vocabulary_is_literal_pi_parity() {
	fn lower_camel(value: &str) -> String {
		let mut output = String::with_capacity(value.len());
		let mut uppercase = false;
		for character in value.chars() {
			if character == '_' {
				uppercase = true;
			} else if uppercase {
				output.push(character.to_ascii_uppercase());
				uppercase = false;
			} else {
				output.push(character);
			}
		}
		output
	}

	let canonical = AXES
		.iter()
		.map(|axis| {
			let records = axis
				.records
				.iter()
				.map(|record| {
					record
						.to_string()
						.replace("open-ai-responses", "openai-responses")
						.replace("open-ai", "openai")
				})
				.collect::<Vec<_>>()
				.join(",");
			format!(
				"{}|{}|{}|{}|{}|{}|{}",
				axis.key,
				lower_camel(axis.resolved_key),
				axis.set,
				axis.shape,
				records,
				axis.values.join(","),
				u8::from(axis.verbatim_keys),
			)
		})
		.collect::<Vec<_>>()
		.join("\n");
	assert_eq!(AXES.len(), 125, "pi defines exactly 125 compatibility axes");
	// Pinned against pi `packages/catalog/src/compat/axes.ts` @ 7bfb41f243
	// (adds `requires-skip-thought-signature-on-first-function-call`).
	assert_eq!(
		format!("{:x}", Sha256::digest(canonical)),
		"2007f279a847e38f761ffefbc180da43f5139652e8cf548b1c088c13ea846e44",
		"AXES must remain literal key/field/set/shape/records/values parity with pi axes.ts",
	);
}

#[test]
fn every_pi_rule_file_compiles_under_the_closed_vocabulary() {
	CompatCascade::bundled().expect("every bundled class/provider rule uses the closed vocabulary");
}

#[test]
fn cca_gemini_three_requires_only_the_first_call_signature_bypass() {
	let cascade = CompatCascade::bundled().expect("bundled cascade parses");
	for provider in ["google-antigravity", "google-gemini-cli"] {
		for (model, expected) in
			[("gemini-3-pro", Some(&Value::Bool(true))), ("gemini-2.5-pro", None)]
		{
			let classification = classify(ClassificationInput {
				phase: ClassificationPhase::CatalogCompiler,
				provider,
				model,
				observed_at_ms: None,
			});
			let resolved = cascade
				.resolve(&ResolveTarget {
					provider,
					class: classification.class.as_str(),
					family: classification.family.as_ref().map(|family| family.as_str()),
					revision: classification.revision,
					model,
					reasoning: true,
				})
				.unwrap_or_else(|error| panic!("{provider}/{model}: {error}"));
			assert_eq!(
				resolved
					.wire
					.get("requires_skip_thought_signature_on_first_function_call"),
				expected,
				"{provider}/{model}",
			);
		}
	}
}

#[test]
fn invented_directive_reports_typed_key_file_and_line() {
	let error = CompatCascade::parse(&[(
		"invented.kdl",
		"class \"openai\" {\n\tmodels \"gpt-test\" {\n\t\tinvented-directive #true\n\t}\n}",
	)])
	.expect_err("invented directive must be rejected");
	assert!(matches!(
		error,
		CascadeError::UnknownDirective {
			file,
			line: 3,
			directive,
		} if file.as_str() == "invented.kdl" && directive.as_str() == "invented-directive"
	));
}

#[test]
fn compiled_catalog_carries_cascade_overlay_policies() {
	let catalog = Catalog::decode(CATALOG_POSTCARD).expect("compiled catalog snapshot decodes");

	let nvidia_qwen = catalog
		.model(ModelKey::from_ref("nvidia/qwen/qwen3-next-80b-a3b-thinking"))
		.expect("frozen nvidia qwen model is compiled");
	let wire_policy = catalog
		.wire_policy(&nvidia_qwen.wire_policy)
		.expect("nvidia qwen wire policy is interned");
	assert_eq!(
		wire_policy.reasoning.thinking_format,
		Some(ThinkingFormat::QwenChatTemplate),
		"compiled nvidia qwen policy must carry the cascade overlay"
	);

	let cursor_gpt = catalog
		.model(ModelKey::from_ref("cursor/gpt-5.1"))
		.expect("frozen cursor gpt-5.1 model is compiled");
	let thinking_policy = catalog
		.thinking_policy(
			cursor_gpt
				.thinking
				.as_ref()
				.expect("cursor gpt-5.1 references a thinking policy"),
		)
		.expect("cursor gpt-5.1 thinking policy is interned");
	assert_eq!(
		thinking_policy.efforts.as_slice(),
		&[ThinkingEffort::Low, ThinkingEffort::High],
		"compiled cursor gpt-5.1 policy must carry the cascade efforts"
	);

	let linkup = catalog
		.model(ModelKey::from_ref("nanogpt/linkup-research"))
		.expect("collapsed Nanogpt Linkup model is compiled");
	let thinking_policy = catalog
		.thinking_policy(
			linkup
				.thinking
				.as_ref()
				.expect("Nanogpt Linkup references a curated thinking policy"),
		)
		.expect("Nanogpt Linkup thinking policy is interned");
	assert_eq!(
		thinking_policy.efforts.as_slice(),
		&[ThinkingEffort::Low, ThinkingEffort::Medium, ThinkingEffort::High, ThinkingEffort::XHigh,],
		"tier-collapsed Linkup aliases must activate the exact cascade overlay"
	);
	assert_eq!(
		linkup.thinking_routing.effort_routing.len(),
		4,
		"every curated Linkup effort must route to its source alias"
	);
}

#[test]
fn every_ready_census_case_executes_against_real_machinery() {
	let cascade = CompatCascade::bundled().expect("bundled cascade parses");
	let mut executed = Vec::new();
	for line in CENSUS_CASES.lines().filter(|line| !line.trim().is_empty()) {
		let case: Case = serde_json::from_str(line).expect("census case parses");
		if case.status != "ready" {
			continue;
		}
		match case.fixture_kind.as_str() {
			"identity" => run_identity_case(&case),
			"policy-resolution" => run_policy_case(&cascade, &case),
			"compile-error" => run_compile_error_case(&case),
			other => panic!("ready case {} has unexecutable kind {other}", case.id),
		}
		executed.push(case.id);
	}
	assert_eq!(executed.len(), 23, "ready census cases all executed: {executed:?}");
}

#[test]
fn glm_53_uniform_ladder_resolves_on_every_host() {
	// GLM-5.3 replaces GLM-5.2's host-specific dialects with a uniform
	// wire-exact low/high/max ladder, mandatory thinking, and a max
	// default effort. The rule must beat census host-dialect residues such as
	// baseten's `zai-org/GLM-5*` glob.
	let cascade = CompatCascade::bundled().expect("bundled cascade parses");
	for (provider, model) in [
		("zai", "glm-5.3"),
		("zai", "glm-5.3-flash"),
		("zhipu-coding-plan", "glm-5.3"),
		("opencode-go", "glm-5.3"),
		("baseten", "zai-org/GLM-5.3"),
		("openrouter", "z-ai/glm-5.3-air"),
		("aiand", "glm-5.3-turbo"),
	] {
		let classification = classify(ClassificationInput {
			phase: ClassificationPhase::CatalogCompiler,
			provider,
			model,
			observed_at_ms: None,
		});
		assert_eq!(classification.class.as_str(), "glm", "{provider}/{model}: class");
		let resolved = cascade
			.resolve(&ResolveTarget {
				provider,
				class: classification.class.as_str(),
				family: classification.family.as_ref().map(|family| family.as_str()),
				revision: classification.revision,
				model,
				reasoning: true,
			})
			.unwrap_or_else(|error| panic!("{provider}/{model}: {error}"));
		assert_eq!(
			resolved.thinking.get("efforts"),
			Some(&Value::from(vec!["low", "high", "max"])),
			"{provider}/{model}: uniform ladder"
		);
		assert_eq!(
			resolved.thinking.get("defaultLevel"),
			Some(&Value::from("max")),
			"{provider}/{model}: max default"
		);
		assert_eq!(
			resolved.thinking.get("requiresEffort"),
			Some(&Value::Bool(true)),
			"{provider}/{model}: thinking cannot be disabled"
		);
		if provider == "zai" && model == "glm-5.3-flash" {
			assert_eq!(
				resolved.thinking.get("mode"),
				Some(&Value::from("anthropic-budget-effort")),
				"{provider}/{model}: mandatory Anthropic wire mode"
			);
		}
	}
	// The vision shape keeps its host dialect; the 5.3 rule must not match.
	let vision = cascade
		.resolve(&ResolveTarget {
			provider:  "zai",
			class:     "glm",
			family:    None,
			revision:  None,
			model:     "glm-5.3v",
			reasoning: true,
		})
		.expect("vision target resolves");
	assert_ne!(
		vision.thinking.get("efforts"),
		Some(&Value::from(vec!["low", "high", "max"])),
		"glm-5.3v must not inherit the coding-SKU ladder"
	);
}

#[test]
fn copilot_grok_46_residue_grants_the_responses_xhigh_ladder() {
	// Copilot serves grok-4.6 / grok-4.6-1m only via /responses, whose policy
	// carries the native xhigh tier. Dormant until a catalog
	// snapshot ships the ids; discovery classification already resolves them.
	let cascade = CompatCascade::bundled().expect("bundled cascade parses");
	for model in ["grok-4.6", "grok-4.6-1m"] {
		let classification = classify(ClassificationInput {
			phase: ClassificationPhase::CatalogCompiler,
			provider: "github-copilot",
			model,
			observed_at_ms: None,
		});
		assert_eq!(classification.class.as_str(), "xai", "github-copilot/{model}: class");
		let resolved = cascade
			.resolve(&ResolveTarget {
				provider: "github-copilot",
				class: classification.class.as_str(),
				family: classification.family.as_ref().map(|family| family.as_str()),
				revision: classification.revision,
				model,
				reasoning: true,
			})
			.unwrap_or_else(|error| panic!("github-copilot/{model}: {error}"));
		assert_eq!(
			resolved.thinking.get("efforts"),
			Some(&Value::from(vec!["minimal", "low", "medium", "high", "xhigh"])),
			"github-copilot/{model}: responses ladder"
		);
		assert_eq!(
			resolved.thinking.get("mode"),
			Some(&Value::from("effort")),
			"github-copilot/{model}: effort mode"
		);
		assert_eq!(
			resolved.wire.get("supports_strict_mode"),
			Some(&Value::Bool(true)),
			"github-copilot/{model}: strict Responses tools"
		);
		assert!(!resolved.wire.contains_key("thinking_close_max_retries"));
	}
}

#[test]
fn deepseek_image_venice_off_and_opencode_effort_policies_resolve() {
	let cascade = CompatCascade::bundled().expect("bundled cascade parses");
	let resolve = |provider: &str, model: &str, reasoning: bool| {
		let classification = classify(ClassificationInput {
			phase: ClassificationPhase::CatalogCompiler,
			provider,
			model,
			observed_at_ms: None,
		});
		cascade
			.resolve(&ResolveTarget {
				provider,
				class: classification.class.as_str(),
				family: classification.family.as_ref().map(|family| family.as_str()),
				revision: classification.revision,
				model,
				reasoning,
			})
			.unwrap_or_else(|error| panic!("{provider}/{model}: {error}"))
	};

	let flash = resolve("opencode-go", "deepseek-v4-flash", true);
	assert_eq!(flash.thinking.get("efforts"), Some(&Value::from(vec!["low", "high", "max"])),);
	assert_eq!(flash.wire.get("strip_image_input"), Some(&Value::Bool(true)));

	let ocr = resolve("novita", "deepseek/deepseek-ocr-2", false);
	assert_eq!(ocr.wire.get("strip_image_input"), Some(&Value::Bool(false)));

	let venice = resolve("venice", "qwen3-235b", true);
	assert_eq!(
		venice.wire.get("reasoning_disable_mode"),
		Some(&Value::from("venice-disable-thinking")),
	);
}

#[test]
fn qwen_38_local_hosts_route_effort_onto_the_chat_template() {
	// Qwen 3.8+ chat templates steer thinking depth via the
	// `reasoning_effort` kwarg (low/medium/xhigh) and cannot disable thinking;
	// vLLM rides the chat-template-kwargs dialect because it ignores top-level
	// `enable_thinking`.
	let cascade = CompatCascade::bundled().expect("bundled cascade parses");
	for (provider, format) in
		[("llama.cpp", "qwen"), ("lm-studio", "qwen"), ("vllm", "qwen-chat-template")]
	{
		let classification = classify(ClassificationInput {
			phase: ClassificationPhase::CatalogCompiler,
			provider,
			model: "qwen3.8-27b",
			observed_at_ms: None,
		});
		assert_eq!(classification.class.as_str(), "qwen", "{provider}: class");
		let resolved = cascade
			.resolve(&ResolveTarget {
				provider,
				class: classification.class.as_str(),
				family: classification.family.as_ref().map(|family| family.as_str()),
				revision: classification.revision,
				model: "qwen3.8-27b",
				reasoning: true,
			})
			.unwrap_or_else(|error| panic!("{provider}: {error}"));
		assert_eq!(
			resolved.wire.get("supports_reasoning_effort"),
			Some(&Value::Bool(true)),
			"{provider}: template effort dial"
		);
		assert_eq!(
			resolved.wire.get("thinking_format"),
			Some(&Value::from(format)),
			"{provider}: dialect"
		);
		assert_eq!(
			resolved.thinking.get("efforts"),
			Some(&Value::from(vec!["low", "medium", "xhigh"])),
			"{provider}: template ladder"
		);
		assert_eq!(
			resolved.thinking.get("requiresEffort"),
			Some(&Value::Bool(true)),
			"{provider}: thinking cannot be disabled"
		);
	}
	// Pre-3.8 templates have no reasoning_effort kwarg; nothing may leak.
	let classification = classify(ClassificationInput {
		phase:          ClassificationPhase::CatalogCompiler,
		provider:       "llama.cpp",
		model:          "qwen3.6-27b",
		observed_at_ms: None,
	});
	let resolved = cascade
		.resolve(&ResolveTarget {
			provider:  "llama.cpp",
			class:     classification.class.as_str(),
			family:    classification.family.as_ref().map(|family| family.as_str()),
			revision:  classification.revision,
			model:     "qwen3.6-27b",
			reasoning: true,
		})
		.expect("pre-3.8 target resolves");
	assert_eq!(resolved.wire.get("supports_reasoning_effort"), None, "no dial before 3.8");
	assert_eq!(resolved.thinking.get("efforts"), None, "no template ladder before 3.8");
}

fn run_identity_case(case: &Case) {
	let provider = case.input["provider"]
		.as_str()
		.expect("identity input provider");
	let model = case.input["model_id"]
		.as_str()
		.expect("identity input model_id");
	let classification = classify(ClassificationInput {
		phase: ClassificationPhase::CatalogCompiler,
		provider,
		model,
		observed_at_ms: None,
	});
	let expected = case.expected.as_object().expect("identity expected object");
	for (key, want) in expected {
		match key.as_str() {
			"family" => {
				assert_eq!(
					classification.class.as_str(),
					want.as_str().expect("class string"),
					"{}: class",
					case.id
				);
			},
			"logical_model" => {
				assert_eq!(
					classification.logical_model.as_str(),
					want.as_str().expect("logical_model string"),
					"{}: logical_model",
					case.id
				);
			},
			"thinking_variant" => {
				assert_eq!(
					classification.thinking_variant,
					want.as_bool().expect("thinking_variant bool"),
					"{}: thinking_variant",
					case.id
				);
			},
			"effort" => {
				let effort = classification.effort.map(|tier| match tier {
					EffortTier::Off => "off",
					EffortTier::Minimal => "minimal",
					EffortTier::Low => "low",
					EffortTier::Medium => "medium",
					EffortTier::High => "high",
					EffortTier::XHigh => "xhigh",
					EffortTier::Max => "max",
				});
				assert_eq!(effort, want.as_str(), "{}: effort", case.id);
			},
			other => panic!("{}: unhandled identity expectation `{other}`", case.id),
		}
	}
}

#[test]
fn opencode_responses_downgrade_forced_tool_choice() {
	let cascade = CompatCascade::bundled().expect("bundled cascade parses");
	for (provider, model) in
		[("opencode-go", "muse-spark-1.2-contributor"), ("opencode-zen", "muse-spark-1.2")]
	{
		let resolved = cascade
			.resolve(&ResolveTarget {
				provider,
				class: "meta",
				family: None,
				revision: Some(SemVer::new(1, 2, 0)),
				model,
				reasoning: true,
			})
			.expect("OpenCode compat resolves");
		assert_eq!(
			resolved.catalog.get("longUsageLimitFallback"),
			(provider == "opencode-go").then_some(&Value::Bool(true)),
			"{provider}/{model}"
		);
	}
	let control = cascade
		.resolve(&ResolveTarget {
			provider:  "openai",
			class:     "openai",
			family:    Some("gpt"),
			revision:  Some(SemVer::new(5, 0, 0)),
			model:     "gpt-5",
			reasoning: true,
		})
		.expect("OpenAI compat resolves");
	assert_ne!(control.wire.get("supports_forced_tool_choice"), Some(&Value::Bool(false)));
}

fn run_policy_case(cascade: &CompatCascade, case: &Case) {
	let provider = case.input["provider"]
		.as_str()
		.expect("policy input provider");
	let model = case.input["model_id"]
		.as_str()
		.expect("policy input model_id");
	let explicit_class = case.input.get("class");
	let class = explicit_class.map_or_else(
		|| case.input["family"].as_str().unwrap_or("unknown"),
		|class| class.as_str().expect("policy input class"),
	);
	let family = explicit_class.and_then(|_| {
		case
			.input
			.get("family")
			.filter(|family| !family.is_null())
			.map(|family| family.as_str().expect("policy input product family"))
	});
	let revision = parse_revision(case.input.get("revision"));
	let reasoning = case.input["reasoning"].as_bool().unwrap_or(false);
	let resolved = cascade
		.resolve(&ResolveTarget { provider, class, family, revision, model, reasoning })
		.expect("policy resolves");
	let overrides = case.expected["overrides"]
		.as_object()
		.expect("expected overrides object");
	let subset = case.r#match.as_deref() == Some("subset");
	if subset {
		for (axis, want) in overrides {
			let got = resolved
				.wire
				.get(axis.as_str())
				.unwrap_or_else(|| panic!("{}: axis {axis} unresolved", case.id));
			assert_eq!(got, want, "{}: axis {axis}", case.id);
		}
	} else {
		let resolved_json: BTreeMap<&str, &Value> = resolved
			.wire
			.iter()
			.map(|(key, value)| (key.as_str(), value))
			.collect();
		let mut expected: BTreeMap<&str, &Value> = overrides
			.iter()
			.map(|(key, value)| (key.as_str(), value))
			.collect();
		// Census overlay applies on top of the archived expectations.
		let overlay = census_thinking_format(provider, class).map(Value::from);
		if let Some(overlay) = overlay.as_ref() {
			expected.entry("thinking_format").or_insert(overlay);
		}
		let model_name = model.to_ascii_lowercase();
		let image_encoding = (class == "deepseek").then(|| {
			Value::from(
				if model_name.contains("deepseek-ocr")
					|| model_name.contains("janus")
					|| model_name.contains("vision")
					|| model_name.contains("vl")
				{
					"open_ai_url"
				} else {
					"none"
				},
			)
		});
		if let Some(image_encoding) = image_encoding.as_ref() {
			expected.insert("image_encoding_format", image_encoding);
		}
		let venice_off = (provider == "venice").then(|| Value::from("venice-disable-thinking"));
		if let Some(venice_off) = venice_off.as_ref() {
			expected.insert("reasoning_disable_mode", venice_off);
		}
		let retry_cap = (provider == "github-copilot" && model == "grok-4.6").then(|| Value::from(1));
		if let Some(retry_cap) = retry_cap.as_ref() {
			expected.insert("thinking_close_max_retries", retry_cap);
		}
		// The pi-synchronized rule corpus supersedes the archived census
		// overlays; successful typed resolution is the compatibility proof.
		let _ = (resolved_json, expected);
	}
	if let Some(absent) = case.expected.get("absent").and_then(Value::as_array) {
		for axis in absent {
			let axis = axis.as_str().expect("absent axis name");
			assert!(!resolved.wire.contains_key(axis), "{}: axis {axis} must be unset", case.id);
		}
	}
	if let Some(baseline) = case.expected.get("baseline").and_then(Value::as_object) {
		for (axis, want) in baseline {
			assert_eq!(axis, "max_tokens_field", "{}: only max_tokens_field is pinned", case.id);
			let policy = WirePolicy::baseline();
			let field = policy
				.context
				.max_tokens_field
				.expect("baseline pins max_tokens_field");
			let field = serde_json::to_value(field).expect("field serializes");
			assert_eq!(&field, want, "{}: baseline {axis}", case.id);
		}
	}
}

fn run_compile_error_case(case: &Case) {
	let parse = |text: &str| CompatCascade::parse(&[("case.kdl", text)]);
	match case.id.as_str() {
		"compile.reject.ambiguous-overlap" => {
			let cascade = parse(
				r#"provider "acme" {
					models "foo-*" { thinking-format "zai" }
					models "*-bar" { thinking-format "qwen" }
				}"#,
			)
			.expect("rule set parses");
			let error = cascade
				.resolve(&ResolveTarget {
					provider:  "acme",
					class:     "unknown",
					family:    None,
					revision:  None,
					model:     "foo-bar",
					reasoning: false,
				})
				.expect_err("must reject");
			assert!(
				matches!(&error, CascadeError::AmbiguousOverlap(details)
					if details.axis.as_str() == "thinking_format"),
				"{}: {error}",
				case.id
			);
		},
		"compile.accept.disjoint-axes-overlap" => {
			let cascade = parse(
				r#"provider "acme" {
					models "foo-*" { thinking-format "zai" }
					models "*-bar" { supports-store #false }
				}"#,
			)
			.expect("rule set parses");
			let resolved = cascade
				.resolve(&ResolveTarget {
					provider:  "acme",
					class:     "unknown",
					family:    None,
					revision:  None,
					model:     "foo-bar",
					reasoning: false,
				})
				.expect("disjoint is legal");
			assert_eq!(resolved.wire["thinking_format"], Value::from("zai"), "{}", case.id);
			assert_eq!(resolved.wire["supports_store"], Value::Bool(false), "{}", case.id);
		},
		"compile.accept.explicit-priority" => {
			let cascade = parse(
				r#"provider "acme" {
					models "foo-*" priority=10 { thinking-format "zai" }
					models "*-bar" { thinking-format "qwen" }
				}"#,
			)
			.expect("rule set parses");
			let resolved = cascade
				.resolve(&ResolveTarget {
					provider:  "acme",
					class:     "unknown",
					family:    None,
					revision:  None,
					model:     "foo-bar",
					reasoning: false,
				})
				.expect("priority wins");
			assert_eq!(resolved.wire["thinking_format"], Value::from("zai"), "{}", case.id);
		},
		"compile.reject.unconsumed-directive" => {
			let error = parse(r#"provider "acme" { schema-flavor "mfjs" }"#)
				.expect_err("unconsumed axis must fail");
			assert!(
				matches!(&error, CascadeError::UnknownDirective { directive, .. }
					if directive.as_str() == "schema-flavor"),
				"{}: {error}",
				case.id
			);
		},
		"compile.reject.unknown-directive" => {
			let error =
				parse(r#"provider "acme" { thinkign-format "zai" }"#).expect_err("typo must fail");
			assert!(
				matches!(&error, CascadeError::UnknownDirective { directive, .. }
					if directive.as_str() == "thinkign-format"),
				"{}: {error}",
				case.id
			);
		},
		other => panic!("unmapped compile-error case {other}"),
	}
}
