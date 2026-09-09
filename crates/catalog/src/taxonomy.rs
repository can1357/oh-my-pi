//! Checked-in model identity taxonomy.

use std::{
	borrow::Cow,
	collections::{BTreeMap, BTreeSet},
	sync::LazyLock,
};

use kdl::{KdlDocument, KdlNode, KdlValue};
use omp_core::{IntoStr, SemVer, Str};
use thiserror::Error;

use crate::{
	cascade::{CascadeError, RevisionConstraint, glob_match, parse_revision_constraint},
	classify::EffortTier,
	id::{ClassId, FamilyId, ProviderId},
	thinking::ThinkingMode,
};

const REVISION_PLACEHOLDER: &str = "{rev}";

macro_rules! sources {
	($($name:literal),+ $(,)?) => {
		&[$(($name, include_str!(concat!("../compat/taxonomy/", $name, ".kdl")))),+]
	};
}

/// Checked-in collapse vocabulary and class taxonomy sources.
pub const BUNDLED_TAXONOMY: &[(&str, &str)] = sources![
	"_collapse",
	"_discovery",
	"ai21",
	"amazon",
	"anthropic",
	"baidu",
	"bytedance",
	"cohere",
	"deepseek",
	"gemini",
	"gemma",
	"glm",
	"gpt-oss",
	"kimi",
	"meta",
	"mimo",
	"minimax",
	"mistral",
	"openai",
	"qwen",
	"stepfun",
	"unknown",
	"xai",
];

/// Kind and specificity rank of a class membership matcher.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum MatcherKind {
	/// Whole lowercased bare identifier.
	Exact,
	/// Bare identifier token with a recognized boundary.
	Bounded,
	/// Exact slash-separated namespace segment.
	Namespace,
	/// Lowercased bare-identifier prefix.
	Prefix,
	/// Anchored wildcard over the lowercased bare identifier.
	Glob,
}

impl MatcherKind {
	const fn rank(self) -> u8 {
		match self {
			Self::Exact => 4,
			Self::Bounded => 3,
			Self::Namespace => 2,
			Self::Prefix => 1,
			Self::Glob => 0,
		}
	}
}

/// One class membership matcher.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Matcher {
	/// Matching operation.
	pub kind:    MatcherKind,
	/// Lowercased matcher token.
	pub token:   Str,
	/// Whether a namespace token accepts legacy dot/colon segments and token
	/// boundaries.
	pub bounded: bool,
}

/// One product-family rule within a class.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct FamilyDef {
	/// Product family identifier.
	pub id:       FamilyId,
	/// Anchored wildcard matched against the lowercased bare name.
	pub glob:     Str,
	/// Explicit overlap priority.
	pub priority: i64,
}

/// One revision-prefix rule.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RevisionPrefix {
	/// Lowercased prefix spelling.
	pub prefix:   Str,
	/// Whether the prefix may occur after the start of the bare identifier.
	pub anywhere: bool,
}

/// Revision extraction rules for a class.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct RevisionDef {
	/// Prefixes used before scanning for a numeric run.
	pub prefixes:  Vec<RevisionPrefix>,
	/// Bare product names which intentionally carry no revision.
	pub skip_bare: Vec<Str>,
}

/// Reviewed exact identity correction.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct IdentityOverride {
	/// Stable review identifier.
	pub id:               Str,
	/// Optional exact provider source key.
	pub provider:         Option<Str>,
	/// Exact case-insensitive wire model identifier.
	pub model:            Str,
	/// Optional corrected logical model identifier.
	pub logical:          Option<Str>,
	/// Optional corrected class.
	pub class:            Option<ClassId>,
	/// Optional corrected product family.
	pub family:           Option<FamilyId>,
	/// Optional pinned revision.
	pub revision:         Option<SemVer>,
	/// Optional effort route.
	pub effort:           Option<EffortTier>,
	/// Optional thinking-sibling marker.
	pub thinking_variant: Option<bool>,
	/// Human-readable review rationale.
	pub rationale:        Str,
	/// Evidence provenance.
	pub provenance:       Str,
	/// Optional Unix-millisecond expiry.
	pub expires_at_ms:    Option<u64>,
}

/// One parsed model class definition.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ClassDef {
	/// Class identifier.
	pub id:        ClassId,
	/// Membership matchers.
	pub matchers:  Vec<Matcher>,
	/// Product-family rules.
	pub families:  Vec<FamilyDef>,
	/// Revision extraction rules.
	pub revisions: RevisionDef,
	/// Reviewed exact corrections stored with this class file.
	pub overrides: Vec<IdentityOverride>,
}

#[derive(Clone, Debug, Eq, PartialEq)]
struct SuffixDef {
	suffix:             Str,
	effort:             Option<EffortTier>,
	thinking:           bool,
	except_bare_prefix: Option<Str>,
}

/// One provider-scoped effort-lane suffix rule.
///
/// A provider may serve one logical model as parallel per-effort sibling
/// lanes (`cursor-grok-4.6-low-fast`): the trailing lane token
/// is transparent to effort collapse, so the effort-suffix vocabulary is
/// applied immediately before the lane suffix and the collapsed logical
/// identifier keeps the lane suffix — one logical model per service-tier
/// lane, never a second routing dimension.
#[derive(Clone, Debug, Eq, PartialEq)]
struct EffortLaneSuffix {
	/// Lowercased lane suffix (`-fast`).
	suffix:      Str,
	/// Providers whose rosters advertise this lane vocabulary.
	providers:   Box<[Str]>,
	/// Optional lowercased bare-name prefix gate for the lane.
	bare_prefix: Option<Str>,
}

/// One provider-scoped routing-variant suffix rule.
///
/// A discovered wire identifier carrying the suffix is a routing variant of
/// its plain identifier — the same backend model behind a different route —
/// so discovery derives base-model metadata from the plain bundled SKU while
/// keeping the suffixed wire identifier for requests.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RoutingVariantSuffix {
	/// Lowercased suffix marking the routing variant.
	pub suffix:    Str,
	/// Providers whose discovery advertises this variant vocabulary.
	pub providers: Box<[Str]>,
}

/// Parsed provider-scoped runtime-discovery vocabulary.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
struct DiscoveryVocabulary {
	/// Providers whose discovery recovers canonical intrinsic parameters.
	canonical_recovery:       Vec<Str>,
	/// Sibling-gateway groups whose bundled catalogs hint the responses route.
	responses_hint_groups:    Vec<Box<[Str]>>,
	/// Provider-scoped exact ids pinned to the responses route.
	responses_route_models:   BTreeMap<Str, Box<[Str]>>,
	/// Billing-variant suffixes sharing a transport with their base id.
	billing_variant_suffixes: Vec<Str>,
	/// Base ids whose generated `-pro` selectors are reasoning aliases.
	pro_reasoning_aliases:    BTreeMap<Str, Box<[Str]>>,
}

/// One reviewed seed for provider-scoped dynamic effort-sibling collapse.
///
/// Declaring at least one family enables the generic grouping rule for that
/// provider. Additional exact aliases fold unsuffixed provider discovery names
/// into the canonical routed family. The reviewed ids retain the upstream
/// inventory in data without baking provider or model names into compiler code.
#[derive(Clone, Debug, Eq, PartialEq)]
struct EffortFamily {
	provider: ProviderId,
	logical:  Str,
	aliases:  Box<[Str]>,
}

/// One reviewed provider-scoped sibling family.
///
/// A family may contain `{rev}` placeholders. Such a family is instantiated
/// only from a matching live identifier and only when its revision constraint
/// accepts the captured revision.
#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct VariantFamily {
	/// Provider whose roster carries the siblings.
	pub(crate) provider: ProviderId,
	/// Logical identifier emitted after collapse.
	pub(crate) logical: Str,
	/// Display name emitted after collapse.
	pub(crate) name: Str,
	/// Optional constraint for a revision template.
	revision: Option<RevisionConstraint>,
	/// Wire identifiers in default-priority order.
	pub(crate) members: Box<[Str]>,
	/// Preferred default member when it is live.
	pub(crate) default_member: Option<Str>,
	/// Members that remain aliases but cannot be selected.
	pub(crate) retired_members: Box<[Str]>,
	/// Portable effort to wire identifier.
	pub(crate) routing: BTreeMap<EffortTier, Str>,
	/// Portable effort to token budget.
	pub(crate) effort_budgets: BTreeMap<EffortTier, u64>,
	/// Native thinking control.
	pub(crate) mode: Option<ThinkingMode>,
	/// Advertised portable effort ladder.
	pub(crate) efforts: Box<[EffortTier]>,
	/// Default portable effort.
	pub(crate) default_level: Option<EffortTier>,
	/// Whether callers must choose an effort.
	pub(crate) requires_effort: Option<bool>,
	/// Whether off requests require an explicit wire control.
	pub(crate) suppress_when_off: Option<bool>,
	/// Whether this rename intentionally exposes no thinking surface.
	pub(crate) no_thinking: bool,
	/// Whether non-off routes survive absent discovery members.
	pub(crate) preserve_absent_effort_routes: bool,
	/// Selector aliases that are not family members.
	pub(crate) extra_aliases: Box<[Str]>,
}

impl VariantFamily {
	fn instantiate_for(&self, id: &str) -> Option<Self> {
		if !self.logical.contains(REVISION_PLACEHOLDER) {
			return self.matches_id(id).then(|| self.clone());
		}
		let revision = self
			.ids_used_for_matching()
			.find_map(|template| capture_template_revision(template, id))?;
		let parsed = parse_revision(revision).ok()?;
		if self
			.revision
			.as_ref()
			.is_some_and(|constraint| !constraint.matches(parsed))
		{
			return None;
		}
		let fill = |value: &Str| Str::from(value.replace(REVISION_PLACEHOLDER, revision));
		let mut family = self.clone();
		family.logical = fill(&self.logical);
		family.name = fill(&self.name);
		family.members = self.members.iter().map(&fill).collect();
		family.default_member = self.default_member.as_ref().map(&fill);
		family.retired_members = self.retired_members.iter().map(&fill).collect();
		family.routing = self
			.routing
			.iter()
			.map(|(effort, target)| (*effort, fill(target)))
			.collect();
		family.extra_aliases = self.extra_aliases.iter().map(fill).collect();
		Some(family)
	}

	fn matches_id(&self, id: &str) -> bool {
		self
			.ids_used_for_matching()
			.any(|candidate| candidate.eq_ignore_ascii_case(id))
	}

	fn ids_used_for_matching(&self) -> impl Iterator<Item = &str> {
		std::iter::once(self.logical.as_str())
			.chain(self.members.iter().map(Str::as_str))
			.chain(self.extra_aliases.iter().map(Str::as_str))
	}

