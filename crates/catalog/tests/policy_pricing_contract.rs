//! Contract tests for catalog policy compilation and pricing behavior.

use std::collections::BTreeMap;

use omp_catalog::{
	ApplyPatchWireKind, CatalogSource, ComputerUseConfigSupport, ComputerUseWireSupport,
	ExtendedContextMode, MaxOutputTokensEmission, NanoUsd, PremiumMultiplier, Price, PriceTier,
	PriceUnit, Pricing, ProvenanceKind, SourceModelRecord, SourceProviderRecord, ThinkingEffort,
	ThinkingMode, UsageDimensions, WirePolicy, compile,
};
use omp_core::sf;

fn source_provider() -> SourceProviderRecord {
	serde_json::from_str(
		r#"{
			"transport":"cursor",
			"base_url":"https://catalog-policy.example.test",
			"compat":{"supportsStore":false}
		}"#,
	)
	.expect("typed provider source")
}

fn source_model() -> SourceModelRecord {
	serde_json::from_str(
		r#"{
			"name":"Policy Fixture",
			"reasoning":true,
			"input":["text"],
			"output":["text"],
			"cost":{"input":0.000001,"output":0.000002},
			"contextWindow":1000000,
			"maxTokens":1000,
			"thinking":{
				"mode":"effort",
				"efforts":["low","high"],
				"effortRouting":{"low":"opaque-low","high":"opaque-high"}
			},
			"cursorMaxMode":true,
			"requestModelId":"opaque-default",
			"applyPatchToolType":"freeform",
			"supportsComputerUse":false,
			"supportsComputerUseConfig":false,
			"omitMaxOutputTokens":true
		}"#,
	)
	.expect("typed model source")
}

#[test]
fn compiler_preserves_policy_provenance_interning_extended_context_and_wire_routing() {
	let compiled = compile(CatalogSource {
		providers: BTreeMap::from([(sf!("cursor"), source_provider())]),
		models:    BTreeMap::from([(
			sf!("cursor"),
			BTreeMap::from([(sf!("gpt-5.1"), source_model())]),
		)]),
	})
	.expect("fixture catalog compiles");

	let model = compiled.models.first().expect("compiled model");
	let policy = compiled
		.wire_policies
		.iter()
		.find(|policy| policy.content_id() == model.wire_policy)
		.expect("model wire policy is interned by its content id");
	assert_eq!(policy.context.supports_store, None);
	assert_eq!(policy.context.extended_mode, Some(ExtendedContextMode::Extended));
	assert_eq!(policy.context.max_output_tokens, Some(MaxOutputTokensEmission::Omit),);
	assert_eq!(policy.tool.apply_patch, Some(ApplyPatchWireKind::Freeform));
	assert_eq!(policy.tool.computer_use, Some(ComputerUseWireSupport::Unsupported),);
	assert_eq!(policy.tool.computer_use_config, Some(ComputerUseConfigSupport::Unsupported),);
	assert_eq!(model.wire_ids[0].1.as_str(), "opaque-default");
	assert_eq!(model.thinking_routing.effort_routing[&ThinkingEffort::Low].as_str(), "opaque-low",);
	assert_eq!(model.thinking_routing.effort_routing[&ThinkingEffort::High].as_str(), "opaque-high",);
	assert_eq!(model.provenance.sources[0].kind, ProvenanceKind::Bundled);
	assert_eq!(model.provenance.sources[0].origin.as_str(), "catalog-oracle/models.json.zst",);

	let provider_policy = compiled
		.wire_policies
		.iter()
		.find(|candidate| candidate.context.supports_store == Some(false))
		.expect("provider default policy remains independently interned");
	assert_eq!(
		compiled.providers[0].wire_policy,
		provider_policy.content_id(),
		"provider record carries its independently interned default policy id",
	);
	assert_ne!(provider_policy.content_id(), policy.content_id());
	let encoded = policy.canonical_bytes();
	let decoded: WirePolicy = serde_json::from_slice(&encoded).expect("canonical policy round-trip");
	assert_eq!(decoded.content_id(), policy.content_id());
}

