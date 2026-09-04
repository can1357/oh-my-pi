//! Layered extension configuration and environment overrides.

use std::{
	collections::{BTreeMap, BTreeSet},
	env,
	path::{Path, PathBuf},
	time::Duration,
};

use omp_core::{Str, sf};
use serde::{Deserialize, Serialize, de};
use strum::{Display, EnumString};

use super::{ExtensionCode, ExtensionError, Layer};

/// The ordered configuration scopes used for extension precedence.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Ord, PartialOrd)]
pub enum Scope {
	/// The operator's client configuration.
	#[default]
	Client,
	/// The workspace's configuration, applied after the client scope.
	Workspace,
}
/// Startup update policy selected by the operator.
#[derive(
	Clone, Copy, Debug, Default, Display, EnumString, Eq, PartialEq, Deserialize, Serialize,
)]
#[serde(rename_all = "lowercase")]
#[strum(serialize_all = "lowercase", ascii_case_insensitive)]
pub enum UpdateMode {
	/// Skip catalog/version fetches while retaining ordinary revocation
	/// admission.
	Off,
	/// Verify and report candidates without mutating active state.
	#[default]
	Notify,
	/// Commit eligible client-layer candidates for later sessions.
	Auto,
}

/// Positive human-readable interval used by the startup update scheduler.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct UpdateInterval(Duration);

impl UpdateInterval {
	/// The default twenty-four hour due window.
	pub const DEFAULT: Self = Self(Duration::from_hours(24));

	/// Returns the interval as a standard duration.
	pub const fn duration(self) -> Duration {
		self.0
	}

	/// Constructs a positive interval.
	pub fn new(duration: Duration) -> Result<Self, ExtensionError> {
		if duration.is_zero() {
			return Err(ExtensionError::new(
				ExtensionCode::EUpdatePolicy,
				"extension update interval must be positive",
			));
		}
		Ok(Self(duration))
	}
}

impl Default for UpdateInterval {
	fn default() -> Self {
		Self::DEFAULT
	}
}

impl Serialize for UpdateInterval {
	fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
	where
		S: serde::Serializer,
	{
		let seconds = self.0.as_secs();
		if seconds.is_multiple_of(24 * 60 * 60) {
			serializer.serialize_str(&format!("{}d", seconds / (24 * 60 * 60)))
		} else if seconds.is_multiple_of(60 * 60) {
			serializer.serialize_str(&format!("{}h", seconds / (60 * 60)))
		} else if seconds.is_multiple_of(60) {
			serializer.serialize_str(&format!("{}m", seconds / 60))
		} else {
			serializer.serialize_str(&format!("{seconds}s"))
		}
	}
}

impl<'de> Deserialize<'de> for UpdateInterval {
	fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
	where
		D: serde::Deserializer<'de>,
	{
		let value = <&str>::deserialize(deserializer)?;
		parse_update_interval(value).map_err(de::Error::custom)
	}
}

fn parse_update_interval(value: &str) -> Result<UpdateInterval, ExtensionError> {
	let (number, multiplier) = match value.as_bytes().last().copied() {
		Some(b's') => (&value[..value.len() - 1], 1_u64),
		Some(b'm') => (&value[..value.len() - 1], 60),
		Some(b'h') => (&value[..value.len() - 1], 60 * 60),
		Some(b'd') => (&value[..value.len() - 1], 24 * 60 * 60),
		_ => {
			return Err(ExtensionError::new(
				ExtensionCode::EUpdatePolicy,
				"extension update interval must end in s, m, h, or d",
			));
		},
	};
	let amount = number.parse::<u64>().map_err(|_| {
		ExtensionError::new(
			ExtensionCode::EUpdatePolicy,
			"extension update interval has an invalid number",
		)
	})?;
	let seconds = amount.checked_mul(multiplier).ok_or_else(|| {
		ExtensionError::new(ExtensionCode::EUpdatePolicy, "extension update interval is too large")
	})?;
	UpdateInterval::new(Duration::from_secs(seconds))
}

/// One scope's optional `[extensions.updates]` overrides.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct UpdateOverlay {
	/// Update mode selected by this scope.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub mode:     Option<UpdateMode>,
	/// Due interval; operator/client scope only.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub interval: Option<UpdateInterval>,
}

/// Effective operator-owned startup update policy.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct UpdatePolicy {
	/// Effective mode after workspace non-escalation.
	pub mode:     UpdateMode,
	/// Operator-selected due interval.
	pub interval: UpdateInterval,
}

impl Default for UpdatePolicy {
	fn default() -> Self {
		Self { mode: UpdateMode::Notify, interval: UpdateInterval::DEFAULT }
	}
}

/// Applies client policy and the workspace's sole permitted reduction to
/// [`UpdateMode::Off`].
pub fn effective_updates(
	client: Option<&UpdateOverlay>,
	workspace: Option<&UpdateOverlay>,
) -> Result<UpdatePolicy, ExtensionError> {
	validate_update_overlay(client, Scope::Client)?;
	validate_update_overlay(workspace, Scope::Workspace)?;
	let mut policy = UpdatePolicy::default();
	if let Some(client) = client {
		policy.mode = client.mode.unwrap_or(policy.mode);
		policy.interval = client.interval.unwrap_or(policy.interval);
	}
	if workspace.and_then(|updates| updates.mode) == Some(UpdateMode::Off) {
		policy.mode = UpdateMode::Off;
	}
	Ok(policy)
}

fn validate_update_overlay(
	updates: Option<&UpdateOverlay>,
	scope: Scope,
) -> Result<(), ExtensionError> {
	let Some(updates) = updates else {
		return Ok(());
	};
	if scope == Scope::Workspace
		&& (updates.interval.is_some() || updates.mode.is_some_and(|mode| mode != UpdateMode::Off))
	{
		return Err(ExtensionError::new(
			ExtensionCode::EUpdatePolicy,
			"workspace [extensions.updates] may only set mode = \"off\"",
		));
	}
	Ok(())
}

impl Scope {
	/// Returns the corresponding extension layer.
	pub const fn layer(self) -> Layer {
		match self {
			Self::Client => Layer::Client,
			Self::Workspace => Layer::Workspace,
		}
	}
}

/// Static extension CLI value shape.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CliValueKind {
	/// Presence-only flag.
	Boolean,
	/// Required string value.
	String,
	/// Optional string value; bare presence yields `true` at the sink.
	OptionalString,
}

/// One typed value delivered to an extension activation sink.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ContributedValue {
	/// Presence-only value.
	Boolean(bool),
	/// String value.
	String(Str),
}

/// A declaration-linked contributed value.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ContributedCliValue {
	/// Qualified extension owner.
	pub owner: Str,
	/// Declared sink key.
	pub sink:  Str,
	/// Parsed typed value.
	pub value: ContributedValue,
}

/// Declaration-checked sink key exposed only to the owning extension.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CliValueSink {
	/// Stable key used by the extension activation payload.
	pub key: Str,
}

/// One static extension CLI contribution.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CliContribution {
	/// TOFU-qualified publisher name.
	pub publisher:      Str,
	/// Extension id within the publisher namespace.
	pub extension:      Str,
	/// Long flag spelling without leading dashes.
	pub name:           Str,
	/// Human-readable help text.
	pub description:    Str,
	/// Typed value shape.
	pub kind:           CliValueKind,
	/// Optional typed default represented in manifest JSON.
	#[serde(default)]
	pub default:        Option<serde_json::Value>,
	/// Explicit operator-approved built-in shadow declaration.
	#[serde(default)]
	pub shadow_builtin: bool,
	/// Owning extension's activation sink.
	pub sink:           CliValueSink,
}

impl CliContribution {
	/// Publisher-qualified declaration identity.
	pub fn qualified_name(&self) -> Str {
		Str::from(format!("{}/{}:--{}", self.publisher, self.extension, self.name))
	}

	/// Validates static syntax and default type.
	pub fn validate(&self) -> Result<(), CliCollision> {
		if !qualified_component(&self.publisher)
			|| !qualified_component(&self.extension)
			|| !flag_name(&self.name)
			|| self.sink.key.is_empty()
		{
			return Err(CliCollision::Invalid(self.qualified_name()));
		}
		let valid_default = match (&self.kind, &self.default) {
			(_, None) => true,
			(CliValueKind::Boolean, Some(value)) => value.is_boolean(),
			(CliValueKind::String | CliValueKind::OptionalString, Some(value)) => value.is_string(),
		};
		if !valid_default {
			return Err(CliCollision::InvalidDefault(self.qualified_name()));
		}
		Ok(())
	}
}

/// Deterministic contribution collision diagnostic.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum CliCollision {
	/// Static contribution syntax is invalid.
	#[error("invalid extension CLI contribution `{0}`")]
	Invalid(Str),
	/// A typed default does not match the contribution kind.
	#[error("invalid default for extension CLI contribution `{0}`")]
	InvalidDefault(Str),
	/// Two extensions own one spelling.
	#[error("extension CLI flag `--{name}` is declared by both {first} and {second}")]
	Duplicate {
		/// Colliding long name.
		name:   Str,
		/// First qualified owner.
		first:  Str,
		/// Second qualified owner.
		second: Str,
	},
	/// A built-in collision lacked an explicit shadow declaration.
	#[error("extension CLI flag `{owner}` collides with built-in `--{name}` without shadow_builtin")]
	Builtin {
		/// Colliding long name.
		name:  Str,
		/// Qualified owner.
		owner: Str,
	},
}

/// Validated, name-sorted final contribution set.
#[derive(Clone, Debug, Default)]
pub struct CliContributionSet {
	entries: BTreeMap<Str, CliContribution>,
}

impl CliContributionSet {
	/// Validates declarations and configured built-in shadow precedence.
	pub fn build(
		contributions: impl IntoIterator<Item = CliContribution>,
		builtins: impl IntoIterator<Item = Str>,
	) -> Result<Self, CliCollision> {
		let builtins = builtins.into_iter().collect::<BTreeSet<_>>();
		let mut entries = BTreeMap::new();
		for contribution in contributions {
			contribution.validate()?;
			let owner = contribution.qualified_name();
			if builtins.contains(&contribution.name) && !contribution.shadow_builtin {
				return Err(CliCollision::Builtin { name: contribution.name, owner });
			}
			if let Some(first) = entries.insert(contribution.name.clone(), contribution.clone()) {
				return Err(CliCollision::Duplicate {
					name:   contribution.name,
					first:  first.qualified_name(),
					second: owner,
				});
			}
		}
		Ok(Self { entries })
	}

	/// Returns one contribution by long name.
	pub fn get(&self, name: &str) -> Option<&CliContribution> {
		self.entries.get(name)
	}

	/// Iterates in stable long-name order.
	pub fn iter(&self) -> impl ExactSizeIterator<Item = (&Str, &CliContribution)> {
		self.entries.iter()
	}
}

fn qualified_component(value: &str) -> bool {
	!value.is_empty()
		&& value
			.bytes()
			.all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
}

fn flag_name(value: &str) -> bool {
	qualified_component(value) && !value.starts_with('-')
}
/// A source specification accepted by extension discovery.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum SourceSpec {
	/// An omp extension index distribution.
	Index {
		/// Explicit index URL, empty when configured indexes select it.
		index:        String,
		/// Distribution name resolved from that index.
		distribution: Str,
	},
	/// A `PyPI` distribution.
	Pypi {
		/// Distribution name resolved through `PyPI`.
		distribution: Str,
	},
	/// A commit-pinned Git source.
	Git {
		/// Canonical Git repository URL.
		repository:   String,
		/// Immutable commit or annotated tag.
		revision:     Str,
		/// Optional contained repository subdirectory.
		subdirectory: Option<PathBuf>,
	},
	/// A local development source.
	Path(PathBuf),
	/// A hash-addressed archive URL.
	Url {
		/// HTTPS artifact URL.
		url:    String,
		/// Required SHA-256 digest.
		sha256: Str,
	},
}