	pub(crate) fn preferred_default<'a>(&'a self, present: &BTreeSet<&str>) -> Option<&'a str> {
		let is_live = |member: &str| {
			present.iter().any(|candidate| *candidate == member)
				&& !self
					.retired_members
					.iter()
					.any(|retired| retired.as_str() == member)
		};
		if let Some(member) = self.default_member.as_deref()
			&& is_live(member)
		{
			return Some(member);
		}
		self
			.members
			.iter()
			.find_map(|member| is_live(member).then_some(member.as_str()))
	}
}

fn capture_template_revision<'a>(template: &str, id: &'a str) -> Option<&'a str> {
	let marker = template.find(REVISION_PLACEHOLDER)?;
	let prefix = &template[..marker];
	if id.len() < prefix.len() || !id[..prefix.len()].eq_ignore_ascii_case(prefix) {
		return None;
	}
	let tail = &id[prefix.len()..];
	let revision_len = tail
		.bytes()
		.take_while(|byte| byte.is_ascii_digit() || *byte == b'.')
		.count();
	let revision = tail.get(..revision_len)?;
	if revision.is_empty() || parse_revision(revision).is_err() {
		return None;
	}
	let rendered = template.replace(REVISION_PLACEHOLDER, revision);
	rendered.eq_ignore_ascii_case(id).then_some(revision)
}

/// Parsed checked-in identity taxonomy.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Taxonomy {
	classes:          Vec<ClassDef>,
	collapse:         Vec<SuffixDef>,
	pair_tokens:      Vec<Str>,
	lanes:            Vec<EffortLaneSuffix>,
	effort_families:  Vec<EffortFamily>,
	variant_families: Vec<VariantFamily>,
	routing_variants: Vec<RoutingVariantSuffix>,
	discovery:        DiscoveryVocabulary,
}

/// Data-dependent taxonomy ambiguity.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum TaxonomyError {
	/// Two classes have equally specific winning matchers.
	#[error("ambiguous class for `{model}`: `{first}` and `{second}` tie")]
	AmbiguousClass {
		/// Model being classified.
		model:  Box<Str>,
		/// First tied class.
		first:  ClassId,
		/// Second tied class.
		second: ClassId,
	},
	/// Two product families have equally specific winning rules.
	#[error("ambiguous family for `{model}` in class `{class}`: `{first}` and `{second}` tie")]
	AmbiguousFamily {
		/// Model being classified.
		model:  Box<Str>,
		/// Selected class.
		class:  ClassId,
		/// First tied family.
		first:  FamilyId,
		/// Second tied family.
		second: FamilyId,
	},
}

