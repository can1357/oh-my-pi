//! KDL compat cascade: class/provider/model wire- and thinking-policy rules.
//!
//! Authoring format for the sparse per-model compatibility data that today
//! lives as flat enumerated profiles in
//! `fixtures/llm-oracle/catalog-policy/{compat,thinking}-profiles.json`.
//! Rules are conjunctions over five selector dimensions:
//!
//! - **class** — the centrally classified model class ([`crate::classify`]),
//! - **providers** — deployment hosts (`on "a" "b"` inside a class block, or
//!   the enclosing `provider` block),
//! - **family** — the classified product family within a class,
//! - **revision** — a conjunction of `SemVer` comparisons,
//! - **models** — exact or `*`-glob, ASCII-case-insensitive, matched against
//!   the provider-relative model identifier; `token="name"` matches only when
//!   bounded by non-alphanumeric separators or identifier edges.
//!
//! Axis ownership is semantic, not statistical: `classes/*.kdl` carry
//! model-lineage truths (the census keys them on model-class predicates —
//! dialect thinking markup, reasoning-content replay needs, reasoning control
//! ladders), while `providers/*.kdl` carry deployment wire contracts (role
//! and store support, token-field spelling, effort pass-through) plus
//! per-model residues the class stratum does not explain. Absence is never
//! inferred as "stripping": a rule only states what the census established,
//! scoped with `on` when a behavior is a class×host composition.
//!
//! ```kdl
//! class "deepseek" {
//!     models "deepseek-r1" "deepseek/deepseek-v3.2-exp" {
//!         requires-reasoning-content-for-all-assistant-turns #true
//!     }
//! }
//! provider "cursor" {
//!     models "gpt-5.1" { thinking-efforts "low" "high" }
//! }
//! ```
//!
//! Precedence is specificity-only: per axis, the matching rule with the
//! highest `(model-selector exactness, selector dimension count, priority)`
//! wins; two rules tying on all three while contesting one axis are rejected
//! at resolve time — declaration and file order are never semantic. Unknown
//! directives are rejected (`deny_unknown_fields` semantics). Thinking axes
//! describe the reasoning control surface and only apply to models the
//! catalog marks reasoning-capable; callers gate on that capability.
//! `tests/compat_cascade.rs` proves the bundled sources resolve to exactly
//! the frozen oracle for every catalog model.

use std::collections::BTreeMap;

use kdl::{KdlDocument, KdlNode, KdlValue};
use omp_core::{IntoStr, SemVer, Str};
use serde_json::{Map, Value};
use thiserror::Error;

use crate::compat::{AxisSet, AxisShape, axis};

macro_rules! sources {
	($($name:literal),+ $(,)?) => {
		&[$(($name, include_str!(concat!("../compat/", $name, ".kdl")))),+]
	};
}

/// Checked-in cascade sources: `classes/*` then `providers/*`.
///
/// `tests/compat_cascade.rs` asserts this list matches the on-disk `compat/`
/// tree so a new file cannot be silently dropped.
pub const BUNDLED_COMPAT: &[(&str, &str)] = sources![
	"classes/amazon",
	"classes/anthropic",
	"classes/baidu",
	"classes/bytedance",
	"classes/cohere",
	"classes/deepseek",
	"classes/gemini",
	"classes/gemma",
	"classes/glm",
	"classes/gpt-oss",
	"classes/kimi",
	"classes/meta",
	"classes/mimo",
	"classes/minimax",
	"classes/mistral",
	"classes/openai",
	"classes/qwen",
	"classes/stepfun",
	"classes/xai",
	"providers/agnes",
	"providers/agnes-plan",
	"providers/abliteration",
	"providers/aiand",
	"providers/aimlapi",
	"providers/alibaba-coding-plan",
	"providers/alibaba-token-plan",
	"providers/amazon-bedrock",
	"providers/anthropic",
	"providers/azure",
	"providers/baseten",
	"providers/bedrock-mantle",
	"providers/cerebras",
	"providers/cline-pass",
	"providers/cloudflare-ai-gateway",
	"providers/cohere",
	"providers/coreweave",
	"providers/crofai",
	"providers/cursor",
	"providers/deepseek",
	"providers/firepass",
	"providers/fireworks",
	"providers/friendli",
	"providers/github-copilot",
	"providers/gitlab-duo",
	"providers/gmi-cloud",
	"providers/google",
	"providers/google-antigravity",
	"providers/google-gemini-cli",
	"providers/google-vertex",
	"providers/groq",
	"providers/huggingface",
	"providers/inception",
	"providers/kilo",
	"providers/kimi-code",
	"providers/llama.cpp",
	"providers/lm-studio",
	"providers/meta",
	"providers/minimax",
	"providers/minimax-code",
	"providers/minimax-code-cn",
	"providers/mistral",
	"providers/moonshot",
	"providers/nanogpt",
	"providers/novita",
	"providers/nvidia",
	"providers/ollama",
	"providers/ollama-cloud",
	"providers/openai",
	"providers/openai-codex",
	"providers/opencode",
	"providers/opencode-go",
	"providers/opencode-zen",
	"providers/openrouter",
	"providers/ovhai",
	"providers/poolside",
	"providers/qianfan",
	"providers/sakana",
	"providers/sarvam",
	"providers/scaleway",
	"providers/stepfun",
	"providers/stepfun-plan",
	"providers/synthetic",
	"providers/together",
	"providers/umans",
	"providers/venice",
	"providers/vercel-ai-gateway",
	"providers/vllm",
	"providers/wafer-serverless",
	"providers/xai",
	"providers/xai-oauth",
	"providers/xiaomi",
	"providers/xiaomi-token-plan-ams",
	"providers/xiaomi-token-plan-cn",
	"providers/xiaomi-token-plan-sgp",
	"providers/yandex",
	"providers/yolo-auto",
	"providers/zai",
	"providers/zenmux",
	"providers/zhipu-coding-plan",
];

/// Resolved sparse axis assignments keyed by oracle-spelling axis name.
pub type AxisMap = BTreeMap<Str, Value>;