/// Operator feature-selection syntax attached to an install specification.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum FeatureSelection {
	/// No bracket expression was supplied.
	Absent,
	/// `[]` selects no optional features.
	None,
	/// `[*]` selects every declared feature.
	All,
	/// A concrete, trimmed, deduplicated, lexically sorted selection.
	Named(Vec<Str>),
}

/// One extension source with its independently parsed feature-selection
/// request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct InstallSpec {
	/// Source text with the bracket expression removed.
	pub source:    Str,
	/// Requested feature selection.
	pub selection: FeatureSelection,
}

impl InstallSpec {
	/// Parses absent, empty, wildcard, and named bracket forms while retaining
	/// an optional version suffix.
	pub fn parse(value: &str) -> Result<Self, ExtensionError> {
		let Some(open) = value.rfind('[') else {
			return Ok(Self { source: Str::new(value), selection: FeatureSelection::Absent });
		};
		let close = value[open + 1..]
			.find(']')
			.map(|offset| open + 1 + offset)
			.ok_or_else(|| {
				ExtensionError::new(ExtensionCode::EFeature, "feature selection has no closing ]")
			})?;
		let suffix = &value[close + 1..];
		if !suffix.is_empty() && !suffix.starts_with('@') {
			return Err(ExtensionError::new(
				ExtensionCode::EFeature,
				"only an @version suffix may follow a feature selection",
			));
		}
		if value[..open].is_empty() || suffix.contains('[') || suffix.contains(']') {
			return Err(ExtensionError::new(
				ExtensionCode::EFeature,
				"feature selection is malformed",
			));
		}
		let body = &value[open + 1..close];
		let selection = match body.trim() {
			"" => FeatureSelection::None,
			"*" => FeatureSelection::All,
			_ => {
				let mut names = body
					.split(',')
					.map(str::trim)
					.map(|name| {
						if name.is_empty() || name == "*" {
							Err(ExtensionError::new(
								ExtensionCode::EFeature,
								"feature names must be non-empty and `*` must stand alone",
							))
						} else {
							Ok(Str::new(name))
						}
					})
					.collect::<Result<Vec<_>, _>>()?;
				names.sort();
				names.dedup();
				FeatureSelection::Named(names)
			},
		};
		let mut source = String::with_capacity(value.len() - (close - open + 1));
		source.push_str(&value[..open]);
		source.push_str(suffix);
		Ok(Self { source: Str::new(source), selection })
	}
}

impl SourceSpec {
	/// Parses an install source together with its optional feature brackets.
	pub fn parse_install(value: &str) -> Result<(Self, FeatureSelection), ExtensionError> {
		let parsed = InstallSpec::parse(value)?;
		let path = Path::new(parsed.source.as_str());
		let explicitly_local = path.is_absolute()
			|| matches!(
				path.components().next(),
				Some(std::path::Component::CurDir | std::path::Component::ParentDir)
			) || parsed.source.starts_with("~/");
		let source = if explicitly_local {
			Self::Path(path.to_path_buf())
		} else if parsed.source.contains(':') {
			Self::parse(parsed.source.as_str())?
		} else {
			Self::Index { index: String::new(), distribution: parsed.source }
		};
		Ok((source, parsed.selection))
	}

	/// Parses the explicit source grammar. `link` is deliberately absent: links
	/// are local install-record overlays and can never be resolution sources.
	pub fn parse(value: &str) -> Result<Self, ExtensionError> {
		let (kind, rest) = value.split_once(':').ok_or_else(|| {
			ExtensionError::new(
				ExtensionCode::ENoManifest,
				"source must use index:, pypi:, git:, path:, or url:",
			)
		})?;
		match kind {
			"index" if !rest.is_empty() => {
				let (index, distribution) = rest.rsplit_once('/').unwrap_or(("", rest));
				Ok(Self::Index { index: index.to_owned(), distribution: Str::new(distribution) })
			},
			"pypi" if !rest.is_empty() => Ok(Self::Pypi { distribution: Str::new(rest) }),
			"git" => {
				let (source, subdirectory) = rest
					.split_once('#')
					.map_or((rest, None), |(source, subdirectory)| {
						(source, Some(PathBuf::from(subdirectory)))
					});
				let (repository, revision) = source.rsplit_once('@').ok_or_else(|| {
					ExtensionError::new(
						ExtensionCode::EGitFloating,
						"git source must name a commit or annotated tag",
					)
				})?;
				let pinned_commit = matches!(revision.len(), 40 | 64)
					&& revision.bytes().all(|byte| byte.is_ascii_hexdigit());
				let explicit_tag =
					revision.starts_with("refs/tags/") && revision.len() > "refs/tags/".len();
				if !pinned_commit && !explicit_tag {
					return Err(ExtensionError::new(
						ExtensionCode::EGitFloating,
						"git source revision must be a full commit or explicit refs/tags name",
					));
				}
				if subdirectory.as_ref().is_some_and(|path| {
					path.as_os_str().is_empty()
						|| path.is_absolute()
						|| path.components().any(|component| {
							matches!(
								component,
								std::path::Component::ParentDir
									| std::path::Component::RootDir
									| std::path::Component::Prefix(_)
							)
						})
				}) {
					return Err(ExtensionError::new(
						ExtensionCode::EIntegrity,
						"git subdirectory must be a contained relative path",
					));
				}
				Ok(Self::Git {
					repository: repository.to_owned(),
					revision: Str::new(revision),
					subdirectory,
				})
			},
			"path" if !rest.is_empty() => Ok(Self::Path(PathBuf::from(rest))),
			"url" if rest.starts_with("https://") => {
				let (url, sha256) = rest.rsplit_once("#sha256=").ok_or_else(|| {
					ExtensionError::new(
						ExtensionCode::EIntegrity,
						"url source must end with #sha256=<digest>",
					)
				})?;
				if sha256.len() != 64 || !sha256.bytes().all(|byte| byte.is_ascii_hexdigit()) {
					return Err(ExtensionError::new(
						ExtensionCode::EIntegrity,
						"url source has an invalid SHA-256 digest",
					));
				}
				Ok(Self::Url { url: url.to_owned(), sha256: Str::new(sha256) })
			},
			"link" => Err(ExtensionError::new(
				ExtensionCode::ELockLink,
				"link is an installed.toml development overlay, not a source",
			)),
			_ => Err(ExtensionError::new(ExtensionCode::ENoManifest, "unknown extension source")),
		}
	}
}

/// One package-owned resource family that may be filtered independently.
#[derive(
	Clone, Copy, Debug, Display, EnumString, Eq, Ord, PartialEq, PartialOrd, Deserialize, Serialize,
)]
#[serde(rename_all = "lowercase")]
#[strum(serialize_all = "lowercase", ascii_case_insensitive)]
pub enum ResourceFamily {
	/// Executable extension entries.
	Extensions,
	/// Skill documents.
	Skills,
	/// Reusable prompt templates.
	Prompts,
	/// Terminal themes.
	Themes,
}

/// Per-package resource admission rules.
///
/// Plain patterns include by glob, `!` excludes by glob, `+` force-includes
/// an exact path, and `-` force-excludes an exact path. The four classes are
/// applied in that order regardless of their order in the input array.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PackageResourceFilter {
	/// Whether this layer starts from the package defaults. `false` makes the
	/// layer a delta over an earlier scope.
	#[serde(default = "package_autoload_default")]
	pub autoload:   bool,
	/// Executable extension entry patterns.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub extensions: Option<Vec<Str>>,
	/// Skill path patterns.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub skills:     Option<Vec<Str>>,
	/// Prompt-template path patterns.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub prompts:    Option<Vec<Str>>,
	/// Theme path patterns.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub themes:     Option<Vec<Str>>,
}

const fn package_autoload_default() -> bool {
	true
}

impl Default for PackageResourceFilter {
	fn default() -> Self {
		Self {
			autoload:   true,
			extensions: None,
			skills:     None,
			prompts:    None,
			themes:     None,
		}
	}
}

impl PackageResourceFilter {
	/// Returns this package layer's patterns for one resource family.
	pub fn patterns(&self, family: ResourceFamily) -> Option<&[Str]> {
		match family {
			ResourceFamily::Extensions => self.extensions.as_deref(),
			ResourceFamily::Skills => self.skills.as_deref(),
			ResourceFamily::Prompts => self.prompts.as_deref(),
			ResourceFamily::Themes => self.themes.as_deref(),
		}
	}
}

/// Policy selected when a configured extension source is unavailable.
#[derive(
	Clone, Copy, Debug, Default, Display, EnumString, Eq, PartialEq, Deserialize, Serialize,
)]
#[serde(rename_all = "lowercase")]
#[strum(serialize_all = "lowercase", ascii_case_insensitive)]
pub enum MissingSourcePolicy {
	/// Materialize a remote source before admitting its resources.
	#[default]
	Install,
	/// Omit the unavailable source for this discovery pass.
	Skip,
	/// Refuse discovery or resolution.
	Error,
}

/// Typed action produced by missing-source policy evaluation.
#[derive(Clone, Copy, Debug, Display, Eq, PartialEq)]
#[strum(serialize_all = "lowercase")]
pub enum MissingSourceOutcome {
	/// Install or materialize the source.
	Install,
	/// Skip the source.
	Skip,
	/// Return a typed source error.
	Error,
}

impl MissingSourcePolicy {
	/// Returns the action to take for an unavailable configured source.
	pub const fn outcome(self) -> MissingSourceOutcome {
		match self {
			Self::Install => MissingSourceOutcome::Install,
			Self::Skip => MissingSourceOutcome::Skip,
			Self::Error => MissingSourceOutcome::Error,
		}
	}
}

/// The `[extensions]` table for one precedence scope.
#[derive(Clone, Debug, Default, Deserialize, Serialize)]
pub struct ExtensionOverlay {
	/// Extension ids enabled by this scope.
	#[serde(default)]
	pub enabled:        BTreeSet<Str>,
	/// Extension ids disabled by this scope; this is the negative P7 input.
	#[serde(default)]
	pub disabled:       BTreeSet<Str>,
	/// Workspace-only replacement declarations.
	#[serde(default)]
	pub replace:        BTreeSet<Str>,
	/// Feature selections replacing the install-record feature selection.
	#[serde(default)]
	pub features:       BTreeMap<Str, Vec<Str>>,
	/// Scalar, non-secret settings delivered to extensions.
	#[serde(default)]
	pub settings:       BTreeMap<Str, BTreeMap<Str, toml::Value>>,
	/// Per-extension resource-family admission rules.
	#[serde(default)]
	pub resources:      BTreeMap<Str, PackageResourceFilter>,
	/// Action taken when a configured source is unavailable.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub missing_source: Option<MissingSourcePolicy>,
	/// Optional startup update policy. Workspace scope may only disable it.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub updates:        Option<UpdateOverlay>,
}

impl ExtensionOverlay {
	/// Validates scope-only and secret-handling invariants before the overlay is
	/// used.
	pub fn validate(&self, scope: Scope) -> Result<(), ExtensionError> {
		if scope == Scope::Client && !self.replace.is_empty() {
			return Err(ExtensionError::new(
				ExtensionCode::EReplaceScope,
				"[extensions].replace is workspace-only",
			));
		}
		validate_update_overlay(self.updates.as_ref(), scope)?;
		for (extension, settings) in &self.settings {
			for (key, value) in settings {
				if !value.is_str() && !value.is_integer() && !value.is_float() && !value.is_bool() {
					return Err(ExtensionError::new(
						ExtensionCode::ESettingSecret,
						format!("{extension}.{key} is not a scalar setting"),
					));
				}
				if matches!(key.as_str(), "secret" | "password" | "token" | "api_key" | "key") {
					return Err(ExtensionError::new(
						ExtensionCode::ESettingSecret,
						format!("{extension}.{key} belongs in omp.creds"),
					));
				}
			}
		}
		Ok(())
	}
}

