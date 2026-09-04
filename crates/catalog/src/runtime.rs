//! Checked-in provider and model behavior used outside exact model lookup.

use std::sync::LazyLock;

use kdl::{KdlDocument, KdlNode, KdlValue};
use omp_core::{IntoStr, Str};

use crate::{
	capability::{OperationBits, OperationKind},
	cascade::CascadeError,
};

const FILE: &str = "runtime/behavior";
const BUNDLED_RUNTIME_BEHAVIOR: &str = include_str!("../compat/runtime/behavior.kdl");

#[derive(Clone, Debug, Eq, PartialEq)]
struct MatchRule {
	exact:    Box<[Str]>,
	prefixes: Box<[Str]>,
}

impl MatchRule {
	fn matches(&self, value: &str) -> bool {
		self.exact.iter().any(|candidate| candidate == value)
			|| self
				.prefixes
				.iter()
				.any(|prefix| value.starts_with(prefix.as_str()))
	}
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct OperationRule {
	provider:   Str,
	models:     MatchRule,
	operations: OperationBits,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct OpenAiResponsesHeuristic {
	include_prefixes:   Box<[Str]>,
	exclude_prefixes:   Box<[Str]>,
	exclude_substrings: Box<[Str]>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct CursorEffortRule {
	family_marker: Str,
	tiers:         Box<[Str]>,
}
#[derive(Clone, Debug, Eq, PartialEq)]
struct CursorModelParameter {
	model: Str,
	id:    Str,
	value: Str,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct QuotaTier {
	label:  Str,
	models: Box<[Str]>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct QuotaFallback {
	label:     Str,
	substring: Str,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct QuotaRule {
	provider:  Str,
	tiers:     Box<[QuotaTier]>,
	fallbacks: Box<[QuotaFallback]>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct HostedDefault {
	provider: Str,
	model:    Str,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct RuntimeBehavior {
	openai_responses:  OpenAiResponsesHeuristic,
	model_operations:  Box<[OperationRule]>,
	cursor_effort:     CursorEffortRule,
	cursor_parameters: Box<[CursorModelParameter]>,
	quota_tiers:       Box<[QuotaRule]>,
	hosted_defaults:   Box<[HostedDefault]>,
}

impl RuntimeBehavior {
	#[tracing::instrument(
		name = "catalog_runtime_behavior_parse",
		level = "debug",
		skip_all,
		fields(source_count = 1, file = FILE)
	)]
	fn parse(text: &str) -> Result<Self, CascadeError> {
		let document: KdlDocument = text.parse().map_err(|error: kdl::KdlError| {
			tracing::warn!(file = FILE, "catalog runtime KDL failed to parse");
			CascadeError::Parse { file: FILE.to_str(), message: error.to_string().to_str() }
		})?;
		let [root] = document.nodes() else {
			return malformed("behavior");
		};
		if root.name().value() != "behavior" || !root.entries().is_empty() {
			return malformed("behavior");
		}
		let Some(children) = root.children() else {
			return malformed("behavior");
		};
		let mut openai_responses = None;
		let mut model_operations = Vec::new();
		let mut cursor_effort = None;
		let mut cursor_parameters = Vec::new();
		let mut quota_tiers = Vec::new();
		let mut hosted_defaults = Vec::new();
		for node in children.nodes() {
			match node.name().value() {
				"openai-responses-heuristic" => {
					if openai_responses.is_some() {
						return malformed("openai-responses-heuristic");
					}
					openai_responses = Some(parse_openai_responses(node)?);
				},
				"model-operations" => model_operations.push(parse_model_operations(node)?),
				"cursor-effort" => {
					if cursor_effort.is_some() {
						return malformed("cursor-effort");
					}
					cursor_effort = Some(parse_cursor_effort(node)?);
				},
				"cursor-model-parameter" => {
					cursor_parameters.push(parse_cursor_model_parameter(node)?);
				},
				"quota-tiers" => quota_tiers.push(parse_quota_tiers(node)?),
				"hosted-default" => hosted_defaults.push(parse_hosted_default(node)?),
				"retired-providers" | "plan-requirement" | "api-routes" | "exclude-models"
				| "model-limits" | "pricing-peer" => validate_extension(node)?,
				other => return unexpected(other, "behavior"),
			}
		}
		let openai_responses = openai_responses.ok_or_else(|| malformed_error("behavior"))?;
		let cursor_effort = cursor_effort.ok_or_else(|| malformed_error("behavior"))?;
		if model_operations.is_empty()
			|| cursor_parameters.is_empty()
			|| quota_tiers.is_empty()
			|| hosted_defaults.is_empty()
		{
			return malformed("behavior");
		}
		Ok(Self {
			openai_responses,
			model_operations: model_operations.into_boxed_slice(),
			cursor_effort,
			cursor_parameters: cursor_parameters.into_boxed_slice(),
			quota_tiers: quota_tiers.into_boxed_slice(),
			hosted_defaults: hosted_defaults.into_boxed_slice(),
		})
	}
}

fn parse_openai_responses(node: &KdlNode) -> Result<OpenAiResponsesHeuristic, CascadeError> {
	ensure_container(node, "openai-responses-heuristic", &[])?;
	let children = node.children().expect("container validated");
	let mut include_prefixes = None;
	let mut exclude_prefixes = None;
	let mut exclude_substrings = None;
	for child in children.nodes() {
		let values = positional_strings(child)?;
		if values.is_empty() || child.children().is_some() {
			return malformed(child.name().value());
		}
		let slot = match child.name().value() {
			"include-prefix" => &mut include_prefixes,
			"exclude-prefix" => &mut exclude_prefixes,
			"exclude-substring" => &mut exclude_substrings,
			other => return unexpected(other, "openai-responses-heuristic"),
		};
		if slot.replace(values.into_boxed_slice()).is_some() {
			return malformed(child.name().value());
		}
	}
	Ok(OpenAiResponsesHeuristic {
		include_prefixes:   include_prefixes.ok_or_else(|| malformed_error("include-prefix"))?,
		exclude_prefixes:   exclude_prefixes.ok_or_else(|| malformed_error("exclude-prefix"))?,
		exclude_substrings: exclude_substrings.ok_or_else(|| malformed_error("exclude-substring"))?,
	})
}

fn parse_model_operations(node: &KdlNode) -> Result<OperationRule, CascadeError> {
	ensure_container(node, "model-operations", &["provider"])?;
	let provider = required_property(node, "provider", "model-operations")?;
	let mut exact = Vec::new();
	let mut prefixes = Vec::new();
	let mut operations = OperationBits::empty();
	for child in node.children().expect("container validated").nodes() {
		let values = positional_strings(child)?;
		if values.is_empty() || child.children().is_some() {
			return malformed(child.name().value());
		}
		match child.name().value() {
			"exact" => exact.extend(values),
			"prefix" => prefixes.extend(values),
			"operation" => {
				for value in values {
					let operation = value
						.as_str()
						.parse::<OperationKind>()
						.map_err(|_| malformed_error("operation"))?;
					operations.insert_kind(operation);
				}
			},
			other => return unexpected(other, "model-operations"),
		}
	}
	if provider.is_empty() || (exact.is_empty() && prefixes.is_empty()) || operations.is_empty() {
		return malformed("model-operations");
	}
	Ok(OperationRule {
		provider: provider.to_str(),
		models: MatchRule {
			exact:    exact.into_boxed_slice(),
			prefixes: prefixes.into_boxed_slice(),
		},
		operations,
	})
}

fn parse_cursor_effort(node: &KdlNode) -> Result<CursorEffortRule, CascadeError> {
	ensure_container(node, "cursor-effort", &["family-marker"])?;
	let family_marker = required_property(node, "family-marker", "cursor-effort")?;
	let children = node.children().expect("container validated");
	let [tiers] = children.nodes() else {
		return malformed("cursor-effort");
	};
	if tiers.name().value() != "tier" || tiers.children().is_some() {
		return malformed("cursor-effort");
	}
	let tiers = positional_strings(tiers)?;
	if family_marker.is_empty() || tiers.is_empty() {
		return malformed("cursor-effort");
	}
	Ok(CursorEffortRule {
		family_marker: family_marker.to_str(),
		tiers:         tiers.into_boxed_slice(),
	})
}
fn parse_cursor_model_parameter(node: &KdlNode) -> Result<CursorModelParameter, CascadeError> {
	ensure_leaf(node, "cursor-model-parameter", &["model", "id", "value"])?;
	let model = required_property(node, "model", "cursor-model-parameter")?;
	let id = required_property(node, "id", "cursor-model-parameter")?;
	let value = required_property(node, "value", "cursor-model-parameter")?;
	if model.is_empty() || id.is_empty() || value.is_empty() || !positional_strings(node)?.is_empty()
	{
		return malformed("cursor-model-parameter");
	}
	Ok(CursorModelParameter { model: model.to_str(), id: id.to_str(), value: value.to_str() })
}

fn parse_quota_tiers(node: &KdlNode) -> Result<QuotaRule, CascadeError> {
	ensure_container(node, "quota-tiers", &["provider"])?;
	let provider = required_property(node, "provider", "quota-tiers")?;
	let mut tiers = Vec::new();
	let mut fallbacks = Vec::new();
	for child in node.children().expect("container validated").nodes() {
		match child.name().value() {
			"tier" => {
				let values = positional_strings(child)?;
				let Some((label, models)) = values.split_first() else {
					return malformed("tier");
				};
				if label.is_empty() || models.is_empty() || child.children().is_some() {
					return malformed("tier");
				}
				tiers.push(QuotaTier { label: label.clone(), models: models.into() });
			},
			"fallback" => {
				ensure_leaf(child, "fallback", &["substring"])?;
				let values = positional_strings(child)?;
				let [label] = values.as_slice() else {
					return malformed("fallback");
				};
				let substring = required_property(child, "substring", "fallback")?;
				if label.is_empty() || substring.is_empty() {
					return malformed("fallback");
				}
				fallbacks
					.push(QuotaFallback { label: label.clone(), substring: substring.to_str() });
			},
			other => return unexpected(other, "quota-tiers"),
		}
	}
	if provider.is_empty() || tiers.is_empty() {
		return malformed("quota-tiers");
	}
	Ok(QuotaRule {
		provider:  provider.to_str(),
		tiers:     tiers.into_boxed_slice(),
		fallbacks: fallbacks.into_boxed_slice(),
	})
}

fn parse_hosted_default(node: &KdlNode) -> Result<HostedDefault, CascadeError> {
	ensure_leaf(node, "hosted-default", &["provider", "model"])?;
	let provider = required_property(node, "provider", "hosted-default")?;
	let model = required_property(node, "model", "hosted-default")?;
	if provider.is_empty() || model.is_empty() || !positional_strings(node)?.is_empty() {
		return malformed("hosted-default");
	}
	Ok(HostedDefault { provider: provider.to_str(), model: model.to_str() })
}

fn validate_extension(node: &KdlNode) -> Result<(), CascadeError> {
	match node.name().value() {
		"retired-providers" => {
			validate_properties(node, "retired-providers", &[])?;
			if positional_strings(node)?.is_empty() || node.children().is_some() {
				return malformed("retired-providers");
			}
		},
		"exclude-models" => {
			validate_properties(node, "exclude-models", &[
				"provider",
				"exact",
				"prefix",
				"substring",
				"token",
				"glob",
			])?;
			if required_property(node, "provider", "exclude-models")?.is_empty()
				|| !positional_strings(node)?.is_empty()
				|| node.children().is_some()
			{
				return malformed("exclude-models");
			}
		},
		"plan-requirement" => {
			ensure_container(node, "plan-requirement", &["provider"])?;
			for child in node.children().expect("container validated").nodes() {
				ensure_leaf(child, "tier", &["exact", "prefix", "substring", "token", "glob"])?;
				let values = positional_strings(child)?;
				let [tier] = values.as_slice() else {
					return malformed("tier");
				};
				if child.name().value() != "tier" || tier.is_empty() {
					return malformed("tier");
				}
			}
		},
		"api-routes" => {
			ensure_container(node, "api-routes", &["provider", "default"])?;
			for child in node.children().expect("container validated").nodes() {
				ensure_leaf(child, "route", &[
					"exact",
					"prefix",
					"substring",
					"token",
					"glob",
					"strip-prefix",
				])?;
				let values = positional_strings(child)?;
				let [api] = values.as_slice() else {
					return malformed("route");
				};
				if child.name().value() != "route" || api.is_empty() {
					return malformed("route");
				}
			}
		},
		"model-limits" => {
			ensure_container(node, "model-limits", &["provider"])?;
			for child in node.children().expect("container validated").nodes() {
				ensure_leaf(child, "limits", &["context", "max-tokens"])?;
				let values = positional_strings(child)?;
				let [model] = values.as_slice() else {
					return malformed("limits");
				};
				if child.name().value() != "limits" || model.is_empty() {
					return malformed("limits");
				}
			}
		},
		"pricing-peer" => {
			validate_properties(node, "pricing-peer", &["provider", "peers"])?;
			if required_property(node, "provider", "pricing-peer")?.is_empty()
				|| required_property(node, "peers", "pricing-peer")?.is_empty()
				|| node.children().is_none()
			{
				return malformed("pricing-peer");
			}
			for child in node.children().expect("children checked").nodes() {
				ensure_leaf(child, "alias", &["peer-id"])?;
				let values = positional_strings(child)?;
				let [model] = values.as_slice() else {
					return malformed("alias");
				};
				if child.name().value() != "alias"
					|| model.is_empty()
					|| required_property(child, "peer-id", "alias")?.is_empty()
				{
					return malformed("alias");
				}
			}
		},
		_ => return unexpected(node.name().value(), "behavior"),
	}
	Ok(())
}

fn ensure_container(
	node: &KdlNode,
	directive: &str,
	properties: &[&str],
) -> Result<(), CascadeError> {
	validate_properties(node, directive, properties)?;
	if !positional_strings(node)?.is_empty() || node.children().is_none() {
		return malformed(directive);
	}
	Ok(())
}

fn ensure_leaf(node: &KdlNode, directive: &str, properties: &[&str]) -> Result<(), CascadeError> {
	validate_properties(node, directive, properties)?;
	if node.children().is_some() {
		return malformed(directive);
	}
	Ok(())
}

fn validate_properties(
	node: &KdlNode,
	directive: &str,
	allowed: &[&str],
) -> Result<(), CascadeError> {
	for entry in node.entries() {
		if let Some(name) = entry.name()
			&& !allowed.contains(&name.value())
		{
			return unexpected(name.value(), directive);
		}
	}
	Ok(())
}

fn positional_strings(node: &KdlNode) -> Result<Vec<Str>, CascadeError> {
	node
		.entries()
		.iter()
		.filter(|entry| entry.name().is_none())
		.map(|entry| {
			entry
				.value()
				.as_string()
				.map(Str::new)
				.ok_or_else(|| malformed_error(node.name().value()))
		})
		.collect()
}

fn required_property<'node>(
	node: &'node KdlNode,
	property: &str,
	directive: &str,
) -> Result<&'node str, CascadeError> {
	match node.get(property) {
		Some(KdlValue::String(value)) => Ok(value),
		_ => Err(malformed_error(directive)),
	}
}

fn malformed<T>(directive: &str) -> Result<T, CascadeError> {
	Err(malformed_error(directive))
}

fn malformed_error(directive: &str) -> CascadeError {
	CascadeError::MalformedDirective { file: FILE.to_str(), directive: directive.to_str() }
}

fn unexpected<T>(node: &str, context: &str) -> Result<T, CascadeError> {
	Err(CascadeError::UnexpectedNode {
		file:    FILE.to_str(),
		node:    node.to_str(),
		context: context.to_str(),
	})
}

fn runtime_behavior() -> &'static RuntimeBehavior {
	static BEHAVIOR: LazyLock<RuntimeBehavior> = LazyLock::new(|| {
		RuntimeBehavior::parse(BUNDLED_RUNTIME_BEHAVIOR)
			.unwrap_or_else(|error| panic!("bundled runtime behavior is invalid: {error}"))
	});
	&BEHAVIOR
}

/// Applies the catalog's conservative heuristic for a normalized, lowercase
/// LiteLLM-discovered model id that has no exact bundled model record.
pub fn is_likely_openai_responses_id(model: &str) -> bool {
	let rule = &runtime_behavior().openai_responses;
	!rule
		.exclude_prefixes
		.iter()
		.any(|prefix| model.starts_with(prefix.as_str()))
		&& !rule
			.exclude_substrings
			.iter()
			.any(|substring| model.contains(substring.as_str()))
		&& rule
			.include_prefixes
			.iter()
			.any(|prefix| model.starts_with(prefix.as_str()))
}

/// Returns additional catalog-declared operations for a provider/model pair.
///
/// This lookup covers discovered models that do not yet have an exact bundled
/// [`crate::ModelSpec`] record. The returned bits augment capabilities declared
/// by the provider discovery response.
pub fn model_operation_overrides(provider: &str, model: &str) -> OperationBits {
	let rules = &runtime_behavior().model_operations;
	if !rules.iter().any(|rule| rule.provider == provider) {
		return OperationBits::empty();
	}
	let model = model.to_ascii_lowercase();
	rules
		.iter()
		.filter(|rule| rule.provider == provider && rule.models.matches(&model))
		.fold(OperationBits::empty(), |operations, rule| operations | rule.operations)
}

/// Splits a Cursor effort-suffixed `OpenAI` sibling id into its base id and
/// catalog-declared effort tier.
///
/// The family gate requires a `gpt-` prefix followed immediately by an ASCII
/// version digit. Matching remains
/// case-sensitive to preserve Cursor wire-id behavior.
pub fn cursor_openai_effort_suffix(model: &str) -> Option<(&str, &'static str)> {
	let rule = &runtime_behavior().cursor_effort;
	for tier in &rule.tiers {
		let Some(base) = model
			.strip_suffix(tier.as_str())
			.and_then(|prefix| prefix.strip_suffix('-'))
		else {
			continue;
		};
		let family = base
			.match_indices(rule.family_marker.as_str())
			.any(|(index, marker)| {
				base[index + marker.len()..]
					.bytes()
					.next()
					.is_some_and(|byte| byte.is_ascii_digit())
			});
		if !family {
			break;
		}
		return Some((base, tier.as_str()));
	}
	None
}
/// Returns fixed Cursor `requestedModel` parameters declared for an exact wire
/// model.
pub fn cursor_model_parameters(
	model: &str,
) -> impl Iterator<Item = (&'static str, &'static str)> + '_ {
	runtime_behavior()
		.cursor_parameters
		.iter()
		.filter(move |parameter| parameter.model == model)
		.map(|parameter| (parameter.id.as_str(), parameter.value.as_str()))
}

/// Returns the catalog-declared quota scope or display tier for a provider
/// model id.
///
/// Exact authored memberships are checked first. Provider-authored substring
/// fallbacks deliberately preserve quota semantics for newly discovered ids
/// that are not yet present in the bundled catalog.
pub fn quota_display_tier(provider: &str, model: &str) -> Option<&'static str> {
	let rule = runtime_behavior()
		.quota_tiers
		.iter()
		.find(|rule| rule.provider == provider)?;
	if let Some(tier) = rule
		.tiers
		.iter()
		.find(|tier| tier.models.iter().any(|candidate| candidate == model))
	{
		return Some(tier.label.as_str());
	}
	rule
		.fallbacks
		.iter()
		.find(|fallback| model.contains(fallback.substring.as_str()))
		.map(|fallback| fallback.label.as_str())
}
/// Reports whether a provider has catalog-authored model quota scopes.
pub fn has_quota_tier_policy(provider: &str) -> bool {
	runtime_behavior()
		.quota_tiers
		.iter()
		.any(|rule| rule.provider == provider)
}

/// Returns the provider-default wire model for a model-less hosted operation.
pub fn provider_default_wire_model(provider: &str) -> Option<&'static str> {
	runtime_behavior()
		.hosted_defaults
		.iter()
		.find(|default| default.provider == provider)
		.map(|default| default.model.as_str())
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn bundled_runtime_behavior_parses() {
		RuntimeBehavior::parse(BUNDLED_RUNTIME_BEHAVIOR).expect("bundled behavior parses");
	}