/// Wire, thinking, and catalog-data assignments resolved for one model.
///
/// `thinking` describes the reasoning control surface and is only meaningful
/// for models the catalog marks reasoning-capable; callers apply that gate.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Resolved {
	/// `wire/*` request-compatibility overrides.
	pub wire:     AxisMap,
	/// Thinking-profile assignments (`mode`, `efforts`, …).
	pub thinking: AxisMap,
	/// Reviewed catalog-data corrections, separate from wire compatibility.
	pub catalog:  AxisMap,
}

/// Cascade authoring or resolution failure.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum CascadeError {
	/// A source file is not valid KDL.
	#[error("{file}: KDL parse failure: {message}")]
	Parse {
		/// Offending source file.
		file:    Str,
		/// Rendered parser diagnostic.
		message: Str,
	},
	/// A node appeared somewhere its kind is not allowed.
	#[error("{file}: unexpected node `{node}` under `{context}`")]
	UnexpectedNode {
		/// Offending source file.
		file:    Str,
		/// Node name found.
		node:    Str,
		/// Enclosing context.
		context: Str,
	},
	/// A directive is absent from the closed compatibility vocabulary.
	#[error("{file}:{line}: unknown directive `{directive}`")]
	UnknownDirective {
		/// Offending source file.
		file:      Str,
		/// One-based source line.
		line:      usize,
		/// Kebab-case directive as written.
		directive: Str,
	},
	/// A directive has an argument shape its [`AxisShape`] rejects.
	#[error("{file}: directive `{directive}` has a malformed value")]
	MalformedDirective {
		/// Offending source file.
		file:      Str,
		/// Kebab-case directive as written.
		directive: Str,
	},
	/// A string value is outside an axis's closed enumeration.
	#[error("{file}:{line}: directive `{directive}` rejects value `{value}`")]
	InvalidDirectiveValue {
		/// Offending source file.
		file:      Str,
		/// One-based source line.
		line:      usize,
		/// Kebab-case directive as written.
		directive: Str,
		/// Rejected string value.
		value:     Str,
	},
	/// The same axis was assigned twice within one rule block.
	#[error("{file}: axis `{axis}` assigned twice in one block")]
	DuplicateAxis {
		/// Offending source file.
		file: Str,
		/// Resolved axis name.
		axis: Str,
	},
	/// Two rules of equal specificity and priority set the same axis for one
	/// model. Declaration order is never a tiebreak; add `priority=N`.
	#[error(
		"ambiguous overlap for `{}/{}` on axis `{}`: rules `{}` and `{}` tie; add an explicit \
		 priority",
		.0.provider, .0.model, .0.axis, .0.first, .0.second
	)]
	AmbiguousOverlap(Box<OverlapDetails>),
}

/// Colliding-rule evidence for [`CascadeError::AmbiguousOverlap`].
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct OverlapDetails {
	/// Provider whose rules collide.
	pub provider: Str,
	/// Provider-relative model identifier.
	pub model:    Str,
	/// Contested axis name.
	pub axis:     Str,
	/// First tied rule label.
	pub first:    Str,
	/// Second tied rule label.
	pub second:   Str,
}

/// Structured identity and capability input to [`CompatCascade::resolve`].
#[derive(Clone, Copy, Debug)]
pub struct ResolveTarget<'a> {
	/// Deployment provider hosting the model.
	pub provider:  &'a str,
	/// Centrally classified vendor lineage.
	pub class:     &'a str,
	/// Classified product family within the class, when known.
	pub family:    Option<&'a str>,
	/// Parsed model revision, when present in the identity.
	pub revision:  Option<SemVer>,
	/// Provider-relative model identifier.
	pub model:     &'a str,
	/// Whether the model exposes a reasoning control surface.
	pub reasoning: bool,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
enum RevisionOp {
	GreaterEqual,
	Greater,
	LessEqual,
	Less,
	Equal,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub(crate) struct RevisionConstraint(Vec<(RevisionOp, SemVer)>);

impl RevisionConstraint {
	pub(crate) fn matches(&self, revision: SemVer) -> bool {
		self.0.iter().all(|&(op, expected)| match op {
			RevisionOp::GreaterEqual => revision >= expected,
			RevisionOp::Greater => revision > expected,
			RevisionOp::LessEqual => revision <= expected,
			RevisionOp::Less => revision < expected,
			RevisionOp::Equal => revision == expected,
		})
	}
}

/// One exact or glob model selector.
#[derive(Clone, Debug, Eq, PartialEq)]
enum Selector {
	/// Whole-identifier match (case-sensitive: identifiers are exact).
	Exact(Str),
	/// `*`-wildcard match (ASCII-case-insensitive: patterns span the chaotic
	/// aggregator spellings of one lineage).
	Glob(Str),
	/// ASCII-case-insensitive token bounded by identifier punctuation or edges.
	Token(Str),
}

impl Selector {
	fn new(pattern: &str) -> Self {
		if pattern.contains('*') {
			Self::Glob(pattern.to_ascii_lowercase().to_str())
		} else {
			Self::Exact(pattern.to_str())
		}
	}

	fn matches(&self, model: &str, model_lower: &str) -> bool {
		match self {
			Self::Exact(id) => id.as_str() == model,
			Self::Glob(pattern) => glob_match(pattern.as_str(), model_lower),
			Self::Token(token) => model_lower
				.split(|character: char| !character.is_ascii_alphanumeric())
				.any(|part| part == token.as_str()),
		}
	}