/// A parsed configuration scope and its P1/P2 position.
#[derive(Clone, Debug, Default)]
pub struct ScopedOverlay {
	/// Scope identity.
	pub scope:   Scope,
	/// Parsed overlay.
	pub overlay: ExtensionOverlay,
}

/// The result of applying P1–P7 to a specific extension id.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct EffectiveExtensionConfig {
	/// Whether P7 disabled the extension in any scope.
	pub disabled:         bool,
	/// Whether the latest non-negative scope enabled the extension.
	pub enabled:          bool,
	/// Latest feature selection, replacing rather than merging.
	pub features:         Vec<Str>,
	/// Later scalar settings override earlier settings.
	pub settings:         BTreeMap<Str, toml::Value>,
	/// Workspace replacement was explicitly declared.
	pub replace_declared: bool,
	/// Ordered client then workspace resource-filter layers.
	pub resource_filters: Vec<PackageResourceFilter>,
}

/// Folds missing-source policy with later scopes taking precedence.
pub fn effective_missing_source(scopes: &[ScopedOverlay]) -> MissingSourcePolicy {
	scopes
		.iter()
		.filter_map(|scope| scope.overlay.missing_source)
		.next_back()
		.unwrap_or_default()
}

/// Folds ordered client then workspace overlays. P7 is represented directly as
/// the `disabled` accumulator so no caller can accidentally implement a
/// first-wins exception.
pub fn fold_extension(scopes: &[ScopedOverlay], id: &Str) -> EffectiveExtensionConfig {
	let mut result = EffectiveExtensionConfig::default();
	for scope in scopes {
		let overlay = &scope.overlay;
		result.disabled |= overlay.disabled.contains(id);
		if overlay.enabled.contains(id) {
			result.enabled = true;
		}
		if let Some(features) = overlay.features.get(id) {
			result.features.clone_from(features);
		}
		if let Some(settings) = overlay.settings.get(id) {
			for (key, value) in settings {
				result.settings.insert(key.clone(), value.clone());
			}
		}
		if let Some(filter) = overlay.resources.get(id) {
			result.resource_filters.push(filter.clone());
		}
		result.replace_declared |= scope.scope == Scope::Workspace && overlay.replace.contains(id);
	}
	if result.disabled {
		result.enabled = false;
	}
	result
}

impl EffectiveExtensionConfig {
	/// Applies the five-tier package resource precedence for one relative path.
	///
	/// The caller supplies the manifest/default admission state. A normal
	/// filter layer replaces it, while `autoload = false` changes only paths
	/// matched by that layer.
	pub fn resource_enabled(
		&self,
		family: ResourceFamily,
		relative_path: &str,
		default_enabled: bool,
	) -> bool {
		let mut enabled = default_enabled;
		for filter in &self.resource_filters {
			match (filter.autoload, filter.patterns(family)) {
				(true, Some(patterns)) => {
					enabled = if patterns.is_empty() {
						false
					} else {
						resource_patterns_enabled(relative_path, patterns, true)
					};
				},
				(true, None) => enabled = true,
				(false, Some(patterns)) => {
					if !patterns.is_empty() {
						enabled = resource_delta_enabled(relative_path, patterns, enabled);
					}
				},
				(false, None) => {},
			}
		}
		enabled
	}
}

fn resource_patterns_enabled(path: &str, patterns: &[Str], initial: bool) -> bool {
	let mut has_includes = false;
	let mut included = false;
	let mut excluded = false;
	let mut force_included = false;
	let mut force_excluded = false;
	for pattern in patterns {
		let pattern = pattern.as_str();
		let (prefix, target) = pattern
			.as_bytes()
			.first()
			.filter(|prefix| matches!(prefix, b'!' | b'+' | b'-'))
			.map_or((None, pattern), |prefix| (Some(*prefix), &pattern[1..]));
		match prefix {
			None => {
				has_includes = true;
				included |= resource_glob_match(target, path);
			},
			Some(b'!') => excluded |= resource_glob_match(target, path),
			Some(b'+') => force_included |= exact_resource_match(target, path),
			Some(b'-') => force_excluded |= exact_resource_match(target, path),
			Some(_) => unreachable!("resource pattern prefix is closed"),
		}
	}
	let mut enabled = if has_includes { included } else { initial };
	if excluded {
		enabled = false;
	}
	if force_included {
		enabled = true;
	}
	if force_excluded {
		enabled = false;
	}
	enabled
}

fn resource_delta_enabled(path: &str, patterns: &[Str], initial: bool) -> bool {
	let mut enabled = initial;
	for prefix in [None, Some(b'!'), Some(b'+'), Some(b'-')] {
		for pattern in patterns {
			let value = pattern.as_str();
			let (actual, target) = value
				.as_bytes()
				.first()
				.filter(|actual| matches!(actual, b'!' | b'+' | b'-'))
				.map_or((None, value), |actual| (Some(*actual), &value[1..]));
			if actual != prefix {
				continue;
			}
			let matched = if matches!(prefix, Some(b'+' | b'-')) {
				exact_resource_match(target, path)
			} else {
				resource_glob_match(target, path)
			};
			if matched {
				enabled = !matches!(prefix, Some(b'!' | b'-'));
			}
		}
	}
	enabled
}

fn resource_glob_match(pattern: &str, path: &str) -> bool {
	let pattern = pattern.strip_prefix("./").unwrap_or(pattern);
	if glob_matches(pattern, path) {
		return true;
	}
	let path = Path::new(path);
	if path
		.file_name()
		.and_then(|name| name.to_str())
		.is_some_and(|name| glob_matches(pattern, name))
	{
		return true;
	}
	if path.file_name().and_then(|name| name.to_str()) != Some("SKILL.md") {
		return false;
	}
	path.parent().is_some_and(|parent| {
		glob_matches(pattern, &parent.to_string_lossy())
			|| parent
				.file_name()
				.and_then(|name| name.to_str())
				.is_some_and(|name| glob_matches(pattern, name))
	})
}

fn exact_resource_match(pattern: &str, path: &str) -> bool {
	let pattern = pattern.strip_prefix("./").unwrap_or(pattern);
	if pattern == path {
		return true;
	}
	path.strip_suffix("/SKILL.md") == Some(pattern)
}

/// Parses supported extension environment variables before CLI flag wiring.
#[derive(Clone, Debug, Default)]
pub struct ExtensionEnvironment {
	/// Content-addressed store root.
	pub store:         Option<PathBuf>,
	/// Artifact cache root.
	pub cache:         Option<PathBuf>,
	/// Ordered configured indexes.
	pub indexes:       Vec<String>,
	/// Index public-key path.
	pub index_keys:    Option<PathBuf>,
	/// Offline mode; `strict` also fails closed on stale revocations.
	pub offline:       OfflineMode,
	/// Lock mutation refusal.
	pub locked:        bool,
	/// R9 resolution clamp.
	pub exclude_newer: Option<Str>,
	/// Emergency negative admission set.
	pub disabled:      BTreeSet<Str>,
	/// Suppresses the workspace layer entirely.
	pub no_workspace:  bool,
	/// Noninteractive grants.
	pub grant:         Option<String>,
	/// Build allowance for path/git only.
	pub allow_build:   bool,
	/// Publisher signing key.
	pub sign_key:      Option<PathBuf>,
	/// `uv` executable.
	pub uv:            Option<PathBuf>,
	/// Target triples.
	pub targets:       Vec<Str>,
	/// Diagnostic resolution trace.
	pub trace:         bool,
	/// Ambient one-entry Python site override, reported as `W-SITE-OVERRIDE`.
	pub site_override: Option<PathBuf>,
	/// Per-host environment socket.
	pub env_socket:    Option<PathBuf>,
}

/// Offline policy derived from `OMP_EXT_OFFLINE`.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum OfflineMode {
	/// Network access is permitted.
	#[default]
	Online,
	/// Network is prohibited but stale revocation lists warn and proceed.
	Offline,
	/// Network is prohibited and stale revocation lists are refused.
	Strict,
}

impl ExtensionEnvironment {
	/// Reads the `OMP_EXT_*` configuration surface. Flag equivalence is wired by
	/// `ExtCli`; this type deliberately has no CLI dependency.
	pub fn from_environment() -> Self {
		let value = |name| env::var(name).ok().filter(|value| !value.is_empty());
		let comma = |name| {
			value(name).map_or_else(Vec::new, |value| {
				value
					.split(',')
					.filter(|entry| !entry.is_empty())
					.map(Str::new)
					.collect()
			})
		};
		let bool_value = |name| matches!(value(name).as_deref(), Some("1" | "true"));
		Self {
			store:         value("OMP_EXT_STORE").map(PathBuf::from),
			cache:         value("OMP_EXT_CACHE").map(PathBuf::from),
			indexes:       value("OMP_EXT_INDEX").map_or_else(Vec::new, |value| {
				value
					.split(',')
					.filter(|entry| !entry.is_empty())
					.map(str::to_owned)
					.collect()
			}),
			index_keys:    value("OMP_EXT_INDEX_KEYS").map(PathBuf::from),
			offline:       match value("OMP_EXT_OFFLINE").as_deref() {
				Some("strict") => OfflineMode::Strict,
				Some(_) => OfflineMode::Offline,
				None => OfflineMode::Online,
			},
			locked:        bool_value("OMP_EXT_LOCKED"),
			exclude_newer: value("OMP_EXT_EXCLUDE_NEWER").map(Str::new),
			disabled:      comma("OMP_EXT_DISABLE").into_iter().collect(),
			no_workspace:  bool_value("OMP_EXT_NO_WORKSPACE"),
			grant:         value("OMP_EXT_GRANT"),
			allow_build:   bool_value("OMP_EXT_ALLOW_BUILD"),
			sign_key:      value("OMP_EXT_SIGN_KEY").map(PathBuf::from),
			uv:            value("OMP_EXT_UV").map(PathBuf::from),
			targets:       comma("OMP_EXT_TARGETS"),
			trace:         bool_value("OMP_EXT_TRACE"),
			env_socket:    value("OMP_EXT_ENV_SOCKET").map(PathBuf::from),
			site_override: value("OMP_PY_SITE").map(PathBuf::from),
		}
	}

	/// Returns the diagnostic emitted when an ambient site override bypasses
	/// managed per-host site-tree selection.
	pub const fn site_override_warning(&self) -> Option<ExtensionCode> {
		if self.site_override.is_some() {
			Some(ExtensionCode::WSiteOverride)
		} else {
			None
		}
	}
}
/// Static discovery locations for one layer, ordered per P2.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AmbientPaths {
	/// Directories containing manifests, in discovery order.
	pub manifest_roots:  Vec<PathBuf>,
	/// Config overlays, in discovery order.
	pub config_files:    Vec<PathBuf>,
	/// Local install records, in discovery order.
	pub install_records: Vec<PathBuf>,
	/// Compatibility roots that are reported but never loaded.
	pub foreign_roots:   Vec<PathBuf>,
}

/// Builds ambient discovery paths. Workspace paths are included on the
/// workspace side; callers do not invoke this for a remote workspace on the
/// client. Compatibility roots are diagnostic-only (`W-FOREIGN-ROOT`).
pub fn ambient_paths(data_dir: &Path, workspace: Option<&Path>) -> AmbientPaths {
	let mut paths = AmbientPaths {
		manifest_roots:  Vec::new(),
		config_files:    vec![data_dir.join("config.toml")],
		install_records: vec![data_dir.join("ext/installed.toml")],
		foreign_roots:   Vec::new(),
	};
	if let Some(workspace) = workspace {
		let root = workspace.join(".omp");
		paths.manifest_roots.push(root.join("extensions"));
		paths.config_files.push(root.join("config.toml"));
		paths.install_records.push(root.join("installed.toml"));
		for name in [".claude", ".codex", ".gemini"] {
			paths.foreign_roots.push(workspace.join(name));
		}
	}
	paths
}

