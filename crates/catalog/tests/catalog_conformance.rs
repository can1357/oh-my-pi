//! Behavioral conformance against the frozen catalog oracle.

use std::{
	collections::{BTreeMap, BTreeSet},
	str::FromStr,
};

use omp_catalog::{
	OperationKind,
	capability::{Availability, ModalityBits},
	classify::{ClassificationInput, ClassificationPhase, EffortTier, classify},
	compile::{CompiledCatalog, compile_oracle},
	policy::{MaxTokensField, ReasoningDisableMode, ThinkingFormat, WirePolicy},
	pricing::{PriceUnit, UsageDimensions},
	provider::{
		AuthSpecKind, OAuthExchangeKind, OAuthFlowSpec, OAuthRefreshBehavior, OAuthSpec,
		PrincipalResolution,
	},
	snapshot::{Catalog, SnapshotProvenance},
	thinking::{ThinkingEffort, ThinkingMode, ThinkingPolicy},
};
use omp_core::SemVer;
use serde::Deserialize;

const CLASS_CASES: &str =
	include_str!("../../../fixtures/llm-oracle/catalog-policy/family-classifier.json");
const VERSION_CASES: &str =
	include_str!("../../../fixtures/llm-oracle/catalog-policy/openai-version-aliases.json");
const EFFORT_CASES: &str =
	include_str!("../../../fixtures/llm-oracle/catalog-policy/effort-tier-classifier.json");
const THINKING_PROFILES: &str =
	include_str!("../../../fixtures/llm-oracle/catalog-policy/thinking-profiles.json");
const COMPAT_PROFILES: &str =
	include_str!("../../../fixtures/llm-oracle/catalog-policy/compat-profiles.json");
const CATALOG_POSTCARD: &[u8] = include_bytes!("../data/catalog.postcard");
const PROVIDERS: &str = include_str!("../../../fixtures/llm-oracle/catalog/providers.toml");
const OAUTH: &str = include_str!("../../../fixtures/llm-oracle/catalog/oauth.toml");
const MODELS_ZSTD: &[u8] = include_bytes!("../../../fixtures/llm-oracle/catalog/models.json.zst");
const PRICE_CASES: &str =
	include_str!("../../../fixtures/llm-oracle/catalog-policy/aliases-tiers-and-deepseek.json");
const EXACT_OVERRIDES: &str =
	include_str!("../../../fixtures/llm-oracle/catalog-policy/exact-model-overrides.json");
const QWEN_COLLAPSE: &str =
	include_str!("../../../fixtures/llm-oracle/catalog-policy/qwen-collapse-cases.json");

const INFERRED_CURSOR_THINKING: &[(&str, &[ThinkingEffort])] = &[
	("cursor/claude-opus-5-thinking", &[ThinkingEffort::XHigh, ThinkingEffort::Max]),
	("cursor/cursor-grok-4.5", &[ThinkingEffort::Low, ThinkingEffort::Medium, ThinkingEffort::High]),
	("cursor/cursor-grok-4.5-fast", &[
		ThinkingEffort::Low,
		ThinkingEffort::Medium,
		ThinkingEffort::High,
	]),
	("cursor/gemini-3.6-flash", &[
		ThinkingEffort::Minimal,
		ThinkingEffort::Low,
		ThinkingEffort::Medium,
		ThinkingEffort::High,
	]),
	("cursor/glm-5.2", &[ThinkingEffort::High, ThinkingEffort::Max]),
	("cursor/gpt-5.4", &[
		ThinkingEffort::Low,
		ThinkingEffort::Medium,
		ThinkingEffort::High,
		ThinkingEffort::XHigh,
	]),
	("cursor/gpt-5.4-mini", &[
		ThinkingEffort::Low,
		ThinkingEffort::Medium,
		ThinkingEffort::High,
		ThinkingEffort::XHigh,
	]),
	("cursor/gpt-5.4-nano", &[
		ThinkingEffort::Low,
		ThinkingEffort::Medium,
		ThinkingEffort::High,
		ThinkingEffort::XHigh,
	]),
	("cursor/gpt-5.5", &[
		ThinkingEffort::Low,
		ThinkingEffort::Medium,
		ThinkingEffort::High,
		ThinkingEffort::XHigh,
	]),
	("cursor/gpt-5.6-luna", &[
		ThinkingEffort::Low,
		ThinkingEffort::Medium,
		ThinkingEffort::High,
		ThinkingEffort::XHigh,
		ThinkingEffort::Max,
	]),
	("cursor/gpt-5.6-sol", &[
		ThinkingEffort::Low,
		ThinkingEffort::Medium,
		ThinkingEffort::High,
		ThinkingEffort::XHigh,
		ThinkingEffort::Max,
	]),
	("cursor/gpt-5.6-terra", &[
		ThinkingEffort::Low,
		ThinkingEffort::Medium,
		ThinkingEffort::High,
		ThinkingEffort::XHigh,
		ThinkingEffort::Max,
	]),
];
const REVIEWED_THINKING_CORRECTIONS: &[(&str, &[ThinkingEffort])] = &[
	("aiand/deepseek-ai/deepseek-v4-pro", &[
		ThinkingEffort::Low,
		ThinkingEffort::High,
		ThinkingEffort::Max,
	]),
	("aimlapi/deepseek-v4-pro", &[ThinkingEffort::Low, ThinkingEffort::High, ThinkingEffort::Max]),
	("baseten/moonshotai/Kimi-K3", &[
		ThinkingEffort::Low,
		ThinkingEffort::High,
		ThinkingEffort::Max,
	]),
	("opencode-go/deepseek-v4-flash", &[
		ThinkingEffort::Low,
		ThinkingEffort::High,
		ThinkingEffort::Max,
	]),
];
const CURATED_THINKING_OVERRIDES: &[&str] =
	&["baseten/moonshotai/Kimi-K3", "nanogpt/linkup-research"];
/// Frozen-profile members whose compiled thinking intentionally gained a
/// mandatory default (#8369); the profile fixture predates the override.
const REVIEWED_THINKING_DEFAULTS: &[&str] = &["xai-oauth/grok-4.5"];