	/// Exact selectors outrank globs and bounded tokens; all outrank
	/// selector-free rules.
	const fn exactness(&self) -> u8 {
		match self {
			Self::Exact(_) => 2,
			Self::Glob(_) | Self::Token(_) => 1,
		}
	}
}

/// Anchored `*`-wildcard match; both sides pre-lowercased.
pub(crate) fn glob_match(pattern: &str, value: &str) -> bool {
	let mut remainder = value;
	let mut segments = pattern.split('*');
	let Some(head) = segments.next() else {
		return value.is_empty();
	};
	let Some(stripped) = remainder.strip_prefix(head) else {
		return false;
	};
	remainder = stripped;
	let mut tail: Option<&str> = None;
	for segment in segments {
		if let Some(previous) = tail.take() {
			let Some(found) = remainder.find(previous) else {
				return false;
			};
			remainder = &remainder[found + previous.len()..];
		}
		tail = Some(segment);
	}
	match tail {
		// No `*` at all: the prefix strip must have consumed everything.
		None => remainder.is_empty(),
		Some("") => true,
		Some(last) => remainder.ends_with(last),
	}
}

/// One conjunction rule: every present dimension must match.
#[derive(Clone, Debug)]
struct Rule {
	class:     Option<Str>,
	providers: Option<Vec<Str>>,
	family:    Option<Str>,
	revision:  Option<RevisionConstraint>,
	models:    Option<Vec<Selector>>,
	priority:  i64,
	wire:      AxisMap,
	thinking:  AxisMap,
	/// Reviewed catalog-data corrections.
	catalog:   AxisMap,
	/// Human-readable origin for diagnostics.
	label:     Str,
}

impl Rule {
	/// Number of constrained selector dimensions.
	fn dimensions(&self) -> u8 {
		u8::from(self.class.is_some())
			+ u8::from(self.providers.is_some())
			+ u8::from(self.family.is_some())
			+ u8::from(self.revision.is_some())
			+ u8::from(self.models.is_some())
	}

	/// `(exactness, dimensions, priority)` rank when the rule matches.
	fn rank(&self, target: &ResolveTarget<'_>, model_lower: &str) -> Option<(u8, u8, i64)> {
		if let Some(required) = &self.class
			&& required.as_str() != target.class
		{
			return None;
		}
		if let Some(providers) = &self.providers
			&& !providers
				.iter()
				.any(|candidate| candidate.as_str() == target.provider)
		{
			return None;
		}
		if let Some(required) = &self.family
			&& target.family != Some(required.as_str())
		{
			return None;
		}
		if let Some(constraint) = &self.revision
			&& !target
				.revision
				.is_some_and(|revision| constraint.matches(revision))
		{
			return None;
		}
		let exactness = match &self.models {
			None => 0,
			Some(selectors) => selectors
				.iter()
				.filter(|selector| selector.matches(target.model, model_lower))
				.map(Selector::exactness)
				.max()?,
		};
		Some((exactness, self.dimensions(), self.priority))
	}
}

/// Parsed, validated compat cascade over every source file.
#[derive(Clone, Debug, Default)]
pub struct CompatCascade {
	rules: Vec<Rule>,
}

impl CompatCascade {
	/// Parses and validates `(file name, KDL text)` sources.
	///
	/// # Errors
	/// Returns the first [`CascadeError`] encountered: invalid KDL, unknown or
	/// malformed directives, duplicate axes, or misplaced nodes.
	#[tracing::instrument(
		name = "catalog_compat_parse",
		level = "debug",
		skip_all,
		fields(source_count = sources.len())
	)]
	pub fn parse(sources: &[(&str, &str)]) -> Result<Self, CascadeError> {
		let mut rules = Vec::new();
		for &(file, text) in sources {
			let document: KdlDocument = text.parse().map_err(|error: kdl::KdlError| {
				tracing::warn!(file, "catalog compatibility KDL failed to parse");
				CascadeError::Parse { file: file.to_str(), message: error.to_string().to_str() }
			})?;
			for node in document.nodes() {
				match node.name().value() {
					"class" => parse_class(file, text, node, &mut rules)?,
					"provider" => parse_provider(file, text, node, &mut rules)?,
					other => {
						return Err(CascadeError::UnexpectedNode {
							file:    file.to_str(),
							node:    other.to_str(),
							context: "document root".to_str(),
						});
					},
				}
			}
		}
		Ok(Self { rules })
	}

	/// Parses the checked-in [`BUNDLED_COMPAT`] sources.
	///
	/// # Errors
	/// Propagates [`CascadeError`] from [`CompatCascade::parse`]; the bundled
	/// sources failing is a build defect.
	pub fn bundled() -> Result<Self, CascadeError> {
		Self::parse(BUNDLED_COMPAT)
	}

	/// Resolves wire, thinking, and reviewed catalog-data assignments for one
	/// structured model target.
	///
	/// When `target.reasoning` is false, broad thinking rules are not evaluated,
	/// so family and revision policy cannot leak onto non-reasoning siblings.
	/// An exact model selector may still declare thinking axes as a reviewed
	/// correction to stale source capability metadata. Family and revision
	/// selectors never match a target lacking that identity rank. Unmatched
	/// targets resolve to empty maps.
	///
	/// # Errors
	/// [`CascadeError::AmbiguousOverlap`] when two rules tying on
	/// `(exactness, dimensions, priority)` contest one axis.
	pub fn resolve(&self, target: &ResolveTarget<'_>) -> Result<Resolved, CascadeError> {
		let model_lower = target.model.to_ascii_lowercase();
		let mut wire: BTreeMap<&Str, ((u8, u8, i64), &Rule)> = BTreeMap::new();
		let mut thinking: BTreeMap<&Str, ((u8, u8, i64), &Rule)> = BTreeMap::new();
		let mut catalog: BTreeMap<&Str, ((u8, u8, i64), &Rule)> = BTreeMap::new();
		let reasoning = target.reasoning
			|| self.rules.iter().any(|rule| {
				rule.thinking.contains_key("efforts")
					&& rule
						.rank(target, &model_lower)
						.is_some_and(|(exactness, ..)| exactness == 2)
			});
		for rule in &self.rules {
			let Some(rank) = rule.rank(target, &model_lower) else {
				continue;
			};
			if !reasoning && rule.wire.is_empty() && rule.catalog.is_empty() {
				continue;
			}
			contest(&mut wire, &rule.wire, rank, rule, target.provider, target.model)?;
			contest(&mut catalog, &rule.catalog, rank, rule, target.provider, target.model)?;
			if reasoning {
				contest(&mut thinking, &rule.thinking, rank, rule, target.provider, target.model)?;
			}
		}
		let collect = |winners: BTreeMap<&Str, ((u8, u8, i64), &Rule)>,
		               pick: fn(&Rule) -> &AxisMap| {
			winners
				.into_iter()
				.map(|(axis, (_, rule))| (axis.clone(), pick(rule)[axis].clone()))
				.collect()
		};
		Ok(Resolved {
			wire:     collect(wire, |rule| &rule.wire),
			thinking: collect(thinking, |rule| &rule.thinking),
			catalog:  collect(catalog, |rule| &rule.catalog),
		})
	}
}