/// Outcome of the P4 workspace replacement gate.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ReplacementDecision {
	/// The workspace instance is the sole active instance for this id.
	Replace,
	/// The client instance remains active and the workspace instance is omitted.
	Denied(ExtensionCode),
	/// No workspace replacement was requested.
	NotRequested,
}

/// Applies P4's declaration, publisher-match, and policy gates. A denial is
/// deterministic: callers retain or re-admit the client instance rather than
/// allowing both instances to coexist.
pub fn workspace_replacement(
	replace_declared: bool,
	client_publisher: &Str,
	workspace_publisher: &Str,
	policy_permits: bool,
) -> ReplacementDecision {
	if !replace_declared {
		return ReplacementDecision::NotRequested;
	}
	if client_publisher != workspace_publisher || !policy_permits {
		return ReplacementDecision::Denied(ExtensionCode::WReplaceDenied);
	}
	ReplacementDecision::Replace
}

/// The authoring intent of one `[[tools]]` entry.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Eq,
	PartialEq,
	Deserialize,
	Serialize,
	strum::Display,
	strum::EnumString,
)]
#[serde(rename_all = "lowercase")]
#[strum(serialize_all = "lowercase", ascii_case_insensitive)]
pub enum ToolIntent {
	/// Catalog-routed tool declaration.
	#[default]
	Soft,
	/// Model-slot-claiming tool declaration gated by `tools.hard`.
	Hard,
}

/// One optional manifest feature and the surface it owns.
#[derive(Clone, Debug, Default, Eq, PartialEq, Deserialize, Serialize)]
pub struct FeatureManifest {
	/// Whether a fresh unbracketed install selects this feature.
	#[serde(default)]
	pub default:      bool,
	/// Module imported when any executable row owned by the feature activates.
	pub entry:        Str,
	/// Dependencies contributed only while the feature is selected.
	#[serde(default)]
	pub requires:     Vec<Str>,
	/// Human-readable feature summary.
	#[serde(default)]
	pub description:  Str,
	/// Capabilities contributed only while the feature is selected.
	#[serde(default)]
	pub capabilities: Vec<Str>,
}

/// One lock-materialized executable declared by logical name.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct BinaryManifest {
	/// Logical executable name used by static LSP and DAP configuration.
	pub name: Str,
}

/// Parsed deployment manifest surface needed for feature projection and static
/// content validation.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum SettingType {
	/// UTF-8 text.
	String,
	/// Integer or floating-point number.
	Number,
	/// Boolean switch.
	Boolean,
	/// One of the schema's declared string values.
	Enum,
}

/// Product settings tab available to an extension setting.
#[derive(
	Clone,
	Copy,
	Debug,
	Eq,
	PartialEq,
	Deserialize,
	Serialize,
	strum::EnumString,
	strum::IntoStaticStr,
)]
#[serde(rename_all = "lowercase")]
#[strum(serialize_all = "lowercase")]
pub enum SettingUiTab {
	/// Theme and terminal presentation.
	Appearance,
	/// Model behavior and sampling.
	Model,
	/// Input and session interaction.
	Interaction,
	/// Context collection and compaction.
	Context,
	/// Memory systems.
	Memory,
	/// File tools and language services.
	Files,
	/// Shell and runtime execution.
	Shell,
	/// Tool behavior.
	Tools,
	/// Task and subagent behavior.
	Tasks,
	/// Provider transports and services.
	Providers,
}

/// One labeled choice in extension settings UI metadata.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct SettingUiOption {
	/// Value written to the extension convar.
	pub value:       Str,
	/// Human option label.
	pub label:       Str,
	/// Optional explanatory copy.
	#[serde(default)]
	pub description: Str,
}

/// Optional curated settings projection declared by an extension manifest.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct SettingUiSchema {
	/// Product tab.
	pub tab:         SettingUiTab,
	/// Existing product group within the tab.
	pub group:       Str,
	/// Human row label.
	pub label:       Str,
	/// Human explanatory copy.
	pub description: Str,
	/// Optional risk copy.
	#[serde(default)]
	pub warning:     Option<Str>,
	/// Optional labeled choices. Empty means infer the widget from `type`.
	#[serde(default)]
	pub options:     Vec<SettingUiOption>,
	/// Whether selected values have meaningful order.
	#[serde(default)]
	pub ordered:     bool,
}

/// Returns the canonical control-plane name for one extension setting.
///
/// Extension identities remain visible in the name so independently admitted
/// manifests cannot collide.
#[must_use]
pub fn extension_setting_convar_name(extension: &str, key: &str) -> Str {
	sf!("ext::{extension}::{key}")
}

/// One manifest-declared extension setting.
#[derive(Clone, Debug, PartialEq, Deserialize, Serialize)]
pub struct SettingSchema {
	/// Accepted value kind.
	#[serde(rename = "type")]
	pub kind:        SettingType,
	/// Value used when no configuration layer supplies one.
	#[serde(default)]
	pub default:     Option<toml::Value>,
	/// Human-readable setting description.
	#[serde(default)]
	pub description: Option<Str>,
	/// Closed values for an enum setting.
	#[serde(default)]
	pub values:      Vec<Str>,
	/// Inclusive numeric lower bound.
	#[serde(default)]
	pub min:         Option<toml::Value>,
	/// Inclusive numeric upper bound.
	#[serde(default)]
	pub max:         Option<toml::Value>,
	/// Suggested numeric increment.
	#[serde(default)]
	pub step:        Option<toml::Value>,
	/// Whether the value must be supplied by the credential authority.
	#[serde(default)]
	pub secret:      bool,
	/// Optional environment variable source.
	#[serde(default)]
	pub env:         Option<Str>,
	/// Optional explicit product settings UI metadata.
	#[serde(default)]
	pub ui:          Option<SettingUiSchema>,
}

/// A generic command-line extension setting override.
///
/// Parsing this type validates only the inert `<id>.<key>=<value>` envelope.
/// The value remains text until manifest admission knows its schema.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CliSettingOverride {
	/// Target extension identity.
	pub extension: Str,
	/// Target manifest setting key.
	pub key:       Str,
	/// Unparsed command-line value.
	pub value:     Str,
}

impl CliSettingOverride {
	/// Parses an inert command-line override without importing extension code.
	pub fn parse(input: &str) -> Result<Self, ExtensionError> {
		let (target, value) = input.split_once('=').ok_or_else(|| {
			ExtensionError::new(
				ExtensionCode::EManifestParse,
				"extension override must be <id>.<key>=<value>",
			)
		})?;
		let (extension, key) = target.rsplit_once('.').ok_or_else(|| {
			ExtensionError::new(
				ExtensionCode::EManifestParse,
				"extension override must name an extension and setting key",
			)
		})?;
		if extension.is_empty() || key.is_empty() {
			return Err(ExtensionError::new(
				ExtensionCode::EManifestParse,
				"extension override must name an extension and setting key",
			));
		}
		Ok(Self {
			extension: Str::new(extension),
			key:       Str::new(key),
			value:     Str::new(value),
		})
	}
}

/// Parsed deployment manifest surface needed for feature projection and static
/// content validation.
#[derive(Clone, Debug, Default, PartialEq, Deserialize, Serialize)]
pub struct DeploymentManifest {
	/// Stable extension identity.
	#[serde(default)]
	pub id:           Str,
	/// Canonical Python entry module.
	#[serde(default)]
	pub entry:        Str,
	/// Manifest-declared typed settings.
	#[serde(default)]
	pub settings:     BTreeMap<Str, SettingSchema>,
	/// Base extension dependencies.
	#[serde(default)]
	pub requires:     Vec<Str>,
	/// Base extension capabilities.
	#[serde(default)]
	pub capabilities: Vec<Str>,
	/// Named optional features.
	#[serde(default)]
	pub features:     BTreeMap<Str, FeatureManifest>,
	/// Logical binaries materialized by the lock.
	#[serde(default, rename = "binaries")]
	pub binaries:     Vec<BinaryManifest>,
	/// Complete executable and content declaration inventory.
	#[serde(default, rename = "declarations")]
	pub declarations: Vec<StaticDeclaration>,
}

/// Canonical selected manifest projection persisted by lock v2.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ManifestProjection {
	/// Concrete selected feature names.
	pub features:                   Vec<Str>,
	/// Base plus selected dependencies.
	pub requires:                   Vec<Str>,
	/// Base plus selected capabilities.
	pub capabilities:               Vec<Str>,
	/// Base plus selected declaration rows.
	pub declarations:               Vec<StaticDeclaration>,
	/// Digest of the selected declaration table.
	pub declaration_digest:         Str,
	/// Digest of the effective capability set.
	pub capability_digest:          Str,
	/// Digest of the complete feature capability graph.
	pub manifest_capability_digest: Str,
}

/// One source `[[tools]]` manifest entry.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct ToolManifestEntry {
	/// Optional feature owning this row.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub feature: Option<Str>,
	/// Stable declaration id.
	pub id:      Str,
	/// Tool intent; defaults to soft.
	#[serde(default, rename = "kind")]
	pub intent:  ToolIntent,
	/// Module imported when the tool activates.
	pub module:  Str,
	/// Static route key.
	pub key:     Str,
	/// Required API level.
	pub api:     u32,
}

/// Uniform declaration consumed by static catalogs and lazy activation.
#[derive(Clone, Debug, Eq, PartialEq, Deserialize, Serialize)]
pub struct Declaration {
	/// Optional feature owning this row.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub feature: Option<Str>,
	/// Stable declaration id.
	pub id:      Str,
	/// Closed declaration kind (`soft` or `hard` for this lowering).
	pub kind:    ToolIntent,
	/// Module imported on activation.
	pub module:  Str,
	/// Static route key.
	pub key:     Str,
	/// Tools always activate lazily from their static declarations.
	pub trigger: Str,
	/// Required OMP API level.
	pub api:     u32,
}

/// Lowers authoring `[[tools]]` entries into the static declaration table.
pub fn lower_tools(tools: impl IntoIterator<Item = ToolManifestEntry>) -> Vec<Declaration> {
	tools
		.into_iter()
		.map(|tool| Declaration {
			feature: tool.feature,
			id:      tool.id,
			kind:    tool.intent,
			module:  tool.module,
			key:     tool.key,
			trigger: sf!("lazy"),
			api:     tool.api,
		})
		.collect()
}

/// Static MCP notification filter carried only by hook declarations.
#[derive(Clone, Debug, Default, Eq, Ord, PartialEq, PartialOrd, Deserialize, Serialize)]
pub struct HookDeclarationFilter {
	/// Exact raw MCP mount names.
	#[serde(default)]
	pub servers:      Box<[Str]>,
	/// Anchored JSON-RPC method globs.
	#[serde(default)]
	pub method_globs: Box<[Str]>,
}

/// One sealed extension declaration retained before executable code is loaded.
///
/// The common routing fields are typed while class-specific signed properties
/// remain available verbatim. Permission is granted by membership in the
/// containing declaration table, never by a runtime callback.
#[derive(Clone, Debug, Default, Eq, PartialEq, Deserialize, Serialize)]
pub struct StaticDeclaration {
	/// Optional feature owning this executable or content row.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub feature:    Option<Str>,
	/// Stable identity within its declaration class.
	#[serde(default)]
	pub id:         Str,
	/// Closed declaration kind from the deployment manifest.
	#[serde(default)]
	pub kind:       Str,
	/// Package-contained module that implements the declaration.
	#[serde(default)]
	pub module:     Str,
	/// Static activation trigger.
	#[serde(default)]
	pub trigger:    Str,
	/// Static class-specific route key.
	#[serde(default)]
	pub key:        Str,
	/// Required OMP API revision.
	#[serde(default)]
	pub api:        u32,
	/// Unavailability behavior fixed by the manifest.
	#[serde(default)]
	pub failure:    Str,
	/// Deployment-granted capability names.
	#[serde(default)]
	pub grants:     Box<[Str]>,
	/// Optional static prefilter, legal only for hook declarations.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub filter:     Option<HookDeclarationFilter>,
	/// Distribution-relative path or glob for a static content row.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub path:       Option<Str>,
	/// Signed kind-specific metadata for a static content row.
	#[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
	pub metadata:   BTreeMap<Str, serde_json::Value>,
	/// Class-specific signed declaration properties.
	#[serde(flatten)]
	pub properties: BTreeMap<Str, serde_json::Value>,
}

