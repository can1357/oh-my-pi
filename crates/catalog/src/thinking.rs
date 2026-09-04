//! Typed reasoning effort, budget, display, and wire-routing policies.

#![allow(missing_docs, reason = "strum IntoStaticStr emits undocumented inherent methods")]
use std::collections::{BTreeMap, btree_map};

use omp_core::Str;
use serde::{Deserialize, Serialize};
use smallvec::SmallVec;
use strum::{Display, EnumString, IntoStaticStr, VariantNames};

use crate::{
	capability::ReasoningEffort,
	id::{ThinkingPolicyId, WireModelId},
	policy::content_id,
};

/// Portable reasoning effort ordered from disabled to maximum.
#[derive(
	Clone,
	Copy,
	Debug,
	Display,
	EnumString,
	Eq,
	Hash,
	IntoStaticStr,
	Ord,
	PartialEq,
	PartialOrd,
	Serialize,
	Deserialize,
	VariantNames,
)]
#[serde(rename_all = "lowercase")]
#[strum(serialize_all = "lowercase", ascii_case_insensitive, const_into_str)]
pub enum ThinkingEffort {
	/// Explicitly disable reasoning.
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
	#[serde(alias = "x_high")]
	#[strum(to_string = "xhigh", serialize = "x_high")]
	XHigh,
	/// Provider-defined maximum reasoning.
	Max,
}

/// Stable display metadata for one portable reasoning effort.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct ThinkingEffortMetadata {
	/// Canonical effort value.
	pub effort:      ThinkingEffort,
	/// Compact picker/status label.
	pub label:       &'static str,
	/// Stable budget-oriented description.
	pub description: &'static str,
}

impl ThinkingEffort {
	/// Returns allocation-free picker and status metadata.
	pub const fn metadata(self) -> ThinkingEffortMetadata {
		let (label, description) = match self {
			Self::Off => ("off", "No reasoning"),
			Self::Minimal => ("min", "Very brief reasoning (~1k tokens)"),
			Self::Low => ("low", "Light reasoning (~2k tokens)"),
			Self::Medium => ("medium", "Moderate reasoning (~8k tokens)"),
			Self::High => ("high", "Deep reasoning (~16k tokens)"),
			Self::XHigh => ("xhigh", "Extended reasoning (~32k tokens)"),
			Self::Max => ("max", "Maximum reasoning the model supports"),
		};
		ThinkingEffortMetadata { effort: self, label, description }
	}
}

impl From<ReasoningEffort> for ThinkingEffort {
	fn from(effort: ReasoningEffort) -> Self {
		match effort {
			ReasoningEffort::Off => Self::Off,
			ReasoningEffort::Minimal => Self::Minimal,
			ReasoningEffort::Low => Self::Low,
			ReasoningEffort::Medium => Self::Medium,
			ReasoningEffort::High => Self::High,
			ReasoningEffort::Xhigh => Self::XHigh,
			ReasoningEffort::Max => Self::Max,
		}
	}
}

impl From<ThinkingEffort> for ReasoningEffort {
	fn from(effort: ThinkingEffort) -> Self {
		match effort {
			ThinkingEffort::Off => Self::Off,
			ThinkingEffort::Minimal => Self::Minimal,
			ThinkingEffort::Low => Self::Low,
			ThinkingEffort::Medium => Self::Medium,
			ThinkingEffort::High => Self::High,
			ThinkingEffort::XHigh => Self::Xhigh,
			ThinkingEffort::Max => Self::Max,
		}
	}
}

/// Coarse model-relative effort selector used by delegated tasks.
#[derive(Clone, Copy, Debug, Display, EnumString, Eq, Hash, IntoStaticStr, PartialEq)]
#[strum(serialize_all = "lowercase", ascii_case_insensitive, const_into_str)]
pub enum ThinkingEffortSelector {
	/// Lowest supported effort.
	Lo,
	/// Lower-middle supported effort.
	Med,
	/// Highest supported effort.
	Hi,
}