/// Ranks `rule` into the per-axis winner table; equal ranks are ambiguous.
fn contest<'cascade>(
	winners: &mut BTreeMap<&'cascade Str, ((u8, u8, i64), &'cascade Rule)>,
	axes: &'cascade AxisMap,
	rank: (u8, u8, i64),
	rule: &'cascade Rule,
	provider: &str,
	model: &str,
) -> Result<(), CascadeError> {
	for axis in axes.keys() {
		match winners.get(axis) {
			Some(&(held_rank, held)) if held_rank == rank => {
				return Err(CascadeError::AmbiguousOverlap(Box::new(OverlapDetails {
					provider: provider.to_str(),
					model:    model.to_str(),
					axis:     axis.clone(),
					first:    held.label.clone(),
					second:   rule.label.clone(),
				})));
			},
			Some(&(held_rank, _)) if held_rank > rank => {},
			_ => {
				winners.insert(axis, (rank, rule));
			},
		}
	}
	Ok(())
}

const CHILD_ON: u8 = 1 << 0;
const CHILD_CLASS: u8 = 1 << 1;
const CHILD_FAMILY: u8 = 1 << 2;
const CHILD_REVISION: u8 = 1 << 3;
const CHILD_MODELS: u8 = 1 << 4;
const CLASS_CHILDREN: u8 = CHILD_ON | CHILD_FAMILY | CHILD_REVISION | CHILD_MODELS;
const CLASS_ON_CHILDREN: u8 = CHILD_FAMILY | CHILD_REVISION | CHILD_MODELS;
const PROVIDER_CHILDREN: u8 = CHILD_CLASS | CHILD_MODELS;
const FAMILY_CHILDREN: u8 = CHILD_REVISION | CHILD_MODELS;
const REVISION_CHILDREN: u8 = CHILD_MODELS;

#[derive(Clone, Default)]
struct RuleScope {
	class:     Option<Str>,
	providers: Option<Vec<Str>>,
	family:    Option<Str>,
	revision:  Option<RevisionConstraint>,
	models:    Option<Vec<Selector>>,
}

fn source_line(source: &str, node: &KdlNode) -> usize {
	let offset = node.span().offset().min(source.len());
	source[..offset]
		.bytes()
		.filter(|byte| *byte == b'\n')
		.count()
		+ 1
}

fn parse_class(
	file: &str,
	source: &str,
	node: &KdlNode,
	rules: &mut Vec<Rule>,
) -> Result<(), CascadeError> {
	let class = required_name(file, node, "class")?.to_str();
	parse_scope(
		file,
		source,
		node,
		RuleScope { class: Some(class), ..RuleScope::default() },
		CLASS_CHILDREN,
		rules,
	)
}

fn parse_provider(
	file: &str,
	source: &str,
	node: &KdlNode,
	rules: &mut Vec<Rule>,
) -> Result<(), CascadeError> {
	let provider = required_name(file, node, "provider")?.to_str();
	parse_scope(
		file,
		source,
		node,
		RuleScope { providers: Some(vec![provider]), ..RuleScope::default() },
		PROVIDER_CHILDREN,
		rules,
	)
}

fn parse_scope(
	file: &str,
	source: &str,
	node: &KdlNode,
	scope: RuleScope,
	allowed: u8,
	rules: &mut Vec<Rule>,
) -> Result<(), CascadeError> {
	let priority = node_priority(file, node)?;
	let mut axes = RuleAxes::default();
	if let Some(children) = node.children() {
		for child in children.nodes() {
			let (kind, next_allowed) = match child.name().value() {
				"on" => (CHILD_ON, CLASS_ON_CHILDREN),
				"class" => (CHILD_CLASS, CLASS_ON_CHILDREN),
				"family" => (CHILD_FAMILY, FAMILY_CHILDREN),
				"revision" => (CHILD_REVISION, REVISION_CHILDREN),
				"models" => (CHILD_MODELS, 0),
				_ => {
					axes.collect(file, source_line(source, child), child)?;
					continue;
				},
			};
			if allowed & kind == 0 {
				return Err(CascadeError::UnexpectedNode {
					file:    file.to_str(),
					node:    child.name().value().to_str(),
					context: node.name().value().to_str(),
				});
			}

			let mut nested = scope.clone();
			match kind {
				CHILD_ON => nested.providers = Some(string_arguments(child, file, "on")?),
				CHILD_CLASS => nested.class = Some(required_name(file, child, "class")?.to_str()),
				CHILD_FAMILY => nested.family = Some(required_name(file, child, "family")?.to_str()),
				CHILD_REVISION => {
					let expression = required_name(file, child, "revision")?;
					nested.revision = Some(parse_revision_constraint(expression).ok_or_else(|| {
						CascadeError::MalformedDirective {
							file:      file.to_str(),
							directive: "revision".to_str(),
						}
					})?);
				},
				CHILD_MODELS => nested.models = Some(selector_arguments(child, file)?),
				_ => unreachable!("known selector bit"),
			}
			parse_scope(file, source, child, nested, next_allowed, rules)?;
		}
	}
	push_rule(rules, scope, priority, node, axes, file);
	Ok(())
}

fn push_rule(
	rules: &mut Vec<Rule>,
	scope: RuleScope,
	priority: i64,
	node: &KdlNode,
	axes: RuleAxes,
	file: &str,
) {
	if axes.is_empty() {
		return;
	}
	rules.push(Rule {
		class: scope.class,
		providers: scope.providers,
		family: scope.family,
		revision: scope.revision,
		models: scope.models,
		priority,
		wire: axes.wire,
		thinking: axes.thinking,
		catalog: axes.catalog,
		label: fmt_label(file, &[node.name().value()]),
	});
}