impl Taxonomy {
	/// Parses taxonomy KDL sources.
	///
	/// # Errors
	/// Returns [`CascadeError`] for invalid KDL, nodes, properties, or values.
	#[tracing::instrument(
		name = "catalog_taxonomy_parse",
		level = "debug",
		skip_all,
		fields(source_count = sources.len())
	)]
	pub fn parse(sources: &[(&str, &str)]) -> Result<Self, CascadeError> {
		let mut classes = Vec::new();
		let mut collapse = Vec::new();
		let mut pair_tokens = Vec::new();
		let mut lanes = Vec::new();
		let mut effort_families = Vec::new();
		let mut variant_families = Vec::new();
		let mut routing_variants = Vec::new();
		let mut discovery = DiscoveryVocabulary::default();
		let mut source_names = BTreeSet::new();
		let mut class_names = BTreeSet::new();
		let mut saw_collapse = false;
		let mut saw_discovery = false;
		let mut override_ids = BTreeSet::new();
		let mut override_keys = BTreeSet::new();

		for &(file, text) in sources {
			if !source_names.insert(file) {
				return malformed(file, "source");
			}
			let document: KdlDocument = text.parse().map_err(|error: kdl::KdlError| {
				tracing::warn!(file, "catalog taxonomy KDL failed to parse");
				CascadeError::Parse { file: file.to_str(), message: error.to_string().to_str() }
			})?;
			for node in document.nodes() {
				match node.name().value() {
					"class" => {
						let class = parse_class(file, node)?;
						if !class_names.insert(class.id.as_str().to_owned()) {
							return malformed(file, "class");
						}
						for identity in &class.overrides {
							if !override_ids.insert(identity.id.as_str().to_owned()) {
								return malformed(file, "override");
							}
							let key = (
								identity
									.provider
									.as_ref()
									.map(|value| value.to_ascii_lowercase()),
								identity.model.to_ascii_lowercase(),
							);
							if !override_keys.insert(key) {
								return malformed(file, "override");
							}
						}
						classes.push(class);
					},
					"collapse" => {
						if saw_collapse {
							return malformed(file, "collapse");
						}
						saw_collapse = true;
						(collapse, pair_tokens, lanes, routing_variants, variant_families) =
							parse_collapse(file, node)?;
						effort_families = parse_effort_families(file, node)?;
					},
					"discovery" => {
						if saw_discovery {
							return malformed(file, "discovery");
						}
						saw_discovery = true;
						discovery = parse_discovery(file, node)?;
					},
					other => return unexpected(file, other, "taxonomy"),
				}
			}
		}
		if !saw_collapse || collapse.is_empty() {
			return malformed("taxonomy", "collapse");
		}
		Ok(Self {
			classes,
			collapse,
			pair_tokens,
			lanes,
			effort_families,
			variant_families,
			routing_variants,
			discovery,
		})
	}

	/// Returns the full responses-route hint group containing `provider` —
	/// sibling gateways (opencode-go/opencode-zen) whose bundled catalogs hint
	/// that a gateway-first discovered id rides the
	/// openai-responses route. `None` when `provider` is in no declared group.
	pub fn responses_hint_group(&self, provider: &str) -> Option<&[Str]> {
		self
			.discovery
			.responses_hint_groups
			.iter()
			.find(|group| {
				group
					.iter()
					.any(|member| member.eq_ignore_ascii_case(provider))
			})
			.map(Box::as_ref)
	}

	/// Returns exact model ids authored onto a provider's responses route.
	///
	/// These pins cover gateway-first rows whose static census has no same- or
	/// sibling-provider card yet. Billing variants inherit a pinned base route
	/// through [`Self::billing_variant_plain`].
	pub fn responses_route_models(&self, provider: &str) -> Option<&[Str]> {
		self
			.discovery
			.responses_route_models
			.iter()
			.find(|(candidate, _)| candidate.eq_ignore_ascii_case(provider))
			.map(|(_, models)| models.as_ref())
	}

	/// Strips a declared billing-variant suffix (`-free`, `-contributor`) from
	/// a wire identifier, returning the base id it shares a transport with.
	///
	/// Matching is ASCII-case-insensitive on the suffix; the returned slice
	/// preserves the caller's original bytes. A suffix that would leave an
	/// empty base identifier never matches.
	pub fn billing_variant_plain<'model>(&self, wire_model: &'model str) -> Option<&'model str> {
		self
			.discovery
			.billing_variant_suffixes
			.iter()
			.find_map(|suffix| {
				let split = wire_model.len().checked_sub(suffix.len())?;
				if !wire_model.is_char_boundary(split) {
					return None;
				}
				let (plain, candidate) = wire_model.split_at(split);
				(!plain.is_empty() && candidate.eq_ignore_ascii_case(suffix.as_str())).then_some(plain)
			})
	}

	/// Returns the plain wire identifier when `wire_model` is a declared
	/// provider-scoped routing variant (`gpt-5.6-luna-wm` → `gpt-5.6-luna`).
	///
	/// Matching is ASCII-case-insensitive on both the provider and the suffix;
	/// the returned slice preserves the caller's original bytes. A suffix that
	/// would leave an empty plain identifier never matches.
	pub fn routing_variant_plain<'model>(
		&self,
		provider: &str,
		wire_model: &'model str,
	) -> Option<&'model str> {
		self.routing_variants.iter().find_map(|rule| {
			if !rule
				.providers
				.iter()
				.any(|candidate| candidate.eq_ignore_ascii_case(provider))
			{
				return None;
			}
			let split = wire_model.len().checked_sub(rule.suffix.len())?;
			if !wire_model.is_char_boundary(split) {
				return None;
			}
			let (plain, suffix) = wire_model.split_at(split);
			(!plain.is_empty() && suffix.eq_ignore_ascii_case(rule.suffix.as_str())).then_some(plain)
		})
	}

	/// Whether any routing-variant suffix is declared for `provider`.
	pub fn has_routing_variants(&self, provider: &str) -> bool {
		self.routing_variants.iter().any(|rule| {
			rule
				.providers
				.iter()
				.any(|candidate| candidate.eq_ignore_ascii_case(provider))
		})
	}

	/// Whether `provider`'s discovery recovers intrinsic model parameters from
	/// the bundled canonical reference index.
	pub fn recovers_canonical_params(&self, provider: &str) -> bool {
		self
			.discovery
			.canonical_recovery
			.iter()
			.any(|candidate| candidate.eq_ignore_ascii_case(provider))
	}

	/// Parses the checked-in taxonomy inventory.
	pub fn bundled() -> Result<Self, CascadeError> {
		Self::parse(BUNDLED_TAXONOMY)
	}

	/// Finds the most specific active exact identity correction.
	pub fn identity_override(
		&self,
		provider: &str,
		bare_model: &str,
		observed_at_ms: Option<u64>,
	) -> Option<&IdentityOverride> {
		let active = |identity: &&IdentityOverride| {
			identity.model.eq_ignore_ascii_case(bare_model)
				&& !matches!(
					(identity.expires_at_ms, observed_at_ms),
					(Some(expiry), Some(observed)) if observed >= expiry
				)
		};
		self
			.classes
			.iter()
			.flat_map(|class| &class.overrides)
			.filter(active)
			.find(|identity| {
				identity
					.provider
					.as_ref()
					.is_some_and(|expected| expected.eq_ignore_ascii_case(provider))
			})
			.or_else(|| {
				self
					.classes
					.iter()
					.flat_map(|class| &class.overrides)
					.filter(active)
					.find(|identity| identity.provider.is_none())
			})
	}

	/// Removes the first declared bounded thinking-pair token.
	#[must_use]
	pub fn strip_thinking_variant_suffix<'a>(&self, model: &'a str) -> Option<Cow<'a, str>> {
		let lower = model.to_ascii_lowercase();
		for token in &self.pair_tokens {
			let needle = format!("-{token}");
			let mut search_from = 0;
			while let Some(relative) = lower[search_from..].find(&needle) {
				let index = search_from + relative;
				let end = index + needle.len();
				let next_is_token = lower
					.as_bytes()
					.get(end)
					.is_some_and(u8::is_ascii_alphanumeric);
				let word_start = lower[..index]
					.rfind(|character: char| !character.is_ascii_alphanumeric())
					.map_or(0, |position| position + 1);
				let preceding = &lower[word_start..index];
				if !next_is_token && !matches!(preceding, "no" | "non") {
					let mut stripped = String::with_capacity(model.len() - needle.len());
					stripped.push_str(&model[..index]);
					stripped.push_str(&model[end..]);
					return (!stripped.is_empty()).then_some(Cow::Owned(stripped));
				}
				search_from = index + 1;
			}
		}
		None
	}

	/// Collapses a declared thinking or effort suffix from a model identifier.
	///
	/// An exact member alias declared by `effort-family` collapses to that
	/// family's logical model without assigning an effort.
	///
	/// A provider-scoped effort lane (`effort-lane-suffix`) additionally
	/// collapses an effort suffix wedged before the lane token: on a declared
	/// provider, `cursor-grok-4.6-low-fast` collapses to the logical
	/// `cursor-grok-4.6-fast` with effort `low` — one logical model per
	/// service-tier lane.
	pub fn collapse<'a>(
		&'a self,
		provider: &str,
		model: &'a str,
	) -> (Cow<'a, str>, Option<EffortTier>, bool) {
		let lower = model.to_ascii_lowercase();
		if let Some(bases) = self.discovery.pro_reasoning_aliases.get(provider)
			&& let Some(base) = lower.strip_suffix("-pro")
			&& bases.iter().any(|candidate| candidate.as_str() == base)
		{
			return (Cow::Owned(model[..model.len() - 4].to_owned()), None, true);
		}
		let bare = lower.rsplit('/').next().unwrap_or(lower.as_str());
		let winner = self
			.collapse
			.iter()
			.filter(|rule| lower.ends_with(rule.suffix.as_str()))
			.filter(|rule| {
				!rule
					.except_bare_prefix
					.as_ref()
					.is_some_and(|prefix| bare.starts_with(prefix.as_str()))
			})
			.max_by_key(|rule| rule.suffix.len());
		if let Some(rule) = winner {
			return (
				Cow::Borrowed(&model[..model.len() - rule.suffix.len()]),
				rule.effort,
				rule.thinking,
			);
		}
		for lane in &self.lanes {
			if !lane
				.providers
				.iter()
				.any(|candidate| candidate.eq_ignore_ascii_case(provider))
				|| !lower.ends_with(lane.suffix.as_str())
			{
				continue;
			}
			let trimmed = &lower[..lower.len() - lane.suffix.len()];
			let trimmed_bare = trimmed.rsplit('/').next().unwrap_or(trimmed);
			if lane
				.bare_prefix
				.as_ref()
				.is_some_and(|prefix| !trimmed_bare.starts_with(prefix.as_str()))
			{
				continue;
			}
			// The lane wraps effort tiers only; thinking variants never lane.
			let effort = self
				.collapse
				.iter()
				.filter(|rule| rule.effort.is_some())
				.filter(|rule| trimmed.ends_with(rule.suffix.as_str()))
				.filter(|rule| {
					!rule
						.except_bare_prefix
						.as_ref()
						.is_some_and(|prefix| trimmed_bare.starts_with(prefix.as_str()))
				})
				.max_by_key(|rule| rule.suffix.len());
			if let Some(rule) = effort {
				let base = &model[..trimmed.len() - rule.suffix.len()];
				if base.is_empty() || base.ends_with('/') {
					continue;
				}
				// Preserve the caller's original lane bytes on the logical id.
				return (Cow::Owned(format!("{base}{}", &model[trimmed.len()..])), rule.effort, false);
			}
		}
		if let Some(family) = self.variant_family(provider, model)
			&& !family.logical.eq_ignore_ascii_case(model)
		{
			return (Cow::Owned(family.logical.to_string()), None, false);
		}
		if let Some(family) = self.effort_families.iter().find(|family| {
			family.provider.eq_ignore_ascii_case(provider)
				&& family
					.aliases
					.iter()
					.any(|alias| alias.as_str() == lower.as_str())
		}) {
			return (Cow::Borrowed(family.logical.as_str()), None, false);
		}
		(Cow::Borrowed(model), None, false)
	}

	/// Returns the reviewed variant family matching a logical, member, or alias
	/// id.
	pub(crate) fn variant_family(&self, provider: &str, id: &str) -> Option<VariantFamily> {
		let matching_provider =
			|family: &&VariantFamily| family.provider.eq_ignore_ascii_case(provider);
		self
			.variant_families
			.iter()
			.filter(matching_provider)
			.filter(|family| !family.logical.contains(REVISION_PLACEHOLDER))
			.find_map(|family| family.instantiate_for(id))
			.or_else(|| {
				self
					.variant_families
					.iter()
					.filter(matching_provider)
					.filter(|family| family.logical.contains(REVISION_PLACEHOLDER))
					.find_map(|family| family.instantiate_for(id))
			})
	}

	/// Whether `provider` declares dynamic effort-sibling families.
	pub(crate) fn supports_dynamic_effort_siblings(&self, provider: &str) -> bool {
		self
			.effort_families
			.iter()
			.any(|family| family.provider.eq_ignore_ascii_case(provider) && !family.logical.is_empty())
			|| self
				.variant_families
				.iter()
				.any(|family| family.provider.eq_ignore_ascii_case(provider))
	}

	/// Returns the standard-lane id when `model` ends in a declared effort lane.
	pub(crate) fn strip_effort_lane<'a>(&self, provider: &str, model: &'a str) -> &'a str {
		self
			.lanes
			.iter()
			.find(|lane| {
				lane
					.providers
					.iter()
					.any(|candidate| candidate.eq_ignore_ascii_case(provider))
					&& model
						.get(model.len().saturating_sub(lane.suffix.len())..)
						.is_some_and(|suffix| suffix.eq_ignore_ascii_case(lane.suffix.as_str()))
			})
			.map_or(model, |lane| &model[..model.len() - lane.suffix.len()])
	}

	/// Classifies a model into class, product family, and revision ranks.
	///
	/// # Errors
	/// Returns [`TaxonomyError`] when equally ranked cross-class or cross-family
	/// rules match.
	pub fn classify_id(
		&self,
		model: &str,
	) -> Result<(ClassId, Option<FamilyId>, Option<SemVer>), TaxonomyError> {
		let lower = model.trim().to_ascii_lowercase();
		let bare = lower.rsplit('/').next().unwrap_or(lower.as_str());
		let mut winner: Option<((u8, usize), &ClassDef)> = None;
		let mut tied_class = None;
		for class in &self.classes {
			for matcher in &class.matchers {
				if !matcher_matches(matcher, &lower, bare) {
					continue;
				}
				let rank = (matcher.kind.rank(), matcher.token.len());
				match winner {
					Some((held_rank, held)) if held_rank == rank && held.id != class.id => {
						tied_class = Some((held, class));
					},
					Some((held_rank, _)) if held_rank >= rank => {},
					_ => {
						winner = Some((rank, class));
						tied_class = None;
					},
				}
			}
		}
		if let Some((first, second)) = tied_class {
			return Err(TaxonomyError::AmbiguousClass {
				model:  Box::new(lower.to_str()),
				first:  first.id.clone(),
				second: second.id.clone(),
			});
		}
		let Some((_, class)) = winner else {
			return Ok((ClassId::new("unknown"), None, None));
		};
		let class = class.id.clone();
		let (family, revision) = self.ranks_in_class(&class, model)?;
		Ok((class, family, revision))
	}

	/// Resolves product-family and revision ranks within an already selected
	/// class.
	///
	/// An undeclared class has no subordinate ranks.
	///
	/// # Errors
	/// Returns [`TaxonomyError`] when equally ranked product-family rules match.
	pub fn ranks_in_class(
		&self,
		class: &ClassId<str>,
		model: &str,
	) -> Result<(Option<FamilyId>, Option<SemVer>), TaxonomyError> {
		let Some(class) = self
			.classes
			.iter()
			.find(|candidate| candidate.id.as_str() == class.as_str())
		else {
			return Ok((None, None));
		};
		let lower = model.trim().to_ascii_lowercase();
		let bare = lower.rsplit('/').next().unwrap_or(lower.as_str());
		let family = classify_family(class, bare, &lower)?;
		let revision = extract_revision(&class.revisions, bare);
		Ok((family, revision))
	}
}

/// Returns the process-wide checked-in taxonomy.
pub fn taxonomy() -> &'static Taxonomy {
	static TAXONOMY: LazyLock<Taxonomy> = LazyLock::new(|| {
		Taxonomy::bundled().unwrap_or_else(|error| panic!("bundled taxonomy is invalid: {error}"))
	});
	&TAXONOMY
}

fn parse_class(file: &str, node: &KdlNode) -> Result<ClassDef, CascadeError> {
	validate_properties(file, node, "class", &[])?;
	let arguments = positional_strings(node);
	let [name] = arguments.as_slice() else {
		return malformed(file, "class");
	};
	if name.is_empty() {
		return malformed(file, "class");
	}
	let Some(children) = node.children() else {
		return malformed(file, "class");
	};
	let mut class = ClassDef {
		id:        ClassId::new(name.as_str()),
		matchers:  Vec::new(),
		families:  Vec::new(),
		revisions: RevisionDef::default(),
		overrides: Vec::new(),
	};
	for child in children.nodes() {
		match child.name().value() {
			"exact" | "bounded" | "namespace" | "prefix" | "glob" => {
				class.matchers.push(parse_matcher(file, child)?);
			},
			"family" => class.families.push(parse_family(file, child)?),
			"revision" => parse_revision_rule(file, child, &mut class.revisions)?,
			"override" => class.overrides.push(parse_override(file, child)?),
			other => return unexpected(file, other, "class"),
		}
	}
	Ok(class)
}

fn parse_matcher(file: &str, node: &KdlNode) -> Result<Matcher, CascadeError> {
	let directive = node.name().value();
	let allowed = if directive == "namespace" {
		&["bounded"][..]
	} else {
		&[][..]
	};
	validate_properties(file, node, directive, allowed)?;
	let arguments = positional_strings(node);
	let [token] = arguments.as_slice() else {
		return malformed(file, directive);
	};
	if token.is_empty() || node.children().is_some() {
		return malformed(file, directive);
	}
	let bounded = match node.get("bounded") {
		Some(KdlValue::Bool(value)) => *value,
		Some(_) => return malformed(file, directive),
		None => false,
	};
	let kind = match directive {
		"exact" => MatcherKind::Exact,
		"bounded" => MatcherKind::Bounded,
		"namespace" => MatcherKind::Namespace,
		"prefix" => MatcherKind::Prefix,
		"glob" => MatcherKind::Glob,
		_ => unreachable!(),
	};
	Ok(Matcher { kind, token: token.to_ascii_lowercase().to_str(), bounded })
}