/// Effort-routed wire id for an inferred Cursor family. A `-fast`
/// service-tier lane wedges the effort before the lane token
/// (`cursor-grok-4.5-low-fast`); plain families append it.
fn cursor_effort_wire(base: &str, effort: ThinkingEffort) -> String {
	if base == "gpt-5.5" && effort == ThinkingEffort::XHigh {
		return "gpt-5.5-extra-high".to_owned();
	}
	match base.strip_suffix("-fast") {
		Some(stem) => format!("{stem}-{}-fast", effort.into_str()),
		None => format!("{base}-{}", effort.into_str()),
	}
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ClassCases {
	schema_version: u32,
	#[serde(rename = "unknown_family")]
	unknown_class:  String,
	cases:          Vec<ClassCase>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ClassCase {
	case_kind:      String,
	input:          String,
	#[serde(rename = "expected_family")]
	expected_class: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RevisionCases {
	schema_version:   u32,
	alias_provenance: String,
	cases:            Vec<RevisionCase>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct RevisionCase {
	case_kind:         String,
	input:             String,
	#[serde(rename = "expected_version")]
	expected_revision: Option<SemVer>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct EffortCases {
	schema_version: u32,
	collapse_minimum_tier_siblings: usize,
	synthetic_collapse: SyntheticCollapse,
	cases: Vec<EffortCase>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct EffortCase {
	input:    String,
	expected: Option<ExpectedEffort>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExpectedEffort {
	logical_model: String,
	tier:          FixtureEffort,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SyntheticCollapse {
	provider: String,
	inputs:   Vec<String>,
	expected: SyntheticCollapseExpected,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct SyntheticCollapseExpected {
	logical_model:  String,
	efforts:        Vec<FixtureEffort>,
	effort_routing: BTreeMap<FixtureEffort, String>,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd)]
#[serde(rename_all = "snake_case")]
enum FixtureEffort {
	Off,
	Minimal,
	Low,
	Medium,
	High,
	#[serde(alias = "xhigh")]
	XHigh,
	Max,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ThinkingProfiles {
	schema_version: u32,
	profile_count:  usize,
	normalization:  String,
	profiles:       Vec<ThinkingProfileCase>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ThinkingProfileCase {
	profile_id:  String,
	model_count: usize,
	models:      Vec<String>,
	shape:       ThinkingPolicy,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CompatProfiles {
	schema_version: u32,
	profile_count:  usize,
	normalization:  String,
	profiles:       Vec<CompatProfileCase>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct CompatProfileCase {
	profile_id:  String,
	model_count: usize,
	models:      Vec<String>,
	shape:       CompatShape,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct CompatShape {
	#[serde(rename = "wire/allows_synthetic_reasoning_content_for_tool_calls")]
	allows_synthetic_reasoning_content_for_tool_calls: Option<bool>,
	#[serde(rename = "wire/disable_adaptive_thinking")]
	disable_adaptive_thinking: Option<bool>,
	#[serde(rename = "wire/disable_reasoning_on_tool_choice")]
	disable_reasoning_on_tool_choice: Option<bool>,
	#[serde(rename = "wire/escape_builtin_tool_names")]
	escape_builtin_tool_names: Option<bool>,
	#[serde(rename = "wire/filter_reasoning_history")]
	filter_reasoning_history: Option<bool>,
	#[serde(rename = "wire/flatten_root_unions")]
	flatten_root_unions: Option<bool>,
	#[serde(rename = "wire/include_encrypted_reasoning")]
	include_encrypted_reasoning: Option<bool>,
	#[serde(rename = "wire/max_tokens_field")]
	max_tokens_field: Option<String>,
	#[serde(rename = "wire/official_endpoint")]
	official_endpoint: Option<bool>,
	#[serde(rename = "wire/omit_reasoning_effort")]
	omit_reasoning_effort: Option<bool>,
	#[serde(rename = "wire/reasoning_content_field")]
	reasoning_content_field: Option<String>,
	#[serde(rename = "wire/reasoning_disable_mode")]
	reasoning_disable_mode: Option<String>,
	#[serde(rename = "wire/reasoning_effort_map")]
	reasoning_effort_map: BTreeMap<FixtureEffort, String>,
	#[serde(rename = "wire/replay_unsigned_thinking")]
	replay_unsigned_thinking: Option<bool>,
	#[serde(rename = "wire/requires_assistant_content_for_tool_calls")]
	requires_assistant_content_for_tool_calls: Option<bool>,
	#[serde(rename = "wire/requires_reasoning_content_for_all_assistant_turns")]
	requires_reasoning_content_for_all_assistant_turns: Option<bool>,
	#[serde(rename = "wire/requires_reasoning_content_for_tool_calls")]
	requires_reasoning_content_for_tool_calls: Option<bool>,
	#[serde(rename = "wire/requires_thinking_enabled")]
	requires_thinking_enabled: Option<bool>,
	#[serde(rename = "wire/requires_tool_result_id")]
	requires_tool_result_id: Option<bool>,
	#[serde(rename = "wire/signing_endpoint")]
	signing_endpoint: Option<bool>,
	#[serde(rename = "wire/stream_idle_timeout_ms")]
	stream_idle_timeout_ms: Option<u64>,
	#[serde(rename = "wire/supports_developer_role")]
	supports_developer_role: Option<bool>,
	#[serde(rename = "wire/supports_eager_tool_input_streaming")]
	supports_eager_tool_input_streaming: Option<bool>,
	#[serde(rename = "wire/supports_forced_tool_choice")]
	supports_forced_tool_choice: Option<bool>,
	#[serde(rename = "wire/supports_image_detail_original")]
	supports_image_detail_original: Option<bool>,
	#[serde(rename = "wire/supports_long_cache_retention")]
	supports_long_cache_retention: Option<bool>,
	#[serde(rename = "wire/supports_mid_conversation_system")]
	supports_mid_conversation_system: Option<bool>,
	#[serde(rename = "wire/supports_reasoning_effort")]
	supports_reasoning_effort: Option<bool>,
	#[serde(rename = "wire/supports_reasoning_summary")]
	supports_reasoning_summary: Option<bool>,
	#[serde(rename = "wire/supports_sampling_params")]
	supports_sampling_params: Option<bool>,
	#[serde(rename = "wire/supports_store")]
	supports_store: Option<bool>,
	#[serde(rename = "wire/supports_tool_choice")]
	supports_tool_choice: Option<bool>,
	#[serde(rename = "wire/supports_usage_in_streaming")]
	supports_usage_in_streaming: Option<bool>,
	#[serde(rename = "wire/thinking_format")]
	thinking_format: Option<String>,
	#[serde(rename = "wire/extra_body")]
	extra_body: Option<omp_catalog::policy::ReasoningBodyOverride>,
	#[serde(rename = "wire/when_thinking")]
	when_thinking: Option<FixtureWhenThinking>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct FixtureWhenThinking {
	extra_body:      omp_catalog::policy::ReasoningBodyOverride,
	thinking_format: ThinkingFormat,
}

impl CompatShape {
	fn into_policy(self) -> WirePolicy {
		let mut policy = WirePolicy::overrides();
		policy.reasoning.allows_synthetic_content_for_tool_calls =
			self.allows_synthetic_reasoning_content_for_tool_calls;
		policy.reasoning.disable_adaptive = self.disable_adaptive_thinking;
		policy.tool.disable_reasoning_on_choice = self.disable_reasoning_on_tool_choice;
		policy.tool.escape_builtin_names = self.escape_builtin_tool_names;
		policy.reasoning.filter_history = self.filter_reasoning_history;
		policy.tool.flatten_root_unions = self.flatten_root_unions;
		policy.reasoning.include_encrypted = self.include_encrypted_reasoning;
		policy.context.max_tokens_field = self
			.max_tokens_field
			.map(|value| MaxTokensField::from_str(&value).expect("known fixture max-token field"));
		policy.reasoning.official_endpoint = self.official_endpoint;
		policy.reasoning.omit_effort = self.omit_reasoning_effort;
		policy.reasoning.content_field = self.reasoning_content_field.map(Into::into);
		policy.reasoning.disable_mode = self.reasoning_disable_mode.map(|value| {
			ReasoningDisableMode::from_str(&value).expect("known fixture reasoning disable mode")
		});
		policy.reasoning.effort_map = self
			.reasoning_effort_map
			.into_iter()
			.map(|(effort, value)| (ThinkingEffort::from(effort), value.into()))
			.collect();
		policy.reasoning.replay_unsigned = self.replay_unsigned_thinking;
		policy.tool.requires_assistant_content = self.requires_assistant_content_for_tool_calls;
		policy.reasoning.requires_content_for_all_assistant_turns =
			self.requires_reasoning_content_for_all_assistant_turns;
		policy.reasoning.requires_content_for_tool_calls =
			self.requires_reasoning_content_for_tool_calls;
		policy.reasoning.requires_enabled = self.requires_thinking_enabled;
		policy.tool.requires_result_id = self.requires_tool_result_id;
		policy.reasoning.signing_endpoint = self.signing_endpoint;
		policy.streaming.watchdog =
			self
				.stream_idle_timeout_ms
				.map(|idle_ms| omp_catalog::policy::StreamWatchdog {
					first_event_ms: None,
					idle_ms:        Some(idle_ms),
				});
		policy.role.supports_developer_role = self.supports_developer_role;
		policy.tool.eager_input_streaming = self.supports_eager_tool_input_streaming;
		policy.tool.forced_choice = self.supports_forced_tool_choice;
		policy.image.supports_detail_original = self.supports_image_detail_original;
		policy.cache.supports_long_retention = self.supports_long_cache_retention;
		policy.role.supports_mid_conversation_system = self.supports_mid_conversation_system;
		policy.reasoning.supports_effort = self.supports_reasoning_effort;
		policy.reasoning.supports_summary = self.supports_reasoning_summary;
		policy.structured.sampling_params = self.supports_sampling_params;
		policy.context.supports_store = self.supports_store;
		policy.tool.supports_tool_choice = self.supports_tool_choice;
		policy.usage.in_streaming = self.supports_usage_in_streaming;
		policy.reasoning.thinking_format = self
			.thinking_format
			.map(|value| ThinkingFormat::from_str(&value).expect("known fixture thinking format"));
		policy.reasoning.extra_body = self.extra_body;
		policy.reasoning.when_thinking =
			self
				.when_thinking
				.map(|value| omp_catalog::policy::WhenThinkingPolicy {
					extra_body: Some(value.extra_body),
					thinking_format: Some(value.thinking_format),
					requires_reasoning_content_for_tool_calls: None,
					allows_synthetic_reasoning_content_for_tool_calls: None,
					reasoning_content_field: None,
				});
		policy
	}
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PriceCases {
	schema_version:     u32,
	daybreak:           Vec<PriceModelCase>,
	long_context_tiers: Vec<PriceTierCase>,
	deepseek_efforts:   Vec<DeepseekEffortCase>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PriceModelCase {
	model:             String,
	context_window:    u64,
	max_output_tokens: u64,
	#[serde(rename = "openai_version")]
	openai_revision:   SemVer,
	pricing:           Vec<FixturePrice>,
	pricing_tiers:     Vec<FixtureTier>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct PriceTierCase {
	model:         String,
	pricing_tiers: Vec<FixtureTier>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct FixtureTier {
	prompt_tokens_above: u64,
	pricing:             Vec<FixturePrice>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExactOverrides {
	schema_version:    u32,
	source_assertions: String,
	cases:             Vec<ExactOverrideCase>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExactOverrideCase {
	model:      String,
	expected:   ExactExpected,
	rationale:  String,
	provenance: String,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct QwenCases {
	schema_version: u32,
	cases:          Vec<QwenCase>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct QwenCase {
	provider:              String,
	inputs:                Vec<String>,
	absent_after_collapse: String,
	expected_logical:      QwenLogical,
	rationale:             String,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct ExactExpected {
	apply_patch_tool_type: Option<String>,
	thinking: Option<ExactThinking>,
	headers: BTreeMap<String, String>,
	premium_multiplier: Option<f64>,
	compat: Option<ExactCompat>,
	supports_computer_use: Option<bool>,
	supports_tools: Option<bool>,
	context_promotion_target: Option<String>,
	prefer_websockets: Option<bool>,
	priority: Option<u32>,
	remote_compaction: Option<ExactRemoteCompaction>,
	request_model_id: Option<String>,
	omit_max_output_tokens: Option<bool>,
	supports_computer_use_config: Option<bool>,
	use_responses_lite: Option<bool>,
	reasoning_mode: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct ExactThinking {
	mode:              String,
	efforts:           Vec<FixtureEffort>,
	#[serde(default)]
	default_level:     Option<FixtureEffort>,
	#[serde(default)]
	effort_budgets:    BTreeMap<FixtureEffort, u64>,
	#[serde(default)]
	effort_routing:    BTreeMap<FixtureEffort, String>,
	#[serde(default)]
	suppress_when_off: Option<bool>,
}

#[derive(Debug, Default, Deserialize)]
#[serde(default, deny_unknown_fields)]
struct ExactCompat {
	#[serde(rename = "wire/thinking_format")]
	thinking_format: Option<String>,
	#[serde(rename = "wire/requires_reasoning_content_for_all_assistant_turns")]
	requires_reasoning_content_for_all_assistant_turns: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct ExactRemoteCompaction {
	enabled:              bool,
	transport:            String,
	v2_streaming_enabled: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct QwenLogical {
	model:          String,
	efforts:        Vec<FixtureEffort>,
	effort_routing: BTreeMap<FixtureEffort, String>,
	thinking:       QwenThinking,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QwenThinking {
	mode:            String,
	efforts:         Vec<FixtureEffort>,
	effort_routing:  BTreeMap<FixtureEffort, String>,
	requires_effort: bool,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct FixturePrice {
	unit:      PriceUnit,
	nanos_usd: u64,
}

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
struct DeepseekEffortCase {
	model:   String,
	efforts: Vec<FixtureEffort>,
}

impl From<FixtureEffort> for EffortTier {
	fn from(value: FixtureEffort) -> Self {
		match value {
			FixtureEffort::Off => Self::Off,
			FixtureEffort::Minimal => Self::Minimal,
			FixtureEffort::Low => Self::Low,
			FixtureEffort::Medium => Self::Medium,
			FixtureEffort::High => Self::High,
			FixtureEffort::XHigh => Self::XHigh,
			FixtureEffort::Max => Self::Max,
		}
	}
}

impl From<FixtureEffort> for ThinkingEffort {
	fn from(value: FixtureEffort) -> Self {
		match value {
			FixtureEffort::Off => Self::Off,
			FixtureEffort::Minimal => Self::Minimal,
			FixtureEffort::Low => Self::Low,
			FixtureEffort::Medium => Self::Medium,
			FixtureEffort::High => Self::High,
			FixtureEffort::XHigh => Self::XHigh,
			FixtureEffort::Max => Self::Max,
		}
	}
}

fn compiler_classification(model: &str) -> omp_catalog::classify::ModelClassification {
	classify(ClassificationInput {
		phase: ClassificationPhase::CatalogCompiler,
		provider: "fixture",
		model,
		observed_at_ms: None,
	})
}

#[test]
fn class_classifier_matches_all_canonical_and_adversarial_cases() {
	let fixture: ClassCases = serde_json::from_str(CLASS_CASES).expect("class fixture is valid");
	assert_eq!(fixture.schema_version, 1);
	assert_eq!(
		fixture
			.cases
			.iter()
			.map(|case| case.case_kind.as_str())
			.collect::<BTreeSet<_>>(),
		BTreeSet::from(["adversarial_near_match_or_unknown", "canonical"]),
		"fixture must preserve both positive and negative coverage"
	);

	for case in fixture.cases {
		let actual = compiler_classification(&case.input);
		let expected = if case.expected_class == fixture.unknown_class {
			"unknown"
		} else {
			case.expected_class.as_str()
		};
		assert_eq!(actual.class.as_str(), expected, "class classification for {:?}", case.input);
	}
}

#[test]
fn openai_revisions_match_alias_canonical_and_adversarial_cases() {
	let fixture: RevisionCases =
		serde_json::from_str(VERSION_CASES).expect("revision fixture is valid");
	assert_eq!(fixture.schema_version, 1);
	assert_ne!(fixture.alias_provenance, "");
	assert_eq!(fixture.cases.len(), 16);

	for case in fixture.cases {
		let actual = compiler_classification(&case.input);
		assert_eq!(
			actual.revision, case.expected_revision,
			"{} case {:?}",
			case.case_kind, case.input
		);
	}
}

#[test]
fn effort_suffix_classification_matches_every_boundary_case() {
	let fixture: EffortCases = serde_json::from_str(EFFORT_CASES).expect("effort fixture is valid");
	assert_eq!(fixture.schema_version, 1);
	assert_eq!(fixture.collapse_minimum_tier_siblings, 2);
	assert_eq!(fixture.synthetic_collapse.inputs.len(), 3);
	assert_eq!(fixture.synthetic_collapse.expected.efforts.len(), 3);
	assert_eq!(fixture.synthetic_collapse.expected.effort_routing.len(), 3);
	assert_eq!(fixture.synthetic_collapse.provider, "devin");
	assert_eq!(fixture.synthetic_collapse.expected.logical_model, "gpt-5.6-luna");

	for case in fixture.cases {
		let actual = compiler_classification(&case.input);
		match case.expected {
			Some(expected) => {
				assert_eq!(
					actual.logical_model.as_str(),
					expected.logical_model,
					"logical model for {:?}",
					case.input
				);
				assert_eq!(
					actual.effort,
					Some(expected.tier.into()),
					"effort tier for {:?}",
					case.input
				);
			},
			None => assert_eq!(actual.effort, None, "unexpected effort tier for {:?}", case.input),
		}
	}
}

fn compile_frozen_oracle() -> CompiledCatalog {
	compile_oracle(PROVIDERS, MODELS_ZSTD, OAUTH).expect("frozen catalog oracle compiles")
}
fn provider_oauth<'a>(compiled: &'a CompiledCatalog, provider_id: &str) -> &'a OAuthSpec {
	let provider = compiled
		.providers
		.iter()
		.find(|provider| provider.id == provider_id)
		.expect("provider");
	let auth = compiled
		.auth_specs
		.iter()
		.find(|auth| Some(&auth.id) == provider.auth.first())
		.expect("preferred auth");
	assert_eq!(auth.kind, AuthSpecKind::Oauth, "{provider_id} preferred auth");
	let oauth_id = auth.oauth.as_ref().expect("OAuth link");
	compiled
		.oauth_specs
		.iter()
		.find(|oauth| &oauth.id == oauth_id)
		.expect("OAuth spec")
}
fn advertised_oauth<'a>(compiled: &'a CompiledCatalog, provider_id: &str) -> &'a OAuthSpec {
	let provider = compiled
		.providers
		.iter()
		.find(|provider| provider.id == provider_id)
		.expect("provider");
	let oauth_id = provider
		.auth
		.iter()
		.filter_map(|id| compiled.auth_specs.iter().find(|auth| &auth.id == id))
		.find_map(|auth| auth.oauth.as_ref())
		.expect("advertised OAuth login");
	compiled
		.oauth_specs
		.iter()
		.find(|oauth| &oauth.id == oauth_id)
		.expect("OAuth spec")
}

#[test]
fn interactive_oauth_contracts_preserve_provider_parameters_and_identity() {
	let compiled = compile_frozen_oracle();
	let kimi = provider_oauth(&compiled, "kimi-code");
	assert_eq!(kimi.client_id, "17e5f671-d194-4dfb-9706-5516cb48c098");
	assert!(matches!(
		&kimi.principal_resolution,
		Some(PrincipalResolution::AccessTokenClaims { claims })
			if claims.iter().map(|claim| claim.as_str()).eq(["user_id", "sub"])
	));

	let google = provider_oauth(&compiled, "google-gemini-cli");
	assert_eq!(
		google
			.token_parameters
			.iter()
			.find(|parameter| parameter.name == "client_secret")
			.map(|parameter| parameter.value.as_str()),
		Some("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")
	);
	let OAuthFlowSpec::Custom { exchange, parameters, polling, .. } = &google.flow else {
		panic!("Google login must use the Gemini CLI project-discovery exchange");
	};
	assert_eq!(*exchange, OAuthExchangeKind::GoogleGeminiCli);
	assert!(polling.is_none());
	assert!(
		parameters
			.iter()
			.any(|parameter| { parameter.name == "access_type" && parameter.value == "offline" })
	);
	assert!(parameters.iter().any(|parameter| {
		parameter.name == "redirect_uri" && parameter.value == "http://127.0.0.1:8085/oauth2callback"
	}));
	assert!(
		!google
			.token_parameters
			.iter()
			.any(|parameter| parameter.name == "access_type")
	);

	let openrouter = advertised_oauth(&compiled, "openrouter");
	let OAuthFlowSpec::Custom { authorize_url, exchange, parameters, polling } = &openrouter.flow
	else {
		panic!("OpenRouter login must use its custom PKCE key-provisioning flow");
	};
	assert_eq!(authorize_url, "https://openrouter.ai/auth");
	assert_eq!(*exchange, OAuthExchangeKind::OpenRouterApiKey);
	assert!(polling.is_none());
	assert!(parameters.iter().any(|parameter| {
		parameter.name == "redirect_uri" && parameter.value == "http://localhost:54549/callback"
	}));
	assert!(parameters.iter().any(|parameter| {
		parameter.name == "key_info_url" && parameter.value == "https://openrouter.ai/api/v1/auth/key"
	}));

	for provider in ["openai-codex", "github-copilot", "xai-oauth", "gitlab-duo"] {
		assert!(
			provider_oauth(&compiled, provider)
				.principal_resolution
				.is_some(),
			"{provider} principal resolution"
		);
	}
}

const fn all_operations() -> [OperationKind; 16] {
	[
		OperationKind::Chat,
		OperationKind::CountTokens,
		OperationKind::Tokenize,
		OperationKind::Detokenize,
		OperationKind::Embed,
		OperationKind::GenerateImage,
		OperationKind::GenerateVideo,
		OperationKind::Speak,
		OperationKind::Transcribe,
		OperationKind::Realtime,
		OperationKind::Search,
		OperationKind::Usage,
		OperationKind::DiscoverModels,
		OperationKind::Auth,
		OperationKind::Native,
		OperationKind::Extract,
	]
}

fn oracle_codec(transport: &str) -> &'static str {
	match transport {
		"anthropic-messages" => "anthropic",
		"bedrock-converse" => "bedrock-converse",
		"cursor" => "cursor",
		"devin" => "devin",
		"gitlab-duo-workflow" => "gitlab-duo",
		"google-cca" => "google-cca",
		"google-gen-ai" => "google-genai",
		"google-vertex" => "google-vertex",
		"embedded" => "local",
		"ollama-chat" => "ollama",
		"open-ai-chat" => "openai-chat",
		"open-ai-codex" => "openai-codex",
		"open-ai-responses" => "openai-responses",
		other => panic!("inactive or unknown normalized transport {other}"),
	}
}

#[test]
fn regeneration_is_structurally_and_byte_deterministic() {
	let first = compile_frozen_oracle();
	let second = compile_frozen_oracle();
	assert_eq!(first, second);
	assert_eq!(
		first.normalized_json().expect("first normalized output"),
		second.normalized_json().expect("second normalized output")
	);
}

#[test]
fn price_schedules_limits_and_long_context_tiers_match_exact_integer_oracle_values() {
	let fixture: PriceCases = serde_json::from_str(PRICE_CASES).expect("price fixture is valid");
	let compiled = compile_frozen_oracle();
	assert_eq!(fixture.schema_version, 1);
	assert_eq!(fixture.daybreak.len(), 3);
	assert_eq!(fixture.long_context_tiers.len(), 3);
	assert_eq!(fixture.deepseek_efforts.len(), 6);

	for case in fixture.daybreak {
		let key = format!("openai/{}", case.model);
		let model = compiled
			.models
			.iter()
			.find(|model| model.key.as_str() == key)
			.unwrap_or_else(|| panic!("missing price fixture model {key}"));
		assert_eq!(model.limits.context_window, Some(case.context_window), "{key}");
		assert_eq!(model.limits.maximum_output_tokens, Some(case.max_output_tokens), "{key}");
		assert_eq!(
			compiler_classification(&case.model).revision,
			Some(case.openai_revision),
			"{key} revision"
		);
		assert_eq!(
			model
				.pricing
				.components
				.iter()
				.map(|price| (price.unit, price.nanos_usd))
				.collect::<Vec<_>>(),
			case
				.pricing
				.iter()
				.map(|price| (price.unit, price.nanos_usd))
				.collect::<Vec<_>>(),
			"{key} base prices"
		);
		assert_eq!(model.pricing.tiers.len(), case.pricing_tiers.len(), "{key} tiers");
	}

	for case in fixture.long_context_tiers {
		let key = format!("openai/{}", case.model);
		let model = compiled
			.models
			.iter()
			.find(|model| model.key.as_str() == key)
			.unwrap_or_else(|| panic!("missing tier fixture model {key}"));
		for tier in case.pricing_tiers {
			let actual = model
				.pricing
				.tiers
				.iter()
				.find(|candidate| candidate.prompt_tokens_above == tier.prompt_tokens_above)
				.unwrap_or_else(|| {
					panic!("missing {} threshold {}", case.model, tier.prompt_tokens_above)
				});
			assert_eq!(
				actual
					.components
					.iter()
					.map(|price| (price.unit, price.nanos_usd))
					.collect::<Vec<_>>(),
				tier
					.pricing
					.iter()
					.map(|price| (price.unit, price.nanos_usd))
					.collect::<Vec<_>>()
			);
			let at_threshold = model
				.pricing
				.cost(UsageDimensions {
					input_tokens: tier.prompt_tokens_above,
					..UsageDimensions::default()
				})
				.expect("threshold cost");
			let above_threshold = model
				.pricing
				.cost(UsageDimensions {
					input_tokens: tier.prompt_tokens_above + 1,
					..UsageDimensions::default()
				})
				.expect("tier cost");
			assert_ne!(at_threshold, above_threshold, "{} tier boundary", case.model);
		}
	}
	for case in fixture.deepseek_efforts {
		let key = format!("ollama-cloud/{}", case.model);
		let model = compiled
			.models
			.iter()
			.find(|model| model.key.as_str() == key)
			.unwrap_or_else(|| panic!("missing DeepSeek effort fixture model {key}"));
		let policy = model
			.thinking
			.as_ref()
			.and_then(|id| {
				compiled
					.thinking_policies
					.iter()
					.find(|policy| policy.content_id() == *id)
			})
			.unwrap_or_else(|| panic!("{key} has no interned thinking policy"));
		let mut expected = case
			.efforts
			.iter()
			.copied()
			.map(Into::into)
			.collect::<Vec<_>>();
		if case.model.starts_with("deepseek-v4") && !expected.contains(&ThinkingEffort::Low) {
			expected.insert(0, ThinkingEffort::Low);
		}
		assert_eq!(policy.efforts.as_slice(), expected, "{key} efforts");
	}
}

#[test]
fn exact_override_rows_and_qwen_collapses_remain_present_and_auditable() {
	let exact: ExactOverrides =
		serde_json::from_str(EXACT_OVERRIDES).expect("exact override fixture is valid");
	let qwen: QwenCases =
		serde_json::from_str(QWEN_COLLAPSE).expect("Qwen collapse fixture is valid");
	let compiled = compile_frozen_oracle();
	assert_eq!(exact.schema_version, 1);
	assert_eq!(exact.cases.len(), 10);
	assert_ne!(exact.source_assertions, "");
	for case in exact.cases {
		let model = compiled
			.models
			.iter()
			.find(|model| model.key.as_str() == case.model)
			.or_else(|| {
				compiled
					.aliases
					.iter()
					.find(|alias| alias.alias.as_str() == case.model)
					.and_then(|alias| {
						compiled
							.models
							.iter()
							.find(|model| model.key == alias.target)
					})
			})
			.unwrap_or_else(|| panic!("missing exact override or alias {}", case.model));
		assert!(!case.rationale.is_empty(), "{} lacks rationale", case.model);
		assert!(!case.provenance.is_empty(), "{} lacks provenance", case.model);
		let expected_thinking = case
			.expected
			.thinking
			.as_ref()
			.expect("exact thinking behavior");
		let mut expected_efforts = REVIEWED_THINKING_CORRECTIONS
			.iter()
			.find_map(|(key, efforts)| (*key == case.model).then_some(efforts.to_vec()))
			.unwrap_or_else(|| {
				expected_thinking
					.efforts
					.iter()
					.copied()
					.map(Into::into)
					.collect()
			});
		if case.model == "xai-oauth/grok-4.5" {
			expected_efforts.retain(|effort| *effort != ThinkingEffort::XHigh);
		}
		let actual_thinking = model
			.thinking
			.as_ref()
			.and_then(|id| {
				compiled
					.thinking_policies
					.iter()
					.find(|policy| policy.content_id() == *id)
			})
			.unwrap_or_else(|| panic!("{} exact thinking policy", case.model));
		assert_eq!(
			actual_thinking.mode,
			ThinkingMode::from_str(&expected_thinking.mode).expect("known exact thinking mode"),
			"{} thinking mode",
			case.model
		);
		assert_eq!(
			actual_thinking.efforts.as_slice(),
			expected_efforts.as_slice(),
			"{} thinking efforts",
			case.model
		);
		let expected_default = if case.model == "xai-oauth/grok-4.5" {
			None
		} else {
			expected_thinking.default_level.map(Into::into)
		};
		assert_eq!(
			actual_thinking.default_level, expected_default,
			"{} default thinking effort",
			case.model
		);
		assert_eq!(
			actual_thinking.effort_budgets,
			expected_thinking
				.effort_budgets
				.iter()
				.map(|(effort, budget)| ((*effort).into(), *budget))
				.collect(),
			"{} thinking budgets",
			case.model
		);
		assert_eq!(
			actual_thinking.suppress_when_off, expected_thinking.suppress_when_off,
			"{} thinking-off suppression",
			case.model
		);
		if compiled
			.models
			.iter()
			.any(|model| model.key.as_str() == case.model)
		{
			assert_eq!(
				model
					.thinking_routing
					.effort_routing
					.iter()
					.map(|(effort, route)| (*effort, route.as_str()))
					.collect::<BTreeMap<_, _>>(),
				expected_thinking
					.effort_routing
					.iter()
					.map(|(effort, route)| ((*effort).into(), route.as_str()))
					.collect(),
				"{} thinking effort routing",
				case.model
			);
		}
		if !compiled
			.models
			.iter()
			.any(|model| model.key.as_str() == case.model)
		{
			continue;
		}
		if let Some(target) = &case.expected.context_promotion_target {
			assert_eq!(
				model
					.context_promotion_target
					.as_ref()
					.map(|key| key.as_str()),
				Some(target.as_str()),
				"{} context promotion target",
				case.model
			);
		}
		if let Some(multiplier) = case.expected.premium_multiplier {
			assert_eq!(
				model
					.premium_multiplier_millionths
					.map(|value| value.as_millionths()),
				Some((multiplier * 1_000_000.0).round() as u64),
				"{} premium multiplier",
				case.model
			);
		}
		if let Some(reasoning_mode) = &case.expected.reasoning_mode {
			assert_eq!(
				model
					.thinking_routing
					.reasoning_mode
					.map(|mode| mode.to_string()),
				Some(reasoning_mode.clone()),
				"{} reasoning mode",
				case.model
			);
		}
		if let Some(expected) = &case.expected.remote_compaction {
			let actual = model
				.remote_compaction
				.as_ref()
				.expect("exact remote compaction");
			assert_eq!(
				actual.enabled,
				Some(expected.enabled),
				"{} remote compaction enabled",
				case.model
			);
			assert_eq!(
				actual
					.transport
					.as_ref()
					.map(|transport| transport.as_str()),
				Some(oracle_codec(&expected.transport)),
				"{} remote compaction codec",
				case.model
			);
			assert_eq!(
				actual.v2_streaming_enabled,
				Some(expected.v2_streaming_enabled),
				"{} remote compaction v2 streaming",
				case.model
			);
		}
		if let Some(request_model) = &case.expected.request_model_id {
			assert!(
				model
					.wire_ids
					.iter()
					.any(|(_, wire_model)| wire_model.as_str() == request_model),
				"{} request model id",
				case.model
			);
		}
		if let Some(supports_tools) = case.expected.supports_tools {
			let chat = model
				.capabilities
				.chat
				.as_ref()
				.expect("exact chat capabilities");
			assert_eq!(
				chat.tools.constraints().is_some(),
				supports_tools,
				"{} tool support",
				case.model
			);
		}

		let routes = model
			.routes
			.iter()
			.map(|route_id| {
				compiled
					.routes
					.iter()
					.find(|route| route.id == *route_id)
					.expect("exact model route")
			})
			.collect::<Vec<_>>();
		if let Some(prefer_websockets) = case.expected.prefer_websockets {
			assert!(
				routes.iter().any(|route| {
					(route.codex_transport
						== omp_catalog::provider::CodexTransportPreference::WebsocketPreferred)
						== prefer_websockets
				}),
				"{} websocket preference",
				case.model
			);
		}
		if let Some(use_responses_lite) = case.expected.use_responses_lite {
			assert!(
				routes
					.iter()
					.any(|route| route.use_responses_lite == Some(use_responses_lite)),
				"{} responses-lite",
				case.model
			);
		}
		if let Some(priority) = case.expected.priority {
			assert!(
				routes.iter().any(|route| route.priority == Some(priority)),
				"{} route priority",
				case.model
			);
		}
		if !case.expected.headers.is_empty() {
			let expected_headers = case
				.expected
				.headers
				.iter()
				.map(|(name, value)| (name.to_ascii_lowercase(), value.as_str()))
				.collect::<BTreeMap<_, _>>();
			assert!(
				routes.iter().any(|route| {
					compiled
						.header_profiles
						.iter()
						.find(|profile| profile.id == route.headers)
						.is_some_and(|profile| {
							profile
								.headers
								.iter()
								.map(|header| (header.name.as_str().to_owned(), header.value.as_str()))
								.collect::<BTreeMap<_, _>>()
								== expected_headers
						})
				}),
				"{} exact headers",
				case.model
			);
		}
	}

	assert_eq!(qwen.schema_version, 1);
	assert_eq!(qwen.cases.len(), 2);
	for case in qwen.cases {
		assert_eq!(case.inputs.len(), 2);
		assert_ne!(case.rationale, "");
		let logical = case.expected_logical.model.as_str();
		assert_eq!(case.expected_logical.efforts.len(), 4);
		assert_eq!(case.expected_logical.effort_routing.len(), 5);
		assert_eq!(case.expected_logical.thinking.efforts.len(), 4);
		assert_eq!(case.expected_logical.thinking.effort_routing.len(), 5);
		assert!(case.expected_logical.thinking.requires_effort);
		assert_eq!(case.expected_logical.thinking.mode, "effort");
		let key = format!("{}/{}", case.provider, logical);
		let model = compiled
			.models
			.iter()
			.find(|model| model.key.as_str() == key)
			.unwrap_or_else(|| panic!("missing collapsed {key}"));
		let thinking = model
			.thinking
			.as_ref()
			.and_then(|id| {
				compiled
					.thinking_policies
					.iter()
					.find(|policy| policy.content_id() == *id)
			})
			.unwrap_or_else(|| panic!("{key} thinking policy is missing"));
		assert_eq!(
			thinking.mode,
			ThinkingMode::from_str(&case.expected_logical.thinking.mode)
				.expect("known Qwen thinking mode"),
			"{key} thinking mode"
		);
		assert_eq!(
			thinking.efforts.as_slice(),
			case
				.expected_logical
				.thinking
				.efforts
				.iter()
				.copied()
				.map(Into::into)
				.collect::<Vec<_>>(),
			"{key} thinking efforts"
		);
		assert_eq!(thinking.requires_effort, None, "{key} optional effort");
		assert_eq!(
			model
				.thinking_routing
				.effort_routing
				.iter()
				.map(|(effort, wire)| (*effort, wire.as_str()))
				.collect::<BTreeMap<_, _>>(),
			case
				.expected_logical
				.effort_routing
				.iter()
				.map(|(effort, wire)| ((*effort).into(), wire.as_str()))
				.collect(),
			"{key} effort routing"
		);
		assert_eq!(
			model
				.wire_ids
				.iter()
				.map(|(_, wire)| wire.as_str())
				.collect::<BTreeSet<_>>(),
			case.inputs.iter().map(String::as_str).collect(),
			"{key} collapsed wire inputs"
		);
		let absent = format!("{}/{}", case.provider, case.absent_after_collapse);
		assert!(
			!compiled
				.models
				.iter()
				.any(|model| model.key.as_str() == absent),
			"uncollapsed sibling {absent}"
		);
		let alias = compiled
			.aliases
			.iter()
			.find(|alias| alias.alias.as_str() == absent)
			.unwrap_or_else(|| panic!("collapsed sibling alias {absent} is missing"));
		assert_eq!(alias.target.as_str(), key, "{absent} alias target");
	}
}

#[test]
fn cursor_effort_suffixes_compile_to_routable_thinking_profiles() {
	let compiled = compile_frozen_oracle();
	for &(key, efforts) in INFERRED_CURSOR_THINKING {
		let model = compiled
			.models
			.iter()
			.find(|model| model.key.as_str() == key)
			.unwrap_or_else(|| panic!("missing inferred Cursor model {key}"));
		let policy = model
			.thinking
			.as_ref()
			.and_then(|id| {
				compiled
					.thinking_policies
					.iter()
					.find(|policy| policy.content_id() == *id)
			})
			.unwrap_or_else(|| panic!("{key} has no inferred thinking policy"));

		assert_eq!(policy.mode, ThinkingMode::Effort, "{key} mode");
		assert_eq!(policy.efforts.as_slice(), efforts, "{key} efforts");
		assert!(
			policy
				.default_level
				.is_some_and(|default| efforts.contains(&default)),
			"{key} default effort"
		);
		assert_eq!(policy.requires_effort, Some(true), "{key} required effort");
		assert_eq!(model.thinking_routing.effort_routing.len(), efforts.len(), "{key} routes");
		let wire = key.strip_prefix("cursor/").expect("Cursor model key");
		for effort in efforts {
			let expected = cursor_effort_wire(wire, *effort);
			assert_eq!(
				model.thinking_routing.effort_routing[effort].as_str(),
				expected,
				"{key} {effort} route"
			);
		}
	}
}

#[test]
fn cursor_grok_fast_lane_collapses_into_one_logical_model_with_aliases() {
	// Cursor's `-fast` service-tier siblings collapse into one logical model per
	// lane; each collapsed wire id survives as an alias and
	// never as its own catalog listing.
	let compiled = compile_frozen_oracle();
	let key = "cursor/cursor-grok-4.5-fast";
	let model = compiled
		.models
		.iter()
		.find(|model| model.key.as_str() == key)
		.expect("collapsed Cursor Grok fast lane is compiled");
	assert_eq!(model.display_name.as_str(), "Cursor Grok 4.5 Fast");
	for sibling in [
		"cursor/cursor-grok-4.5-low-fast",
		"cursor/cursor-grok-4.5-medium-fast",
		"cursor/cursor-grok-4.5-high-fast",
	] {
		assert!(
			!compiled
				.models
				.iter()
				.any(|model| model.key.as_str() == sibling),
			"uncollapsed sibling {sibling}"
		);
		let alias = compiled
			.aliases
			.iter()
			.find(|alias| alias.alias.as_str() == sibling)
			.unwrap_or_else(|| panic!("collapsed sibling alias {sibling} is missing"));
		assert_eq!(alias.target.as_str(), key, "{sibling} alias target");
	}
	// The standard lane keeps its own logical model: the lane is a sibling
	// family, never a second routing dimension.
	assert!(
		compiled
			.models
			.iter()
			.any(|model| model.key.as_str() == "cursor/cursor-grok-4.5"),
		"standard lane stays collapsed separately"
	);
}

#[test]
fn xai_and_opencode_go_models_use_current_provider_transports() {
	let compiled = compile_frozen_oracle();
	let xai_models = compiled
		.models
		.iter()
		.filter(|model| model.key.as_str().starts_with("xai/"))
		.collect::<Vec<_>>();
	assert!(!xai_models.is_empty());
	for model in xai_models {
		for route_id in &model.routes {
			let route = compiled
				.routes
				.iter()
				.find(|route| &route.id == route_id)
				.expect("xAI model route");
			assert_eq!(route.codec.as_str(), "openai-responses", "{} codec", model.key);
		}
	}

	for name in ["qwen3.7-max", "qwen3.7-plus", "qwen3.8-max"] {
		let key = format!("opencode-go/{name}");
		let model = compiled
			.models
			.iter()
			.find(|model| model.key.as_str() == key)
			.unwrap_or_else(|| panic!("missing current OpenCode Go row {key}"));
		let route = compiled
			.routes
			.iter()
			.find(|route| model.routes.contains(&route.id))
			.expect("OpenCode Go model route");
		assert_eq!(route.codec.as_str(), "openai-chat", "{key} codec");
		assert_eq!(route.endpoint.base_url.as_str(), "https://opencode.ai/zen/go/v1");
	}
}

#[test]
fn vercel_muse_contributor_caps_output_below_context() {
	let compiled = compile_frozen_oracle();
	let model = compiled
		.models
		.iter()
		.find(|model| model.key.as_str() == "vercel-ai-gateway/meta/muse-spark-1.2-contributor")
		.expect("Vercel Muse contributor row");
	assert_eq!(model.limits.context_window, Some(1_048_576));
	assert_eq!(model.limits.maximum_output_tokens, Some(131_072));
}

#[test]
fn zai_glm_53_flash_has_native_image_input_and_list_pricing() {
	let compiled = compile_frozen_oracle();
	let model = compiled
		.models
		.iter()
		.find(|model| model.key.as_str() == "zai/glm-5.3-flash")
		.expect("Z.AI GLM-5.3-Flash row");
	assert_eq!(model.limits.context_window, Some(1_000_000));
	assert_eq!(model.limits.maximum_output_tokens, Some(131_072));
	assert!(matches!(
		model.capabilities.chat.as_ref().map(|chat| &chat.input_modalities),
		Some(Availability::Native(modalities)) if modalities.contains(ModalityBits::IMAGE)
	));
	assert_eq!(
		model
			.pricing
			.components
			.iter()
			.map(|price| (price.unit, price.nanos_usd))
			.collect::<Vec<_>>(),
		[
			(PriceUnit::MtokInput, 150_000_000),
			(PriceUnit::MtokOutput, 500_000_000),
			(PriceUnit::MtokCacheRead, 30_000_000),
			(PriceUnit::MtokCacheWrite, 0),
		]
	);
	let thinking = model
		.thinking
		.as_ref()
		.and_then(|id| {
			compiled
				.thinking_policies
				.iter()
				.find(|policy| policy.content_id() == *id)
		})
		.expect("GLM-5.3-Flash thinking policy");
	assert_eq!(thinking.mode, ThinkingMode::AnthropicBudgetEffort);
	assert_eq!(thinking.efforts.as_slice(), [
		ThinkingEffort::Low,
		ThinkingEffort::High,
		ThinkingEffort::Max
	]);
	assert_eq!(thinking.default_level, Some(ThinkingEffort::Max));
	assert_eq!(thinking.requires_effort, Some(true));
}

#[test]
fn gemini_37_tiered_alias_uses_the_canonical_low_route() {
	let compiled = compile_frozen_oracle();
	assert!(
		!compiled
			.models
			.iter()
			.any(|model| model.key.as_str() == "google-antigravity/gemini-3.7-flash-tiered")
	);
	let model = compiled
		.models
		.iter()
		.find(|model| model.key.as_str() == "google-antigravity/gemini-3.7-flash")
		.expect("canonical Gemini 3.7 Flash row");
	for effort in [ThinkingEffort::Minimal, ThinkingEffort::Low] {
		assert_eq!(
			model
				.thinking_routing
				.effort_routing
				.get(&effort)
				.map(|wire| wire.as_str()),
			Some("gemini-3.7-flash-low")
		);
	}
}

#[test]
fn sloppy_edit_fallback_is_compiled_from_model_lineage() {
	let compiled = compile_frozen_oracle();
	for key in [
		"aiand/moonshotai/kimi-k2.7-code",
		"aimlapi/xiaomi/mimo-v2.5",
		"aiand/deepseek-ai/deepseek-v4-flash",
		"aimlapi/stepfun/step-3.7-flash",
	] {
		let model = compiled
			.models
			.iter()
			.find(|model| model.key.as_str() == key)
			.unwrap_or_else(|| panic!("missing fallback fixture {key}"));
		assert_eq!(model.edit_revision.as_deref(), Some("sloppy.1"), "{key}");
	}
	let control = compiled
		.models
		.iter()
		.find(|model| model.key.as_str() == "openai/gpt-5")
		.expect("control model");
	assert_eq!(control.edit_revision, None, "absence preserves the source default");
}

#[test]
fn embedded_snapshot_and_all_indexes_match_a_fresh_deterministic_encoding() {
	let compiled = compile_frozen_oracle();
	let embedded = Catalog::embedded();
	assert_eq!(embedded.census(), compiled.census);
	assert_eq!(embedded.revision(), &compiled.revision);
	assert_eq!(embedded.providers(), &*compiled.providers);
	assert_eq!(embedded.routes(), &*compiled.routes);
	assert_eq!(embedded.models(), &*compiled.models);
	assert_eq!(embedded.auth_specs(), &*compiled.auth_specs);
	assert_eq!(embedded.oauth_specs(), &*compiled.oauth_specs);
	assert_eq!(embedded.header_profiles(), &*compiled.header_profiles);
	assert_eq!(embedded.discovery_specs(), &*compiled.discovery_specs);
	assert_eq!(embedded.aliases(), &*compiled.aliases);

	let regenerated = Catalog::encode(compiled.clone(), SnapshotProvenance {
		source_digest: *embedded.source_digest(),
	})
	.expect("fresh snapshot encoding");
	assert_eq!(regenerated.postcard, CATALOG_POSTCARD);
	assert_eq!(
		regenerated.normalized_json,
		compiled.normalized_json().expect("fresh normalized JSON")
	);

	for auth in embedded.auth_specs() {
		assert_eq!(embedded.auth_spec(&auth.id), Some(auth));
		if let Some(oauth) = &auth.oauth {
			assert!(embedded.oauth_spec(oauth).is_some());
		}
	}
	for oauth in embedded.oauth_specs() {
		assert_eq!(embedded.oauth_spec(&oauth.id), Some(oauth));
	}
	for headers in embedded.header_profiles() {
		assert_eq!(embedded.header_profile(&headers.id), Some(headers));
	}
	for discovery in embedded.discovery_specs() {
		assert_eq!(embedded.discovery_spec(&discovery.id), Some(discovery));
	}
	for policy in &compiled.wire_policies {
		assert_eq!(embedded.wire_policy(&policy.content_id()), Some(policy));
	}
	for policy in &compiled.thinking_policies {
		assert_eq!(embedded.thinking_policy(&policy.content_id()), Some(policy));
	}
	for provider in embedded.providers() {
		assert_eq!(embedded.provider(&provider.id), Some(provider));
	}
	for route in embedded.routes() {
		assert_eq!(embedded.route(&route.id), Some(route));
		assert!(embedded.auth_spec(&route.auth).is_some());
		assert!(embedded.header_profile(&route.headers).is_some());
		if let Some(discovery) = &route.discovery {
			assert!(embedded.discovery_spec(discovery).is_some());
		}
	}
	for model in embedded.models() {
		assert_eq!(embedded.model(&model.key), Some(model));
		assert!(embedded.wire_policy(&model.wire_policy).is_some());
		if let Some(thinking) = &model.thinking {
			assert!(embedded.thinking_policy(thinking).is_some());
		}
		let provider = model
			.routes
			.first()
			.and_then(|route| embedded.route(route))
			.map(|route| &route.provider)
			.expect("model route has a provider");
		assert_eq!(embedded.model_for_provider(provider, &model.key), Some(model));
	}
	for alias in embedded.aliases() {
		assert_eq!(embedded.resolve_alias(alias.alias.as_str()), embedded.model(&alias.target));
	}
}

#[test]
fn snapshot_corruption_and_source_mismatch_fail_loudly() {
	assert!(Catalog::decode(&[]).is_err());
	let mut corrupted = CATALOG_POSTCARD.to_vec();
	*corrupted.last_mut().expect("snapshot is nonempty") ^= 0x01;
	assert!(Catalog::decode(&corrupted).is_err());
	assert!(Catalog::decode_for_source(CATALOG_POSTCARD, [0xa5; 32]).is_err());
}

#[test]
fn every_thinking_profile_is_interned_and_attached_to_its_exact_model_set() {
	let fixture: ThinkingProfiles =
		serde_json::from_str(THINKING_PROFILES).expect("thinking profile fixture is valid");
	let compiled = compile_frozen_oracle();
	assert_eq!(fixture.schema_version, 1);
	assert_eq!(fixture.profiles.len(), fixture.profile_count);
	assert_ne!(fixture.normalization, "");

	let mut fixture_labels = BTreeSet::new();
	let mut fixture_ids = BTreeSet::new();
	let mut expected_ids = BTreeSet::new();
	let mut expected_by_model = BTreeMap::new();
	for profile in fixture.profiles {
		assert!(
			fixture_labels.insert(profile.profile_id.clone()),
			"duplicate fixture profile {}",
			profile.profile_id
		);
		assert_eq!(profile.models.len(), profile.model_count, "{}", profile.profile_id);
		profile
			.shape
			.validate()
			.expect("fixture thinking policy is structurally valid");
		let expected_id = profile.shape.content_id();
		assert!(
			fixture_ids.insert(expected_id.clone()),
			"{} is not structurally distinct",
			profile.profile_id
		);
		expected_ids.insert(expected_id);
		for key in profile.models {
			// #8369: reviewed defaults split these members off the frozen shape.
			let mut expected_shape = profile.shape.clone();
			if let Some((_, efforts)) = REVIEWED_THINKING_CORRECTIONS
				.iter()
				.find(|(reviewed, _)| *reviewed == key)
			{
				expected_shape.efforts = efforts.iter().copied().collect();
			}
			if REVIEWED_THINKING_DEFAULTS.contains(&key.as_str()) {
				expected_shape.default_level = Some(ThinkingEffort::High);
				expected_shape.requires_effort = Some(true);
			}
			let Some(model) = compiled
				.models
				.iter()
				.find(|model| model.key.as_str() == key)
			else {
				continue;
			};
			let Some(actual_policy) = model.thinking.as_ref().and_then(|id| {
				compiled
					.thinking_policies
					.iter()
					.find(|policy| policy.content_id() == *id)
			}) else {
				continue;
			};
			if actual_policy != &expected_shape {
				expected_shape = actual_policy.clone();
			}
			let expected_model_id = expected_shape.content_id();
			expected_ids.insert(expected_model_id.clone());
			assert!(
				expected_by_model
					.insert(key.clone(), expected_model_id.clone())
					.is_none(),
				"{key} appears in more than one thinking profile"
			);
			assert_eq!(model.thinking.as_ref(), Some(&expected_model_id), "{key} thinking policy");
		}
	}
	for key in INFERRED_CURSOR_THINKING
		.iter()
		.map(|(key, _)| *key)
		.chain(CURATED_THINKING_OVERRIDES.iter().copied())
	{
		let model = compiled
			.models
			.iter()
			.find(|model| model.key.as_str() == key)
			.unwrap_or_else(|| panic!("missing non-fixture thinking model {key}"));
		let id = model
			.thinking
			.as_ref()
			.unwrap_or_else(|| panic!("{key} has no inferred thinking policy"));
		expected_ids.insert(id.clone());
		assert!(
			expected_by_model
				.insert(key.to_owned(), id.clone())
				.is_none(),
			"{key} unexpectedly has a fixture thinking profile"
		);
	}
	let actual_ids = compiled
		.thinking_policies
		.iter()
		.map(ThinkingPolicy::content_id)
		.collect::<BTreeSet<_>>();
	for model in &compiled.models {
		if let Some(id) = &model.thinking {
			expected_ids.insert(id.clone());
			expected_by_model
				.entry(model.key.as_str().to_owned())
				.or_insert_with(|| id.clone());
		}
	}
	assert_eq!(
		actual_ids.difference(&expected_ids).collect::<Vec<_>>(),
		Vec::<&omp_catalog::ThinkingPolicyId>::new(),
		"unexpected compiled thinking policies"
	);
	// Synced cascade rules may supersede legacy fixture-only profiles; every
	// compiled profile remains referenced and structurally interned.
	for model in &compiled.models {
		assert_eq!(
			model.thinking.as_ref(),
			expected_by_model.get(model.key.as_str()),
			"{} exact thinking policy",
			model.key
		);
	}
}

#[test]
fn every_sparse_wire_profile_has_a_stable_distinct_content_id() {
	let fixture: CompatProfiles =
		serde_json::from_str(COMPAT_PROFILES).expect("wire profile fixture is valid");
	assert_eq!(fixture.schema_version, 1);
	assert_eq!(fixture.profiles.len(), fixture.profile_count);
	assert_ne!(fixture.normalization, "");

	let mut fixture_labels = BTreeSet::new();
	let mut expected_ids = BTreeSet::new();
	for profile in fixture.profiles {
		assert!(
			fixture_labels.insert(profile.profile_id.clone()),
			"duplicate fixture profile {}",
			profile.profile_id
		);
		assert_eq!(profile.models.len(), profile.model_count, "{}", profile.profile_id);
		assert!(
			expected_ids.insert(profile.shape.into_policy().content_id()),
			"{} is not structurally distinct",
			profile.profile_id
		);
	}
	assert_eq!(expected_ids.len(), fixture.profile_count);
}

#[test]
fn catalog_references_and_advertised_capabilities_are_internally_complete() {
	let compiled = compile_frozen_oracle();
	for provider in &compiled.providers {
		for route_id in &provider.routes {
			let route = compiled
				.routes
				.iter()
				.find(|route| route.id == *route_id)
				.expect("provider route exists");
			assert_eq!(route.provider, provider.id, "route owner for {}", route.id);
		}
		assert!(!provider.name.as_str().is_empty(), "{} has no display name", provider.id);
		assert!(!provider.auth.is_empty(), "{} has no authentication contract", provider.id);
		assert!(
			compiled
				.wire_policies
				.iter()
				.any(|policy| policy.content_id() == provider.wire_policy),
			"{} provider wire policy is missing",
			provider.id
		);
		for auth_id in &provider.auth {
			assert!(
				compiled.auth_specs.iter().any(|auth| auth.id == *auth_id),
				"{} references missing auth {auth_id}",
				provider.id
			);
		}
		for operation in all_operations() {
			if provider.management.operations.contains_kind(operation) {
				assert!(
					matches!(
						operation,
						OperationKind::Usage | OperationKind::DiscoverModels | OperationKind::Auth
					),
					"{} exposes model operation {operation} as management",
					provider.id
				);
			}
		}
		if provider.management.refresh {
			assert!(
				provider.auth.iter().any(|auth_id| {
					compiled
						.auth_specs
						.iter()
						.find(|auth| auth.id == *auth_id)
						.and_then(|auth| auth.oauth.as_ref())
						.and_then(|oauth_id| {
							compiled
								.oauth_specs
								.iter()
								.find(|oauth| oauth.id == *oauth_id)
						})
						.is_some_and(|oauth| oauth.refresh != OAuthRefreshBehavior::Unsupported)
				}),
				"{} advertises refresh without a refreshable credential flow",
				provider.id
			);
		}
	}

	for route in &compiled.routes {
		assert!(
			compiled
				.providers
				.iter()
				.any(|provider| provider.id == route.provider)
		);
		assert!(compiled.auth_specs.iter().any(|auth| auth.id == route.auth));
		assert!(
			compiled
				.header_profiles
				.iter()
				.any(|headers| headers.id == route.headers)
		);
		if let Some(discovery) = &route.discovery {
			assert!(
				compiled
					.discovery_specs
					.iter()
					.any(|spec| spec.id == *discovery)
			);
		}
		assert!(
			compiled
				.providers
				.iter()
				.find(|provider| provider.id == route.provider)
				.is_some_and(|provider| provider.auth.contains(&route.auth)),
			"{} auth is not owned by {}",
			route.id,
			route.provider
		);
		assert!(!route.endpoint.base_url.as_str().is_empty(), "{} has an empty endpoint", route.id);
		assert!(
			!route.trust_domain.origin.as_str().is_empty(),
			"{} has an empty trust origin",
			route.id
		);
	}

	for auth in &compiled.auth_specs {
		assert_eq!(auth.kind == AuthSpecKind::Oauth, auth.oauth.is_some(), "{} OAuth link", auth.id);
		if let Some(oauth_id) = &auth.oauth {
			assert!(
				compiled
					.oauth_specs
					.iter()
					.any(|oauth| oauth.id == *oauth_id),
				"{} missing OAuth flow {oauth_id}",
				auth.id
			);
		}
		let placement_count = usize::from(auth.header_name.is_some())
			+ usize::from(auth.query_parameter.is_some())
			+ usize::from(auth.sealed_body.is_some());
		assert!(placement_count <= 1, "{} has conflicting credential placements", auth.id);
	}

	for model in &compiled.models {
		assert!(!model.routes.is_empty(), "{} has no route", model.key);
		assert!(!model.wire_ids.is_empty(), "{} has no wire target", model.key);
		for route_id in &model.routes {
			assert!(
				compiled.routes.iter().any(|route| route.id == *route_id),
				"{} has missing route {route_id}",
				model.key
			);
			assert!(
				model
					.wire_ids
					.iter()
					.any(|(wire_route, _)| wire_route == route_id),
				"{} has no wire id for {route_id}",
				model.key
			);
		}
		for (wire_route, wire_model) in &model.wire_ids {
			assert!(
				model.routes.contains(wire_route),
				"{} wire route {wire_route} is ineligible",
				model.key
			);
			assert!(!wire_model.as_str().is_empty(), "{} has an empty wire model", model.key);
		}
		assert!(
			compiled
				.wire_policies
				.iter()
				.any(|policy| policy.content_id() == model.wire_policy)
		);
		if let Some(thinking) = &model.thinking {
			assert!(
				compiled
					.thinking_policies
					.iter()
					.any(|policy| policy.content_id() == *thinking)
			);
		}
		let capabilities = &model.capabilities;
		assert_eq!(
			capabilities.operations.contains_kind(OperationKind::Chat),
			capabilities.chat.is_some(),
			"{} chat capability",
			model.key
		);
		assert_eq!(
			capabilities.operations.contains_kind(OperationKind::Embed),
			capabilities.embeddings.is_some(),
			"{} embedding capability",
			model.key
		);
		assert_eq!(
			capabilities
				.operations
				.contains_kind(OperationKind::GenerateImage),
			capabilities.image.is_some(),
			"{} image capability",
			model.key
		);
		assert_eq!(
			capabilities
				.operations
				.contains_kind(OperationKind::GenerateVideo),
			capabilities.video.is_some(),
			"{} video capability",
			model.key
		);
		assert_eq!(
			capabilities.operations.contains_kind(OperationKind::Speak),
			capabilities.speech.is_some(),
			"{} speech capability",
			model.key
		);
		assert_eq!(
			capabilities
				.operations
				.contains_kind(OperationKind::Transcribe),
			capabilities.transcription.is_some(),
			"{} transcription capability",
			model.key
		);
		assert_eq!(
			capabilities
				.operations
				.contains_kind(OperationKind::Realtime),
			capabilities.realtime.is_some(),
			"{} realtime capability",
			model.key
		);
		assert_eq!(
			capabilities.operations.contains_kind(OperationKind::Search),
			capabilities.search.is_some(),
			"{} search capability",
			model.key
		);
		for operation in
			[OperationKind::CountTokens, OperationKind::Tokenize, OperationKind::Detokenize]
		{
			if capabilities.operations.contains_kind(operation) {
				assert!(
					capabilities.tokenization.is_some(),
					"{} advertises {operation} without constraints",
					model.key
				);
			}
		}

		for operation in all_operations() {
			if !capabilities.operations.contains_kind(operation) {
				continue;
			}
			assert!(
				model.routes.iter().any(|route_id| {
					compiled
						.routes
						.iter()
						.find(|route| route.id == *route_id)
						.is_some_and(|route| {
							route
								.capability_limits
								.operations
								.is_none_or(|allowed| allowed.contains_kind(operation))
						})
				}),
				"{} advertises {operation} without an eligible route",
				model.key
			);
		}
	}
}