	#[test]
	fn openai_responses_heuristic_preserves_text_model_boundary() {
		for model in ["gpt-5.6-sol", "o1", "o3-mini", "o4-mini", "chatgpt-4o-latest"] {
			assert!(is_likely_openai_responses_id(model), "{model}");
		}
		for model in [
			"gpt-image-1",
			"gpt-realtime",
			"text-embedding-3-small",
			"whisper-1",
			"my-embedding-gpt-5",
			"claude-fable-5",
		] {
			assert!(!is_likely_openai_responses_id(model), "{model}");
		}
	}

	#[test]
	fn model_operation_rules_cover_codex_image_generation() {
		for model in ["gpt-5.6-sol", "o3", "o3-mini"] {
			assert!(
				model_operation_overrides("openai-codex", model)
					.contains_kind(OperationKind::GenerateImage),
				"{model}"
			);
		}
		assert!(model_operation_overrides("openai-codex", "codex-mini-latest").is_empty());
	}

	#[test]
	fn cursor_effort_rule_requires_version_digit_after_marker() {
		assert_eq!(cursor_openai_effort_suffix("gpt-5.6-sol-high"), Some(("gpt-5.6-sol", "high")));
		assert_eq!(cursor_openai_effort_suffix("claude-fable-5-low"), None);
		assert_eq!(cursor_openai_effort_suffix("gpt-alpha-high"), None);
	}
	#[test]
	fn cursor_model_parameters_are_exact_wire_model_data() {
		assert_eq!(cursor_model_parameters("composer-2.5").collect::<Vec<_>>(), vec![(
			"fast", "false"
		)]);
		assert!(
			cursor_model_parameters("composer-2.5-fast")
				.next()
				.is_none()
		);
	}

	#[test]
	fn quota_tiers_prefer_exact_membership_then_discovery_fallback() {
		assert_eq!(
			quota_display_tier("google-gemini-cli", "gemini-3-flash-preview"),
			Some("3-Flash")
		);
		assert_eq!(quota_display_tier("google-gemini-cli", "gemini-future-flash"), Some("Flash"));
		assert_eq!(quota_display_tier("google-gemini-cli", "unknown"), None);
	}

	#[test]
	fn hosted_defaults_are_provider_owned() {
		assert_eq!(provider_default_wire_model("kimi-search"), Some("kimi-for-coding"));
		assert_eq!(provider_default_wire_model("zai-search"), Some("glm-4.7"));
		assert_eq!(provider_default_wire_model("synthetic-search"), Some("auto"));
		assert_eq!(provider_default_wire_model("unknown"), None);
	}
}