/// Provider-native control used to select reasoning intensity.
#[derive(
	Clone,
	Copy,
	Debug,
	Display,
	EnumString,
	Eq,
	Hash,
	IntoStaticStr,
	Ord,
	PartialEq,
	PartialOrd,
	Serialize,
	Deserialize,
)]
#[serde(rename_all = "kebab-case")]
#[strum(serialize_all = "kebab-case", ascii_case_insensitive)]
pub enum ThinkingMode {
	/// Send a named effort.
	Effort,
	/// Send a token budget.
	Budget,
	/// Send a Google thinking level.
	GoogleLevel,
	/// Use Anthropic adaptive thinking.
	AnthropicAdaptive,
	/// Use Anthropic budget thinking plus an effort.
	AnthropicBudgetEffort,
}

impl ThinkingMode {
	/// Returns the canonical static spelling for this control mode.
	pub const fn into_str(&self) -> &'static str {
		match self {
			Self::Effort => "effort",
			Self::Budget => "budget",
			Self::GoogleLevel => "google-level",
			Self::AnthropicAdaptive => "anthropic-adaptive",
			Self::AnthropicBudgetEffort => "anthropic-budget-effort",
		}
	}
}

/// Additional serving path selected independently of effort.
#[derive(
	Clone,
	Copy,
	Debug,
	Display,
	EnumString,
	Eq,
	Hash,
	IntoStaticStr,
	Ord,
	PartialEq,
	PartialOrd,
	Serialize,
	Deserialize,
)]
#[serde(rename_all = "lowercase")]
#[strum(serialize_all = "lowercase", ascii_case_insensitive)]
pub enum ReasoningMode {
	/// Use the provider's pro reasoning path.
	Pro,
}

impl ReasoningMode {
	/// Returns the canonical static spelling for this serving path.
	pub const fn into_str(&self) -> &'static str {
		match self {
			Self::Pro => "pro",
		}
	}
}

/// Structurally interned reasoning capability profile.
///
/// Effort spelling and wire-model routing are intentionally stored in
/// [`ThinkingRouting`], because two deployments with the same capability shape
/// may use different opaque wire identifiers.
#[derive(Clone, Debug, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThinkingPolicy {
	/// Provider-native control mode.
	pub mode:              ThinkingMode,
	/// Supported non-off efforts ordered from least to most intensive.
	pub efforts:           SmallVec<ThinkingEffort, 6>,
	/// Default effort when the caller does not choose one.
	pub default_level:     Option<ThinkingEffort>,
	/// Per-effort thinking token budgets.
	#[serde(default)]
	pub effort_budgets:    BTreeMap<ThinkingEffort, u64>,
	/// Per-effort native control spellings.
	#[serde(default)]
	pub effort_map:        BTreeMap<ThinkingEffort, Str>,
	/// Whether signed thinking binds to the exact preceding prefix.
	#[serde(default)]
	pub prefix_binding:    Option<bool>,
	/// Whether adaptive-thinking display controls are supported.
	pub supports_display:  Option<bool>,
	/// Whether disabling reasoning must be explicit on the wire.
	pub suppress_when_off: Option<bool>,
	/// Whether an omitted or off effort is invalid.
	pub requires_effort:   Option<bool>,
}

impl ThinkingPolicy {
	/// Creates the smallest valid profile for a mode and ordered effort list.
	pub fn new(
		mode: ThinkingMode,
		efforts: impl IntoIterator<Item = ThinkingEffort>,
	) -> Result<Self, ThinkingPolicyError> {
		let profile = Self {
			mode,
			efforts: efforts.into_iter().collect(),
			default_level: None,
			effort_budgets: BTreeMap::new(),
			effort_map: BTreeMap::new(),
			prefix_binding: None,
			supports_display: None,
			suppress_when_off: None,
			requires_effort: None,
		};
		profile.validate()?;
		Ok(profile)
	}