fn parse_family(file: &str, node: &KdlNode) -> Result<FamilyDef, CascadeError> {
	validate_properties(file, node, "family", &["glob", "priority"])?;
	let arguments = positional_strings(node);
	let [name] = arguments.as_slice() else {
		return malformed(file, "family");
	};
	let glob = property_string(node, "glob").ok_or_else(|| malformed_error(file, "family"))?;
	let priority = match node.get("priority") {
		Some(value) => value
			.as_integer()
			.and_then(|value| i64::try_from(value).ok())
			.ok_or_else(|| malformed_error(file, "family"))?,
		None => 0,
	};
	if name.is_empty() || glob.is_empty() || node.children().is_some() {
		return malformed(file, "family");
	}
	Ok(FamilyDef {
		id: FamilyId::new(name.as_str()),
		glob: glob.to_ascii_lowercase().to_str(),
		priority,
	})
}

fn parse_revision_rule(
	file: &str,
	node: &KdlNode,
	revisions: &mut RevisionDef,
) -> Result<(), CascadeError> {
	validate_properties(file, node, "revision", &["prefix", "anywhere"])?;
	if node.children().is_some() {
		return malformed(file, "revision");
	}
	match property_string(node, "prefix") {
		Some(prefix) if positional_strings(node).is_empty() && !prefix.is_empty() => {
			let anywhere = match node.get("anywhere") {
				Some(KdlValue::Bool(value)) => *value,
				Some(_) => return malformed(file, "revision"),
				None => false,
			};
			revisions
				.prefixes
				.push(RevisionPrefix { prefix: prefix.to_ascii_lowercase().to_str(), anywhere });
		},
		None if node.get("anywhere").is_none() => {
			let arguments = positional_strings(node);
			if arguments.first().map(String::as_str) != Some("skip-bare") || arguments.len() < 2 {
				return malformed(file, "revision");
			}
			revisions.skip_bare.extend(
				arguments[1..]
					.iter()
					.map(|value| value.to_ascii_lowercase().to_str()),
			);
		},
		_ => return malformed(file, "revision"),
	}
	Ok(())
}

fn parse_override(file: &str, node: &KdlNode) -> Result<IdentityOverride, CascadeError> {
	const PROPERTIES: &[&str] = &[
		"id",
		"provider",
		"model",
		"logical",
		"class",
		"family",
		"revision",
		"effort",
		"thinking-variant",
		"rationale",
		"provenance",
		"expires-at-ms",
	];
	validate_properties(file, node, "override", PROPERTIES)?;
	if !positional_strings(node).is_empty() || node.children().is_some() {
		return malformed(file, "override");
	}
	for name in [
		"id",
		"provider",
		"model",
		"logical",
		"class",
		"family",
		"revision",
		"effort",
		"rationale",
		"provenance",
	] {
		if node.get(name).is_some() && property_string(node, name).is_none() {
			return malformed(file, "override");
		}
	}
	if ["class", "family"]
		.into_iter()
		.any(|name| property_string(node, name).is_some_and(str::is_empty))
	{
		return malformed(file, "override");
	}
	let required =
		|name| property_string(node, name).ok_or_else(|| malformed_error(file, "override"));
	let revision = property_string(node, "revision")
		.map(parse_revision)
		.transpose()
		.map_err(|()| malformed_error(file, "override"))?;
	let effort = property_string(node, "effort")
		.map(parse_effort)
		.transpose()
		.map_err(|()| malformed_error(file, "override"))?;
	let thinking_variant = match node.get("thinking-variant") {
		Some(KdlValue::Bool(value)) => Some(*value),
		Some(_) => return malformed(file, "override"),
		None => None,
	};
	let expires_at_ms = match node.get("expires-at-ms") {
		Some(value) => Some(
			value
				.as_integer()
				.and_then(|value| u64::try_from(value).ok())
				.ok_or_else(|| malformed_error(file, "override"))?,
		),
		None => None,
	};
	Ok(IdentityOverride {
		id: required("id")?.to_str(),
		provider: property_string(node, "provider").map(|value| value.to_str()),
		model: required("model")?.to_str(),
		logical: property_string(node, "logical").map(|value| value.to_str()),
		class: property_string(node, "class").map(ClassId::new),
		family: property_string(node, "family").map(FamilyId::new),
		revision,
		effort,
		thinking_variant,
		rationale: required("rationale")?.to_str(),
		provenance: required("provenance")?.to_str(),
		expires_at_ms,
	})
}

#[allow(
	clippy::type_complexity,
	reason = "one internal parse seam returns the three collapse vocabularies"
)]
fn parse_collapse(
	file: &str,
	node: &KdlNode,
) -> Result<
	(Vec<SuffixDef>, Vec<Str>, Vec<EffortLaneSuffix>, Vec<RoutingVariantSuffix>, Vec<VariantFamily>),
	CascadeError,
> {
	validate_properties(file, node, "collapse", &[])?;
	if !positional_strings(node).is_empty() {
		return malformed(file, "collapse");
	}
	let Some(children) = node.children() else {
		return malformed(file, "collapse");
	};
	let mut rules = Vec::new();
	let mut pair_tokens = Vec::new();
	let mut lanes = Vec::new();
	let mut routing_variants = Vec::new();
	let mut variant_families = Vec::new();
	let mut suffixes = BTreeSet::new();
	for child in children.nodes() {
		let directive = child.name().value();
		if !matches!(
			directive,
			"thinking-suffix"
				| "pair-token"
				| "effort-suffix"
				| "effort-lane-suffix"
				| "effort-family"
				| "variant-family"
				| "provider-alias"
				| "routing-variant-suffix"
		) {
			return unexpected(file, directive, "collapse");
		}
		let allowed = match directive {
			"effort-suffix" => &["tier", "except-bare-prefix"][..],
			"effort-lane-suffix" => &["bare-prefix"][..],
			"variant-family" => &["name", "revision"][..],
			_ => &[][..],
		};
		validate_properties(file, child, directive, allowed)?;
		if child.get("except-bare-prefix").is_some()
			&& property_string(child, "except-bare-prefix").is_none()
		{
			return malformed(file, directive);
		}
		if child.get("bare-prefix").is_some() && property_string(child, "bare-prefix").is_none() {
			return malformed(file, directive);
		}
		let arguments = positional_strings(child);
		if directive == "variant-family" {
			variant_families.push(parse_variant_family(file, child)?);
			continue;
		}
		if matches!(directive, "effort-family" | "provider-alias") {
			continue;
		}
		if directive == "pair-token" {
			if arguments.is_empty()
				|| arguments.iter().any(String::is_empty)
				|| child.children().is_some()
			{
				return malformed(file, directive);
			}
			for token in arguments {
				let token = token.to_ascii_lowercase();
				if !token.bytes().all(|byte| byte.is_ascii_alphanumeric())
					|| pair_tokens
						.iter()
						.any(|existing: &Str| existing.as_str() == token)
				{
					return malformed(file, directive);
				}
				pair_tokens.push(token.to_str());
			}
			continue;
		}
		if directive == "routing-variant-suffix" {
			// One suffix followed by one or more provider ids; the suffix
			// shares the case-insensitive uniqueness namespace with the
			// collapse suffixes so one spelling never carries two meanings.
			let [suffix, providers @ ..] = arguments.as_slice() else {
				return malformed(file, directive);
			};
			if suffix.is_empty()
				|| providers.is_empty()
				|| providers.iter().any(String::is_empty)
				|| child.children().is_some()
				|| !suffixes.insert(suffix.to_ascii_lowercase())
			{
				return malformed(file, directive);
			}
			routing_variants.push(RoutingVariantSuffix {
				suffix:    suffix.to_ascii_lowercase().to_str(),
				providers: providers
					.iter()
					.map(|provider| provider.to_ascii_lowercase().to_str())
					.collect(),
			});
			continue;
		}
		if directive == "effort-lane-suffix" {
			// One lane suffix followed by one or more provider ids, with an
			// optional bare-prefix gate; the lane shares the case-insensitive
			// suffix uniqueness namespace with the collapse vocabulary.
			let [suffix, providers @ ..] = arguments.as_slice() else {
				return malformed(file, directive);
			};
			if suffix.is_empty()
				|| providers.is_empty()
				|| providers.iter().any(String::is_empty)
				|| child.children().is_some()
				|| !suffixes.insert(suffix.to_ascii_lowercase())
			{
				return malformed(file, directive);
			}
			lanes.push(EffortLaneSuffix {
				suffix:      suffix.to_ascii_lowercase().to_str(),
				providers:   providers
					.iter()
					.map(|provider| provider.to_ascii_lowercase().to_str())
					.collect(),
				bare_prefix: property_string(child, "bare-prefix")
					.map(|value| value.to_ascii_lowercase().to_str()),
			});
			continue;
		}
		let [suffix] = arguments.as_slice() else {
			return malformed(file, directive);
		};
		if suffix.is_empty()
			|| child.children().is_some()
			|| !suffixes.insert(suffix.to_ascii_lowercase())
		{
			return malformed(file, directive);
		}
		let effort = if directive == "effort-suffix" {
			Some(
				parse_effort(
					property_string(child, "tier").ok_or_else(|| malformed_error(file, directive))?,
				)
				.map_err(|()| malformed_error(file, directive))?,
			)
		} else {
			None
		};
		rules.push(SuffixDef {
			suffix: suffix.to_ascii_lowercase().to_str(),
			effort,
			thinking: directive == "thinking-suffix",
			except_bare_prefix: property_string(child, "except-bare-prefix")
				.map(|value| value.to_ascii_lowercase().to_str()),
		});
	}
	Ok((rules, pair_tokens, lanes, routing_variants, variant_families))
}