fn validate_setting_value(
	extension: &str,
	key: &str,
	schema: &SettingSchema,
	value: &toml::Value,
) -> Result<(), ExtensionError> {
	let valid = match schema.kind {
		SettingType::String => value.is_str(),
		SettingType::Number => value.is_integer() || value.is_float(),
		SettingType::Boolean => value.is_bool(),
		SettingType::Enum => value
			.as_str()
			.is_some_and(|value| schema.values.iter().any(|allowed| allowed == value)),
	};
	if !valid {
		return Err(ExtensionError::new(
			ExtensionCode::EManifestParse,
			format!("extension {extension} setting {key} has an invalid value"),
		));
	}
	if matches!(schema.kind, SettingType::Number) {
		let numeric = value
			.as_float()
			.or_else(|| value.as_integer().map(|value| value as f64))
			.expect("number setting was type checked");
		if schema
			.min
			.as_ref()
			.and_then(|value| {
				value
					.as_float()
					.or_else(|| value.as_integer().map(|value| value as f64))
			})
			.is_some_and(|minimum| numeric < minimum)
			|| schema
				.max
				.as_ref()
				.and_then(|value| {
					value
						.as_float()
						.or_else(|| value.as_integer().map(|value| value as f64))
				})
				.is_some_and(|maximum| numeric > maximum)
		{
			return Err(ExtensionError::new(
				ExtensionCode::EManifestParse,
				format!("extension {extension} setting {key} is outside its admitted range"),
			));
		}
	}
	Ok(())
}

fn parse_override_value(
	extension: &str,
	key: &str,
	schema: &SettingSchema,
	raw: &str,
) -> Result<toml::Value, ExtensionError> {
	let value = match schema.kind {
		SettingType::String | SettingType::Enum => toml::Value::String(raw.to_owned()),
		SettingType::Boolean => match raw {
			"true" => toml::Value::Boolean(true),
			"false" => toml::Value::Boolean(false),
			_ => {
				return Err(ExtensionError::new(
					ExtensionCode::EManifestParse,
					format!("extension {extension} setting {key} expects true or false"),
				));
			},
		},
		SettingType::Number => {
			if let Ok(value) = raw.parse::<i64>() {
				toml::Value::Integer(value)
			} else if let Ok(value) = raw.parse::<f64>() {
				toml::Value::Float(value)
			} else {
				return Err(ExtensionError::new(
					ExtensionCode::EManifestParse,
					format!("extension {extension} setting {key} expects a number"),
				));
			}
		},
	};
	validate_setting_value(extension, key, schema, &value)?;
	Ok(value)
}

/// Applies invocation overrides to an already resolved extension setting map.
///
/// Overrides targeting another extension are inert. Values targeting this
/// extension are parsed and validated against the authenticated schema before
/// replacing the resolved JSON scalar.
pub fn apply_resolved_setting_overrides(
	extension: &str,
	schemas: &BTreeMap<Str, SettingSchema>,
	resolved: &mut serde_json::Map<String, serde_json::Value>,
	overrides: &[CliSettingOverride],
) -> Result<(), ExtensionError> {
	for value in overrides
		.iter()
		.filter(|value| value.extension == extension)
	{
		let schema = schemas.get(&value.key).ok_or_else(|| {
			ExtensionError::new(
				ExtensionCode::EManifestParse,
				format!("extension {extension} has no setting named {}", value.key),
			)
		})?;
		let parsed = parse_override_value(extension, &value.key, schema, &value.value)?;
		validate_setting_value(extension, &value.key, schema, &parsed)?;
		let parsed = serde_json::to_value(parsed).map_err(|source| {
			ExtensionError::new(ExtensionCode::EManifestParse, source.to_string())
		})?;
		resolved.insert(value.key.to_string(), parsed);
	}
	Ok(())
}

/// Resolves defaults, user/project configuration, then command-line overrides
/// against one admitted manifest settings schema.
pub fn resolve_extension_settings(
	manifest: &DeploymentManifest,
	configured: &BTreeMap<Str, toml::Value>,
	overrides: &[CliSettingOverride],
) -> Result<serde_json::Map<String, serde_json::Value>, ExtensionError> {
	manifest.validate()?;
	let extension = manifest.id.as_str();
	let mut resolved = manifest
		.settings
		.iter()
		.filter_map(|(key, schema)| schema.default.clone().map(|value| (key.clone(), value)))
		.collect::<BTreeMap<_, _>>();
	for (key, value) in configured {
		let schema = manifest.settings.get(key).ok_or_else(|| {
			ExtensionError::new(
				ExtensionCode::EManifestParse,
				format!("extension {extension} has no setting named {key}"),
			)
		})?;
		validate_setting_value(extension, key, schema, value)?;
		resolved.insert(key.clone(), value.clone());
	}
	for value in overrides
		.iter()
		.filter(|value| value.extension == manifest.id)
	{
		let schema = manifest.settings.get(&value.key).ok_or_else(|| {
			ExtensionError::new(
				ExtensionCode::EManifestParse,
				format!("extension {extension} has no setting named {}", value.key),
			)
		})?;
		resolved.insert(
			value.key.clone(),
			parse_override_value(extension, &value.key, schema, &value.value)?,
		);
	}
	resolved
		.into_iter()
		.map(|(key, value)| {
			serde_json::to_value(value)
				.map(|value| (key.to_string(), value))
				.map_err(|source| {
					ExtensionError::new(ExtensionCode::EManifestParse, source.to_string())
				})
		})
		.collect()
}

impl DeploymentManifest {
	/// Parses a projected wheel `omp.toml`.
	pub fn parse(input: &str) -> Result<Self, ExtensionError> {
		toml::from_str(input)
			.map_err(|source| ExtensionError::new(ExtensionCode::EManifestParse, source.to_string()))
	}

	/// Validates feature ownership and the exact static-content row shape.
	pub fn validate(&self) -> Result<(), ExtensionError> {
		for (key, schema) in &self.settings {
			if key.is_empty() || key.as_str().trim() != key.as_str() {
				return Err(ExtensionError::new(
					ExtensionCode::EManifestParse,
					"setting names must be non-empty and trimmed",
				));
			}
			if schema.secret {
				return Err(ExtensionError::new(
					ExtensionCode::ESettingSecret,
					format!("{}.{} is secret and belongs in omp.creds", self.id, key),
				));
			}
			if matches!(schema.kind, SettingType::Enum) && schema.values.is_empty() {
				return Err(ExtensionError::new(
					ExtensionCode::EManifestParse,
					format!("{}.{} enum setting declares no values", self.id, key),
				));
			}
			for value in schema
				.default
				.iter()
				.chain(schema.min.iter())
				.chain(schema.max.iter())
				.chain(schema.step.iter())
			{
				if !value.is_str() && !value.is_integer() && !value.is_float() && !value.is_bool() {
					return Err(ExtensionError::new(
						ExtensionCode::EManifestParse,
						format!("{}.{} setting schema contains a non-scalar value", self.id, key),
					));
				}
			}
			if let Some(default) = &schema.default {
				validate_setting_value(&self.id, key, schema, default)?;
			}
		}
		let feature_entries = self
			.features
			.iter()
			.map(|(name, feature)| (feature.entry.as_str(), name))
			.collect::<BTreeMap<_, _>>();
		for (name, feature) in &self.features {
			if name.is_empty() || name.as_str().trim() != name.as_str() || feature.entry.is_empty() {
				return Err(ExtensionError::new(
					ExtensionCode::EFeature,
					"feature names must be trimmed and every feature must declare an entry",
				));
			}
		}
		let mut ids = BTreeSet::new();
		for row in &self.declarations {
			if let Some(feature_name) = &row.feature {
				let feature = self.features.get(feature_name).ok_or_else(|| {
					ExtensionError::new(
						ExtensionCode::EFeature,
						format!("declaration references unknown feature {feature_name}"),
					)
				})?;
				if !row.module.is_empty() && row.module != feature.entry {
					return Err(ExtensionError::new(
						ExtensionCode::EFeature,
						format!("declaration {} is not emitted by {}", row.id, feature.entry),
					));
				}
			} else if !row.module.is_empty() && feature_entries.contains_key(row.module.as_str()) {
				return Err(ExtensionError::new(
					ExtensionCode::EFeature,
					format!("declaration {} emitted by a feature has no feature", row.id),
				));
			}
			if !row.id.is_empty() && !ids.insert(&row.id) {
				return Err(ExtensionError::new(
					ExtensionCode::EDupId,
					format!("duplicate declaration id {}", row.id),
				));
			}
			validate_static_row(row)?;
		}
		Ok(())
	}

	/// Produces the canonical base-plus-selected manifest projection.
	pub fn project(&self, selected: &[Str]) -> Result<ManifestProjection, ExtensionError> {
		self.validate()?;
		let mut features = selected.to_vec();
		features.sort();
		features.dedup();
		for feature in &features {
			if !self.features.contains_key(feature) {
				return Err(ExtensionError::new(
					ExtensionCode::EFeature,
					format!("unknown feature {feature}"),
				));
			}
		}
		let selected_set = features.iter().collect::<BTreeSet<_>>();
		let mut requires = self.requires.clone();
		let mut capabilities = self.capabilities.clone();
		for feature in &features {
			let manifest = &self.features[feature];
			requires.extend(manifest.requires.iter().cloned());
			capabilities.extend(manifest.capabilities.iter().cloned());
		}
		requires.sort();
		requires.dedup();
		capabilities.sort();
		capabilities.dedup();
		let declarations = self
			.declarations
			.iter()
			.filter(|row| {
				row.feature
					.as_ref()
					.is_none_or(|name| selected_set.contains(name))
			})
			.cloned()
			.collect::<Vec<_>>();
		Ok(ManifestProjection {
			features,
			requires,
			capability_digest: crate::trust::capability_digest(capabilities.iter().cloned(), []),
			declaration_digest: declaration_digest(&declarations)?,
			manifest_capability_digest: manifest_capability_digest(self)?,
			capabilities,
			declarations,
		})
	}

	/// Validates that every static content path is contained and covered by the
	/// distribution `RECORD`.
	pub fn validate_record<'a>(
		&self,
		record: impl IntoIterator<Item = &'a str>,
	) -> Result<(), ExtensionError> {
		let record = record.into_iter().collect::<Vec<_>>();
		for row in &self.declarations {
			let Some(pattern) = row.path.as_deref() else {
				continue;
			};
			validate_relative_pattern(pattern)?;
			if !record.iter().any(|path| glob_matches(pattern, path)) {
				return Err(ExtensionError::new(
					ExtensionCode::EIntegrity,
					format!("declaration path {pattern} is not covered by RECORD"),
				));
			}
		}
		Ok(())
	}
}

/// Computes the canonical digest of a selected declaration table.
pub fn declaration_digest(rows: &[StaticDeclaration]) -> Result<Str, ExtensionError> {
	let mut rows = rows.to_vec();
	for row in &mut rows {
		row.grants.sort();
	}
	rows.sort_by(|left, right| {
		(
			left.feature.as_deref(),
			left.kind.as_str(),
			left.id.as_str(),
			left.path.as_deref(),
			left.key.as_str(),
		)
			.cmp(&(
				right.feature.as_deref(),
				right.kind.as_str(),
				right.id.as_str(),
				right.path.as_deref(),
				right.key.as_str(),
			))
	});
	canonical_digest(&rows)
}