	/// Validates effort ordering and cross-field references.
	pub fn validate(&self) -> Result<(), ThinkingPolicyError> {
		if self.efforts.is_empty() {
			return Err(ThinkingPolicyError::NoEfforts);
		}
		let mut previous = None;
		for effort in &self.efforts {
			if *effort == ThinkingEffort::Off {
				return Err(ThinkingPolicyError::OffAdvertised);
			}
			if previous.is_some_and(|prior| prior >= *effort) {
				return Err(ThinkingPolicyError::EffortsNotStrictlyOrdered);
			}
			previous = Some(*effort);
		}
		if let Some(default) = self.default_level
			&& !self.efforts.contains(&default)
		{
			return Err(ThinkingPolicyError::UnknownDefault(default));
		}
		for effort in self.effort_budgets.keys() {
			if !self.efforts.contains(effort) {
				return Err(ThinkingPolicyError::UnknownBudget(*effort));
			}
		}
		Ok(())
	}

	/// Reports whether an effort may be selected.
	pub fn supports(&self, effort: ThinkingEffort) -> bool {
		if effort == ThinkingEffort::Off {
			return self.requires_effort != Some(true);
		}
		self.efforts.contains(&effort)
	}

	/// Returns the configured budget for an effort.
	pub fn budget(&self, effort: ThinkingEffort) -> Option<u64> {
		self.effort_budgets.get(&effort).copied()
	}

	/// Serializes the profile into deterministic structural bytes.
	pub fn canonical_bytes(&self) -> Vec<u8> {
		serde_json::to_vec(self).expect("typed thinking policy always serializes")
	}

	/// Returns the stable content-derived profile identifier.
	pub fn content_id(&self) -> ThinkingPolicyId {
		ThinkingPolicyId::from(content_id("thinking", &self.canonical_bytes()))
	}
}

/// Model-specific effort spelling and opaque wire-model routing.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ThinkingRouting {
	/// Canonical-to-native effort spelling overrides.
	pub effort_map:     BTreeMap<ThinkingEffort, Str>,
	/// Canonical effort to opaque wire-model identifier.
	pub effort_routing: BTreeMap<ThinkingEffort, WireModelId>,
	/// Additional provider serving path.
	pub reasoning_mode: Option<ReasoningMode>,
}

/// Clamps an effort to both a configured ceiling and the model's advertised
/// ceiling.
///
/// Unsupported intermediate levels clamp downward to the greatest
/// model-supported effort. `Off` remains available unless the model requires
/// reasoning.
pub fn clamp_thinking_effort(
	policy: &ThinkingPolicy,
	requested: Option<ThinkingEffort>,
	configured_ceiling: Option<ThinkingEffort>,
) -> Option<ThinkingEffort> {
	let requested = requested.or(policy.default_level)?;
	let model_ceiling = policy
		.efforts
		.last()
		.copied()
		.unwrap_or(ThinkingEffort::Off);
	let ceiling = configured_ceiling.map_or(model_ceiling, |ceiling| ceiling.min(model_ceiling));
	if requested == ThinkingEffort::Off {
		return Some(ThinkingEffort::Off);
	}
	let bounded = requested.min(ceiling);
	let mut floor = None;
	let mut clamped = None;
	for effort in policy.efforts.iter().copied() {
		if effort > ceiling {
			break;
		}
		floor.get_or_insert(effort);
		if effort <= bounded {
			clamped = Some(effort);
		}
	}
	clamped.or(floor)
}

/// Resolves `lo`, `med`, or `hi` against a model ladder and optional ceiling.
///
/// The median of an even-sized ladder is the lower middle. A ceiling below the
/// model floor has no compatible selection.
pub fn resolve_thinking_selector(
	policy: &ThinkingPolicy,
	selector: ThinkingEffortSelector,
	configured_ceiling: Option<ThinkingEffort>,
) -> Option<ThinkingEffort> {
	let model_ceiling = policy.efforts.last().copied()?;
	let ceiling = configured_ceiling.map_or(model_ceiling, |value| value.min(model_ceiling));
	let count = policy
		.efforts
		.iter()
		.take_while(|effort| **effort <= ceiling)
		.count();
	if count == 0 {
		return None;
	}
	let index = match selector {
		ThinkingEffortSelector::Lo => 0,
		ThinkingEffortSelector::Med => (count - 1) / 2,
		ThinkingEffortSelector::Hi => count - 1,
	};
	policy.efforts.get(index).copied()
}