fn parse_variant_family(file: &str, node: &KdlNode) -> Result<VariantFamily, CascadeError> {
	validate_properties(file, node, "variant-family", &["name", "revision"])?;
	let arguments = positional_strings(node);
	let [provider, logical] = arguments.as_slice() else {
		return malformed(file, "variant-family");
	};
	if provider.is_empty() || logical.is_empty() {
		return malformed(file, "variant-family");
	}
	let name =
		property_string(node, "name").ok_or_else(|| malformed_error(file, "variant-family"))?;
	let Some(children) = node.children() else {
		return malformed(file, "variant-family");
	};
	let templated = logical.contains(REVISION_PLACEHOLDER);
	let revision = match node.get("revision") {
		Some(KdlValue::String(expression)) if templated => Some(
			parse_revision_constraint(expression)
				.ok_or_else(|| malformed_error(file, "variant-family"))?,
		),
		Some(_) => return malformed(file, "variant-family"),
		None => None,
	};
	let mut family = VariantFamily {
		provider: ProviderId::new(provider.to_ascii_lowercase()),
		logical: Str::new(logical),
		name: Str::new(name),
		revision,
		members: Box::default(),
		default_member: None,
		retired_members: Box::default(),
		routing: BTreeMap::new(),
		effort_budgets: BTreeMap::new(),
		mode: None,
		efforts: Box::default(),
		default_level: None,
		requires_effort: None,
		suppress_when_off: None,
		no_thinking: false,
		preserve_absent_effort_routes: false,
		extra_aliases: Box::default(),
	};
	let mut members = Vec::new();
	let mut retired_members = Vec::new();
	let mut efforts = Vec::new();
	let mut extra_aliases = Vec::new();
	for child in children.nodes() {
		let directive = child.name().value();
		if child.children().is_some() {
			return malformed(file, directive);
		}
		if matches!(
			directive,
			"requires-effort" | "suppress-when-off" | "no-thinking" | "preserve-absent-effort-routes"
		) {
			let [entry] = child.entries() else {
				return malformed(file, directive);
			};
			if entry.name().is_some() {
				return malformed(file, directive);
			}
			let KdlValue::Bool(value) = entry.value() else {
				return malformed(file, directive);
			};
			match directive {
				"requires-effort" => family.requires_effort = Some(*value),
				"suppress-when-off" => family.suppress_when_off = Some(*value),
				"no-thinking" => family.no_thinking = *value,
				"preserve-absent-effort-routes" => {
					family.preserve_absent_effort_routes = *value;
				},
				_ => unreachable!("matched boolean variant-family directive"),
			}
			continue;
		}
		validate_properties(file, child, directive, &[])?;
		let values = positional_strings(child);
		if values.len() != child.entries().len() {
			return malformed(file, directive);
		}
		match directive {
			"members" => {
				if values.is_empty() || values.iter().any(String::is_empty) {
					return malformed(file, directive);
				}
				members.extend(values.into_iter().map(Str::new));
			},
			"route" => {
				let [tier, target] = values.as_slice() else {
					return malformed(file, directive);
				};
				if target.is_empty() {
					return malformed(file, directive);
				}
				let tier = parse_effort(tier).map_err(|()| malformed_error(file, directive))?;
				if family.routing.insert(tier, Str::new(target)).is_some() {
					return malformed(file, directive);
				}
			},
			"budget" => {
				let [tier, amount] = values.as_slice() else {
					return malformed(file, directive);
				};
				let tier = parse_effort(tier).map_err(|()| malformed_error(file, directive))?;
				if tier == EffortTier::Off {
					return malformed(file, directive);
				}
				let amount = amount
					.parse::<u64>()
					.map_err(|_| malformed_error(file, directive))?;
				if amount > 9_007_199_254_740_991 {
					return malformed(file, directive);
				}
				if family.effort_budgets.insert(tier, amount).is_some() {
					return malformed(file, directive);
				}
			},
			"mode" => {
				let [mode] = values.as_slice() else {
					return malformed(file, directive);
				};
				if mode.is_empty() || family.mode.is_some() {
					return malformed(file, directive);
				}
				let parsed = mode
					.parse::<ThinkingMode>()
					.map_err(|_| malformed_error(file, directive))?;
				if parsed.into_str() != mode {
					return malformed(file, directive);
				}
				family.mode = Some(parsed);
			},
			"efforts" => {
				if values.is_empty() || !efforts.is_empty() {
					return malformed(file, directive);
				}
				for value in values {
					let effort = parse_effort(&value).map_err(|()| malformed_error(file, directive))?;
					if effort == EffortTier::Off {
						return malformed(file, directive);
					}
					efforts.push(effort);
				}
			},
			"default-level" => {
				let [value] = values.as_slice() else {
					return malformed(file, directive);
				};
				if family.default_level.is_some() {
					return malformed(file, directive);
				}
				let effort = parse_effort(value).map_err(|()| malformed_error(file, directive))?;
				if effort == EffortTier::Off {
					return malformed(file, directive);
				}
				family.default_level = Some(effort);
			},
			"default-member" => {
				let [value] = values.as_slice() else {
					return malformed(file, directive);
				};
				if value.is_empty() || family.default_member.is_some() {
					return malformed(file, directive);
				}
				family.default_member = Some(Str::new(value));
			},
			"retired" => {
				if values.is_empty() || values.iter().any(String::is_empty) {
					return malformed(file, directive);
				}
				retired_members.extend(values.into_iter().map(Str::new));
			},
			"aliases" => {
				if values.is_empty() || values.iter().any(String::is_empty) {
					return malformed(file, directive);
				}
				extra_aliases.extend(values.into_iter().map(Str::new));
			},
			_ => return unexpected(file, directive, "variant-family"),
		}
	}
	if members.is_empty() {
		return malformed(file, "variant-family");
	}
	let placeholder_shape_is_valid = members
		.iter()
		.chain(family.routing.values())
		.chain(retired_members.iter())
		.chain(extra_aliases.iter())
		.chain(family.default_member.iter())
		.all(|id| id.contains(REVISION_PLACEHOLDER) == templated);
	if !placeholder_shape_is_valid {
		return malformed(file, "variant-family");
	}
	family.members = members.into_boxed_slice();
	family.retired_members = retired_members.into_boxed_slice();
	family.efforts = efforts.into_boxed_slice();
	family.extra_aliases = extra_aliases.into_boxed_slice();
	Ok(family)
}

fn parse_effort_families(file: &str, node: &KdlNode) -> Result<Vec<EffortFamily>, CascadeError> {
	let Some(children) = node.children() else {
		return malformed(file, "collapse");
	};
	let mut families = Vec::new();
	let mut aliases = Vec::new();
	let mut unique = BTreeSet::new();
	let mut unique_aliases = BTreeSet::new();
	for child in children.nodes() {
		let directive = child.name().value();
		if directive == "provider-alias" {
			validate_properties(file, child, directive, &[])?;
			let arguments = positional_strings(child);
			let [provider, alias, logical] = arguments.as_slice() else {
				return malformed(file, directive);
			};
			if provider.is_empty()
				|| alias.is_empty()
				|| logical.is_empty()
				|| child.children().is_some()
			{
				return malformed(file, directive);
			}
			aliases.push((
				provider.to_ascii_lowercase(),
				alias.to_ascii_lowercase(),
				logical.to_ascii_lowercase(),
			));
			continue;
		}
		if !matches!(directive, "effort-family" | "variant-family") {
			continue;
		}
		let (provider, logical, family_aliases) = if directive == "effort-family" {
			validate_properties(file, child, directive, &[])?;
			let arguments = positional_strings(child);
			let [provider, logical, family_aliases @ ..] = arguments.as_slice() else {
				return malformed(file, directive);
			};
			if child.children().is_some() {
				return malformed(file, directive);
			}
			(
				provider.to_ascii_lowercase(),
				logical.to_ascii_lowercase(),
				family_aliases
					.iter()
					.map(|alias| alias.to_ascii_lowercase())
					.collect::<Vec<_>>(),
			)
		} else {
			validate_properties(file, child, directive, &["name", "revision"])?;
			let arguments = positional_strings(child);
			let [provider, logical] = arguments.as_slice() else {
				return malformed(file, directive);
			};
			let Some(body) = child.children() else {
				return malformed(file, directive);
			};
			let Some(members) = body
				.nodes()
				.iter()
				.find(|node| node.name().value() == "members")
			else {
				return malformed(file, directive);
			};
			let family_aliases = positional_strings(members)
				.into_iter()
				.map(|alias| alias.to_ascii_lowercase())
				.collect::<Vec<_>>();
			(provider.to_ascii_lowercase(), logical.to_ascii_lowercase(), family_aliases)
		};
		let family_aliases = family_aliases
			.into_iter()
			.filter(|alias| alias != &logical)
			.collect::<Vec<_>>();
		if let Some(existing) = families.iter_mut().find(|family: &&mut EffortFamily| {
			family.provider.eq_ignore_ascii_case(&provider) && family.logical.as_str() == logical
		}) {
			let mut merged = existing.aliases.to_vec();
			for alias in family_aliases {
				if !merged.iter().any(|value| value.as_str() == alias) {
					unique_aliases.insert((provider.clone(), alias.clone()));
					merged.push(alias.to_str());
				}
			}
			existing.aliases = merged.into_boxed_slice();
			continue;
		}
		if provider.is_empty()
			|| logical.is_empty()
			|| unique_aliases.contains(&(provider.clone(), logical.clone()))
			|| family_aliases.iter().any(|alias| {
				alias.is_empty()
					|| unique.contains(&(provider.clone(), alias.clone()))
					|| !unique_aliases.insert((provider.clone(), alias.clone()))
			}) || !unique.insert((provider.clone(), logical.clone()))
		{
			return malformed(file, directive);
		}
		families.push(EffortFamily {
			provider: ProviderId::new(provider),
			logical:  logical.to_str(),
			aliases:  family_aliases.into_iter().map(Str::new).collect(),
		});
	}
	for (provider, alias, logical) in aliases {
		let Some(family) = families.iter_mut().find(|family| {
			family.provider.eq_ignore_ascii_case(&provider) && family.logical.as_str() == logical
		}) else {
			return malformed(file, "provider-alias");
		};
		if alias == logical
			|| unique.contains(&(provider.clone(), alias.clone()))
			|| !unique_aliases.insert((provider, alias.clone()))
		{
			return malformed(file, "provider-alias");
		}
		let mut merged = family.aliases.to_vec();
		merged.push(alias.to_str());
		family.aliases = merged.into_boxed_slice();
	}
	Ok(families)
}