#[test]
fn baseten_kimi_k3_exposes_reasoning_with_max_as_the_default_effort() {
	let model: SourceModelRecord = serde_json::from_str(
		r#"{
			"name":"Kimi K3",
			"reasoning":false,
			"input":["text","image"],
			"output":["text"],
			"contextWindow":1048576,
			"maxTokens":262144
		}"#,
	)
	.expect("typed Baseten model source");
	let compiled = compile(CatalogSource {
		providers: BTreeMap::from([(sf!("baseten"), source_provider())]),
		models:    BTreeMap::from([(
			sf!("baseten"),
			BTreeMap::from([(sf!("moonshotai/Kimi-K3"), model)]),
		)]),
	})
	.expect("Baseten catalog compiles");
	let model = compiled.models.first().expect("compiled Kimi K3");
	let chat = model
		.capabilities
		.chat
		.as_ref()
		.expect("Kimi K3 chat capability");
	assert!(!chat.reasoning.is_unsupported(), "Kimi K3 advertises reasoning");
	let thinking_id = model.thinking.as_ref().expect("Kimi K3 thinking policy");
	let thinking = compiled
		.thinking_policies
		.iter()
		.find(|policy| policy.content_id() == *thinking_id)
		.expect("Kimi K3 thinking policy is interned");
	assert_eq!(thinking.mode, ThinkingMode::Effort);
	assert_eq!(thinking.efforts.as_slice(), [
		ThinkingEffort::Low,
		ThinkingEffort::High,
		ThinkingEffort::Max
	],);
	assert_eq!(thinking.default_level, Some(ThinkingEffort::Max));
}

#[test]
fn opencode_go_deepseek_v4_omits_tool_choice_without_hiding_tools() {
	let source = |name: &str| {
		serde_json::from_value::<SourceModelRecord>(serde_json::json!({
			"name": name,
			"reasoning": true,
			"supportsTools": true,
			"input": ["text"],
			"output": ["text"],
			"thinking": {
				"mode": "effort",
				"efforts": ["high"]
			}
		}))
		.expect("typed OpenCode model source")
	};
	let compiled = compile(CatalogSource {
		providers: BTreeMap::from([(sf!("opencode-go"), source_provider())]),
		models:    BTreeMap::from([(
			sf!("opencode-go"),
			BTreeMap::from([
				(sf!("deepseek-v4-flash"), source("DeepSeek V4 Flash")),
				(sf!("deepseek-v4-pro"), source("DeepSeek V4 Pro")),
			]),
		)]),
	})
	.expect("OpenCode Go catalog compiles");

	for key in ["opencode-go/deepseek-v4-flash", "opencode-go/deepseek-v4-pro"] {
		let model = compiled
			.models
			.iter()
			.find(|model| model.key.as_str() == key)
			.unwrap_or_else(|| panic!("compiled {key}"));
		let policy = compiled
			.wire_policies
			.iter()
			.find(|policy| policy.content_id() == model.wire_policy)
			.unwrap_or_else(|| panic!("{key} wire policy"));
		assert_eq!(policy.tool.supports_tool_choice, Some(false), "{key} tool_choice");
		let chat = model.capabilities.chat.as_ref().expect("chat capability");
		assert!(chat.tools.constraints().is_some(), "{key} still advertises tools");
	}
}