/// Invalid task-level effort selection.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum TaskThinkingError {
	/// The operator ceiling excludes the resolved model's entire effort ladder.
	#[error(
		"model has no supported thinking effort at or below task.maxEffort={ceiling} (model floor \
		 is {floor})"
	)]
	CeilingBelowFloor {
		/// Configured task ceiling.
		ceiling: ThinkingEffort,
		/// Lowest model-supported effort.
		floor:   ThinkingEffort,
	},
}

/// Maps a task `lo`/`med`/`hi` selector over the full model ladder, then
/// clamps the result to `task.maxEffort`.
///
/// A ceiling below the model floor is rejected rather than silently selecting
/// an unsupported effort.
pub fn resolve_task_thinking_selector(
	policy: &ThinkingPolicy,
	selector: ThinkingEffortSelector,
	max_effort: Option<ThinkingEffort>,
) -> Result<Option<ThinkingEffort>, TaskThinkingError> {
	let Some(floor) = policy.efforts.first().copied() else {
		return Ok(None);
	};
	let selected = match selector {
		ThinkingEffortSelector::Lo => floor,
		ThinkingEffortSelector::Med => policy.efforts[(policy.efforts.len() - 1) / 2],
		ThinkingEffortSelector::Hi => *policy.efforts.last().expect("nonempty effort ladder"),
	};
	let Some(max_effort) = max_effort else {
		return Ok(Some(selected));
	};
	let ceiling = policy
		.efforts
		.iter()
		.rev()
		.copied()
		.find(|effort| *effort <= max_effort)
		.ok_or(TaskThinkingError::CeilingBelowFloor { ceiling: max_effort, floor })?;
	Ok(Some(selected.min(ceiling)))
}

/// Reports whether a controllable ladder has an effort at or below a ceiling.
///
/// An absent policy represents an uncontrollable ladder and is compatible
/// because no effort can be forwarded.
pub fn thinking_ceiling_compatible(
	policy: Option<&ThinkingPolicy>,
	ceiling: ThinkingEffort,
) -> bool {
	policy.is_none_or(|policy| policy.efforts.iter().any(|effort| *effort <= ceiling))
}

/// Model-specific effort spelling and opaque wire-model routing.
impl ThinkingRouting {
	/// Validates that every native spelling override refers to an advertised
	/// effort or off.
	pub fn validate(&self, policy: &ThinkingPolicy) -> Result<(), ThinkingSelectionError> {
		let valid = |effort: &ThinkingEffort| {
			*effort == ThinkingEffort::Off || policy.efforts.contains(effort)
		};
		if let Some(effort) = self.effort_map.keys().find(|effort| !valid(effort)) {
			return Err(ThinkingSelectionError::UnsupportedEffort(*effort));
		}
		Ok(())
	}