fn parse_discovery(file: &str, node: &KdlNode) -> Result<DiscoveryVocabulary, CascadeError> {
	validate_properties(file, node, "discovery", &[])?;
	if !positional_strings(node).is_empty() {
		return malformed(file, "discovery");
	}
	let Some(children) = node.children() else {
		return malformed(file, "discovery");
	};
	let mut vocabulary = DiscoveryVocabulary::default();
	let mut grouped_providers: Vec<Str> = Vec::new();
	for child in children.nodes() {
		let directive = child.name().value();
		validate_properties(file, child, directive, &[])?;
		let arguments = positional_strings(child);
		if arguments.is_empty()
			|| arguments.iter().any(String::is_empty)
			|| child.children().is_some()
		{
			return malformed(file, directive);
		}
		match directive {
			"recover-canonical-params" => {
				for provider in arguments {
					let provider = provider.to_ascii_lowercase();
					if vocabulary
						.canonical_recovery
						.iter()
						.any(|held| held.as_str() == provider)
					{
						return malformed(file, directive);
					}
					vocabulary.canonical_recovery.push(provider.to_str());
				}
			},
			"borrow-responses-route" => {
				let mut group = Vec::with_capacity(arguments.len());
				for provider in arguments {
					let provider = provider.to_ascii_lowercase().to_str();
					// A provider in two groups would make its sibling set
					// ambiguous, including within one directive.
					if grouped_providers.contains(&provider) {
						return malformed(file, directive);
					}
					grouped_providers.push(provider.clone());
					group.push(provider);
				}
				vocabulary
					.responses_hint_groups
					.push(group.into_boxed_slice());
			},
			"responses-route-models" => {
				let [provider, models @ ..] = arguments.as_slice() else {
					return malformed(file, directive);
				};
				if models.is_empty() {
					return malformed(file, directive);
				}
				let provider = provider.to_ascii_lowercase().to_str();
				let mut unique = BTreeSet::new();
				let models: Box<[Str]> = models
					.iter()
					.map(|model| model.to_ascii_lowercase())
					.map(|model| {
						if unique.insert(model.clone()) {
							Ok(model.to_str())
						} else {
							Err(malformed_error(file, directive))
						}
					})
					.collect::<Result<_, _>>()?;
				if vocabulary
					.responses_route_models
					.insert(provider, models)
					.is_some()
				{
					return malformed(file, directive);
				}
			},
			"billing-variant-suffix" => {
				for suffix in arguments {
					let suffix = suffix.to_ascii_lowercase();
					if suffix == "-"
						|| vocabulary
							.billing_variant_suffixes
							.iter()
							.any(|held| held.as_str() == suffix)
					{
						return malformed(file, directive);
					}
					vocabulary.billing_variant_suffixes.push(suffix.to_str());
				}
			},
			"pro-reasoning-alias" => {
				let [provider, models @ ..] = arguments.as_slice() else {
					return malformed(file, directive);
				};
				if models.is_empty() {
					return malformed(file, directive);
				}
				let provider = provider.to_ascii_lowercase().to_str();
				let models = models
					.iter()
					.map(|model| model.to_ascii_lowercase().to_str())
					.collect::<Box<[_]>>();
				if vocabulary
					.pro_reasoning_aliases
					.insert(provider, models)
					.is_some()
				{
					return malformed(file, directive);
				}
			},
			"pro-reasoning-sweep"
			| "canonical-family-token"
			| "wrapper-prefix"
			| "synthetic-prefix"
			| "trailing-marker"
			| "reference-only-trailing-marker" => {},
			other => return unexpected(file, other, "discovery"),
		}
	}
	if vocabulary == DiscoveryVocabulary::default() {
		return malformed(file, "discovery");
	}
	Ok(vocabulary)
}

fn matcher_matches(matcher: &Matcher, lower: &str, bare: &str) -> bool {
	let token = matcher.token.as_str();
	match matcher.kind {
		MatcherKind::Exact => bare == token,
		MatcherKind::Bounded => bounded(bare, token),
		MatcherKind::Namespace if matcher.bounded => lower
			.split(['/', '.', ':'])
			.filter(|part| !part.is_empty())
			.any(|part| bounded(part, token)),
		MatcherKind::Namespace => lower
			.split('/')
			.filter(|part| !part.is_empty())
			.any(|part| part == token),
		MatcherKind::Prefix => bare.starts_with(token),
		MatcherKind::Glob => glob_match(token, bare),
	}
}

fn bounded(value: &str, token: &str) -> bool {
	value == token
		|| value.strip_prefix(token).is_some_and(|rest| {
			rest
				.as_bytes()
				.first()
				.is_some_and(|byte| matches!(byte, b'-' | b'_' | b'.' | b':' | b'0'..=b'9'))
		})
}

fn classify_family(
	class: &ClassDef,
	bare: &str,
	model: &str,
) -> Result<Option<FamilyId>, TaxonomyError> {
	let mut winner: Option<((i64, usize), &FamilyDef)> = None;
	let mut tied_family = None;
	for family in &class.families {
		if !glob_match(family.glob.as_str(), bare) {
			continue;
		}
		let rank = (family.priority, family.glob.bytes().filter(|byte| *byte != b'*').count());
		match winner {
			Some((held_rank, held)) if held_rank == rank && held.id != family.id => {
				tied_family = Some((held, family));
			},
			Some((held_rank, _)) if held_rank >= rank => {},
			_ => {
				winner = Some((rank, family));
				tied_family = None;
			},
		}
	}
	if let Some((first, second)) = tied_family {
		return Err(TaxonomyError::AmbiguousFamily {
			model:  Box::new(model.to_str()),
			class:  class.id.clone(),
			first:  first.id.clone(),
			second: second.id.clone(),
		});
	}
	Ok(winner.map(|(_, family)| family.id.clone()))
}

fn extract_revision(rules: &RevisionDef, bare: &str) -> Option<SemVer> {
	if rules.skip_bare.iter().any(|skip| skip.as_str() == bare) {
		return None;
	}
	let tail = rules.prefixes.iter().find_map(|rule| {
		if rule.anywhere {
			let start = bare.find(rule.prefix.as_str())?;
			Some(&bare[start + rule.prefix.len()..])
		} else {
			bare.strip_prefix(rule.prefix.as_str())
		}
	})?;
	let start = tail.as_bytes().iter().position(u8::is_ascii_digit)?;
	parse_revision_prefix(&tail[start..])
}

fn parse_revision_prefix(value: &str) -> Option<SemVer> {
	let bytes = value.as_bytes();
	let mut numbers = [0_u8; 3];
	let mut count = 0;
	let mut index = 0;
	while count < numbers.len() {
		let start = index;
		while bytes.get(index).is_some_and(u8::is_ascii_digit) {
			index += 1;
		}
		let Ok(number) = parse_u8_component(&value[start..index]) else {
			return (count > 0).then(|| SemVer::new(numbers[0], numbers[1], numbers[2]));
		};
		numbers[count] = number;
		count += 1;
		let Some(separator) = bytes.get(index) else {
			break;
		};
		if !matches!(separator, b'.' | b'-') || !bytes.get(index + 1).is_some_and(u8::is_ascii_digit)
		{
			break;
		}
		index += 1;
	}
	Some(SemVer::new(numbers[0], numbers[1], numbers[2]))
}

fn parse_revision(value: &str) -> Result<SemVer, ()> {
	let mut numbers = [0_u8; 3];
	let mut count = 0;
	for part in value.split(['.', '-']) {
		if count == numbers.len() {
			return Err(());
		}
		numbers[count] = parse_u8_component(part)?;
		count += 1;
	}
	if count == 0 {
		return Err(());
	}
	Ok(SemVer::new(numbers[0], numbers[1], numbers[2]))
}

fn parse_u8_component(value: &str) -> Result<u8, ()> {
	if value.is_empty() {
		return Err(());
	}
	value.as_bytes().iter().try_fold(0_u8, |number, byte| {
		if !byte.is_ascii_digit() {
			return Err(());
		}
		number
			.checked_mul(10)
			.and_then(|number| number.checked_add(*byte - b'0'))
			.ok_or(())
	})
}

fn parse_effort(value: &str) -> Result<EffortTier, ()> {
	match value {
		"off" => Ok(EffortTier::Off),
		"minimal" => Ok(EffortTier::Minimal),
		"low" => Ok(EffortTier::Low),
		"medium" => Ok(EffortTier::Medium),
		"high" => Ok(EffortTier::High),
		"xhigh" => Ok(EffortTier::XHigh),
		"max" => Ok(EffortTier::Max),
		_ => Err(()),
	}
}

fn positional_strings(node: &KdlNode) -> Vec<String> {
	node
		.entries()
		.iter()
		.filter(|entry| entry.name().is_none())
		.filter_map(|entry| entry.value().as_string().map(str::to_owned))
		.collect()
}

fn property_string<'a>(node: &'a KdlNode, name: &str) -> Option<&'a str> {
	node.get(name).and_then(KdlValue::as_string)
}

fn validate_properties(
	file: &str,
	node: &KdlNode,
	directive: &str,
	allowed: &[&str],
) -> Result<(), CascadeError> {
	let mut seen = BTreeSet::new();
	for entry in node.entries() {
		if let Some(name) = entry.name() {
			if !allowed.contains(&name.value()) {
				return unexpected(file, name.value(), directive);
			}
			if !seen.insert(name.value()) {
				return malformed(file, directive);
			}
		}
	}
	let positional_count = node
		.entries()
		.iter()
		.filter(|entry| entry.name().is_none())
		.count();
	if positional_strings(node).len() != positional_count {
		return malformed(file, directive);
	}
	Ok(())
}

fn malformed<T>(file: &str, directive: &str) -> Result<T, CascadeError> {
	Err(malformed_error(file, directive))
}

fn malformed_error(file: &str, directive: &str) -> CascadeError {
	CascadeError::MalformedDirective { file: file.to_str(), directive: directive.to_str() }
}

fn unexpected<T>(file: &str, node: &str, context: &str) -> Result<T, CascadeError> {
	Err(CascadeError::UnexpectedNode {
		file:    file.to_str(),
		node:    node.to_str(),
		context: context.to_str(),
	})
}

#[cfg(test)]
mod tests {
	use omp_core::semver;

	use super::{taxonomy as bundled_taxonomy, *};

	fn parse(sources: &[(&str, &str)]) -> Taxonomy {
		Taxonomy::parse(sources).expect("valid taxonomy")
	}

	fn with_collapse(class: &str) -> Taxonomy {
		parse(&[("collapse", include_str!("../compat/taxonomy/_collapse.kdl")), ("class", class)])
	}

	#[test]
	fn bundled_inventory_parses_once() {
		assert_eq!(BUNDLED_TAXONOMY.len(), 23);
		Taxonomy::bundled().expect("bundled taxonomy parses");
		let unique: BTreeSet<_> = BUNDLED_TAXONOMY.iter().map(|(name, _)| *name).collect();
		assert_eq!(unique.len(), BUNDLED_TAXONOMY.len());
	}