/// Computes the digest of the complete base-and-feature capability graph.
pub fn manifest_capability_digest(manifest: &DeploymentManifest) -> Result<Str, ExtensionError> {
	#[derive(Serialize)]
	struct Graph<'a> {
		base:     Vec<&'a Str>,
		features: BTreeMap<&'a Str, Vec<&'a Str>>,
	}
	let mut base = manifest.capabilities.iter().collect::<Vec<_>>();
	base.sort();
	base.dedup();
	let features = manifest
		.features
		.iter()
		.map(|(name, feature)| {
			let mut capabilities = feature.capabilities.iter().collect::<Vec<_>>();
			capabilities.sort();
			capabilities.dedup();
			(name, capabilities)
		})
		.collect();
	canonical_digest(&Graph { base, features })
}

fn canonical_digest(value: &impl Serialize) -> Result<Str, ExtensionError> {
	let bytes = serde_json::to_vec(value)
		.map_err(|source| ExtensionError::new(ExtensionCode::EManifestParse, source.to_string()))?;
	Ok(Str::new(format!("b3:{}", blake3::hash(&bytes).to_hex())))
}

fn validate_static_row(row: &StaticDeclaration) -> Result<(), ExtensionError> {
	if let Some(filter) = &row.filter {
		if row.kind != "hook" {
			return Err(ExtensionError::new(
				ExtensionCode::EManifestParse,
				"declaration filter is legal only for hooks",
			));
		}
		if filter.servers.is_empty() && filter.method_globs.is_empty() {
			return Err(ExtensionError::new(
				ExtensionCode::EManifestParse,
				"hook declaration filter must select a server or method",
			));
		}
		if filter
			.servers
			.iter()
			.chain(filter.method_globs.iter())
			.any(|value| value.is_empty() || value.as_str().trim() != value.as_str())
		{
			return Err(ExtensionError::new(
				ExtensionCode::EManifestParse,
				"hook declaration filter entries must be non-empty and trimmed",
			));
		}
	}
	let content = matches!(
		row.kind.as_str(),
		"skills"
			| "rules"
			| "context-files"
			| "prompts"
			| "agents"
			| "lsp-servers"
			| "dap-adapters"
			| "themes"
	);
	if content {
		let path = row.path.as_deref().ok_or_else(|| {
			ExtensionError::new(ExtensionCode::EManifestParse, "static content row has no path")
		})?;
		validate_relative_pattern(path)?;
		if !row.id.is_empty()
			|| !row.module.is_empty()
			|| !row.key.is_empty()
			|| !row.trigger.is_empty()
			|| row.api != 0
			|| !row.failure.is_empty()
		{
			return Err(ExtensionError::new(
				ExtensionCode::EManifestParse,
				"static content rows cannot carry executable fields",
			));
		}
		let format = row
			.metadata
			.get("format")
			.and_then(serde_json::Value::as_str);
		let valid_format = match row.kind.as_str() {
			"agents" => format == Some("omp-agent-markdown"),
			"lsp-servers" | "dap-adapters" => matches!(format, Some("json" | "yaml")),
			_ => true,
		};
		if !valid_format {
			return Err(ExtensionError::new(
				ExtensionCode::EManifestParse,
				format!("{} declaration has an invalid metadata.format", row.kind),
			));
		}
	} else if row.path.is_some() {
		return Err(ExtensionError::new(
			ExtensionCode::EManifestParse,
			"executable declaration cannot carry a content path",
		));
	}
	Ok(())
}

fn validate_relative_pattern(pattern: &str) -> Result<(), ExtensionError> {
	let path = Path::new(pattern);
	if pattern.is_empty()
		|| pattern.contains('\\')
		|| path.is_absolute()
		|| path.components().any(|component| {
			matches!(
				component,
				std::path::Component::ParentDir
					| std::path::Component::RootDir
					| std::path::Component::Prefix(_)
			)
		}) {
		return Err(ExtensionError::new(
			ExtensionCode::EIntegrity,
			format!("declaration path {pattern} escapes the distribution"),
		));
	}
	Ok(())
}

fn glob_matches(pattern: &str, value: &str) -> bool {
	let pattern = pattern.as_bytes();
	let value = value.as_bytes();
	let mut table = vec![vec![false; value.len() + 1]; pattern.len() + 1];
	table[0][0] = true;
	for index in 0..pattern.len() {
		if pattern[index] == b'*' {
			table[index + 1][0] = table[index][0];
		}
		for offset in 0..value.len() {
			table[index + 1][offset + 1] = match pattern[index] {
				b'*' => table[index][offset + 1] || table[index + 1][offset],
				b'?' => table[index][offset],
				byte => table[index][offset] && byte == value[offset],
			};
		}
	}
	table[pattern.len()][value.len()]
}

/// Sealed interactive UI declaration tables.
#[derive(Clone, Debug, Default, Eq, PartialEq, Deserialize, Serialize)]
pub struct UiDeclarations {
	/// Namespaced command declarations.
	#[serde(default)]
	pub commands:          Box<[StaticDeclaration]>,
	/// High-level shortcut declarations.
	#[serde(default)]
	pub shortcuts:         Box<[StaticDeclaration]>,
	/// Versioned message renderer declarations.
	#[serde(default)]
	pub message_renderers: Box<[StaticDeclaration]>,
	/// Versioned verdict renderer declarations.
	#[serde(default)]
	pub verdict_renderers: Box<[StaticDeclaration]>,
	/// Typed completion source declarations.
	#[serde(default)]
	pub completions:       Box<[StaticDeclaration]>,
}

/// Sealed telemetry declaration tables.
#[derive(Clone, Debug, Default, Eq, PartialEq, Deserialize, Serialize)]
pub struct TelemetryDeclarations {
	/// Event subscriptions visible to the extension.
	#[serde(default)]
	pub subscriptions: Box<[StaticDeclaration]>,
	/// Consent-gated telemetry export declarations.
	#[serde(default)]
	pub exports:       Box<[StaticDeclaration]>,
}

/// Every statically declared extension CONTROL surface.
#[derive(Clone, Debug, Default, Eq, PartialEq, Deserialize, Serialize)]
pub struct StaticDeclarations {
	/// Exact deployment capability grant payload, grouped by authority domain.
	#[serde(default, rename = "capabilities")]
	pub capability_grants: BTreeMap<Str, serde_json::Value>,
	/// Uniform sealed declaration rows in deployment order.
	#[serde(default, rename = "declarations")]
	pub ordered:           Box<[StaticDeclaration]>,
	/// Soft and hard tool declarations.
	#[serde(default)]
	pub tools:             Box<[StaticDeclaration]>,
	/// Hook declarations.
	#[serde(default)]
	pub hooks:             Box<[StaticDeclaration]>,
	/// Inter-extension service declarations.
	#[serde(default)]
	pub services:          Box<[StaticDeclaration]>,
	/// Inference provider catalog declarations.
	#[serde(default)]
	pub providers:         Box<[StaticDeclaration]>,
	/// Session and turn regime declarations.
	#[serde(default)]
	pub regimes:           Box<[StaticDeclaration]>,
	/// Interactive presentation declarations.
	#[serde(default)]
	pub ui:                UiDeclarations,
	/// Telemetry observation and export declarations.
	#[serde(default)]
	pub telemetry:         TelemetryDeclarations,
	/// Typed system-prompt slot contributions.
	#[serde(default)]
	pub prompt_slots:      Box<[StaticDeclaration]>,
	/// Opaque credential-source declarations.
	#[serde(default)]
	pub credentials:       Box<[StaticDeclaration]>,
	/// Secret transform and reference declarations.
	#[serde(default)]
	pub secrets:           Box<[StaticDeclaration]>,
	/// Supervised Python worker declarations.
	#[serde(default)]
	pub workers:           Box<[StaticDeclaration]>,
	/// Worker placement constraints and affinity declarations.
	#[serde(default)]
	pub placement:         Box<[StaticDeclaration]>,
	/// Signed extension-provided agent definition files.
	#[serde(default)]
	pub agents:            Box<[StaticDeclaration]>,
	/// Signed extension-provided language-server catalogs.
	#[serde(default, rename = "lsp-servers")]
	pub lsp_servers:       Box<[StaticDeclaration]>,
	/// Signed extension-provided debug-adapter catalogs.
	#[serde(default, rename = "dap-adapters")]
	pub dap_adapters:      Box<[StaticDeclaration]>,
}

/// Closed class identity used by declaration/runtime drift reports.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum StaticDeclarationClass {
	/// Soft or hard tool.
	Tool,
	/// Hook.
	Hook,
	/// Inter-extension service.
	Service,
	/// Inference provider.
	Provider,
	/// Regime.
	Regime,
	/// UI command.
	UiCommand,
	/// UI shortcut.
	UiShortcut,
	/// UI message renderer.
	UiMessageRenderer,
	/// UI verdict renderer.
	UiVerdictRenderer,
	/// UI completion source.
	UiCompletion,
	/// Telemetry subscription.
	TelemetrySubscription,
	/// Telemetry exporter.
	TelemetryExport,
	/// Prompt slot.
	PromptSlot,
	/// Credential source.
	Credential,
	/// Secret declaration.
	Secret,
	/// Supervised worker.
	Worker,
	/// Placement rule.
	Placement,
}

/// Exact identities missing from or unexpectedly reported by a frozen runtime.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct StaticDeclarationDrift {
	/// Manifest rows absent from the runtime report.
	pub missing:    Box<[(StaticDeclarationClass, Str)]>,
	/// Runtime rows absent from the authenticated manifest.
	pub unexpected: Box<[(StaticDeclarationClass, Str)]>,
}

impl StaticDeclarationDrift {
	/// Returns whether static and runtime identities agree exactly.
	pub fn is_empty(&self) -> bool {
		self.missing.is_empty() && self.unexpected.is_empty()
	}
}

