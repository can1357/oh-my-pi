//! Offline model identity classification for catalog compilation and discovery
//! normalization.
#![allow(missing_docs, reason = "strum IntoStaticStr emits undocumented inherent methods")]

use std::borrow;

use omp_core::{SemVer, Str, sf};
use serde::{Deserialize, Serialize};
use strum::IntoStaticStr;

use crate::{
	id::{ClassId, FamilyId},
	taxonomy::{Taxonomy, TaxonomyError, VariantFamily, taxonomy},
};

/// Source phase allowed to invoke identity classification.
#[allow(missing_docs, reason = "strum IntoStaticStr generates undocumented as_str")]
#[derive(Clone, Copy, Debug, Eq, IntoStaticStr, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClassificationPhase {
	/// Checked-in source compilation.
	#[strum(serialize = "catalog-compiler")]
	CatalogCompiler,
	/// Provider model-list normalization.
	#[strum(serialize = "provider-discovery")]
	DiscoveryNormalizer,
}

/// Ordered reasoning effort suffix recognized by the catalog compiler.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EffortTier {
	/// Explicit non-reasoning route.
	Off,
	/// Minimal reasoning.
	Minimal,
	/// Low reasoning.
	Low,
	/// Medium reasoning.
	Medium,
	/// High reasoning.
	High,
	/// Extra-high reasoning.
	XHigh,
	/// Provider-defined maximum reasoning.
	Max,
}

/// Why a classification fact is present.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ClassificationMethod {
	/// An exact reviewed override supplied the result.
	ExactOverride,
	/// A bounded class rule supplied the result.
	#[serde(rename = "family_rule")]
	ClassRule,
	/// A structural suffix or exact effort-family alias supplied the result.
	StructuralSuffix,
	/// No rule established the fact.
	Unknown,
}

/// Auditable evidence attached to compiler-produced identity facts.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ClassificationEvidence {
	/// Classification mechanism.
	pub method:        ClassificationMethod,
	/// Stable rule or override identifier.
	pub rule:          Str,
	/// Human-readable review rationale.
	pub rationale:     Str,
	/// Source path, document, or provider declaration supporting the fact.
	pub provenance:    Str,
	/// Optional Unix-millisecond expiry for temporary evidence.
	pub expires_at_ms: Option<u64>,
}

/// Borrowed input accepted only by compiler and discovery normalization code.
#[derive(Clone, Copy, Debug)]
pub struct ClassificationInput<'a> {
	/// Compiler or discovery phase invoking the classifier.
	pub phase:          ClassificationPhase,
	/// Provider source key, before provider alias resolution.
	pub provider:       &'a str,
	/// Opaque provider model identifier.
	pub model:          &'a str,
	/// Observation time used to reject expired overrides.
	pub observed_at_ms: Option<u64>,
}

/// Compiler-normalized identity and its evidence.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
pub struct ModelClassification {
	/// Logical model identifier after effort sibling collapse.
	pub logical_model:    Str,
	/// Centrally classified model class; `unknown` is conservative.
	pub class:            ClassId,
	/// Product family within the classified class, when established.
	pub family:           Option<FamilyId>,
	/// Parsed class revision when the rule establishes one.
	pub revision:         Option<SemVer>,
	/// Effort route represented by this source row.
	pub effort:           Option<EffortTier>,
	/// Whether this row is the reasoning sibling of an explicit off route.
	pub thinking_variant: bool,
	/// Evidence for class and identity normalization.
	pub evidence:         ClassificationEvidence,
}

/// Classifies one source identity without consulting process state.
pub fn classify(input: ClassificationInput<'_>) -> ModelClassification {
	classify_with_taxonomy(input, taxonomy())
}
/// Returns the reviewed variant family matching a logical, member, or alias id.
pub(crate) fn variant_family(provider: &str, id: &str) -> Option<VariantFamily> {
	taxonomy().variant_family(provider, id)
}

/// Whether a provider declares conservative dynamic effort-sibling grouping.
pub(crate) fn supports_dynamic_effort_siblings(provider: &str) -> bool {
	taxonomy().supports_dynamic_effort_siblings(provider)
}

/// Returns the standard-lane id for a provider-declared effort lane.
pub(crate) fn strip_effort_lane<'a>(provider: &str, model: &'a str) -> &'a str {
	taxonomy().strip_effort_lane(provider, model)
}