	#[test]
	fn bounded_matcher_outranks_prefix() {
		let taxonomy = with_collapse(
			r#"class "openai" { prefix "gpt-" }
			class "gpt-oss" { bounded "gpt-oss" }"#,
		);
		assert_eq!(taxonomy.classify_id("gpt-oss-120b").unwrap().0, "gpt-oss");
	}

	#[test]
	fn namespace_matches_exact_slash_segments_only() {
		assert_eq!(taxonomy().classify_id("cohere/opaque").unwrap().0, "cohere");
		assert_eq!(
			taxonomy()
				.classify_id("cohere.command-r-plus-v1:0")
				.unwrap()
				.0,
			"unknown"
		);
	}

	#[test]
	fn bounded_namespaces_preserve_boundaries() {
		assert_eq!(
			taxonomy()
				.classify_id("router/anthropic-v2/opaque")
				.unwrap()
				.0,
			"anthropic"
		);
		for model in ["anthropicology", "deepseeker"] {
			assert_eq!(taxonomy().classify_id(model).unwrap().0, "unknown", "{model}");
		}
	}

	#[test]
	fn family_priority_wins_overlap() {
		let taxonomy = with_collapse(
			r#"class "gemini" {
				bounded "gemini"
				family "flash" glob="*flash*"
				family "lite" glob="*flash-lite*" priority=10
			}"#,
		);
		assert_eq!(
			taxonomy
				.classify_id("gemini-2.5-flash-lite")
				.unwrap()
				.1
				.unwrap(),
			"lite"
		);
	}

	#[test]
	fn revisions_normalize_dashes_and_ignore_invalid_trailing_components() {
		let cases = [
			("amazon-bedrock/us.anthropic.claude-opus-4-6-v1", "anthropic", semver!(4.6)),
			("claude-opus-4-1-20250805", "anthropic", semver!(4.1)),
			("gemini-2.5-flash", "gemini", semver!(2.5)),
			("qwen3.8-max", "qwen", semver!(3.8)),
			("o3-mini", "openai", semver!(3.0)),
		];
		for (model, class, revision) in cases {
			let classified = taxonomy().classify_id(model).unwrap();
			assert_eq!(classified.0, class, "{model}");
			assert_eq!(classified.2, Some(revision), "{model}");
		}
		let distill = taxonomy()
			.classify_id("deepseek-r1-distill-qwen-32b")
			.unwrap();
		assert_eq!(distill.0, "qwen");
		assert_eq!(distill.2, None);
	}

	#[test]
	fn bundled_openai_o_series_membership_does_not_claim_later_numbers() {
		let o3_mini = taxonomy()
			.classify_id("o3-mini")
			.expect("bundled taxonomy classifies o3-mini");
		assert_eq!(o3_mini.0, "openai");
		assert_eq!(o3_mini.2, Some(semver!(3.0)));

		let o10 = taxonomy()
			.classify_id("o10")
			.expect("bundled taxonomy classifies o10");
		assert_eq!(o10.0, "unknown");
		assert_eq!(o10.2, None);
	}

	#[test]
	fn revisions_reject_components_above_u8() {
		assert_eq!(parse_revision("255.255.255"), Ok(semver!(255.255.255)));
		assert_eq!(parse_revision("256.0.0"), Err(()));
		assert_eq!(parse_revision("0.256.0"), Err(()));
		assert_eq!(parse_revision("0.0.256"), Err(()));
	}

	#[test]
	fn ranks_can_be_resolved_within_a_preselected_class() {
		let ranks = taxonomy()
			.ranks_in_class(ClassId::from_ref("anthropic"), "claude-opus-4-1-20250805")
			.unwrap();
		assert_eq!(ranks, (Some(FamilyId::new("opus")), Some(semver!(4.1))));
	}

	#[test]
	fn qwen_max_is_product_but_xhigh_is_longest_suffix() {
		assert_eq!(
			taxonomy().collapse("fixture", "qwen3.8-max"),
			(Cow::Borrowed("qwen3.8-max"), None, false)
		);
		assert_eq!(
			taxonomy().collapse("fixture", "gpt-5-xhigh"),
			(Cow::Borrowed("gpt-5"), Some(EffortTier::XHigh), false)
		);
	}

	#[test]
	fn equal_cross_class_and_family_ranks_are_ambiguous() {
		let classes = with_collapse(
			r#"class "one" { bounded "same" }
			class "two" { bounded "same" }"#,
		);
		assert!(matches!(classes.classify_id("same-1"), Err(TaxonomyError::AmbiguousClass { .. })));

		let families = with_collapse(
			r#"class "one" {
				bounded "same"
				family "left" glob="*a*"
				family "right" glob="*b*"
			}"#,
		);
		assert!(matches!(
			families.classify_id("same-ab"),
			Err(TaxonomyError::AmbiguousFamily { .. })
		));
	}

	#[test]
	fn identity_overrides_honor_provider_scope_and_expiry() {
		let taxonomy = with_collapse(
			r#"class "one" {
				exact "model"
				override id="generic" model="model" logical="generic/model" class="one" rationale="test" provenance="test"
				override id="scoped" provider="host" model="model" logical="host/model" class="one" expires-at-ms=10 rationale="test" provenance="test"
			}"#,
		);
		assert_eq!(
			taxonomy
				.identity_override("host", "MODEL", Some(9))
				.unwrap()
				.id,
			"scoped"
		);
		assert_eq!(
			taxonomy
				.identity_override("host", "model", Some(10))
				.unwrap()
				.id,
			"generic"
		);
	}

	#[test]
	fn unknown_and_malformed_nodes_are_rejected() {
		let collapse = ("collapse", include_str!("../compat/taxonomy/_collapse.kdl"));
		assert!(matches!(
			Taxonomy::parse(&[collapse, ("bad", "class \"x\" { mystery \"x\" }")]),
			Err(CascadeError::UnexpectedNode { .. })
		));
		assert!(matches!(
			Taxonomy::parse(&[collapse, ("bad", "class \"x\" { family \"x\" }")]),
			Err(CascadeError::MalformedDirective { .. })
		));
		assert!(matches!(
			Taxonomy::parse(&[collapse, ("bad", "class \"\" {}")]),
			Err(CascadeError::MalformedDirective { .. })
		));
		assert!(matches!(
			Taxonomy::parse(&[collapse, ("bad", "class \"x\" { family \"\" glob=\"*\" }")]),
			Err(CascadeError::MalformedDirective { .. })
		));
	}

	#[test]
	fn routing_variant_suffixes_are_provider_scoped_and_never_collapse() {
		let taxonomy = parse(&[(
			"collapse",
			r#"collapse {
				thinking-suffix "-thinking"
				routing-variant-suffix "-wm" "openai-codex" "openai-codex-device"
			}"#,
		)]);
		assert_eq!(
			taxonomy.routing_variant_plain("openai-codex", "gpt-5.6-luna-wm"),
			Some("gpt-5.6-luna")
		);
		assert_eq!(
			taxonomy.routing_variant_plain("OPENAI-CODEX-DEVICE", "GPT-5.6-LUNA-WM"),
			Some("GPT-5.6-LUNA"),
			"provider and suffix matching are case-insensitive"
		);
		assert_eq!(taxonomy.routing_variant_plain("openrouter", "gpt-5.6-luna-wm"), None);
		assert_eq!(taxonomy.routing_variant_plain("openai-codex", "gpt-5.6-luna"), None);
		assert_eq!(taxonomy.routing_variant_plain("openai-codex", "-wm"), None);
		assert!(taxonomy.has_routing_variants("openai-codex"));
		assert!(!taxonomy.has_routing_variants("openrouter"));
		// Routing variants are route vocabulary, not effort siblings: the
		// classifier's suffix collapse must ignore them.
		assert_eq!(taxonomy.collapse("openai-codex", "gpt-5.6-luna-wm").0, "gpt-5.6-luna-wm");
	}

	#[test]
	fn bundled_collapse_declares_the_codex_worker_routing_variant() {
		// Codex discovery advertises worker-mode `-wm` routing variants of its plain
		// SKUs.
		let taxonomy = taxonomy();
		for provider in ["openai-codex", "openai-codex-device"] {
			assert_eq!(
				taxonomy.routing_variant_plain(provider, "gpt-5.6-luna-wm"),
				Some("gpt-5.6-luna"),
				"{provider}"
			);
		}
		assert_eq!(taxonomy.routing_variant_plain("openai", "gpt-5.6-luna-wm"), None);
	}

	#[test]
	fn malformed_routing_variant_suffixes_are_rejected() {
		for source in [
			// No providers.
			r#"collapse { thinking-suffix "-thinking"; routing-variant-suffix "-wm" }"#,
			// Empty provider.
			r#"collapse { thinking-suffix "-thinking"; routing-variant-suffix "-wm" "" }"#,
			// Empty suffix.
			r#"collapse { thinking-suffix "-thinking"; routing-variant-suffix "" "openai-codex" }"#,
			// Suffix spelling already owned by the collapse vocabulary.
			r#"collapse { thinking-suffix "-thinking"; routing-variant-suffix "-thinking" "openai-codex" }"#,
		] {
			let result = Taxonomy::parse(&[("bad", source)]);
			assert!(
				matches!(result, Err(CascadeError::MalformedDirective { .. })),
				"{source} -> {result:?}"
			);
		}
	}

	#[test]
	fn effort_lane_suffixes_collapse_per_service_tier_lane() {
		let taxonomy = parse(&[(
			"collapse",
			r#"collapse {
				effort-suffix "-low" tier="low"
				effort-suffix "-xhigh" tier="xhigh"
				effort-suffix "-max" tier="max" except-bare-prefix="qwen"
				effort-lane-suffix "-fast" "cursor" bare-prefix="cursor-grok"
			}"#,
		)]);
		assert_eq!(
			taxonomy.collapse("cursor", "cursor-grok-4.6-low-fast"),
			(Cow::Owned::<str>("cursor-grok-4.6-fast".into()), Some(EffortTier::Low), false)
		);
		assert_eq!(
			taxonomy.collapse("cursor", "cursor-grok-4.6-xhigh-fast"),
			(Cow::Owned::<str>("cursor-grok-4.6-fast".into()), Some(EffortTier::XHigh), false)
		);
		// Provider and suffix matching are case-insensitive; the logical id
		// preserves the caller's original lane bytes.
		assert_eq!(
			taxonomy.collapse("CURSOR", "Cursor-Grok-4.6-Low-FAST"),
			(Cow::Owned::<str>("Cursor-Grok-4.6-FAST".into()), Some(EffortTier::Low), false)
		);
		// The plain lane keeps collapsing by the ordinary effort vocabulary.
		assert_eq!(
			taxonomy.collapse("cursor", "cursor-grok-4.6-low"),
			(Cow::Borrowed("cursor-grok-4.6"), Some(EffortTier::Low), false)
		);
		// Undeclared provider, gated bare prefix, and lanes without a wedged
		// effort suffix never collapse.
		assert_eq!(
			taxonomy.collapse("devin", "cursor-grok-4.6-low-fast").0,
			"cursor-grok-4.6-low-fast"
		);
		assert_eq!(taxonomy.collapse("cursor", "claude-opus-5-low-fast").0, "claude-opus-5-low-fast");
		assert_eq!(taxonomy.collapse("cursor", "cursor-grok-4.6-fast").0, "cursor-grok-4.6-fast");
		// `except-bare-prefix` gates the wedged effort suffix inside a lane.
		let ungated = parse(&[(
			"collapse",
			r#"collapse {
				effort-suffix "-max" tier="max" except-bare-prefix="qwen"
				effort-lane-suffix "-fast" "cursor"
			}"#,
		)]);
		assert_eq!(ungated.collapse("cursor", "qwen3.8-max-fast").0, "qwen3.8-max-fast");
		assert_eq!(
			ungated.collapse("cursor", "grok-5-max-fast"),
			(Cow::Owned::<str>("grok-5-fast".into()), Some(EffortTier::Max), false)
		);
	}

	#[test]
	fn bundled_collapse_declares_the_cursor_fast_lane() {
		// Cursor serves effort siblings alongside a parallel `-fast`
		// service-tier lane; batch safety decides which candidate groups
		// actually collapse.
		let taxonomy = taxonomy();
		let cursor_families = taxonomy
			.effort_families
			.iter()
			.filter(|family| family.provider == "cursor")
			.map(|family| family.logical.as_str())
			.collect::<Vec<_>>();
		for expected in ["gpt-5.6-luna", "gpt-5.6-sol", "gpt-5.6-terra"] {
			assert!(cursor_families.contains(&expected), "missing Cursor family {expected}");
		}
		assert_eq!(
			taxonomy.collapse("cursor", "cursor-grok-4.6-medium-fast"),
			(Cow::Owned::<str>("cursor-grok-4.6-fast".into()), Some(EffortTier::Medium), false)
		);
		assert_eq!(
			taxonomy.collapse("cursor", "cursor-grok-4.5-high-fast"),
			(Cow::Owned::<str>("cursor-grok-4.5-fast".into()), Some(EffortTier::High), false)
		);
		// The non-reasoning coding SKU keeps its identity: it neither ends in
		// the lane token nor carries the versioned prefix.
		assert_eq!(taxonomy.collapse("cursor", "grok-code-fast-1").0, "grok-code-fast-1");
		assert_eq!(
			taxonomy.collapse("cursor", "claude-opus-5-high-fast"),
			(Cow::Owned::<str>("claude-opus-5-fast".into()), Some(EffortTier::High), false)
		);
	}

	#[test]
	fn bundled_effort_families_fold_gemini_tiered_aliases() {
		let taxonomy = taxonomy();
		for (alias, logical) in [
			("gemini-3.6-flash-tiered", "gemini-3.6-flash"),
			("gemini-3.7-flash-tiered", "gemini-3.7-flash"),
		] {
			assert_eq!(
				taxonomy.collapse("google-antigravity", alias),
				(Cow::Borrowed(logical), None, false)
			);
		}
		assert_eq!(
			taxonomy
				.collapse("GOOGLE-ANTIGRAVITY", "GEMINI-3.7-FLASH-TIERED")
				.0,
			"gemini-3.7-flash"
		);
		assert_eq!(
			taxonomy.collapse("google", "gemini-3.7-flash-tiered").0,
			"gemini-3.7-flash-tiered"
		);
	}

	#[test]
	fn malformed_effort_family_aliases_are_rejected() {
		for source in [
			r#"collapse {
				effort-family "provider" "model" ""
			}"#,
			r#"collapse {
				effort-family "provider" "model" "model"
			}"#,
			r#"collapse {
				effort-family "provider" "first" "shared-alias"
				effort-family "provider" "second" "shared-alias"
			}"#,
		] {
			let result = Taxonomy::parse(&[("bad", source)]);
			assert!(
				matches!(result, Err(CascadeError::MalformedDirective { .. })),
				"{source} -> {result:?}"
			);
		}
	}

	#[test]
	fn malformed_effort_lane_suffixes_are_rejected() {
		for source in [
			// No providers.
			r#"collapse { thinking-suffix "-thinking"; effort-lane-suffix "-fast" }"#,
			// Empty provider.
			r#"collapse { thinking-suffix "-thinking"; effort-lane-suffix "-fast" "" }"#,
			// Empty suffix.
			r#"collapse { thinking-suffix "-thinking"; effort-lane-suffix "" "cursor" }"#,
			// Suffix spelling already owned by the collapse vocabulary.
			r#"collapse { thinking-suffix "-thinking"; effort-lane-suffix "-thinking" "cursor" }"#,
			// Non-string bare-prefix gate.
			r#"collapse { thinking-suffix "-thinking"; effort-lane-suffix "-fast" "cursor" bare-prefix=1 }"#,
		] {
			let result = Taxonomy::parse(&[("bad", source)]);
			assert!(
				matches!(result, Err(CascadeError::MalformedDirective { .. })),
				"{source} -> {result:?}"
			);
		}
	}

	#[test]
	fn discovery_canonical_recovery_is_provider_scoped() {
		let taxonomy = parse(&[
			("collapse", r#"collapse { thinking-suffix "-thinking" }"#),
			("discovery", r#"discovery { recover-canonical-params "gmi-cloud" }"#),
		]);
		assert!(taxonomy.recovers_canonical_params("gmi-cloud"));
		assert!(taxonomy.recovers_canonical_params("GMI-CLOUD"));
		assert!(!taxonomy.recovers_canonical_params("siliconflow"));
		assert!(super::taxonomy().recovers_canonical_params("gmi-cloud"));
		assert!(super::taxonomy().recovers_canonical_params("opencode-go"));
		assert!(!super::taxonomy().recovers_canonical_params("openrouter"));
	}

	#[test]
	fn malformed_discovery_nodes_are_rejected() {
		let collapse = ("collapse", r#"collapse { thinking-suffix "-thinking" }"#);
		for source in [
			// Empty block.
			"discovery {}",
			// No providers.
			r"discovery { recover-canonical-params }",
			// Empty provider.
			r#"discovery { recover-canonical-params "" }"#,
			// Duplicate provider.
			r#"discovery { recover-canonical-params "gmi-cloud" "GMI-Cloud" }"#,
			// Empty group.
			r"discovery { borrow-responses-route }",
			// Empty group member.
			r#"discovery { borrow-responses-route "" }"#,
			// Duplicate member within one group.
			r#"discovery { borrow-responses-route "opencode-go" "OPENCODE-GO" }"#,
			// A provider may belong to at most one group.
			r#"discovery { borrow-responses-route "opencode-go" "opencode-zen"; borrow-responses-route "Opencode-Go" }"#,
			// Exact response-route pins require a provider and at least one model.
			r#"discovery { responses-route-models "opencode-go" }"#,
			// Exact pins are unique within a provider.
			r#"discovery { responses-route-models "opencode-go" "muse" "MUSE" }"#,
			// A provider's exact pins are declared once.
			r#"discovery { responses-route-models "opencode-go" "muse"; responses-route-models "OPENCODE-GO" "other" }"#,
			// Empty suffix.
			r#"discovery { billing-variant-suffix "" }"#,
			// Bare dash suffix.
			r#"discovery { billing-variant-suffix "-" }"#,
			// Duplicate suffix.
			r#"discovery { billing-variant-suffix "-free" "-FREE" }"#,
		] {
			assert!(
				matches!(
					Taxonomy::parse(&[collapse, ("bad", source)]),
					Err(CascadeError::MalformedDirective { .. })
				),
				"{source}"
			);
		}
		assert!(matches!(
			Taxonomy::parse(&[collapse, ("bad", r#"discovery { mystery "x" }"#)]),
			Err(CascadeError::UnexpectedNode { .. })
		));
		assert!(matches!(
			Taxonomy::parse(&[
				collapse,
				("one", r#"discovery { recover-canonical-params "a" }"#),
				("two", r#"discovery { recover-canonical-params "b" }"#),
			]),
			Err(CascadeError::MalformedDirective { .. })
		));
	}

	#[test]
	fn discovery_responses_route_hints_are_group_and_suffix_scoped() {
		let taxonomy = parse(&[
			("collapse", r#"collapse { thinking-suffix "-thinking" }"#),
			(
				"discovery",
				r#"discovery { borrow-responses-route "opencode-go" "opencode-zen"; responses-route-models "opencode-go" "muse-spark-1.2"; billing-variant-suffix "-free" "-contributor" }"#,
			),
		]);
		let group = taxonomy
			.responses_hint_group("OPENCODE-GO")
			.expect("declared group");
		assert!(group.iter().any(|member| member.as_str() == "opencode-zen"));
		assert!(taxonomy.responses_hint_group("openrouter").is_none());
		assert_eq!(
			taxonomy
				.responses_route_models("OPENCODE-GO")
				.expect("provider route pins"),
			["muse-spark-1.2"]
		);
		assert!(taxonomy.responses_route_models("openrouter").is_none());
		assert_eq!(
			taxonomy.billing_variant_plain("muse-spark-1.2-contributor"),
			Some("muse-spark-1.2")
		);
		assert_eq!(
			taxonomy.billing_variant_plain("deepseek-v4-flash-FREE"),
			Some("deepseek-v4-flash")
		);
		assert_eq!(taxonomy.billing_variant_plain("-free"), None, "an empty base never matches");
		assert_eq!(taxonomy.billing_variant_plain("kimi-k3"), None);
		// The bundled inventory declares the OpenCode gateway group and the
		// billing-variant suffixes runtime discovery hints with.
		let bundled = bundled_taxonomy();
		assert!(
			bundled
				.responses_hint_group("opencode-go")
				.expect("bundled OpenCode group")
				.iter()
				.any(|member| member.as_str() == "opencode-zen")
		);
		assert!(
			bundled
				.responses_route_models("opencode-go")
				.expect("bundled route pins")
				.iter()
				.any(|model| model.as_str() == "muse-spark-1.2")
		);
		assert_eq!(
			bundled.billing_variant_plain("muse-spark-1.2-contributor"),
			Some("muse-spark-1.2")
		);
	}
}