impl StaticDeclarations {
	/// Parses declaration tables from authenticated manifest properties.
	pub fn from_properties(
		properties: &BTreeMap<Str, serde_json::Value>,
	) -> Result<Self, serde_json::Error> {
		let mut parsed = serde_json::from_value::<Self>(serde_json::to_value(properties)?)?;
		let mut tools = Vec::from(parsed.tools);
		let mut hooks = Vec::from(parsed.hooks);
		let mut services = Vec::from(parsed.services);
		let mut providers = Vec::from(parsed.providers);
		let mut regimes = Vec::from(parsed.regimes);
		let mut commands = Vec::from(parsed.ui.commands);
		let mut shortcuts = Vec::from(parsed.ui.shortcuts);
		let mut message_renderers = Vec::from(parsed.ui.message_renderers);
		let mut verdict_renderers = Vec::from(parsed.ui.verdict_renderers);
		let mut completions = Vec::from(parsed.ui.completions);
		let mut subscriptions = Vec::from(parsed.telemetry.subscriptions);
		let mut exports = Vec::from(parsed.telemetry.exports);
		let mut prompt_slots = Vec::from(parsed.prompt_slots);
		let mut credentials = Vec::from(parsed.credentials);
		let mut secrets = Vec::from(parsed.secrets);
		let mut workers = Vec::from(parsed.workers);
		let mut placement = Vec::from(parsed.placement);
		let mut agents = Vec::from(parsed.agents);
		let mut lsp_servers = Vec::from(parsed.lsp_servers);
		let mut dap_adapters = Vec::from(parsed.dap_adapters);
		for row in &parsed.ordered {
			if !matches!(
				row.trigger.as_str(),
				"" | "static"
					| "lazy" | "first_reach"
					| "eager-prompt"
					| "before_first_prompt"
					| "eager-ui"
					| "before_ui_input"
			) {
				return Err(de::Error::custom(format!("unknown activation trigger `{}`", row.trigger)));
			}
			match row.kind.as_str() {
				"soft" | "hard" | "tool" => tools.push(row.clone()),
				"hook" => hooks.push(row.clone()),
				"service" => services.push(row.clone()),
				"provider" => providers.push(row.clone()),
				"regime" => regimes.push(row.clone()),
				"command" => commands.push(row.clone()),
				"shortcut" => shortcuts.push(row.clone()),
				"message_renderer" => message_renderers.push(row.clone()),
				"verdict_renderer" | "renderer" => verdict_renderers.push(row.clone()),
				"completion" => completions.push(row.clone()),
				"telemetry" | "telemetry_subscription" => subscriptions.push(row.clone()),
				"telemetry_export" => exports.push(row.clone()),
				"prompt_slot" => prompt_slots.push(row.clone()),
				"credential" => credentials.push(row.clone()),
				"secret" => secrets.push(row.clone()),
				"worker" => workers.push(row.clone()),
				"placement" => placement.push(row.clone()),
				"skills" | "rules" | "context-files" | "prompts" | "themes" => {},
				"agents" => agents.push(row.clone()),
				"lsp-servers" => lsp_servers.push(row.clone()),
				"dap-adapters" => dap_adapters.push(row.clone()),
				kind => {
					return Err(de::Error::custom(format!("unknown static declaration kind `{kind}`")));
				},
			}
		}
		parsed.tools = tools.into_boxed_slice();
		parsed.hooks = hooks.into_boxed_slice();
		parsed.services = services.into_boxed_slice();
		parsed.providers = providers.into_boxed_slice();
		parsed.regimes = regimes.into_boxed_slice();
		parsed.ui.commands = commands.into_boxed_slice();
		parsed.ui.shortcuts = shortcuts.into_boxed_slice();
		parsed.ui.message_renderers = message_renderers.into_boxed_slice();
		parsed.ui.verdict_renderers = verdict_renderers.into_boxed_slice();
		parsed.ui.completions = completions.into_boxed_slice();
		parsed.telemetry.subscriptions = subscriptions.into_boxed_slice();
		parsed.telemetry.exports = exports.into_boxed_slice();
		parsed.prompt_slots = prompt_slots.into_boxed_slice();
		parsed.credentials = credentials.into_boxed_slice();
		parsed.secrets = secrets.into_boxed_slice();
		parsed.workers = workers.into_boxed_slice();
		parsed.placement = placement.into_boxed_slice();
		parsed.agents = agents.into_boxed_slice();
		parsed.lsp_servers = lsp_servers.into_boxed_slice();
		parsed.dap_adapters = dap_adapters.into_boxed_slice();
		Ok(parsed)
	}

	/// Parses only base rows and rows owned by the selected concrete features.
	///
	/// Filtering occurs before a typed table reaches a wire encoder or runtime
	/// registry.
	pub fn from_properties_selected(
		properties: &BTreeMap<Str, serde_json::Value>,
		selected: &[Str],
	) -> Result<Self, serde_json::Error> {
		let selected = selected.iter().map(Str::as_str).collect::<BTreeSet<_>>();
		let mut filtered = properties.clone();
		for value in filtered.values_mut() {
			retain_selected_rows(value, &selected);
		}
		Self::from_properties(&filtered)
	}

	/// Visits every declaration row without changing manifest order within a
	/// declaration class.
	pub fn rows(&self) -> impl Iterator<Item = &StaticDeclaration> {
		self
			.tools
			.iter()
			.chain(self.hooks.iter())
			.chain(self.services.iter())
			.chain(self.providers.iter())
			.chain(self.regimes.iter())
			.chain(self.ui.commands.iter())
			.chain(self.ui.shortcuts.iter())
			.chain(self.ui.message_renderers.iter())
			.chain(self.ui.verdict_renderers.iter())
			.chain(self.ui.completions.iter())
			.chain(self.telemetry.subscriptions.iter())
			.chain(self.telemetry.exports.iter())
			.chain(self.prompt_slots.iter())
			.chain(self.credentials.iter())
			.chain(self.secrets.iter())
			.chain(self.workers.iter())
			.chain(self.placement.iter())
			.chain(self.agents.iter())
			.chain(self.lsp_servers.iter())
			.chain(self.dap_adapters.iter())
	}

	/// Visits every identity with its closed declaration class.
	pub fn identities(&self) -> impl Iterator<Item = (StaticDeclarationClass, &Str)> {
		self
			.tools
			.iter()
			.map(|row| (StaticDeclarationClass::Tool, &row.id))
			.chain(
				self
					.hooks
					.iter()
					.map(|row| (StaticDeclarationClass::Hook, &row.id)),
			)
			.chain(
				self
					.services
					.iter()
					.map(|row| (StaticDeclarationClass::Service, &row.id)),
			)
			.chain(
				self
					.providers
					.iter()
					.map(|row| (StaticDeclarationClass::Provider, &row.id)),
			)
			.chain(
				self
					.regimes
					.iter()
					.map(|row| (StaticDeclarationClass::Regime, &row.id)),
			)
			.chain(
				self
					.ui
					.commands
					.iter()
					.map(|row| (StaticDeclarationClass::UiCommand, &row.id)),
			)
			.chain(
				self
					.ui
					.shortcuts
					.iter()
					.map(|row| (StaticDeclarationClass::UiShortcut, &row.id)),
			)
			.chain(
				self
					.ui
					.message_renderers
					.iter()
					.map(|row| (StaticDeclarationClass::UiMessageRenderer, &row.id)),
			)
			.chain(
				self
					.ui
					.verdict_renderers
					.iter()
					.map(|row| (StaticDeclarationClass::UiVerdictRenderer, &row.id)),
			)
			.chain(
				self
					.ui
					.completions
					.iter()
					.map(|row| (StaticDeclarationClass::UiCompletion, &row.id)),
			)
			.chain(
				self
					.telemetry
					.subscriptions
					.iter()
					.map(|row| (StaticDeclarationClass::TelemetrySubscription, &row.id)),
			)
			.chain(
				self
					.telemetry
					.exports
					.iter()
					.map(|row| (StaticDeclarationClass::TelemetryExport, &row.id)),
			)
			.chain(
				self
					.prompt_slots
					.iter()
					.map(|row| (StaticDeclarationClass::PromptSlot, &row.id)),
			)
			.chain(
				self
					.credentials
					.iter()
					.map(|row| (StaticDeclarationClass::Credential, &row.id)),
			)
			.chain(
				self
					.secrets
					.iter()
					.map(|row| (StaticDeclarationClass::Secret, &row.id)),
			)
			.chain(
				self
					.workers
					.iter()
					.map(|row| (StaticDeclarationClass::Worker, &row.id)),
			)
			.chain(
				self
					.placement
					.iter()
					.map(|row| (StaticDeclarationClass::Placement, &row.id)),
			)
	}

	/// Compares a frozen runtime observation against this authenticated
	/// declaration snapshot. Runtime rows verify drift and never add authority.
	pub fn drift(&self, runtime: &Self) -> StaticDeclarationDrift {
		let expected = self
			.identities()
			.map(|(class, id)| (class, id.clone()))
			.collect::<BTreeSet<_>>();
		let actual = runtime
			.identities()
			.map(|(class, id)| (class, id.clone()))
			.collect::<BTreeSet<_>>();
		StaticDeclarationDrift {
			missing:    expected.difference(&actual).cloned().collect(),
			unexpected: actual.difference(&expected).cloned().collect(),
		}
	}

	/// Returns whether no static CONTROL declaration is present.
	pub fn is_empty(&self) -> bool {
		self.rows().next().is_none()
	}
}

fn retain_selected_rows(value: &mut serde_json::Value, selected: &BTreeSet<&str>) {
	match value {
		serde_json::Value::Array(rows) => {
			rows.retain(|row| {
				row.get("feature")
					.and_then(serde_json::Value::as_str)
					.is_none_or(|feature| selected.contains(feature))
			});
			for row in rows {
				retain_selected_rows(row, selected);
			}
		},
		serde_json::Value::Object(object) => {
			for value in object.values_mut() {
				retain_selected_rows(value, selected);
			}
		},
		_ => {},
	}
}

#[cfg(test)]
mod tests {
	use super::*;
	#[test]
	fn missing_source_policy_uses_latest_scoped_setting() {
		let client = ScopedOverlay {
			scope:   Scope::Client,
			overlay: ExtensionOverlay {
				missing_source: Some(MissingSourcePolicy::Install),
				..ExtensionOverlay::default()
			},
		};
		let workspace = ScopedOverlay {
			scope:   Scope::Workspace,
			overlay: ExtensionOverlay {
				missing_source: Some(MissingSourcePolicy::Skip),
				..ExtensionOverlay::default()
			},
		};
		assert_eq!(effective_missing_source(&[client, workspace]), MissingSourcePolicy::Skip);
		assert_eq!(MissingSourcePolicy::Skip.outcome(), MissingSourceOutcome::Skip);
	}

	#[test]
	fn update_policy_defaults_notify_and_workspace_can_only_disable() {
		let default = effective_updates(None, None).expect("default update policy");
		assert_eq!(default.mode, UpdateMode::Notify);
		assert_eq!(default.interval, UpdateInterval::DEFAULT);

		let client = UpdateOverlay {
			mode:     Some(UpdateMode::Auto),
			interval: Some(UpdateInterval::new(Duration::from_secs(60 * 60)).expect("interval")),
		};
		let workspace = UpdateOverlay { mode: Some(UpdateMode::Off), interval: None };
		let effective =
			effective_updates(Some(&client), Some(&workspace)).expect("workspace reduction");
		assert_eq!(effective.mode, UpdateMode::Off);
		assert_eq!(effective.interval.duration(), Duration::from_secs(60 * 60));

		let escalation = UpdateOverlay { mode: Some(UpdateMode::Auto), interval: None };
		let error = effective_updates(None, Some(&escalation)).expect_err("workspace escalation");
		assert_eq!(error.code, ExtensionCode::EUpdatePolicy);
	}

	#[test]
	fn update_interval_parses_human_units_and_rejects_zero() {
		#[derive(Deserialize)]
		struct Wrapper {
			interval: UpdateInterval,
		}
		let parsed: Wrapper = toml::from_str("interval = \"24h\"").expect("parse interval");
		assert_eq!(parsed.interval.duration(), Duration::from_secs(24 * 60 * 60));
		assert!(toml::from_str::<Wrapper>("interval = \"0s\"").is_err());
	}

	#[test]
	fn p7_negative_dominates_later_positive() {
		let id = sf!("acme.reviewer");
		let client = ScopedOverlay {
			scope:   Scope::Client,
			overlay: ExtensionOverlay {
				disabled: [id.clone()].into_iter().collect(),
				..ExtensionOverlay::default()
			},
		};
		let workspace = ScopedOverlay {
			scope:   Scope::Workspace,
			overlay: ExtensionOverlay {
				enabled: [id.clone()].into_iter().collect(),
				..ExtensionOverlay::default()
			},
		};
		let effective = fold_extension(&[client, workspace], &id);
		assert!(effective.disabled);
		assert!(!effective.enabled);
	}

	#[test]
	fn package_resource_filters_apply_fixed_override_precedence() {
		let filter = PackageResourceFilter {
			skills: Some(vec![
				sf!("skills/**"),
				sf!("!skills/private/**"),
				sf!("+skills/private/keep/SKILL.md"),
				sf!("-skills/private/keep/SKILL.md"),
			]),
			..PackageResourceFilter::default()
		};
		let config =
			EffectiveExtensionConfig { resource_filters: vec![filter], ..Default::default() };

		assert!(config.resource_enabled(ResourceFamily::Skills, "skills/public/SKILL.md", true));
		assert!(!config.resource_enabled(
			ResourceFamily::Skills,
			"skills/private/other/SKILL.md",
			true,
		));
		assert!(!config.resource_enabled(
			ResourceFamily::Skills,
			"skills/private/keep/SKILL.md",
			true,
		));
		assert!(!config.resource_enabled(ResourceFamily::Skills, "outside/SKILL.md", true));
	}