#[test]
fn xai_oauth_grok_45_and_46_default_to_mandatory_high_effort() {
	let source = |name: &str| {
		serde_json::from_value::<SourceModelRecord>(serde_json::json!({
			"name": name,
			"reasoning": true,
			"input": ["text", "image"],
			"output": ["text"],
			"thinking": {
				"mode": "effort",
				"efforts": ["minimal", "low", "medium", "high", "xhigh"]
			}
		}))
		.expect("typed xAI OAuth model source")
	};
	let compiled = compile(CatalogSource {
		providers: BTreeMap::from([(sf!("xai-oauth"), source_provider())]),
		models:    BTreeMap::from([(
			sf!("xai-oauth"),
			BTreeMap::from([
				(sf!("grok-4.5"), source("Grok 4.5")),
				(sf!("grok-4.6"), source("Grok 4.6")),
			]),
		)]),
	})
	.expect("xAI OAuth catalog compiles");

	// Grok 4.5's ladder is pinned by the frozen source row's legacy compat, so
	// only the mandatory-high default applies to it today; Grok 4.6 carries the
	// full corrected ladder for the next snapshot import.
	for (key, expected) in [
		(
			"xai-oauth/grok-4.5",
			&[
				ThinkingEffort::Minimal,
				ThinkingEffort::Low,
				ThinkingEffort::Medium,
				ThinkingEffort::High,
			][..],
		),
		(
			"xai-oauth/grok-4.6",
			&[
				ThinkingEffort::Minimal,
				ThinkingEffort::Low,
				ThinkingEffort::Medium,
				ThinkingEffort::High,
				ThinkingEffort::XHigh,
			][..],
		),
	] {
		let model = compiled
			.models
			.iter()
			.find(|model| model.key.as_str() == key)
			.unwrap_or_else(|| panic!("compiled {key}"));
		let thinking_id = model
			.thinking
			.as_ref()
			.unwrap_or_else(|| panic!("{key} thinking policy"));
		let thinking = compiled
			.thinking_policies
			.iter()
			.find(|policy| policy.content_id() == *thinking_id)
			.unwrap_or_else(|| panic!("{key} interned thinking policy"));
		assert_eq!(thinking.efforts.as_slice(), expected, "{key} efforts");
		assert_eq!(thinking.default_level, None, "{key} default");
		assert_eq!(thinking.requires_effort, None, "{key} optional effort");
		assert!(thinking.supports(ThinkingEffort::Off), "{key} has an off switch");
	}
	let grok_46 = compiled
		.models
		.iter()
		.find(|model| model.key.as_str() == "xai-oauth/grok-4.6")
		.expect("compiled grok-4.6");
	let grok_46_thinking = compiled
		.thinking_policies
		.iter()
		.find(|policy| policy.content_id() == *grok_46.thinking.as_ref().expect("grok-4.6 thinking"))
		.expect("grok-4.6 interned thinking policy");
	assert!(
		grok_46_thinking.supports(ThinkingEffort::Minimal),
		"grok-4.6 exposes the synchronized minimal tier"
	);
}

#[test]
fn integer_nano_usd_cost_is_exact_at_micro_usd_and_tier_boundaries() {
	let pricing =
		Pricing::new(vec![Price { unit: PriceUnit::MtokInput, nanos_usd: 1_000 }], vec![PriceTier {
			prompt_tokens_above: 1_000_000,
			components:          Box::new([Price {
				unit:      PriceUnit::MtokInput,
				nanos_usd: 2_000,
			}]),
		}])
		.expect("canonical pricing");

	assert_eq!(
		pricing
			.cost(UsageDimensions { input_tokens: 1_000_000, ..UsageDimensions::default() })
			.expect("base boundary"),
		NanoUsd::from_nanos(1_000),
	);
	assert_eq!(
		pricing
			.cost(UsageDimensions { input_tokens: 1_000_001, ..UsageDimensions::default() })
			.expect("extended tier boundary"),
		NanoUsd::from_nanos(2_001),
	);
	assert_eq!(
		PremiumMultiplier::from_millionths(500_000)
			.apply(NanoUsd::from_nanos(1))
			.expect("sub-nano result rounds upward"),
		NanoUsd::from_nanos(1),
	);
}