	/// Resolves caller effort to exact native spelling, budget, and wire model.
	pub fn resolve(
		&self,
		policy: &ThinkingPolicy,
		requested: Option<ThinkingEffort>,
		default_wire_model: &WireModelId<str>,
	) -> Result<ThinkingSelection, ThinkingSelectionError> {
		self.validate(policy)?;
		let effort = match requested.or(policy.default_level) {
			Some(ThinkingEffort::Off) => ThinkingEffort::Off,
			Some(effort) => clamp_thinking_effort(policy, Some(effort), None)
				.ok_or(ThinkingSelectionError::UnsupportedEffort(effort))?,
			None if policy.requires_effort == Some(true) => {
				return Err(ThinkingSelectionError::RequiredEffortMissing);
			},
			None => ThinkingEffort::Off,
		};
		if !policy.supports(effort) {
			return Err(ThinkingSelectionError::UnsupportedEffort(effort));
		}
		let native_effort = self.effort_map.get(&effort).cloned();
		// A collapsed family may alias `minimal` onto the sibling `low` wire
		// identity (Cloud Code Assist Gemini 3.6/3.7 Flash route both onto the
		// `-low` SKU, which rejects wire `MINIMAL`. The wire
		// effort names the canonical effort that owns the routed identity so
		// codecs spell the level that SKU actually accepts.
		let wire_effort = if effort == ThinkingEffort::Minimal
			&& let Some(routed) = self.effort_routing.get(&ThinkingEffort::Minimal)
			&& self.effort_routing.get(&ThinkingEffort::Low) == Some(routed)
		{
			ThinkingEffort::Low
		} else {
			effort
		};
		let wire_model = self
			.effort_routing
			.get(&effort)
			.map_or_else(|| default_wire_model.to_owned(), Clone::clone);
		// MiniMax on Anthropic-shaped routes maps every advertised effort onto
		// the literal `adaptive` tag: the control surface is `thinking.type`,
		// not `output_config.effort`, so codecs must neither pin an effort nor
		// treat the model as adaptive-only when thinking is off.
		let adaptive_tag_only = policy.mode == ThinkingMode::AnthropicAdaptive
			&& !policy.efforts.is_empty()
			&& policy.efforts.iter().all(|effort| {
				self
					.effort_map
					.get(effort)
					.is_some_and(|native| native.as_str() == ADAPTIVE_TAG)
			});
		Ok(ThinkingSelection {
			effort,
			wire_effort,
			native_effort,
			budget: policy.budget(effort),
			wire_model,
			reasoning_mode: self.reasoning_mode,
			suppress_when_off: effort == ThinkingEffort::Off && policy.suppress_when_off == Some(true),
			adaptive_tag_only,
		})
	}
}

/// Native effort spelling that turns `output_config.effort` into a no-op tag.
const ADAPTIVE_TAG: &str = "adaptive";

/// Fully resolved reasoning controls for one encoded request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ThinkingSelection {
	/// Selected canonical effort.
	pub effort:            ThinkingEffort,
	/// Canonical effort that owns the routed wire identity.
	///
	/// Differs from [`Self::effort`] only when a collapsed family aliases the
	/// requested effort onto a sibling's wire model (Cloud Code Assist rejects
	/// wire `MINIMAL` on `-low` SKUs).
	pub wire_effort:       ThinkingEffort,
	/// Provider-native spelling override, when one exists.
	pub native_effort:     Option<Str>,
	/// Provider-native token budget, when one exists.
	pub budget:            Option<u64>,
	/// Opaque wire model selected for this effort.
	pub wire_model:        WireModelId,
	/// Additional serving path.
	pub reasoning_mode:    Option<ReasoningMode>,
	/// Whether the wire reasoning control must be suppressed while off.
	pub suppress_when_off: bool,
	/// Whether every advertised effort spells the native `adaptive` tag, so
	/// the model is driven by `thinking.type` alone and still accepts
	/// `thinking.type: disabled` (`MiniMax` on Anthropic-shaped routes).
	pub adaptive_tag_only: bool,
}

/// Invalid structural reasoning profile.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ThinkingPolicyError {
	/// A reasoning profile advertised no effort.
	#[error("thinking policy must advertise at least one effort")]
	NoEfforts,
	/// Off was incorrectly included in the advertised non-off effort list.
	#[error("off is implicit and cannot be advertised as a non-off effort")]
	OffAdvertised,
	/// Efforts were duplicated or not ordered least-to-most.
	#[error("thinking efforts must be unique and strictly ordered")]
	EffortsNotStrictlyOrdered,
	/// The default effort was not advertised.
	#[error("default thinking effort `{0}` is not advertised")]
	UnknownDefault(ThinkingEffort),
	/// A budget referred to an unadvertised effort.
	#[error("thinking budget effort `{0}` is not advertised")]
	UnknownBudget(ThinkingEffort),
}

/// Invalid reasoning selection or model-specific routing table.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum ThinkingSelectionError {
	/// A required effort was omitted.
	#[error("this model requires an explicit reasoning effort")]
	RequiredEffortMissing,
	/// An effort is not supported by the structural profile.
	#[error("reasoning effort `{0}` is not supported")]
	UnsupportedEffort(ThinkingEffort),
}

/// Stable structural table that interns equal reasoning profiles once.
#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize, Deserialize)]
pub struct ThinkingPolicyTable {
	entries: BTreeMap<ThinkingPolicyId, ThinkingPolicy>,
}