fn required_name<'a>(
	file: &str,
	node: &'a KdlNode,
	directive: &str,
) -> Result<&'a str, CascadeError> {
	single_string_argument(node).ok_or_else(|| CascadeError::MalformedDirective {
		file:      file.to_str(),
		directive: directive.to_str(),
	})
}

pub(crate) fn parse_revision_constraint(expression: &str) -> Option<RevisionConstraint> {
	let mut terms = Vec::new();
	for term in expression.split_ascii_whitespace() {
		let (op, version) = if let Some(version) = term.strip_prefix(">=") {
			(RevisionOp::GreaterEqual, version)
		} else if let Some(version) = term.strip_prefix("<=") {
			(RevisionOp::LessEqual, version)
		} else if let Some(version) = term.strip_prefix('>') {
			(RevisionOp::Greater, version)
		} else if let Some(version) = term.strip_prefix('<') {
			(RevisionOp::Less, version)
		} else {
			let version = term.strip_prefix('=')?;
			(RevisionOp::Equal, version)
		};
		terms.push((op, parse_semver(version)?));
	}
	(!terms.is_empty()).then_some(RevisionConstraint(terms))
}

fn parse_semver(text: &str) -> Option<SemVer> {
	let mut components = [0_u8; 3];
	let mut count = 0;
	for component in text.split('.') {
		if count == components.len()
			|| component.is_empty()
			|| !component.bytes().all(|byte| byte.is_ascii_digit())
		{
			return None;
		}
		components[count] = component.parse().ok()?;
		count += 1;
	}
	(count > 0).then(|| SemVer::new(components[0], components[1], components[2]))
}

/// Wire, thinking, and catalog-data assignments collected from one rule block.
#[derive(Default)]
struct RuleAxes {
	wire:     AxisMap,
	thinking: AxisMap,
	catalog:  AxisMap,
}

impl RuleAxes {
	fn is_empty(&self) -> bool {
		self.wire.is_empty() && self.thinking.is_empty() && self.catalog.is_empty()
	}

	fn collect(&mut self, file: &str, line: usize, node: &KdlNode) -> Result<(), CascadeError> {
		if node.entries().iter().any(|entry| entry.name().is_some()) {
			return Err(CascadeError::MalformedDirective {
				file:      file.to_str(),
				directive: node.name().value().to_str(),
			});
		}
		let written = node.name().value();
		let Some(definition) = axis(written) else {
			return Err(CascadeError::UnknownDirective {
				file: file.to_str(),
				line,
				directive: written.to_str(),
			});
		};
		let value =
			node_value(node, definition.shape, definition.verbatim_keys).ok_or_else(|| {
				CascadeError::MalformedDirective {
					file:      file.to_str(),
					directive: written.to_str(),
				}
			})?;
		if !definition.values.is_empty() {
			let invalid = match &value {
				Value::String(value) => {
					(!definition.values.contains(&value.as_str())).then_some(value.as_str())
				},
				Value::Array(values) => values.iter().find_map(|value| {
					value
						.as_str()
						.filter(|value| !definition.values.contains(value))
				}),
				_ => {
					return Err(CascadeError::MalformedDirective {
						file:      file.to_str(),
						directive: written.to_str(),
					});
				},
			};
			if let Some(value) = invalid {
				return Err(CascadeError::InvalidDirectiveValue {
					file: file.to_str(),
					line,
					directive: written.to_str(),
					value: value.to_str(),
				});
			}
		}
		if written == "edit-revision"
			&& value
				.as_str()
				.is_some_and(|revision| revision.trim().is_empty())
		{
			return Err(CascadeError::MalformedDirective {
				file:      file.to_str(),
				directive: written.to_str(),
			});
		}
		let map = match definition.set {
			AxisSet::Wire => &mut self.wire,
			AxisSet::Thinking => &mut self.thinking,
			AxisSet::Catalog => &mut self.catalog,
		};
		if map
			.insert(definition.resolved_key.to_str(), value)
			.is_some()
		{
			return Err(CascadeError::DuplicateAxis {
				file: file.to_str(),
				axis: definition.resolved_key.to_str(),
			});
		}
		Ok(())
	}
}

fn node_priority(file: &str, node: &KdlNode) -> Result<i64, CascadeError> {
	let mut priority = None;
	for entry in node.entries().iter().filter(|entry| entry.name().is_some()) {
		let name = entry.name().expect("filtered to named entries").value();
		if node.name().value() == "models" && name == "token" {
			continue;
		}
		if name != "priority" || priority.is_some() {
			return Err(CascadeError::MalformedDirective {
				file:      file.to_str(),
				directive: node.name().value().to_str(),
			});
		}
		priority = entry
			.value()
			.as_integer()
			.and_then(|value| i64::try_from(value).ok());
		if priority.is_none() {
			return Err(CascadeError::MalformedDirective {
				file:      file.to_str(),
				directive: node.name().value().to_str(),
			});
		}
	}
	Ok(priority.unwrap_or(0))
}

fn fmt_label(file: &str, parts: &[&str]) -> Str {
	let mut label = String::with_capacity(file.len() + 16);
	label.push_str(file);
	for part in parts {
		label.push(':');
		label.push_str(part);
	}
	label.to_str()
}

/// Converts one directive node into JSON per its [`AxisShape`].
fn node_value(node: &KdlNode, shape: AxisShape, verbatim_keys: bool) -> Option<Value> {
	let arguments: Vec<&KdlValue> = node
		.entries()
		.iter()
		.filter(|e| e.name().is_none())
		.map(kdl::KdlEntry::value)
		.collect();
	match shape {
		AxisShape::Scalar => match (arguments.as_slice(), node.children()) {
			([value], None) => scalar_value(value),
			_ => None,
		},
		AxisShape::Array => {
			if arguments.is_empty() || node.children().is_some() {
				return None;
			}
			arguments
				.iter()
				.map(|value| scalar_value(value))
				.collect::<Option<Vec<_>>>()
				.map(Value::from)
		},
		AxisShape::Object => match (arguments.as_slice(), node.children()) {
			([], Some(children)) => object_value(children, verbatim_keys),
			_ => None,
		},
	}
}