fn classify_with_taxonomy(
	input: ClassificationInput<'_>,
	taxonomy: &Taxonomy,
) -> ModelClassification {
	let trimmed = input.model.trim();
	let bare = trimmed.rsplit('/').next().unwrap_or(trimmed);
	let override_ = taxonomy.identity_override(input.provider, bare, input.observed_at_ms);
	if let Some(identity) = override_ {
		let logical = identity.logical.as_deref().unwrap_or(trimmed);
		let class = identity
			.class
			.clone()
			.unwrap_or_else(|| classify_ranks(taxonomy, input.phase, logical).0);
		let (inferred_family, inferred_revision) =
			ranks_in_class(taxonomy, input.phase, &class, logical);
		return ModelClassification {
			logical_model: Str::new(logical),
			class,
			family: identity.family.clone().or(inferred_family),
			revision: identity.revision.or(inferred_revision),
			effort: identity.effort,
			thinking_variant: identity.thinking_variant.unwrap_or(false),
			evidence: ClassificationEvidence {
				method:        ClassificationMethod::ExactOverride,
				rule:          Str::new(identity.id.as_str()),
				rationale:     identity.rationale.clone(),
				provenance:    identity.provenance.clone(),
				expires_at_ms: identity.expires_at_ms,
			},
		};
	}

	let (logical, collapsed_effort, collapsed_thinking) = if trimmed.len() == input.model.len() {
		taxonomy.collapse(input.provider, trimmed)
	} else {
		(borrow::Cow::Borrowed(trimmed), None, false)
	};
	let (inferred_class, inferred_family, inferred_revision) =
		classify_ranks(taxonomy, input.phase, &logical);

	let family_alias =
		logical.as_ref() != trimmed && collapsed_effort.is_none() && !collapsed_thinking;
	let structural = family_alias || collapsed_effort.is_some() || collapsed_thinking;
	let method = if structural {
		ClassificationMethod::StructuralSuffix
	} else if inferred_class.as_str() == "unknown" {
		ClassificationMethod::Unknown
	} else {
		ClassificationMethod::ClassRule
	};
	ModelClassification {
		logical_model:    Str::new(logical.as_ref()),
		class:            inferred_class,
		family:           inferred_family,
		revision:         inferred_revision,
		effort:           collapsed_effort,
		thinking_variant: collapsed_thinking,
		evidence:         ClassificationEvidence {
			method,
			rule: if family_alias {
				Str::new_static("effort-family-alias-v1")
			} else if structural {
				sf!("effort-suffix-v1")
			} else {
				sf!("family-segments-v1")
			},
			rationale: if family_alias {
				Str::new_static("provider row is an exact alias of one logical effort family")
			} else if structural {
				sf!("provider row is a structurally named effort route of one logical model",)
			} else {
				sf!("bounded vendor and model-family segments establish lineage")
			},
			provenance: sf!(<&'static str>::from(input.phase)),
			expires_at_ms: None,
		},
	}
}

fn classify_ranks(
	taxonomy: &Taxonomy,
	phase: ClassificationPhase,
	model: &str,
) -> (ClassId, Option<FamilyId>, Option<SemVer>) {
	match taxonomy.classify_id(model) {
		Ok(ranks) => ranks,
		Err(error) => match (phase, error) {
			(ClassificationPhase::DiscoveryNormalizer, TaxonomyError::AmbiguousClass { .. }) => {
				(ClassId::new("unknown"), None, None)
			},
			(
				ClassificationPhase::DiscoveryNormalizer,
				TaxonomyError::AmbiguousFamily { class, .. },
			) => (class, None, None),
			(ClassificationPhase::CatalogCompiler, error) => {
				panic!("bundled taxonomy classification is ambiguous: {error}")
			},
		},
	}
}

fn ranks_in_class(
	taxonomy: &Taxonomy,
	phase: ClassificationPhase,
	class: &ClassId<str>,
	model: &str,
) -> (Option<FamilyId>, Option<SemVer>) {
	match taxonomy.ranks_in_class(class, model) {
		Ok(ranks) => ranks,
		Err(error) => match phase {
			ClassificationPhase::DiscoveryNormalizer => (None, None),
			ClassificationPhase::CatalogCompiler => {
				panic!("bundled taxonomy classification is ambiguous: {error}")
			},
		},
	}
}

#[cfg(test)]
mod tests {
	use omp_core::semver;

	use super::*;

	fn compiler(model: &str) -> ModelClassification {
		classify(ClassificationInput {
			phase: ClassificationPhase::CatalogCompiler,
			provider: "test",
			model,
			observed_at_ms: None,
		})
	}

	#[test]
	fn classifies_bounded_classes_without_substring_false_positives() {
		assert_eq!(compiler("openrouter/qwen/qwen3-coder").class.as_str(), "qwen");
		assert_eq!(compiler("acme/notqwen-model").class.as_str(), "unknown");
		assert_eq!(compiler("xai/grok-4.6").class.as_str(), "xai");
		assert_eq!(compiler("myxai/grokker").class.as_str(), "unknown");
	}

	#[test]
	fn preserves_qwen3_max_product_name_and_collapses_thinking_sibling() {
		let ordinary = compiler("qwen/qwen3-max");
		assert_eq!(ordinary.logical_model.as_str(), "qwen/qwen3-max");
		assert_eq!(ordinary.effort, None);
		let thinking = compiler("qwen/qwen3-max-thinking");
		assert_eq!(thinking.logical_model.as_str(), "qwen/qwen3-max");
		assert!(thinking.thinking_variant);
	}

	#[test]
	fn preserves_reviewed_kimi_thinking_products() {
		for provider in ["kilo", "openrouter", "vercel-ai-gateway"] {
			let product = classify(ClassificationInput {
				phase: ClassificationPhase::CatalogCompiler,
				provider,
				model: "kimi-k2-thinking",
				observed_at_ms: None,
			});
			assert_eq!(product.logical_model.as_str(), "moonshotai/kimi-k2-thinking");
			assert_eq!(product.class.as_str(), "kimi");
			assert_eq!(product.family.as_ref().map(|family| family.as_str()), Some("k2-thinking"));
			assert_eq!(product.effort, None);
			assert!(!product.thinking_variant);
			assert_eq!(product.evidence.method, ClassificationMethod::ExactOverride);
		}
	}

	#[test]
	fn exact_overrides_infer_ranks_within_their_final_class() {
		for (provider, model, family) in [
			("umans", "umans-deepseek-v4-flash-0731", "flash"),
			("umans", "umans-deepseek-v4-flash-0731-lab", "flash"),
			("venice", "e2ee-deepseek-v4-flash", "flash"),
			("kilo", "qwq-32b", "qwq"),
			("openrouter", "qwq-32b", "qwq"),
		] {
			let product = classify(ClassificationInput {
				phase: ClassificationPhase::CatalogCompiler,
				provider,
				model,
				observed_at_ms: None,
			});
			assert_eq!(product.family.as_ref().map(|family| family.as_str()), Some(family));
			assert_eq!(product.evidence.method, ClassificationMethod::ExactOverride);
		}
	}

	#[test]
	fn openai_omni_names_do_not_imply_the_o_series_family() {
		let product = compiler("openai/omni-moderation-latest");
		assert_eq!(product.class.as_str(), "openai");
		assert_eq!(product.family, None);
	}

	#[test]
	fn openai_o_series_family_accepts_only_admitted_spellings() {
		for model in ["o1", "o1-mini", "o1.2", "o3", "o3-mini", "o3.2", "o4", "o4-mini", "o4.2"] {
			assert_eq!(
				compiler(model)
					.family
					.as_ref()
					.map(|family| family.as_str()),
				Some("o-series")
			);
		}
		for model in ["openai/omni-realtime", "openai/orbit", "openai/o5-mini"] {
			assert_eq!(compiler(model).family, None);
		}
	}

	#[test]
	fn discovery_returns_conservative_ranks_for_taxonomy_ambiguity() {
		let ambiguous_class = Taxonomy::parse(&[(
			"ambiguous-class.kdl",
			r#"
				class "alpha" { exact "same" }
				class "beta" { exact "same" }
				collapse { thinking-suffix "-thinking" }
			"#,
		)])
		.expect("test taxonomy must parse");
		let class_result = classify_with_taxonomy(
			ClassificationInput {
				phase:          ClassificationPhase::DiscoveryNormalizer,
				provider:       "test",
				model:          "same",
				observed_at_ms: None,
			},
			&ambiguous_class,
		);
		assert_eq!(class_result.class.as_str(), "unknown");
		assert_eq!(class_result.family, None);
		assert_eq!(class_result.revision, None);

		let ambiguous_family = Taxonomy::parse(&[(
			"ambiguous-family.kdl",
			r#"
				class "alpha" {
					exact "same1"
					family "first" glob="same1"
					family "second" glob="same1"
					revision prefix="same"
				}
				collapse { thinking-suffix "-thinking" }
			"#,
		)])
		.expect("test taxonomy must parse");
		let family_result = classify_with_taxonomy(
			ClassificationInput {
				phase:          ClassificationPhase::DiscoveryNormalizer,
				provider:       "test",
				model:          "same1",
				observed_at_ms: None,
			},
			&ambiguous_family,
		);
		assert_eq!(family_result.class.as_str(), "alpha");
		assert_eq!(family_result.family, None);
		assert_eq!(family_result.revision, None);
	}

	#[test]
	fn collapses_all_effort_tiers() {
		for (suffix, effort) in [
			("none", EffortTier::Off),
			("minimal", EffortTier::Minimal),
			("low", EffortTier::Low),
			("medium", EffortTier::Medium),
			("high", EffortTier::High),
			("xhigh", EffortTier::XHigh),
			("extra-high", EffortTier::XHigh),
			("max", EffortTier::Max),
		] {
			let value = compiler(&format!("gpt-5-luna-{suffix}"));
			assert_eq!(value.logical_model.as_str(), "gpt-5-luna");
			assert_eq!(value.effort, Some(effort));
		}
	}

	#[test]
	fn bundled_dynamic_cursor_families_are_data_driven() {
		assert!(supports_dynamic_effort_siblings("CURSOR"));
		assert_eq!(strip_effort_lane("cursor", "gpt-5.6-luna-fast"), "gpt-5.6-luna");
		assert_eq!(strip_effort_lane("other", "gpt-5.6-luna-fast"), "gpt-5.6-luna-fast");
	}

	#[test]
	fn classifies_gemini_tiered_alias_as_the_canonical_effort_family() {
		let classified = classify(ClassificationInput {
			phase:          ClassificationPhase::DiscoveryNormalizer,
			provider:       "google-antigravity",
			model:          "gemini-3.7-flash-tiered",
			observed_at_ms: None,
		});
		assert_eq!(classified.logical_model.as_str(), "gemini-3.7-flash");
		assert_eq!(classified.effort, None);
		assert_eq!(classified.evidence.method, ClassificationMethod::StructuralSuffix);
		assert_eq!(classified.evidence.rule.as_str(), "effort-family-alias-v1");
	}

	#[test]
	fn collapses_cursor_grok_effort_lanes_per_service_tier() {
		// Each Cursor Grok service-tier lane is one logical model; the `-fast`
		// lane routes efforts onto the `-<effort>-fast` wire siblings while the
		// standard lane keeps the plain collapse.
		let cursor = |model: &str| {
			classify(ClassificationInput {
				phase: ClassificationPhase::CatalogCompiler,
				provider: "cursor",
				model,
				observed_at_ms: None,
			})
		};
		let fast = cursor("cursor-grok-4.6-low-fast");
		assert_eq!(fast.logical_model.as_str(), "cursor-grok-4.6-fast");
		assert_eq!(fast.effort, Some(EffortTier::Low));
		assert_eq!(fast.evidence.method, ClassificationMethod::StructuralSuffix);
		let xhigh = cursor("cursor-grok-4.6-xhigh-fast");
		assert_eq!(xhigh.logical_model.as_str(), "cursor-grok-4.6-fast");
		assert_eq!(xhigh.effort, Some(EffortTier::XHigh));
		let plain = cursor("cursor-grok-4.6-high");
		assert_eq!(plain.logical_model.as_str(), "cursor-grok-4.6");
		assert_eq!(plain.effort, Some(EffortTier::High));
		// The lane is provider-scoped; other hosts keep the sibling identity.
		let elsewhere = compiler("cursor-grok-4.6-low-fast");
		assert_eq!(elsewhere.logical_model.as_str(), "cursor-grok-4.6-low-fast");
		assert_eq!(elsewhere.effort, None);
		// Coding SKUs do not carry a wedged effort suffix. Other Cursor lanes
		// are classified structurally, then batch safety decides collapse.
		assert_eq!(cursor("grok-code-fast-1").logical_model.as_str(), "grok-code-fast-1");
		assert_eq!(cursor("claude-opus-5-high-fast").logical_model.as_str(), "claude-opus-5-fast");
	}

	#[test]
	fn expired_exact_override_falls_back_to_rules() {
		let before_expiry = classify(ClassificationInput {
			phase:          ClassificationPhase::CatalogCompiler,
			provider:       "openai",
			model:          "gpt-daybreak-blue-latest",
			observed_at_ms: Some(1_799_711_999_999),
		});
		assert_eq!(before_expiry.evidence.method, ClassificationMethod::ExactOverride);
		assert_eq!(before_expiry.revision, Some(semver!(5.6)));

		let at_expiry = classify(ClassificationInput {
			phase:          ClassificationPhase::CatalogCompiler,
			provider:       "openai",
			model:          "gpt-daybreak-blue-latest",
			observed_at_ms: Some(1_799_712_000_000),
		});
		assert_eq!(at_expiry.evidence.method, ClassificationMethod::ClassRule);
		assert_eq!(at_expiry.revision, None);
	}
}