	#[test]
	fn workspace_autoload_false_is_a_delta_over_client_filter() {
		let id = sf!("acme.reviewer");
		let client_filter = PackageResourceFilter {
			skills: Some(vec![sf!("skills/**"), sf!("!skills/private/**")]),
			..PackageResourceFilter::default()
		};
		let workspace_filter = PackageResourceFilter {
			autoload: false,
			skills: Some(vec![sf!("+skills/private/keep/SKILL.md")]),
			..PackageResourceFilter::default()
		};
		let client = ScopedOverlay {
			scope:   Scope::Client,
			overlay: ExtensionOverlay {
				resources: [(id.clone(), client_filter)].into_iter().collect(),
				..ExtensionOverlay::default()
			},
		};
		let workspace = ScopedOverlay {
			scope:   Scope::Workspace,
			overlay: ExtensionOverlay {
				resources: [(id.clone(), workspace_filter)].into_iter().collect(),
				..ExtensionOverlay::default()
			},
		};
		let effective = fold_extension(&[client, workspace], &id);

		assert!(effective.resource_enabled(
			ResourceFamily::Skills,
			"skills/private/keep/SKILL.md",
			true,
		));
		assert!(!effective.resource_enabled(
			ResourceFamily::Skills,
			"skills/private/other/SKILL.md",
			true,
		));
	}

	#[test]
	fn empty_family_pattern_list_disables_that_family() {
		let overlay: ExtensionOverlay = toml::from_str(
			r#"
[resources."acme.reviewer"]
skills = []
"#,
		)
		.expect("resource filter");
		let effective =
			fold_extension(&[ScopedOverlay { scope: Scope::Client, overlay }], &sf!("acme.reviewer"));
		assert!(!effective.resource_enabled(ResourceFamily::Skills, "skills/a/SKILL.md", true));
		assert!(effective.resource_enabled(ResourceFamily::Prompts, "prompts/a.md", false));
	}

	#[test]
	fn regime_declarations_serialize_under_the_clean_class_name() {
		let declarations = StaticDeclarations {
			regimes: vec![StaticDeclaration {
				id: sf!("acme.goal-loop"),
				..StaticDeclaration::default()
			}]
			.into_boxed_slice(),
			..StaticDeclarations::default()
		};

		let encoded = serde_json::to_value(&declarations).expect("serialize declarations");
		assert_eq!(encoded["regimes"][0]["id"], "acme.goal-loop");
	}

	#[test]
	fn ordered_regime_declaration_lowers_and_unknown_kind_is_rejected() {
		let mut properties = BTreeMap::new();
		properties.insert(
			sf!("declarations"),
			serde_json::json!([{"id": "acme.goal-loop", "kind": "regime"}]),
		);
		let declarations =
			StaticDeclarations::from_properties(&properties).expect("lower regime declaration");
		assert_eq!(declarations.regimes.len(), 1);
		let (class, id) = declarations.identities().next().expect("regime identity");
		assert_eq!(class, StaticDeclarationClass::Regime);
		assert_eq!(id.as_str(), "acme.goal-loop");

		properties.insert(
			sf!("declarations"),
			serde_json::json!([{"id": "acme.legacy", "kind": "legacy_control"}]),
		);
		assert!(StaticDeclarations::from_properties(&properties).is_err());
	}
	#[test]
	fn extension_setting_convar_names_are_owner_qualified() {
		assert_eq!(
			extension_setting_convar_name("dev.example.lint", "severity"),
			"ext::dev.example.lint::severity",
		);
	}

	#[test]
	fn resolved_setting_overrides_are_typed_filtered_and_strict() {
		let manifest = DeploymentManifest::parse(
			r#"
id = "demo"

[settings.verbose]
type = "boolean"
default = false

[settings.limit]
type = "number"
default = 1
min = 1
max = 10

[settings.mode]
type = "enum"
values = ["safe", "fast"]
default = "safe"
"#,
		)
		.expect("settings manifest");
		let mut resolved =
			resolve_extension_settings(&manifest, &BTreeMap::new(), &[]).expect("defaults");
		let overrides = [
			CliSettingOverride::parse("other.verbose=true").expect("other override"),
			CliSettingOverride::parse("demo.verbose=true").expect("boolean override"),
			CliSettingOverride::parse("demo.limit=8.5").expect("number override"),
			CliSettingOverride::parse("demo.mode=fast").expect("enum override"),
		];
		apply_resolved_setting_overrides("demo", &manifest.settings, &mut resolved, &overrides)
			.expect("typed overrides");
		assert_eq!(resolved["verbose"], serde_json::json!(true));
		assert_eq!(resolved["limit"], serde_json::json!(8.5));
		assert_eq!(resolved["mode"], serde_json::json!("fast"));

		let error = apply_resolved_setting_overrides("demo", &manifest.settings, &mut resolved, &[
			CliSettingOverride::parse("demo.unknown=true").expect("unknown override"),
		])
		.expect_err("unknown setting");
		assert!(error.to_string().contains("demo"));
		assert!(error.to_string().contains("unknown"));

		assert!(
			apply_resolved_setting_overrides("demo", &manifest.settings, &mut resolved, &[
				CliSettingOverride::parse("demo.mode=invalid").expect("invalid enum")
			],)
			.is_err()
		);
	}

	#[test]
	fn cli_setting_override_wins_and_invalid_keys_name_the_extension() {
		let manifest = DeploymentManifest::parse(
			r#"
id = "demo"

[settings.verbose]
type = "boolean"
default = false

[settings.limit]
type = "number"
default = 1
min = 1
max = 10
"#,
		)
		.expect("settings manifest");
		let configured = BTreeMap::from([
			(sf!("verbose"), toml::Value::Boolean(false)),
			(sf!("limit"), toml::Value::Integer(4)),
		]);
		let overrides = [
			CliSettingOverride::parse("demo.verbose=true").expect("boolean override"),
			CliSettingOverride::parse("demo.limit=8").expect("number override"),
		];
		let settings =
			resolve_extension_settings(&manifest, &configured, &overrides).expect("resolved");
		assert_eq!(settings["verbose"], serde_json::json!(true));
		assert_eq!(settings["limit"], serde_json::json!(8));

		let error = resolve_extension_settings(&manifest, &configured, &[CliSettingOverride::parse(
			"demo.unknown=true",
		)
		.expect("generic parse")])
		.expect_err("unknown key");
		assert!(error.to_string().contains("demo"));
		assert!(error.to_string().contains("unknown"));
	}

	#[test]
	fn manifest_admission_rejects_composer_shape_declaration_kind() {
		let mut properties = BTreeMap::new();
		properties.insert(
			sf!("declarations"),
			serde_json::json!([{"id": "acme.dock", "kind": "composer-shape"}]),
		);

		assert!(StaticDeclarations::from_properties(&properties).is_err());
	}

	#[test]
	fn install_feature_brackets_are_canonical() {
		let absent = InstallSpec::parse("index:main/pkg@1").unwrap();
		assert_eq!(absent.selection, FeatureSelection::Absent);
		let none = InstallSpec::parse("index:main/pkg[]@1").unwrap();
		assert_eq!(none.source, "index:main/pkg@1");
		assert_eq!(none.selection, FeatureSelection::None);
		assert_eq!(
			InstallSpec::parse("index:main/pkg[*]@1").unwrap().selection,
			FeatureSelection::All
		);
		assert_eq!(
			InstallSpec::parse("index:main/pkg[b, a, a]@1")
				.unwrap()
				.selection,
			FeatureSelection::Named(vec![sf!("a"), sf!("b")])
		);
		assert_eq!(
			SourceSpec::parse_install("/tmp/acme").unwrap().0,
			SourceSpec::Path(PathBuf::from("/tmp/acme"))
		);
		assert_eq!(
			SourceSpec::parse_install("./acme").unwrap().0,
			SourceSpec::Path(PathBuf::from("./acme"))
		);
		assert_eq!(SourceSpec::parse_install("acme").unwrap().0, SourceSpec::Index {
			index:        String::new(),
			distribution: sf!("acme"),
		});
	}

	#[test]
	fn feature_projection_filters_rows_and_changes_only_selected_digests() {
		let manifest = DeploymentManifest {
			capabilities: vec![sf!("env.base")],
			features: [(sf!("review"), FeatureManifest {
				entry: sf!("acme.review"),
				requires: vec![sf!("unidiff>=0.7")],
				capabilities: vec![sf!("env.docs.read")],
				..FeatureManifest::default()
			})]
			.into_iter()
			.collect(),
			declarations: vec![
				StaticDeclaration {
					id: sf!("base"),
					kind: sf!("soft"),
					module: sf!("acme.base"),
					..StaticDeclaration::default()
				},
				StaticDeclaration {
					feature: Some(sf!("review")),
					id: sf!("review"),
					kind: sf!("soft"),
					module: sf!("acme.review"),
					..StaticDeclaration::default()
				},
			],
			..DeploymentManifest::default()
		};
		let disabled = manifest.project(&[]).unwrap();
		let enabled = manifest.project(&[sf!("review")]).unwrap();
		assert_eq!(disabled.declarations.len(), 1);
		assert_eq!(enabled.declarations.len(), 2);
		assert_ne!(disabled.declaration_digest, enabled.declaration_digest);
		assert_ne!(disabled.capability_digest, enabled.capability_digest);
		assert_eq!(disabled.manifest_capability_digest, enabled.manifest_capability_digest);
		assert!(disabled.requires.is_empty());
		assert_eq!(enabled.requires, vec![sf!("unidiff>=0.7")]);
		let properties = [(
			sf!("declarations"),
			serde_json::json!([
				{"id":"base","kind":"soft"},
				{"id":"review","kind":"soft","feature":"review"}
			]),
		)]
		.into_iter()
		.collect();
		let lowered = StaticDeclarations::from_properties_selected(&properties, &[]).unwrap();
		assert_eq!(lowered.tools.len(), 1);
		assert_eq!(lowered.tools[0].id, "base");
	}

	#[test]
	fn static_slot_rows_require_exact_shape_containment_and_record_coverage() {
		let manifest = DeploymentManifest {
			declarations: vec![
				StaticDeclaration {
					kind: sf!("agents"),
					path: Some(sf!("acme/agents/*.md")),
					metadata: [(sf!("format"), serde_json::json!("omp-agent-markdown"))]
						.into_iter()
						.collect(),
					..StaticDeclaration::default()
				},
				StaticDeclaration {
					kind: sf!("lsp-servers"),
					path: Some(sf!("acme/catalog/lsp.json")),
					metadata: [(sf!("format"), serde_json::json!("json"))]
						.into_iter()
						.collect(),
					..StaticDeclaration::default()
				},
				StaticDeclaration {
					kind: sf!("dap-adapters"),
					path: Some(sf!("acme/catalog/dap.yaml")),
					metadata: [(sf!("format"), serde_json::json!("yaml"))]
						.into_iter()
						.collect(),
					..StaticDeclaration::default()
				},
			],
			..DeploymentManifest::default()
		};
		manifest.validate().unwrap();
		manifest
			.validate_record([
				"acme/agents/reviewer.md",
				"acme/catalog/lsp.json",
				"acme/catalog/dap.yaml",
			])
			.unwrap();
		let mut escaping = manifest.clone();
		escaping.declarations[0].path = Some(sf!("../agents/*.md"));
		assert!(escaping.validate().is_err());
		let mut malformed = manifest;
		malformed.declarations[1].metadata.clear();
		assert!(malformed.validate().is_err());
	}
}