/// Nested payload node → JSON: scalar or deeper object values.
fn object_value(children: &KdlDocument, verbatim_keys: bool) -> Option<Value> {
	let mut object = Map::new();
	for child in children.nodes() {
		let arguments: Vec<&KdlValue> = child
			.entries()
			.iter()
			.filter(|entry| entry.name().is_none())
			.map(kdl::KdlEntry::value)
			.collect();
		let value = match (arguments.as_slice(), child.children()) {
			([value], None) => scalar_value(value)?,
			([], Some(nested)) => object_value(nested, verbatim_keys)?,
			_ => return None,
		};
		let written = child.name().value();
		let key = if verbatim_keys {
			written.to_owned()
		} else {
			kebab_to_camel(written)?
		};
		object.insert(key, value);
	}
	Some(Value::Object(object))
}

fn kebab_to_camel(written: &str) -> Option<String> {
	if written.is_empty() || written.bytes().any(|byte| byte.is_ascii_uppercase()) {
		return None;
	}
	let mut key = String::with_capacity(written.len());
	let mut uppercase = false;
	for character in written.chars() {
		if character == '-' {
			if uppercase || key.is_empty() {
				return None;
			}
			uppercase = true;
		} else if uppercase {
			key.extend(character.to_uppercase());
			uppercase = false;
		} else {
			key.push(character);
		}
	}
	(!uppercase).then_some(key)
}

fn scalar_value(value: &KdlValue) -> Option<Value> {
	match value {
		KdlValue::Bool(flag) => Some(Value::Bool(*flag)),
		KdlValue::Integer(integer) => i64::try_from(*integer).ok().map(Value::from),
		KdlValue::Float(float) => Some(Value::from(*float)),
		KdlValue::String(text) => Some(Value::from(text.as_str())),
		KdlValue::Null => None,
	}
}

fn single_string_argument(node: &KdlNode) -> Option<&str> {
	let mut arguments = node.entries().iter().filter(|entry| entry.name().is_none());
	let first = arguments.next()?;
	if arguments.next().is_some() {
		return None;
	}
	first.value().as_string()
}

fn string_arguments(node: &KdlNode, file: &str, directive: &str) -> Result<Vec<Str>, CascadeError> {
	let values: Option<Vec<Str>> = node
		.entries()
		.iter()
		.filter(|entry| entry.name().is_none())
		.map(|entry| entry.value().as_string().map(|text| text.to_str()))
		.collect();
	match values {
		Some(values) if !values.is_empty() => Ok(values),
		_ => Err(CascadeError::MalformedDirective {
			file:      file.to_str(),
			directive: directive.to_str(),
		}),
	}
}

fn selector_arguments(node: &KdlNode, file: &str) -> Result<Vec<Selector>, CascadeError> {
	let malformed = || CascadeError::MalformedDirective {
		file:      file.to_str(),
		directive: "models".to_str(),
	};
	let mut selectors = Vec::new();
	for entry in node.entries() {
		let name = entry.name().map(|name| name.value());
		if name == Some("priority") {
			continue;
		}
		let value = entry.value().as_string().ok_or_else(&malformed)?;
		match name {
			None => selectors.push(Selector::new(value)),
			Some("token") => {
				selectors.push(Selector::Token(value.to_ascii_lowercase().to_str()));
			},
			Some(_) => return Err(malformed()),
		}
	}
	if selectors.is_empty() {
		return Err(malformed());
	}
	Ok(selectors)
}

#[cfg(test)]
mod tests {
	use super::*;

	fn parse_one(text: &str) -> Result<CompatCascade, CascadeError> {
		CompatCascade::parse(&[("test.kdl", text)])
	}