impl ThinkingPolicyTable {
	/// Validates and interns a profile, returning its stable content identifier.
	pub fn intern(
		&mut self,
		policy: ThinkingPolicy,
	) -> Result<ThinkingPolicyId, ThinkingPolicyError> {
		policy.validate()?;
		let id = policy.content_id();
		self.entries.entry(id.clone()).or_insert(policy);
		Ok(id)
	}

	/// Gets an interned profile by identifier.
	pub fn get(&self, id: &ThinkingPolicyId<str>) -> Option<&ThinkingPolicy> {
		self.entries.get(id)
	}

	/// Iterates over profiles in stable identifier order.
	pub fn iter(&self) -> btree_map::Iter<'_, ThinkingPolicyId, ThinkingPolicy> {
		self.entries.iter()
	}

	/// Returns the number of distinct structural profiles.
	pub fn len(&self) -> usize {
		self.entries.len()
	}

	/// Reports whether no profile is interned.
	pub fn is_empty(&self) -> bool {
		self.entries.is_empty()
	}
}

impl<'a> IntoIterator for &'a ThinkingPolicyTable {
	type IntoIter = btree_map::Iter<'a, ThinkingPolicyId, ThinkingPolicy>;
	type Item = (&'a ThinkingPolicyId, &'a ThinkingPolicy);

	fn into_iter(self) -> Self::IntoIter {
		self.entries.iter()
	}
}

#[cfg(test)]
mod tests {
	use serde::Deserialize;

	use super::*;

	#[derive(Deserialize)]
	struct ThinkingFixture {
		profile_count: usize,
		profiles:      Vec<ThinkingCase>,
	}

	#[derive(Deserialize)]
	struct ThinkingCase {
		shape: ThinkingPolicy,
	}

	#[test]
	fn every_thinking_fixture_shape_is_valid_distinct_and_content_stable() {
		let fixture: ThinkingFixture = serde_json::from_str(include_str!(
			"../../../fixtures/llm-oracle/catalog-policy/thinking-profiles.json"
		))
		.expect("thinking fixture parses into typed profiles");
		assert_eq!(fixture.profiles.len(), fixture.profile_count);

		let mut table = ThinkingPolicyTable::default();
		for case in fixture.profiles {
			case.shape.validate().expect("fixture profile is valid");
			let id = case.shape.content_id();
			let bytes = case.shape.canonical_bytes();
			let decoded: ThinkingPolicy =
				serde_json::from_slice(&bytes).expect("canonical profile bytes decode");
			assert_eq!(decoded.content_id(), id);
			assert_eq!(table.intern(case.shape).expect("valid intern"), id);
		}
		assert_eq!(table.len(), 43);
	}

	#[test]
	fn routing_resolves_off_default_budget_and_native_wire_overrides() {
		let mut policy =
			ThinkingPolicy::new(ThinkingMode::Budget, [ThinkingEffort::Low, ThinkingEffort::High])
				.expect("ordered efforts");
		policy.default_level = Some(ThinkingEffort::Low);
		policy.effort_budgets.insert(ThinkingEffort::Low, 1_001);
		policy.suppress_when_off = Some(true);

		let mut routing = ThinkingRouting::default();
		routing
			.effort_map
			.insert(ThinkingEffort::Low, Str::new_static("low-native"));
		routing
			.effort_routing
			.insert(ThinkingEffort::Low, "model-low".into());
		let selection = routing
			.resolve(&policy, None, WireModelId::from_ref("model-default"))
			.expect("default effort resolves");
		assert_eq!(selection.effort, ThinkingEffort::Low);
		assert_eq!(selection.native_effort.as_deref(), Some("low-native"));
		assert_eq!(selection.budget, Some(1_001));
		assert_eq!(selection.wire_model, "model-low");

		let off = routing
			.resolve(&policy, Some(ThinkingEffort::Off), WireModelId::from_ref("model-default"))
			.expect("off resolves when effort is optional");
		assert!(off.suppress_when_off);
		assert_eq!(off.wire_model, "model-default");
		assert!(!off.adaptive_tag_only);
	}

	#[test]
	fn adaptive_tag_only_requires_every_effort_to_spell_adaptive() {
		let policy = ThinkingPolicy::new(ThinkingMode::AnthropicAdaptive, [
			ThinkingEffort::Low,
			ThinkingEffort::High,
		])
		.expect("ordered efforts");
		let mut routing = ThinkingRouting::default();
		routing
			.effort_map
			.insert(ThinkingEffort::Low, Str::new_static("adaptive"));
		let partial = routing
			.resolve(&policy, Some(ThinkingEffort::Off), WireModelId::from_ref("m"))
			.expect("off resolves");
		assert!(!partial.adaptive_tag_only, "one mapped effort is not a tag-only profile");

		routing
			.effort_map
			.insert(ThinkingEffort::High, Str::new_static("adaptive"));
		let tag_only = routing
			.resolve(&policy, Some(ThinkingEffort::Off), WireModelId::from_ref("m"))
			.expect("off resolves");
		assert!(tag_only.adaptive_tag_only);

		let budget =
			ThinkingPolicy::new(ThinkingMode::Budget, [ThinkingEffort::Low, ThinkingEffort::High])
				.expect("ordered efforts");
		let budget_selection = routing
			.resolve(&budget, Some(ThinkingEffort::Off), WireModelId::from_ref("m"))
			.expect("off resolves");
		assert!(!budget_selection.adaptive_tag_only, "only anthropic-adaptive profiles qualify");
	}

	#[test]
	fn minimal_aliased_onto_the_low_wire_model_spells_low() {
		// Cloud Code Assist Gemini 3.6/3.7 Flash route both minimal and low
		// onto the `-low` SKU, which rejects wire `MINIMAL`.
		let policy = ThinkingPolicy::new(ThinkingMode::GoogleLevel, [
			ThinkingEffort::Minimal,
			ThinkingEffort::Low,
			ThinkingEffort::Medium,
			ThinkingEffort::High,
		])
		.expect("ordered efforts");
		let mut routing = ThinkingRouting::default();
		routing
			.effort_routing
			.insert(ThinkingEffort::Minimal, "gemini-3.7-flash-low".into());
		routing
			.effort_routing
			.insert(ThinkingEffort::Low, "gemini-3.7-flash-low".into());
		routing
			.effort_routing
			.insert(ThinkingEffort::Medium, "gemini-3.7-flash-medium".into());
		let aliased = routing
			.resolve(&policy, Some(ThinkingEffort::Minimal), WireModelId::from_ref("gemini-3.7-flash"))
			.expect("minimal resolves");
		assert_eq!(aliased.effort, ThinkingEffort::Minimal);
		assert_eq!(aliased.wire_effort, ThinkingEffort::Low);
		assert_eq!(aliased.wire_model, "gemini-3.7-flash-low");

		// Unaliased minimal keeps its own wire identity and spelling.
		let mut unaliased = ThinkingRouting::default();
		unaliased
			.effort_routing
			.insert(ThinkingEffort::Minimal, "gemini-3.7-flash-minimal".into());
		unaliased
			.effort_routing
			.insert(ThinkingEffort::Low, "gemini-3.7-flash-low".into());
		let selection = unaliased
			.resolve(&policy, Some(ThinkingEffort::Minimal), WireModelId::from_ref("gemini-3.7-flash"))
			.expect("minimal resolves");
		assert_eq!(selection.wire_effort, ThinkingEffort::Minimal);
	}

	#[test]
	fn every_over_ceiling_effort_clamps_down_at_the_policy_boundary() {
		let policy = ThinkingPolicy::new(ThinkingMode::Effort, [
			ThinkingEffort::Low,
			ThinkingEffort::Medium,
			ThinkingEffort::High,
		])
		.expect("policy");
		assert_eq!(
			clamp_thinking_effort(&policy, Some(ThinkingEffort::Max), Some(ThinkingEffort::Medium)),
			Some(ThinkingEffort::Medium)
		);
		assert_eq!(
			clamp_thinking_effort(&policy, Some(ThinkingEffort::XHigh), None),
			Some(ThinkingEffort::High)
		);
	}
}