	fn target<'a>(
		provider: &'a str,
		class: &'a str,
		model: &'a str,
		reasoning: bool,
	) -> ResolveTarget<'a> {
		ResolveTarget { provider, class, family: None, revision: None, model, reasoning }
	}

	#[test]
	fn deepseek_vision_exemption_requires_a_bounded_token() {
		let cascade = CompatCascade::bundled().expect("bundled cascade parses");
		let strip_images = |model| {
			cascade
				.resolve(&target("custom-proxy", "deepseek", model, false))
				.expect("DeepSeek model resolves")
				.wire["strip_image_input"]
				.clone()
		};
		for model in ["deepseek-v4-flash-vision-exp", "deepseek_vision", "vision-deepseek-v4"] {
			assert_eq!(strip_images(model), Value::Bool(false), "{model}");
		}
		for model in ["deepseek-r1-revision-0528", "deepseek-v4-provisioned"] {
			assert_eq!(strip_images(model), Value::Bool(true), "{model}");
		}
	}

	#[test]
	fn long_context_cost_is_catalog_data_not_wire_policy() {
		let cascade = parse_one(
			r#"provider "subscription" {
				models "model-a" {
					long-context-cost {
						input-threshold 272000
						input 10.0
						output 45.0
						cache-read 1.0
						cache-write 12.5
					}
				}
			}"#,
		)
		.expect("catalog pricing directive parses");
		let resolved = cascade
			.resolve(&target("subscription", "openai", "model-a", false))
			.expect("catalog data resolves without reasoning");
		assert!(resolved.wire.is_empty());
		assert!(resolved.thinking.is_empty());
		assert_eq!(resolved.catalog["longContext"]["inputThreshold"], Value::from(272_000));
		assert_eq!(resolved.catalog["longContext"]["cacheWrite"], Value::from(12.5));
	}

	#[test]
	fn edit_revision_is_catalog_data_and_absence_is_empty() {
		let cascade = parse_one(
			r#"class "kimi" {
				edit-revision "sloppy.1"
			}"#,
		)
		.expect("edit revision directive parses");
		let resolved = cascade
			.resolve(&target("openrouter", "kimi", "moonshotai/kimi-k2", false))
			.expect("catalog data resolves");
		assert_eq!(resolved.catalog["editRevision"], Value::from("sloppy.1"));
		assert!(resolved.wire.is_empty());
		assert!(
			cascade
				.resolve(&target("openai", "openai", "gpt-5", false))
				.expect("unmatched target resolves")
				.catalog
				.is_empty()
		);
		assert!(matches!(
			parse_one(r#"class "kimi" { edit-revision "" }"#),
			Err(CascadeError::MalformedDirective { .. })
		));
	}

	#[test]
	fn class_provider_and_model_rules_rank_by_specificity() {
		let cascade = parse_one(
			r#"
			class "deepseek" {
				models "r1-*" { requires-reasoning-content-for-all-assistant-turns #true }
				on "vendor" { thinking-mode "effort" }
			}
			provider "vendor" {
				supports-store #false
				models "r1-pro" { supports-store #true }
			}
			"#,
		)
		.expect("valid cascade");
		let base = cascade
			.resolve(&target("vendor", "deepseek", "r1-mini", true))
			.expect("resolves");
		assert_eq!(base.wire["supports_store"], Value::Bool(false));
		assert_eq!(
			base.wire["requires_reasoning_content_for_all_assistant_turns"],
			Value::Bool(true)
		);
		assert_eq!(base.thinking["mode"], Value::from("effort"));
		let pro = cascade
			.resolve(&target("vendor", "deepseek", "r1-pro", true))
			.expect("resolves");
		assert_eq!(pro.wire["supports_store"], Value::Bool(true), "model rule beats provider");
		let foreign = cascade
			.resolve(&target("vendor", "qwen", "r1-mini", true))
			.expect("resolves");
		assert!(
			!foreign
				.wire
				.contains_key("requires_reasoning_content_for_all_assistant_turns")
		);
		assert!(foreign.thinking.is_empty());
		let elsewhere = cascade
			.resolve(&target("other", "deepseek", "r1-mini", true))
			.expect("resolves");
		assert!(elsewhere.thinking.is_empty(), "`on` scopes the composition");
		assert_eq!(
			elsewhere.wire["requires_reasoning_content_for_all_assistant_turns"],
			Value::Bool(true),
			"selector-free dimensions do not scope"
		);
		let gated = cascade
			.resolve(&target("vendor", "deepseek", "r1-mini", false))
			.expect("resolves");
		assert!(gated.thinking.is_empty(), "reasoning=false suppresses thinking axes");
		assert_eq!(gated.wire, base.wire, "wire axes are unaffected by the gate");
	}

	#[test]
	fn equal_rank_overlap_on_one_axis_is_rejected() {
		let cascade = parse_one(
			r#"provider "acme" {
				models "foo-*" { thinking-format "zai" }
				models "*-bar" { thinking-format "qwen" }
			}"#,
		)
		.expect("valid cascade");
		let error = cascade
			.resolve(&target("acme", "unknown", "foo-bar", true))
			.expect_err("ambiguous");
		assert!(matches!(
			&error,
			CascadeError::AmbiguousOverlap(details) if details.axis.as_str() == "thinking_format"
		));
		assert!(
			cascade
				.resolve(&target("acme", "unknown", "foo-only", true))
				.is_ok()
		);
	}

	#[test]
	fn disjoint_axes_overlap_resolves_both_values() {
		let cascade = parse_one(
			r#"provider "acme" {
				models "foo-*" { thinking-format "zai" }
				models "*-bar" { supports-store #false }
			}"#,
		)
		.expect("valid cascade");
		let resolved = cascade
			.resolve(&target("acme", "unknown", "foo-bar", true))
			.expect("resolves");
		assert_eq!(resolved.wire["thinking_format"], Value::from("zai"));
		assert_eq!(resolved.wire["supports_store"], Value::Bool(false));
	}

	#[test]
	fn explicit_priority_breaks_ties_and_exact_beats_glob() {
		let cascade = parse_one(
			r#"provider "acme" {
				models "foo-*" priority=10 { thinking-format "zai" }
				models "*-bar" { thinking-format "qwen" }
				models "foo-exact" { thinking-format "kimi" }
			}"#,
		)
		.expect("valid cascade");
		let tied = cascade
			.resolve(&target("acme", "unknown", "foo-bar", true))
			.expect("priority wins");
		assert_eq!(tied.wire["thinking_format"], Value::from("zai"));
		let exact = cascade
			.resolve(&target("acme", "unknown", "foo-exact", true))
			.expect("resolves");
		assert_eq!(exact.wire["thinking_format"], Value::from("kimi"), "exact beats glob");
	}

	#[test]
	fn unknown_and_malformed_directives_are_rejected() {
		assert!(matches!(
			&parse_one(r#"provider "acme" { thinkign-format "zai" }"#),
			Err(CascadeError::UnknownDirective { directive, .. })
				if directive.as_str() == "thinkign-format"
		));
		assert!(matches!(
			parse_one(r#"provider "acme" { thinking-format "zai" "extra" }"#),
			Err(CascadeError::MalformedDirective { .. })
		));
		assert!(matches!(
			&parse_one(r#"provider "acme" { thinking-format "openai"
				thinking-format "zai" }"#),
			Err(CascadeError::DuplicateAxis { axis, .. }) if axis.as_str() == "thinking_format"
		));
		assert!(matches!(
			parse_one(r#"provider "acme" { models "*" priority="10" { thinking-format "zai" } }"#),
			Err(CascadeError::MalformedDirective { .. })
		));
		assert!(matches!(
			parse_one(
				r#"provider "acme" {
					models "*" priority=9223372036854775808 { thinking-format "zai" }
				}"#
			),
			Err(CascadeError::MalformedDirective { .. })
		));
		assert!(matches!(
			parse_one(r#"provider "acme" bogus=#true { thinking-format "zai" }"#),
			Err(CascadeError::MalformedDirective { .. })
		));
		assert!(matches!(
			parse_one(r#"provider "acme" { thinking-format "zai" bogus=#true }"#),
			Err(CascadeError::MalformedDirective { .. })
		));
	}

	#[test]
	fn nested_payloads_arrays_and_empty_maps_convert_to_wire_json() {
		let cascade = parse_one(
			r#"provider "acme" {
				extra-body { thinking { type "enabled" } }
				reasoning-effort-map {}
				stream-idle-timeout-ms 0
				thinking-efforts "low" "high" "max"
			}"#,
		)
		.expect("valid cascade");
		let resolved = cascade
			.resolve(&target("acme", "unknown", "any", true))
			.expect("resolves");
		assert_eq!(
			resolved.wire["extra_body"],
			serde_json::json!({ "thinking": { "type": "enabled" } })
		);
		assert_eq!(resolved.wire["reasoning_effort_map"], serde_json::json!({}));
		assert_eq!(resolved.wire["stream_idle_timeout_ms"], Value::from(0));
		assert_eq!(resolved.thinking["efforts"], serde_json::json!(["low", "high", "max"]));
	}
	#[test]
	fn qwen_template_effort_axis_parses_to_its_wire_policy_key() {
		let cascade = parse_one(
			r#"class "qwen" {
				template-reasoning-effort #true
			}"#,
		)
		.expect("new wire axes parse");
		let resolved = cascade
			.resolve(&target("local", "qwen", "qwen3.8-27b", true))
			.expect("resolves");
		assert_eq!(resolved.wire["qwen_template_reasoning_effort"], Value::Bool(true));
	}

	#[test]
	fn exact_selectors_are_case_sensitive_and_globs_are_not() {
		let cascade = parse_one(
			r#"class "glm" {
				models "zai-org/GLM-4.7" "glm-5.*" { thinking-format "zai" }
			}"#,
		)
		.expect("valid cascade");
		for id in ["zai-org/GLM-4.7", "GLM-5.2", "glm-5.2-fast"] {
			let resolved = cascade
				.resolve(&target("anyhost", "glm", id, true))
				.expect("resolves");
			assert_eq!(resolved.wire["thinking_format"], Value::from("zai"), "{id}");
		}
		let miss = cascade
			.resolve(&target("anyhost", "glm", "zai-org/glm-4.7", true))
			.expect("resolves");
		assert!(
			!miss.wire.contains_key("thinking_format"),
			"exact ids are distinct identifiers across case"
		);
	}

	#[test]
	fn revision_boundaries_and_missing_family_are_strict() {
		let cascade = parse_one(
			r#"class "gemini" {
				revision ">=2.5" { supports-store #true }
				family "flash" { thinking-format "openai" }
			}"#,
		)
		.expect("valid cascade");
		let mut candidate = target("acme", "gemini", "gemini-2.5-flash", true);
		candidate.revision = Some(SemVer::new(2, 5, 0));
		assert_eq!(
			cascade.resolve(&candidate).expect("boundary matches").wire["supports_store"],
			Value::Bool(true)
		);
		candidate.revision = Some(SemVer::new(2, 4, 9));
		assert!(
			!cascade
				.resolve(&candidate)
				.expect("below boundary resolves")
				.wire
				.contains_key("supports_store")
		);
		assert!(
			!cascade
				.resolve(&candidate)
				.expect("family-less target resolves")
				.wire
				.contains_key("thinking_format"),
			"family selectors never match family=None"
		);
	}

	#[test]
	fn family_and_revision_conjunction_outranks_family_only() {
		let cascade = parse_one(
			r#"class "gemini" {
				family "flash" {
					thinking-format "openai"
					revision ">=2.5" { thinking-format "openrouter" }
				}
			}"#,
		)
		.expect("valid cascade");
		let candidate = ResolveTarget {
			provider:  "acme",
			class:     "gemini",
			family:    Some("flash"),
			revision:  Some(SemVer::new(2, 5, 0)),
			model:     "gemini-2.5-flash",
			reasoning: true,
		};
		assert_eq!(
			cascade.resolve(&candidate).expect("resolves").wire["thinking_format"],
			Value::from("openrouter")
		);
	}

	#[test]
	fn overlapping_revision_ranges_need_priority() {
		let ambiguous = parse_one(
			r#"class "gemini" {
				revision ">=2" { thinking-format "openai" }
				revision "<3" { thinking-format "openrouter" }
			}"#,
		)
		.expect("valid cascade");
		let candidate = ResolveTarget {
			provider:  "acme",
			class:     "gemini",
			family:    None,
			revision:  Some(SemVer::new(2, 5, 0)),
			model:     "gemini-2.5",
			reasoning: true,
		};
		assert!(matches!(ambiguous.resolve(&candidate), Err(CascadeError::AmbiguousOverlap(_))));

		let prioritized = parse_one(
			r#"class "gemini" {
				revision ">=2" priority=1 { thinking-format "openai" }
				revision "<3" { thinking-format "openrouter" }
			}"#,
		)
		.expect("valid cascade");
		assert_eq!(
			prioritized
				.resolve(&candidate)
				.expect("priority resolves")
				.wire["thinking_format"],
			Value::from("openai")
		);
	}

	#[test]
	fn malformed_revisions_and_illegal_nesting_are_rejected() {
		for expression in [">=2.5.0.1", "2.5", ">=256", ">=2..5", ">= 2.5", ""] {
			let source =
				format!("class \"gemini\" {{ revision \"{expression}\" {{ supports-store #true }} }}");
			assert!(
				matches!(parse_one(&source), Err(CascadeError::MalformedDirective { .. })),
				"{expression:?}"
			);
		}
		for source in [
			r#"provider "acme" { family "flash" { supports-store #true } }"#,
			r#"class "gemini" { models "*" { revision ">=2" { supports-store #true } } }"#,
			r#"class "gemini" { family "flash" { family "lite" { supports-store #true } } }"#,
			r#"provider "acme" { class "gemini" { on "other" { supports-store #true } } }"#,
		] {
			assert!(matches!(parse_one(source), Err(CascadeError::UnexpectedNode { .. })));
		}
	}

	#[test]
	fn glob_matching_is_anchored() {
		assert!(glob_match("foo-*", "foo-bar"));
		assert!(glob_match("*-bar", "foo-bar"));
		assert!(glob_match("foo-*-bar", "foo-x-bar"));
		assert!(glob_match("*", "anything"));
		assert!(!glob_match("foo-*", "xfoo-bar"));
		assert!(!glob_match("*-bar", "foo-barx"));
		assert!(!glob_match("foo", "foo-bar"));
	}
}
