//! Typed, revisioned tool contracts for the agent/environment boundary.
//!
//! Execution is deliberately absent from this crate. A tool keeps concrete
//! parameter and result types until [`Registry::register`], while prompt
//! projection and revision lifting remain deterministic shared code.

mod device_path;
mod diag;
mod incoming;
mod registry;
pub mod render;
mod spec_generated;

use std::{
	collections::BTreeMap,
	fmt::{self, Display},
	future::Future,
	io,
	io::Write,
	mem,
	mem::size_of,
	str,
	sync::Arc,
};

use bytes::Bytes;
pub use device_path::{DevicePath, DevicePathError};
pub use diag::{Diag, DiagEnvelope, DiagKind, Omitted, Severity, Unit};
use futures::Stream;
pub use incoming::{
	CommitError, FinalizedArgs, IncomingCursor, IncomingParams, Interrupt, InterruptWaitError,
	InterruptibleParams, InvocationEvent, InvocationFeed, InvocationSendError, ParamError,
};
pub use omp_core::slopjson::{PullMode, Pulled, PulledKind, PulledValueKind};
use omp_core::{Hash32, InvocationPhase, SparseMap, Str, sf};
pub use omp_proto::inference::v1::{Fallback, InvokeInput};
use omp_proto::policy::v1;
pub use registry::{
	AvailabilityDelta, Claim, Claims, ConstraintDisposition, DeviceMetadata, DeviceTarget, ErasedEv,
	ErasedOutcome, ErasedStream, GoalToolState, HostToolExecutor, HostToolInvocation,
	HostToolResult, HostToolSpec, HostToolUpdateSink, InclusionPolicy, LeafCatalogSnapshot,
	LeafOwner, LeafReplacementError, LeafReplacementRegistry, LeafVersion, LoweredTool,
	LoweringCaps, MemoryToolState, MountedDevice, Precedence, ProjectedCall, ProjectedVerdict,
	ProjectionKey, ProjectionRequest, PublishedLeaf, Registry, RegistryError, RegistryLeaf,
	ShadowClaim, ToolLocus, ToolPromptEntry, ToolPromptProjection, ToolRoute, WorkerSiteKind,
};
use schemars::generate::SchemaSettings;
use serde::{Deserialize, Serialize, de, de::DeserializeOwned};
use smallvec::SmallVec;
pub use spec_generated::{
	CallbackAbi, PhaseLegalityRow, RuntimeDurationMetadata, RuntimeSymbolSpec, operation_spec,
	phase_legality_matrix, runtime_duration_metadata, runtime_symbols,
};
use thiserror::Error;

/// Failure while adding protocol-owned fields to a model-facing tool schema.
#[derive(Debug, Error)]
pub enum ProtocolSchemaError {
	/// The schema bytes were not valid JSON.
	#[error("tool parameter schema is invalid JSON")]
	Json(#[from] serde_json::Error),
	/// Tool parameters must be described by an object schema.
	#[error("tool parameter schema must have `type: \"object\"`")]
	Object,
	/// The schema's `properties` keyword was present with the wrong shape.
	#[error("tool parameter schema `properties` must be an object")]
	Properties,
	/// The schema's `required` keyword was present with the wrong shape.
	#[error("tool parameter schema `required` must be an array of strings")]
	Required,
}

/// Injects the caller-owned fields shared by every model-facing tool schema.
///
/// `i` is always the first required property. `notrunc` is always optional;
/// omitting it retains the default central output bound. Setting it requests
/// complete inline output only up to the runtime's fixed security ceiling;
/// larger results remain complete in the returned artifact.
pub fn inject_protocol_schema(schema: &[u8]) -> Result<Bytes, ProtocolSchemaError> {
	let mut value = serde_json::from_slice(schema)?;
	inject_protocol_fields(&mut value)?;
	Ok(Bytes::from(serde_json::to_vec(&value)?))
}

fn inject_protocol_fields(value: &mut serde_json::Value) -> Result<(), ProtocolSchemaError> {
	let object = value.as_object_mut().ok_or(ProtocolSchemaError::Object)?;
	if object.get("type").and_then(serde_json::Value::as_str) != Some("object") {
		return Err(ProtocolSchemaError::Object);
	}
	let properties = object
		.entry("properties")
		.or_insert_with(|| serde_json::Value::Object(serde_json::Map::new()))
		.as_object_mut()
		.ok_or(ProtocolSchemaError::Properties)?;
	properties.insert(
		"i".to_owned(),
		serde_json::json!({
			"type": "string",
			"description": "Short present-participle intent for this call."
		}),
	);
	properties.insert(
		"notrunc".to_owned(),
		serde_json::json!({
			"type": "boolean",
			"description": "Prefer complete output inline up to the host security ceiling; overflow or transport backpressure remains available through its artifact."
		}),
	);
	let required = object
		.entry("required")
		.or_insert_with(|| serde_json::Value::Array(Vec::new()))
		.as_array_mut()
		.ok_or(ProtocolSchemaError::Required)?;
	if required.iter().any(|name| !name.is_string()) {
		return Err(ProtocolSchemaError::Required);
	}
	required.retain(|name| !matches!(name.as_str(), Some("i" | "notrunc")));
	required.insert(0, serde_json::Value::String("i".to_owned()));
	Ok(())
}

/// Generates the compact, deterministic JSON Schema exposed to models for `T`.
///
/// Subschemas are inlined and generator metadata is omitted. Schemas describe
/// deserialization, matching how tool parameters are consumed, then receive
/// the shared required `i` and optional `notrunc` protocol fields.
pub fn schema<T: schemars::JsonSchema>() -> Bytes {
	let generator = SchemaSettings::draft2020_12()
		.with(|settings| {
			settings.inline_subschemas = true;
			settings.meta_schema = None;
		})
		.for_deserialize()
		.into_generator();
	let mut root = generator.into_root_schema_for::<T>();
	root.remove("$schema");
	root.remove("title");
	let mut value =
		serde_json::to_value(root.as_value()).expect("schemars-generated JSON Schema must serialize");
	inject_protocol_fields(&mut value)
		.expect("schemars-generated tool parameter schemas must describe an object");
	Bytes::from(
		serde_json::to_vec(&value)
			.expect("schemars-generated JSON Schema must serialize to compact JSON"),
	)
}

/// Deserializes a tool's parameters after removing the protocol-owned fields.
///
/// `i` and `notrunc` remain in the canonical invocation arguments for
/// journaling and dispatch policy, but are not fields each executor must
/// duplicate in its domain-specific parameter type.
pub fn decode_params<T: DeserializeOwned>(json: &str) -> Result<T, serde_json::Error> {
	let mut value = serde_json::from_str::<serde_json::Value>(json)?;
	if let Some(object) = value.as_object_mut() {
		object.remove("i");
		object.remove("notrunc");
	}
	serde_json::from_value(value)
}

/// Namespaced thread-item property carrying a committed tool revision.
pub const TOOL_REV_PROP: &str = "omp/tool-rev";

/// Canonical courtesy-interrupt grace used when runtime settings omit it.
pub const DEFAULT_INTERRUPT_GRACE: omp_core::Duration =
	omp_core::Duration::new(150, omp_core::DurationUnit::Milliseconds);

/// Maximum number of simultaneous host pull requests for one invocation.
pub const MAX_PENDING_PULLS: usize = 1;

/// Model-facing registration surface for a tool declaration.
#[derive(
	Clone,
	Copy,
	Debug,
	Deserialize,
	Eq,
	Hash,
	PartialEq,
	Serialize,
	strum::Display,
	strum::EnumString,
	strum::IntoStaticStr,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum Presentation {
	/// A stable schema slot advertised directly to the model.
	Slot,
	/// A catalog entry reached through the dynamic device tool.
	Device,
	/// An invokable declaration omitted until a session policy selects it.
	Hidden,
}
/// Session policy deciding whether the model receives tool slots, the dynamic
/// device transport, or both.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Deserialize,
	Eq,
	Hash,
	PartialEq,
	Serialize,
	strum::Display,
	strum::EnumString,
	strum::IntoStaticStr,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum ToolsPolicy {
	/// Advertise slots and the dynamic device transport.
	#[default]
	Auto,
	/// Advertise only the dynamic device transport.
	DeviceOnly,
	/// Advertise only tool slots.
	ToolOnly,
}

/// Batch scheduling constraint declared by one tool revision.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Deserialize,
	Eq,
	PartialEq,
	Serialize,
	strum::Display,
	strum::EnumString,
	strum::IntoStaticStr,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum ExecutionMode {
	/// Calls may execute concurrently with sibling calls.
	#[default]
	Parallel,
	/// Any batch containing this tool executes in issued order.
	Sequential,
}

/// One argument-dialect revision within a revision family.
#[derive(Clone, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
pub struct Rev {
	/// Argument-dialect family, such as `hl` or `rep`.
	pub family: Str,
	/// Monotonic revision within `family`.
	pub n:      u16,
}

impl Display for Rev {
	fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
		if self.family.is_empty() {
			write!(f, "{}", self.n)
		} else {
			write!(f, "{}.{}", self.family, self.n)
		}
	}
}

/// Failure to parse a canonical `family.n` or bare `n` revision stamp.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
#[error("invalid tool revision: {value}")]
pub struct RevParseError {
	/// Rejected revision text.
	pub value: Str,
}

impl str::FromStr for Rev {
	type Err = RevParseError;

	fn from_str(value: &str) -> Result<Self, Self::Err> {
		let invalid = || RevParseError { value: Str::new(value) };
		let (family, number) = match value.split_once('.') {
			Some((family, number))
				if !family.is_empty() && !number.is_empty() && !number.contains('.') =>
			{
				(family, number)
			},
			Some(_) => return Err(invalid()),
			None => ("", value),
		};
		if number.is_empty() || !number.bytes().all(|byte| byte.is_ascii_digit()) {
			return Err(invalid());
		}
		let n = number.parse().map_err(|_| invalid())?;
		Ok(Self { family: Str::new(family), n })
	}
}

/// Canonical non-negative US-dollar amount stored exactly as nano-USD.
#[derive(Clone, Copy, Debug, Default, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct Usd(u64);

impl Usd {
	/// Zero dollars.
	pub const ZERO: Self = Self(0);

	/// Creates an exact amount from nano-US dollars.
	pub const fn from_nanos(nanos: u64) -> Self {
		Self(nanos)
	}

	/// Returns the exact nano-US-dollar magnitude.
	pub const fn as_nanos(self) -> u64 {
		self.0
	}
}

/// Invalid or non-canonical decimal US-dollar text.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
#[error("invalid canonical USD amount: {value}")]
pub struct UsdParseError {
	/// Rejected spelling.
	pub value: Str,
}

impl str::FromStr for Usd {
	type Err = UsdParseError;

	fn from_str(value: &str) -> Result<Self, Self::Err> {
		let invalid = || UsdParseError { value: Str::new(value) };
		let (whole, fraction) = match value.split_once('.') {
			Some((_whole, "")) => return Err(invalid()),
			Some((whole, fraction)) => (whole, fraction),
			None => (value, ""),
		};
		if whole.is_empty()
			|| !whole.bytes().all(|byte| byte.is_ascii_digit())
			|| (whole.len() > 1 && whole.starts_with('0'))
			|| fraction.len() > 9
			|| (!fraction.is_empty()
				&& (!fraction.bytes().all(|byte| byte.is_ascii_digit()) || fraction.ends_with('0')))
		{
			return Err(invalid());
		}
		let whole: u64 = whole.parse().map_err(|_| invalid())?;
		let scale = 10_u64.pow(u32::try_from(9 - fraction.len()).expect("fraction length bounded"));
		let fraction = if fraction.is_empty() {
			0
		} else {
			fraction
				.parse::<u64>()
				.map_err(|_| invalid())?
				.checked_mul(scale)
				.ok_or_else(invalid)?
		};
		let nanos = whole
			.checked_mul(1_000_000_000)
			.and_then(|whole| whole.checked_add(fraction))
			.ok_or_else(invalid)?;
		Ok(Self(nanos))
	}
}

impl Display for Usd {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		let whole = self.0 / 1_000_000_000;
		let fraction = self.0 % 1_000_000_000;
		if fraction == 0 {
			return whole.fmt(formatter);
		}
		let mut digits = format!("{fraction:09}");
		while digits.ends_with('0') {
			digits.pop();
		}
		write!(formatter, "{whole}.{digits}")
	}
}

impl Serialize for Usd {
	fn serialize<S: serde::Serializer>(&self, serializer: S) -> Result<S::Ok, S::Error> {
		serializer.collect_str(self)
	}
}

impl<'de> Deserialize<'de> for Usd {
	fn deserialize<D: serde::Deserializer<'de>>(deserializer: D) -> Result<Self, D::Error> {
		let value = Str::deserialize(deserializer)?;
		value.parse().map_err(de::Error::custom)
	}
}

/// Maximum declared document authority for one tool revision.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct DocEffects {
	/// Whether document reads are permitted.
	pub read:        bool,
	/// Exact declared write-glob ceilings.
	pub write_globs: Arc<[Str]>,
}

impl DocEffects {
	/// Returns whether this document domain grants no authority.
	pub fn is_empty(&self) -> bool {
		!self.read && self.write_globs.is_empty()
	}
}

/// Maximum declared process authority for one tool revision.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct ExecEffects {
	/// Exact executable names permitted by the declaration.
	pub commands: Arc<[Str]>,
	/// Whether outbound network access is permitted.
	pub network:  bool,
}

impl ExecEffects {
	/// Returns whether this process domain grants no authority.
	pub fn is_empty(&self) -> bool {
		self.commands.is_empty() && !self.network
	}
}

/// Maximum declared inference spend for one tool revision.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct InferenceEffects {
	/// Maximum provider requests.
	pub max_requests: u32,
	/// Maximum exact provider spend.
	pub max_usd:      Usd,
}

impl InferenceEffects {
	/// Returns whether this inference domain grants no authority.
	pub const fn is_empty(&self) -> bool {
		self.max_requests == 0 && self.max_usd.as_nanos() == 0
	}
}
/// Maximum declared native desktop authority for one tool revision.
#[derive(Clone, Copy, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct DesktopEffects {
	/// Whether framebuffer capture and display/window enumeration are permitted.
	pub capture:       bool,
	/// Whether accessibility-tree reads are permitted.
	pub accessibility: bool,
	/// Whether pointer, keyboard, focus, and accessibility mutation are
	/// permitted.
	pub input:         bool,
}

impl DesktopEffects {
	/// Returns whether this desktop domain grants no authority.
	pub const fn is_empty(&self) -> bool {
		!self.capture && !self.accessibility && !self.input
	}
}

/// Maximum declared effect envelope for one tool revision.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct Effects {
	/// Document authority, absent when the domain is denied.
	pub documents: Option<DocEffects>,
	/// Process authority, absent when the domain is denied.
	pub exec:      Option<ExecEffects>,
	/// Inference authority, absent when the domain is denied.
	pub inference: Option<InferenceEffects>,
	/// Native desktop authority, absent when the domain is denied.
	pub desktop:   Option<DesktopEffects>,
	/// Maximum spawned subagents.
	pub subagents: u32,
}

const _: () = assert!(size_of::<Effects>() <= 96, "Effects must stay compact");

/// Returns whether an effect envelope may mutate environment-owned state.
#[must_use]
pub fn effects_mutate_environment(effects: &Effects) -> bool {
	effects.mutates_environment()
}

impl Effects {
	/// Empty deny-all envelope for an explicitly effect-free tool.
	pub const fn empty() -> Self {
		Self { documents: None, exec: None, inference: None, desktop: None, subagents: 0 }
	}

	/// Returns whether `self` grants no authority.
	pub fn is_empty(&self) -> bool {
		self.documents.as_ref().is_none_or(DocEffects::is_empty)
			&& self.exec.as_ref().is_none_or(ExecEffects::is_empty)
			&& self
				.inference
				.as_ref()
				.is_none_or(InferenceEffects::is_empty)
			&& self.desktop.as_ref().is_none_or(DesktopEffects::is_empty)
			&& self.subagents == 0
	}

	/// Returns whether this envelope may mutate environment-owned state.
	pub fn mutates_environment(&self) -> bool {
		self
			.documents
			.as_ref()
			.is_some_and(|documents| !documents.write_globs.is_empty())
			|| self.exec.as_ref().is_some_and(|exec| !exec.is_empty())
			|| self.subagents != 0
	}

	/// Returns whether this envelope is a conservative subset of `maximum`.
	///
	/// Executable `*` is the explicit unrestricted ceiling. Write-glob
	/// narrowing recognizes exact ceilings, `**`, and lexical descendants of a
	/// `path/**` ceiling; uncertain glob-language implication fails closed.
	pub fn is_subset_of(&self, maximum: &Self) -> bool {
		self.subagents <= maximum.subagents
			&& optional_subset(
				self.documents.as_ref(),
				maximum.documents.as_ref(),
				DocEffects::is_empty,
				|value, max| {
					(!value.read || max.read)
						&& value.write_globs.iter().all(|glob| {
							max.write_globs
								.iter()
								.any(|ceiling| glob_is_subset(glob, ceiling))
						})
				},
			) && optional_subset(
			self.exec.as_ref(),
			maximum.exec.as_ref(),
			ExecEffects::is_empty,
			|value, max| {
				(!value.network || max.network)
					&& value.commands.iter().all(|command| {
						max.commands
							.iter()
							.any(|ceiling| ceiling == "*" || ceiling == command)
					})
			},
		) && optional_subset(
			self.inference.as_ref(),
			maximum.inference.as_ref(),
			InferenceEffects::is_empty,
			|value, max| value.max_requests <= max.max_requests && value.max_usd <= max.max_usd,
		) && optional_subset(
			self.desktop.as_ref(),
			maximum.desktop.as_ref(),
			DesktopEffects::is_empty,
			|value, max| {
				(!value.capture || max.capture)
					&& (!value.accessibility || max.accessibility)
					&& (!value.input || max.input)
			},
		)
	}

	/// Accepts an invocation envelope only when it narrows this declaration.
	pub fn narrow(&self, requested: Self) -> Option<Self> {
		requested.is_subset_of(self).then_some(requested)
	}
}

fn glob_is_subset(value: &str, maximum: &str) -> bool {
	if value == maximum || maximum == "**" {
		return true;
	}
	if value.split('/').any(|component| component == "..") {
		return false;
	}
	maximum.strip_suffix("/**").is_some_and(|prefix| {
		value
			.strip_prefix(prefix)
			.is_some_and(|suffix| suffix.starts_with('/'))
	})
}

fn optional_subset<T>(
	value: Option<&T>,
	maximum: Option<&T>,
	is_empty: impl FnOnce(&T) -> bool,
	check: impl FnOnce(&T, &T) -> bool,
) -> bool {
	match (value, maximum) {
		(None, _) => true,
		(Some(value), Some(maximum)) => check(value, maximum),
		(Some(value), None) => is_empty(value),
	}
}

/// Invalid effect envelope received at a transport boundary.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum EffectsWireError {
	/// Inference spend was not canonical decimal USD.
	#[error(transparent)]
	Usd(#[from] UsdParseError),
}

impl From<&Effects> for v1::EffectEnvelope {
	fn from(value: &Effects) -> Self {
		Self {
			documents: value.documents.as_ref().map(|documents| v1::DocEffects {
				read:        documents.read,
				write_globs: documents
					.write_globs
					.iter()
					.map(|glob| glob.as_str().to_owned())
					.collect(),
				props:       None,
			}),
			exec:      value.exec.as_ref().map(|exec| v1::ExecEffects {
				commands: exec
					.commands
					.iter()
					.map(|command| command.as_str().to_owned())
					.collect(),
				network:  exec.network,
				props:    None,
			}),
			inference: value
				.inference
				.as_ref()
				.map(|inference| v1::InferenceEffects {
					max_requests: inference.max_requests,
					max_usd:      inference.max_usd.to_string(),
					props:        None,
				}),
			desktop:   value.desktop.as_ref().map(|desktop| v1::DesktopEffects {
				capture:       desktop.capture,
				accessibility: desktop.accessibility,
				input:         desktop.input,
				props:         None,
			}),
			subagents: value.subagents,
			props:     None,
		}
	}
}

impl TryFrom<&v1::EffectEnvelope> for Effects {
	type Error = EffectsWireError;

	fn try_from(value: &v1::EffectEnvelope) -> Result<Self, Self::Error> {
		Ok(Self {
			documents: value.documents.as_ref().map(|documents| DocEffects {
				read:        documents.read,
				write_globs: Arc::from(
					documents
						.write_globs
						.iter()
						.map(|glob| Str::new(glob.as_str()))
						.collect::<Vec<_>>(),
				),
			}),
			exec:      value.exec.as_ref().map(|exec| ExecEffects {
				commands: Arc::from(
					exec
						.commands
						.iter()
						.map(|command| Str::new(command.as_str()))
						.collect::<Vec<_>>(),
				),
				network:  exec.network,
			}),
			inference: value
				.inference
				.as_ref()
				.map(|inference| -> Result<InferenceEffects, EffectsWireError> {
					Ok(InferenceEffects {
						max_requests: inference.max_requests,
						max_usd:      inference.max_usd.parse()?,
					})
				})
				.transpose()?,
			desktop:   value.desktop.as_ref().map(|desktop| DesktopEffects {
				capture:       desktop.capture,
				accessibility: desktop.accessibility,
				input:         desktop.input,
			}),
			subagents: value.subagents,
		})
	}
}

/// Durable identity of a tool call in a transcript.
#[derive(Clone, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
pub struct ToolIdentity {
	/// Stable model-facing name.
	pub name: Str,
	/// Argument and rendering revision.
	pub rev:  Rev,
}

/// Static description of one tool revision.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ToolSpec {
	/// Stable wire name exposed to models.
	pub name:            Str,
	/// Transcript revision.
	pub rev:             Rev,
	/// Model-facing purpose.
	pub description:     Str,
	/// Complete JSON Schema bytes.
	pub schema:          Bytes,
	/// Requested constrained-sampling behavior.
	pub constraint:      Constraint,
	/// Maximum declared effect envelope; empty grants no authority.
	pub effects:         Effects,
	/// Content identity of the code that produces model-facing projections.
	///
	/// Native registrations use their crate/build identity. Supervised workers
	/// use the frozen module-content hash supplied at registration.
	pub projection_code: [u8; 32],
}

/// Computes a native projection-code identity without allocating.
///
/// `module_source` must contain the source bytes that implement the tool's
/// projection. Package identity separates equal source shipped by unrelated
/// crates, while source bytes move the identity when projection code changes.
pub fn native_projection_code(
	crate_name: &str,
	crate_version: &str,
	module_source: &[u8],
) -> Hash32 {
	let mut hasher = Hash32::hasher();
	for field in [crate_name.as_bytes(), crate_version.as_bytes(), module_source] {
		hasher.update((field.len() as u64).to_le_bytes());
		hasher.update(field);
	}
	hasher.finalize()
}

impl ToolSpec {
	/// Returns the durable `(name, family/n)` identity.
	pub fn identity(&self) -> ToolIdentity {
		ToolIdentity { name: self.name.clone(), rev: self.rev.clone() }
	}
}

/// Requested argument-sampling constraint.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Constraint {
	/// Ordinary lenient JSON arguments.
	None,
	/// Strict JSON Schema sampling when supported.
	Schema {
		/// Relative request priority; larger values are preferred during
		/// route-budget arbitration.
		priority:       u8,
		/// Required behavior when the selected route lacks strict sampling.
		#[serde(default)]
		on_unsupported: Fallback,
	},
	/// Freeform input constrained by a grammar.
	///
	/// The tool is offered as raw grammar-constrained text on grammar-capable
	/// transports and as its ordinary JSON schema everywhere else; recovery
	/// canonicalizes freeform text into the schema's `input` string property.
	/// Registration therefore rejects grammar declarations whose schema lacks
	/// one ([`RegistryError::GrammarInputProperty`]).
	Grammar {
		/// Grammar language.
		syntax:         GrammarSyntax,
		/// Complete grammar definition.
		definition:     Str,
		/// Relative request priority; larger values are preferred during
		/// route-budget arbitration.
		priority:       u8,
		/// Required behavior when the selected route lacks this grammar.
		#[serde(default)]
		on_unsupported: Fallback,
	},
}

/// Grammar languages represented in the model catalog.
#[derive(
	Clone,
	Copy,
	Debug,
	Deserialize,
	Eq,
	PartialEq,
	Serialize,
	strum::Display,
	strum::EnumString,
	strum::IntoStaticStr,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum GrammarSyntax {
	/// Lark grammar.
	Lark,
	/// Regular expression.
	Regex,
	/// Extended Backus-Naur form.
	Ebnf,
}

/// Argument dialect used by the live tool revision.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Deserialize,
	Eq,
	Hash,
	PartialEq,
	Serialize,
	strum::Display,
	strum::EnumString,
	strum::IntoStaticStr,
)]
#[repr(u8)]
pub enum Dialect {
	/// Hashline's snapshot-anchored edit language.
	#[serde(rename = "hl")]
	#[strum(serialize = "hl")]
	Hashline,
	/// Old-text/new-text replacement.
	#[serde(rename = "rep")]
	#[strum(serialize = "rep")]
	Replace,
	/// JSON patch-operation input.
	#[serde(rename = "patch")]
	#[strum(serialize = "patch")]
	Patch,
	/// Codex apply-patch/unified-hunk envelope input.
	#[serde(rename = "apply_patch")]
	#[strum(serialize = "apply_patch")]
	ApplyPatch,
	/// Sloppy match/rewrite input.
	#[serde(rename = "sloppy")]
	#[strum(serialize = "sloppy")]
	Sloppy,
	/// A vendor-trained or otherwise unclassified native dialect.
	#[default]
	#[serde(rename = "native")]
	#[strum(serialize = "native")]
	Native,
}

impl Dialect {
	/// Classifies a revision family without consulting model names.
	pub fn for_rev(rev: &Rev) -> Self {
		rev.family.parse().unwrap_or_default()
	}
}

/// Coarse, ordered model capability band used only for projection verbosity.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Deserialize,
	Eq,
	Hash,
	Ord,
	PartialEq,
	PartialOrd,
	Serialize,
	strum::Display,
	strum::EnumString,
	strum::IntoStaticStr,
)]
#[repr(u8)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum ModelClass {
	/// Embedded classification or titling model.
	Tiny     = 0,
	/// Small local model.
	Small    = 1,
	/// Mainstream hosted model and the conservative default.
	#[default]
	Standard = 2,
	/// Long-context flagship model.
	Frontier = 3,
}

/// Model-wide projection inputs shared by every tool in one request.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct CapsBase {
	/// Maximum number of parts a tool may emit.
	pub maximum_parts:      u16,
	/// Maximum aggregate UTF-8 text bytes.
	pub maximum_text_bytes: u32,
	/// Whether blob-backed media parts may be exposed to the model.
	pub media:              bool,
	/// Catalog-derived model capability band.
	pub model_class:        ModelClass,
}

/// Deterministic model-facing projection budget for one live tool revision.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PromptCaps {
	/// Maximum number of parts a tool may emit.
	pub maximum_parts:      u16,
	/// Maximum aggregate UTF-8 text bytes.
	pub maximum_text_bytes: u32,
	/// Whether blob-backed media parts may be exposed to the model.
	pub media:              bool,
	/// Argument dialect derived from the live revision family.
	#[serde(default)]
	pub dialect:            Dialect,
	/// Catalog-derived model capability band.
	#[serde(default)]
	pub model_class:        ModelClass,
}

impl PromptCaps {
	/// Combines model-wide limits with the dialect of `live_rev`.
	pub fn for_tool(base: CapsBase, live_rev: &Rev) -> Self {
		Self {
			maximum_parts:      base.maximum_parts,
			maximum_text_bytes: base.maximum_text_bytes,
			media:              base.media,
			dialect:            Dialect::for_rev(live_rev),
			model_class:        base.model_class,
		}
	}

	/// Returns the model-wide inputs independent of a tool revision.
	pub const fn base(self) -> CapsBase {
		CapsBase {
			maximum_parts:      self.maximum_parts,
			maximum_text_bytes: self.maximum_text_bytes,
			media:              self.media,
			model_class:        self.model_class,
		}
	}
}

/// Whether an operation leaves durable state.
#[derive(
	Clone,
	Copy,
	Debug,
	Deserialize,
	Eq,
	Hash,
	PartialEq,
	Serialize,
	strum::Display,
	strum::EnumString,
	strum::IntoStaticStr,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum Durability {
	/// No durable state is promised.
	Ephemeral,
	/// The operation acknowledges a durable state transition.
	Durable,
}

/// Cost class charged by an operation.
#[derive(
	Clone,
	Copy,
	Debug,
	Deserialize,
	Eq,
	Hash,
	PartialEq,
	Serialize,
	strum::Display,
	strum::EnumString,
	strum::IntoStaticStr,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum CostClass {
	/// No separately metered resource is consumed.
	None,
	/// A bounded local or quota-metered resource is consumed.
	Metered,
	/// A paid upstream resource may be consumed.
	Paid,
}

/// Runtime authority responsible for enforcing an operation specification.
#[derive(
	Clone,
	Copy,
	Debug,
	Deserialize,
	Eq,
	Hash,
	PartialEq,
	Serialize,
	strum::Display,
	strum::EnumString,
	strum::IntoStaticStr,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum Authority {
	/// The core control-plane boundary enforces the operation.
	Core,
	/// The environment data-plane boundary enforces the operation.
	Environment,
}

/// Generated phase, durability, cost, and authority metadata for one operation.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Hash, PartialEq, Serialize)]
pub struct OperationSpec {
	/// Earliest invocation phase in which the operation is legal.
	pub minimum_phase: InvocationPhase,
	/// Whether the operation leaves durable state.
	pub durability:    Durability,
	/// Resource cost class.
	pub cost:          CostClass,
	/// Boundary that authoritatively enforces `minimum_phase`.
	pub authority:     Authority,
}

/// Caller-selected inline-output policy.
///
/// `Complete` bypasses the ordinary projection limit, but never the fixed host
/// security ceiling. Results larger than that ceiling remain artifact-backed.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Deserialize,
	Eq,
	Hash,
	PartialEq,
	Serialize,
	strum::Display,
	strum::EnumString,
	strum::IntoStaticStr,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum OutputRequest {
	/// Apply the runtime's ordinary inline projection limit.
	#[default]
	Bounded,
	/// Prefer complete inline output up to the host security ceiling; a stalled
	/// consumer still falls back to the complete artifact.
	Complete,
}

/// A content-addressed blob reference suitable for durable projection.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct BlobRef {
	/// Content hash in the environment blob namespace.
	pub hash:       Str,
	/// MIME type of the stored bytes.
	pub media_type: Str,
	/// Exact stored byte length.
	pub byte_len:   u64,
}

/// Typed receipt for the one output projection applied at a trust boundary.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct OutputProjection {
	/// Caller policy in force when the projection was made.
	pub request:      OutputRequest,
	/// Exact bytes observed before projection.
	pub source_bytes: u64,
	/// Bytes emitted inline after projection.
	pub inline_bytes: u64,
	/// Whether any source byte was omitted from the inline result.
	pub omitted:      bool,
	/// Complete retained bytes when an artifact store is available.
	pub artifact:     Option<BlobRef>,
}

impl OutputProjection {
	/// Returns whether all source bytes were emitted inline.
	#[must_use]
	pub const fn complete_inline(&self) -> bool {
		!self.omitted && self.inline_bytes == self.source_bytes
	}
}

/// One model-facing tool-result part.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Part {
	/// UTF-8 model-visible text.
	Text {
		/// Model-visible text payload.
		text: Str,
	},
	/// Structured JSON retained as exact bytes.
	Json {
		/// Raw JSON byte payload.
		json: Bytes,
	},
	/// Blob-backed media; never inline base64.
	Blob {
		/// Durable blob reference.
		blob: BlobRef,
		/// Optional deterministic accessibility/model fallback.
		alt:  Option<Str>,
	},
}

/// One source-backed range in a model-facing projection.
///
/// The central dispatcher resolves these candidates against the bytes it
/// actually retained inline. Tools never guess visibility from a local byte
/// limit or from a rendered truncation notice.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectionSpan {
	/// Index of the projected [`Part`] containing this range.
	pub part:       usize,
	/// Inclusive UTF-8 byte offset in the unbounded part.
	pub start_byte: usize,
	/// Exclusive UTF-8 byte offset in the unbounded part.
	pub end_byte:   usize,
	/// Stable document-authority identity.
	pub source_key: Str,
	/// One-based source line represented by the complete range.
	pub line:       usize,
}

/// Complete model projection before central output bounding.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct PromptProjection {
	/// Unbounded deterministic model-facing parts.
	pub parts:      Vec<Part>,
	/// Source ranges whose visibility requires authority acknowledgement.
	pub visibility: Vec<ProjectionSpan>,
}

impl PromptProjection {
	/// Wraps ordinary tool parts which carry no document visibility.
	#[must_use]
	pub const fn new(parts: Vec<Part>) -> Self {
		Self { parts, visibility: Vec::new() }
	}
}

/// One source line proven visible by the central dispatcher.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct VisibleSourceLine {
	/// Stable document-authority identity.
	pub source_key: Str,
	/// One-based source line fully retained inline.
	pub line:       usize,
}

/// Typed authorization receipt returned after central projection.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct VisibilityReceipt {
	/// Exact source lines fully visible to the model, sorted and deduplicated.
	pub lines: Vec<VisibleSourceLine>,
}

/// Typed failure while returning a visibility receipt to its authority.
#[derive(Debug, Error)]
#[error("tool projection visibility authorization failed")]
pub struct ProjectionAuthorizationError {
	#[source]
	source: Box<dyn std::error::Error + Send + Sync>,
}

impl ProjectionAuthorizationError {
	/// Preserves the authority's typed failure across the erased registry seam.
	pub fn new(source: impl std::error::Error + Send + Sync + 'static) -> Self {
		Self { source: Box::new(source) }
	}
}

/// One model-facing example attached to an exact tool revision.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolPromptExample {
	/// Optional short purpose or scenario.
	pub label:     Option<Str>,
	/// Canonical JSON argument bytes.
	pub arguments: Bytes,
}

/// One typed tool implementation.
pub trait Tool: Send + Sync + 'static {
	/// Declared whole-argument shape for tools which opt into whole validation.
	type Params: DeserializeOwned;
	/// Ephemeral progress payload.
	type Update: Serialize + DeserializeOwned + Send;
	/// Durable successful result.
	type Payload: Serialize + DeserializeOwned + Send;
	/// Durable typed failure.
	type Fault: Serialize + DeserializeOwned + Send;

	/// Returns this implementation's immutable specification.
	fn spec(&self) -> &ToolSpec;

	/// Returns the batch scheduling constraint for this tool.
	///
	/// Interactive tools use [`ExecutionMode::Sequential`] so concurrent
	/// calls cannot compete for one host-owned presentation surface.
	fn execution_mode(&self) -> ExecutionMode {
		ExecutionMode::Parallel
	}

	/// Returns model-facing examples for this exact revision.
	///
	/// Examples are optional metadata; the registry never invents examples for
	/// tools that do not declare them.
	fn prompt_examples(&self) -> &[ToolPromptExample] {
		&[]
	}

	/// Returns long-form model-facing documentation for this exact revision.
	///
	/// The short purpose remains [`ToolSpec::description`].
	fn prompt_docs(&self) -> Option<&str> {
		None
	}

	/// Executes one invocation from its single linear argument/event stream.
	fn call<'c>(
		&'c self,
		params: IncomingParams<'c>,
	) -> impl Stream<Item = Ev<Self::Update, Self::Payload, Self::Fault>> + Send + 'c;

	/// Deterministically projects either durable tool branch for one model.
	fn prompt(&self, view: Result<&Self::Payload, &Self::Fault>, caps: &PromptCaps) -> Vec<Part>;

	/// Projects model parts together with any source ranges requiring a
	/// post-bound visibility receipt.
	///
	/// Ordinary tools inherit a range-free projection. Source-backed tools
	/// override this method so rendering and range attribution happen once.
	fn projection(
		&self,
		view: Result<&Self::Payload, &Self::Fault>,
		caps: &PromptCaps,
	) -> PromptProjection {
		PromptProjection::new(self.prompt(view, caps))
	}

	/// Returns the dispatcher's final visibility receipt to the tool's
	/// document authority.
	///
	/// This runs only for the live call after central bounding, never while
	/// replaying or re-projecting historical calls.
	fn authorize_visibility(
		&self,
		_view: Result<&Self::Payload, &Self::Fault>,
		_receipt: &VisibilityReceipt,
	) -> Result<(), ProjectionAuthorizationError> {
		Ok(())
	}

	/// Projects one typed ephemeral update into an optional live invocation
	/// frame.
	///
	/// The default keeps ordinary tool progress on the agent event feed only.
	fn invoke_input(&self, _update: &Self::Update, _invocation_id: &str) -> Option<InvokeInput> {
		None
	}

	/// Deterministically migrates one historical call toward this revision.
	fn lift(&self, _from: &Rev, _call: RecordedCall<'_>) -> Option<LiftedCall> {
		None
	}
}

/// One event emitted by a typed tool invocation.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum Ev<U, P, F> {
	/// Ephemeral progress, never transcript history.
	Update(U),
	/// Durable harness notice materialized as a `<diag>` child of the call
	/// (ADR 0008); never interpolated into the result body.
	Diag(Diag),
	/// Terminal structured failure of a parameter the tool pulled.
	Args(ArgIssue),
	/// Terminal structured cancellation or effect-uncertainty report.
	Aborted(Abort),
	/// Terminal event; supervisors fuse the stream after this event.
	Done(ToolTerminal<P, F>),
}

/// Terminal executor result before durable call-outcome lowering.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum ToolTerminal<P, F> {
	/// A synchronous success or typed fault.
	Done {
		/// Tool-owned durable branch.
		result:  Result<P, F>,
		/// Whether model-facing parts may be compacted while truth survives.
		useless: bool,
	},
	/// Work continues outside the turn and will settle through the job board.
	Detached(JobRef),
}

/// Journaled truth for exactly one of a settled call's four branches.
#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum CallOutcome<P, F> {
	/// Successful durable payload.
	Ok(P),
	/// Tool-owned durable fault.
	Faulted(F),
	/// Structured failure of a parameter the tool actually pulled.
	ArgsRejected(ArgIssue),
	/// Structured cancellation, skip, or policy denial.
	Aborted {
		/// Fine-grained owner-reported abort reason.
		abort:  Abort,
		/// Coarse machine-readable abort class.
		kind:   AbortKind,
		/// Structured denial when `kind` is [`AbortKind::PolicyDenied`].
		#[serde(default, skip_serializing_if = "Option::is_none")]
		policy: Option<PolicyDenied>,
	},
}

impl<P, F> CallOutcome<P, F> {
	/// Creates a non-policy abort, deriving its coarse class from `abort`.
	pub const fn aborted(abort: Abort) -> Self {
		let kind = abort.kind();
		Self::Aborted { abort, kind, policy: None }
	}

	/// Creates a structured policy denial.
	pub const fn policy_denied(abort: Abort, policy: PolicyDenied) -> Self {
		Self::Aborted { abort, kind: AbortKind::PolicyDenied, policy: Some(policy) }
	}
}

#[derive(Deserialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
enum CallOutcomeRepr<P, F> {
	Ok(P),
	#[serde(alias = "fault")]
	Faulted(F),
	#[serde(alias = "args")]
	ArgsRejected(ArgIssue),
	Aborted(AbortedRepr),
}

#[derive(Deserialize)]
#[serde(untagged)]
enum AbortedRepr {
	Current {
		abort:  Abort,
		#[serde(default)]
		kind:   Option<AbortKind>,
		#[serde(default)]
		policy: Option<PolicyDenied>,
	},
	Legacy(Abort),
}

impl<'de, P, F> Deserialize<'de> for CallOutcome<P, F>
where
	P: Deserialize<'de>,
	F: Deserialize<'de>,
{
	fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
	where
		D: serde::Deserializer<'de>,
	{
		Ok(match CallOutcomeRepr::<P, F>::deserialize(deserializer)? {
			CallOutcomeRepr::Ok(payload) => Self::Ok(payload),
			CallOutcomeRepr::Faulted(fault) => Self::Faulted(fault),
			CallOutcomeRepr::ArgsRejected(issue) => Self::ArgsRejected(issue),
			CallOutcomeRepr::Aborted(AbortedRepr::Legacy(abort)) => Self::aborted(abort),
			CallOutcomeRepr::Aborted(AbortedRepr::Current { abort, kind, policy }) => {
				let kind = kind.unwrap_or_else(|| {
					if policy.is_some() {
						AbortKind::PolicyDenied
					} else {
						abort.kind()
					}
				});
				let carries_policy = policy.is_some();
				if (kind == AbortKind::PolicyDenied) != carries_policy {
					return Err(de::Error::custom(
						"policy is present if and only if abort kind is policy_denied",
					));
				}
				Self::Aborted { abort, kind, policy }
			},
		})
	}
}

/// One segment in a pulled JSON path.
#[derive(Clone, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(tag = "kind", content = "value", rename_all = "snake_case")]
pub enum ArgPath {
	/// Object key.
	Key(Str),
	/// Array index.
	Index(u64),
}

/// Declared repair coercion applied after a value is pulled.
#[derive(
	Clone,
	Copy,
	Debug,
	Deserialize,
	Eq,
	PartialEq,
	Serialize,
	strum::Display,
	strum::EnumString,
	strum::IntoStaticStr,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum Coerce {
	/// Converts common string and numeric boolean spellings.
	LooseBool,
	/// Converts an integral string or integral real to an integer.
	Integer,
	/// Converts a numeric string to a real.
	Number,
	/// Converts a JSON value to text, encoding arrays and objects as JSON.
	String,
	/// Wraps one non-array value in a one-element array.
	Singleton,
	/// Parses a string's contents as the target JSON shape.
	JsonString,
	/// Removes leading and trailing string whitespace.
	Strip,
	/// Splits a comma-delimited string into an array.
	Csv,
	/// Treats null-like optional values as an absent field.
	NullElision,
}

/// Stable class of an immutable argument repair.
#[derive(
	Clone,
	Copy,
	Debug,
	Deserialize,
	Eq,
	PartialEq,
	Serialize,
	strum::Display,
	strum::EnumString,
	strum::IntoStaticStr,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum RepairKind {
	/// A declared non-canonical field name was replaced by its canonical name.
	Alias,
	/// A declared [`Coerce`] transformation succeeded.
	Coercion,
	/// The tolerant parser accepted non-standard surface syntax.
	Tolerance,
	/// An optional null-like or unrecognized closed-object field was removed.
	Elision,
}

/// One immutable transformation tied to the exact raw argument emission.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Repair {
	/// Canonical argument path affected by the transformation.
	pub path:   SmallVec<ArgPath, 4>,
	/// Stable repair class.
	pub kind:   RepairKind,
	/// Exact human-readable before/after description.
	pub detail: Str,
}

/// Immutable declaration for one canonical argument path.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ArgSpec {
	/// Canonical key/index path.
	pub path:                  SmallVec<ArgPath, 4>,
	/// Additional accepted spellings of the final object key.
	pub aliases:               SmallVec<Str, 4>,
	/// Coercions applied in declaration order.
	pub coerce:                SmallVec<Coerce, 2>,
	/// Whether this declaration came from a speculative failed union branch.
	///
	/// Lossy coercions are suppressed for speculative branches. A branch
	/// uniquely selected by a matching `const`/`enum` discriminator is
	/// authoritative and must set this to `false`.
	#[serde(default)]
	pub from_union_branch:     bool,
	/// Human-readable requested shape used by structured argument faults.
	pub expected:              Str,
	/// Optional valid example borrowed into a structured argument fault.
	pub example:               Option<Str>,
	/// Whether this object field explicitly accepts undeclared member names.
	///
	/// Duplicate member names remain ambiguous even for an open object.
	#[serde(default)]
	pub additional_properties: bool,
}

#[derive(Clone, Default)]
struct RevArgSpecs {
	path_ids: BTreeMap<SmallVec<ArgPath, 4>, u32>,
	specs:    SparseMap<u32, ArgSpec>,
}

/// Per-revision argument declarations keyed by interned path identifiers.
///
/// Canonical paths and final-key aliases intern to the same dense identifier.
/// Once sealed, the table serves borrowed lock-free index lookups and rejects
/// every later mutation.
#[derive(Clone, Default)]
pub struct ArgSpecRegistry {
	revisions: BTreeMap<Rev, RevArgSpecs>,
	sealed:    bool,
}

/// Deterministic argument declaration registration failure.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum ArgSpecRegistryError {
	/// A declaration was attempted after the registry was sealed.
	#[error("argument specification registry is sealed")]
	Sealed,
	/// A canonical path or one of its aliases was already declared.
	#[error("argument path already registered for revision {rev}: {path:?}")]
	Duplicate {
		/// Exact argument dialect revision.
		rev:  Rev,
		/// Conflicting canonical or alias path.
		path: Arc<[ArgPath]>,
	},
	/// Aliases were declared for a path which does not end in an object key.
	#[error("argument aliases require a final object key for revision {rev}: {path:?}")]
	AliasOnIndex {
		/// Exact argument dialect revision.
		rev:  Rev,
		/// Invalid canonical path.
		path: Arc<[ArgPath]>,
	},
	/// One revision exhausted the dense path identifier space.
	#[error("too many argument paths registered for revision {0}")]
	PathLimit(Rev),
}

const _: () =
	assert!(size_of::<ArgSpecRegistryError>() <= 128, "ArgSpecRegistryError must stay compact");

impl ArgSpecRegistry {
	/// Creates an empty mutable declaration table.
	pub fn new() -> Self {
		Self::default()
	}

	/// Registers one canonical declaration and interns its alias paths.
	pub fn register(&mut self, rev: Rev, spec: ArgSpec) -> Result<(), ArgSpecRegistryError> {
		if self.sealed {
			return Err(ArgSpecRegistryError::Sealed);
		}
		let mut paths = SmallVec::<SmallVec<ArgPath, 4>, 5>::new();
		paths.push(spec.path.clone());
		if !spec.aliases.is_empty() {
			if !matches!(spec.path.last(), Some(ArgPath::Key(_))) {
				return Err(ArgSpecRegistryError::AliasOnIndex {
					rev,
					path: Arc::from(spec.path.into_vec()),
				});
			}
			for alias in &spec.aliases {
				let mut path = spec.path.clone();
				let Some(ArgPath::Key(key)) = path.last_mut() else {
					unreachable!("final path segment was checked as a key")
				};
				*key = alias.clone();
				if paths.contains(&path) {
					return Err(ArgSpecRegistryError::Duplicate {
						rev,
						path: Arc::from(path.into_vec()),
					});
				}
				paths.push(path);
			}
		}
		let revision = self.revisions.entry(rev.clone()).or_default();
		if let Some(path) = paths
			.iter()
			.find(|path| revision.path_ids.contains_key(path.as_slice()))
		{
			return Err(ArgSpecRegistryError::Duplicate {
				rev,
				path: Arc::from((*path).clone().into_vec()),
			});
		}
		let path_id = u32::try_from(revision.specs.len())
			.map_err(|_| ArgSpecRegistryError::PathLimit(rev.clone()))?;
		for path in paths {
			let previous = revision.path_ids.insert(path, path_id);
			debug_assert!(previous.is_none(), "argument paths were checked before insertion");
		}
		let previous = revision.specs.insert(path_id, spec);
		debug_assert!(previous.is_none(), "path identifiers are dense and never reused");
		Ok(())
	}

	/// Seals the table against every later registration.
	pub const fn seal(&mut self) {
		self.sealed = true;
	}

	/// Reports whether the declaration table is immutable.
	pub const fn is_sealed(&self) -> bool {
		self.sealed
	}

	/// Borrows the declaration for one exact revision and canonical or alias
	/// path.
	pub fn get(&self, rev: &Rev, path: &[ArgPath]) -> Option<&ArgSpec> {
		let revision = self.revisions.get(rev)?;
		revision.specs.get(*revision.path_ids.get(path)?)
	}

	/// Borrows the declaration and its dense path identifier for one exact
	/// revision and canonical or alias path.
	pub fn get_with_id(&self, rev: &Rev, path: &[ArgPath]) -> Option<(u32, &ArgSpec)> {
		let revision = self.revisions.get(rev)?;
		let path_id = *revision.path_ids.get(path)?;
		Some((path_id, revision.specs.get(path_id)?))
	}

	/// Iterates the canonical declarations for one exact revision in dense path
	/// identifier order.
	pub fn iter(&self, rev: &Rev) -> impl Iterator<Item = (u32, &ArgSpec)> + '_ {
		self
			.revisions
			.get(rev)
			.into_iter()
			.flat_map(|revision| revision.specs.iter())
	}
}

/// Stable class of parameter pull failure.
#[derive(
	Clone,
	Copy,
	Debug,
	Deserialize,
	Eq,
	PartialEq,
	Serialize,
	strum::Display,
	strum::EnumString,
	strum::IntoStaticStr,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum ArgIssueKind {
	/// Required pulled value was absent.
	Missing,
	/// Input ended before the pulled value completed.
	Incomplete,
	/// Input was explicitly or implicitly abandoned.
	Aborted,
	/// Complete input was malformed.
	Malformed,
	/// Pulled value had another JSON shape.
	TypeMismatch,
	/// More than one source member mapped to one canonical argument path.
	Ambiguous,
	/// Invocation framing violated the linear stream contract.
	Protocol,
}

/// Structured issue for one parameter the tool pulled.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ArgIssue {
	/// Full pulled key/index path.
	pub path:     Vec<ArgPath>,
	/// Requested shape.
	pub expected: Str,
	/// Stable failure class.
	pub kind:     ArgIssueKind,
	/// Optional valid example for model repair.
	pub example:  Option<Str>,
	/// Observed shape for [`ArgIssueKind::TypeMismatch`].
	pub found:    Option<Str>,
}
/// Structured device-routing issue, using the same repair vocabulary as a
/// pulled argument failure.
pub type DeviceIssue = ArgIssue;

/// Durable device-router fault.
///
/// A device failure retains the resolved semantic revision and the typed path
/// that selected its claimant so replay and schema-echo projection never
/// recover identity from text.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Verdict {
	/// A device path could not be resolved or dispatched.
	Device {
		/// Device-tree address selected by the dynamic transport.
		path:  DevicePath,
		/// Semantic revision attributed to the selected device.
		rev:   Rev,
		/// Structured routing or argument issue.
		issue: DeviceIssue,
	},
}

/// Structured reason an invocation did not produce a normal outcome.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Abort {
	/// Call was deliberately not started.
	Skipped {
		/// Explanation of why invocation execution was bypassed.
		reason: Str,
	},
	/// Owner observed interruption before effects could land.
	Interrupted {
		/// Explanation of the interruption event or signal.
		reason: Str,
	},
	/// Cancellation raced an effect and only the owner can report uncertainty.
	EffectsUnknown {
		/// Explanation of why side-effect state cannot be confirmed.
		reason: Str,
	},
	/// Invocation feed disappeared before explicit commitment.
	InputDropped,
	/// Executor stream ended without a terminal event.
	MissingOutcome,
}

impl Abort {
	/// Renders the harness-owned model-facing text for an aborted call.
	#[must_use]
	pub fn render(&self) -> Str {
		match self {
			Self::Skipped { reason } => sf!("skipped: {reason}"),
			Self::Interrupted { reason } => sf!("interrupted: {reason}"),
			Self::EffectsUnknown { reason } => sf!("aborted with effects unknown: {reason}"),
			Self::InputDropped => sf!("aborted: invocation input dropped before commit"),
			Self::MissingOutcome => sf!("aborted: executor ended without a terminal outcome"),
		}
	}

	/// Returns the coarse class implied by this owner-reported reason.
	pub const fn kind(&self) -> AbortKind {
		match self {
			Self::Skipped { .. } | Self::InputDropped => AbortKind::Skipped,
			Self::Interrupted { .. } | Self::EffectsUnknown { .. } | Self::MissingOutcome => {
				AbortKind::Cancelled
			},
		}
	}
}

/// Coarse machine-readable class of an aborted invocation.
#[derive(
	Clone,
	Copy,
	Debug,
	Deserialize,
	Eq,
	Hash,
	PartialEq,
	Serialize,
	strum::Display,
	strum::EnumString,
	strum::IntoStaticStr,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum AbortKind {
	/// A dispatched call failed to settle normally.
	Cancelled,
	/// A call was never dispatched.
	Skipped,
	/// Core admission policy denied the call.
	PolicyDenied,
}

/// Structured durable evidence for a policy denial.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PolicyDenied {
	/// Human-readable explanation.
	pub reason:      Str,
	/// Stable machine-readable denial code, when one exists.
	pub code:        Option<Str>,
	/// Durable admission decision identifier.
	pub decision_id: Str,
	/// Stable identifiers of every policy rule that fired.
	pub rules:       Arc<[Str]>,
}

const _: () = assert!(size_of::<PolicyDenied>() <= 128, "PolicyDenied must stay compact");

/// Result of a post-settlement review that cannot rewrite the call outcome.
#[derive(
	Clone,
	Copy,
	Debug,
	Deserialize,
	Eq,
	Hash,
	PartialEq,
	Serialize,
	strum::Display,
	strum::EnumString,
	strum::IntoStaticStr,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum PostconditionStatus {
	/// Downstream review accepted the settled outcome.
	Passed,
	/// Downstream review found a durable problem after settlement.
	Rejected,
}

/// Durable finding attached beside, and never inside, a settled call outcome.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Postcondition {
	/// Review result.
	pub status:      PostconditionStatus,
	/// Human-readable finding.
	pub reason:      Str,
	/// Stable machine-readable finding code, when one exists.
	pub code:        Option<Str>,
	/// Durable decision identifier.
	pub decision_id: Str,
	/// Stable identifiers of policy rules supporting the finding.
	#[serde(default)]
	pub rules:       SmallVec<Str, 4>,
}

/// Retention promise for an artifact produced by detached work.
///
/// This is a lifetime hint for artifact storage, not ownership of an
/// environment resource. Producers may retain an artifact longer than promised.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Deserialize,
	Eq,
	PartialEq,
	Serialize,
	strum::Display,
	strum::EnumString,
	strum::IntoStaticStr,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum ArtifactLifetime {
	/// Retain only long enough to consume the settlement.
	Ephemeral,
	/// Retain for the current agent session.
	#[default]
	Session,
	/// Retain independently of the current agent session.
	Durable,
}

/// Environment resource that authoritatively owns detached work.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum JobOwner {
	/// One generation of a named environment process.
	NamedProcess {
		/// Stable process name.
		name:       Str,
		/// Exact process generation observed when detaching.
		generation: u64,
	},
	/// A durable agent loop addressed by its stable registry identifier.
	AgentLoop {
		/// Stable agent identifier retained by the journal-backed registry.
		agent_id: Str,
	},
}

/// Kind of execution represented by a detached job.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Deserialize,
	Eq,
	PartialEq,
	Serialize,
	strum::Display,
	strum::EnumString,
	strum::IntoStaticStr,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum JobKind {
	/// A shell command or supervised named process.
	#[default]
	Shell,
	/// A subagent loop.
	Task,
	/// A detached evaluation.
	Eval,
}

/// Lifecycle state observed for detached work.
#[derive(
	Clone,
	Copy,
	Debug,
	Default,
	Deserialize,
	Eq,
	PartialEq,
	Serialize,
	strum::Display,
	strum::EnumString,
	strum::IntoStaticStr,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum JobStatus {
	/// Registered but waiting for its execution slot.
	Queued,
	/// Actively executing.
	#[default]
	Running,
	/// Settled successfully.
	Completed,
	/// Settled with an error.
	Failed,
	/// Cancelled by its owner or caller.
	Cancelled,
}

/// Immutable lifecycle snapshot carried with a detached-job descriptor.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default)]
pub struct JobMetadata {
	/// Execution kind used by roster and delivery projections.
	pub kind:          JobKind,
	/// Most recently observed lifecycle state.
	pub status:        JobStatus,
	/// Human-readable job label.
	pub label:         Str,
	/// Registration time in milliseconds since the Unix epoch.
	pub created_at_ms: u64,
	/// Execution start time, absent while queued.
	pub started_at_ms: Option<u64>,
	/// Settlement time, present only for terminal states.
	pub settled_at_ms: Option<u64>,
	/// Durable session that owns delivery and process reattachment.
	pub owner_session: Option<Str>,
	/// Actual serving model for agent/evaluation work, when known.
	pub model:         Option<Str>,
	/// Bounded successful settlement summary, when known.
	pub result:        Option<Str>,
	/// Bounded failed settlement summary, when known.
	pub error:         Option<Str>,
}

impl JobMetadata {
	/// Builds metadata for work that begins running as it is registered.
	pub const fn running(kind: JobKind, label: Str, started_at_ms: u64) -> Self {
		Self {
			kind,
			status: JobStatus::Running,
			label,
			created_at_ms: started_at_ms,
			started_at_ms: Some(started_at_ms),
			settled_at_ms: None,
			owner_session: None,
			model: None,
			result: None,
			error: None,
		}
	}
}

/// Detached work and its expected artifact.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct JobRef {
	/// Stable environment job identifier.
	pub id:       Str,
	/// Environment resource that authoritatively reports settlement.
	pub owner:    JobOwner,
	/// Lifecycle metadata used by owner-scoped roster and delivery projections.
	#[serde(default)]
	pub metadata: Arc<JobMetadata>,
	/// Artifact expected when the job settles.
	pub artifact: ExpectedArtifact,
}

/// Expected output of a detached job.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ExpectedArtifact {
	/// Human-readable artifact role.
	pub description: Str,
	/// Expected MIME type, when known.
	pub media_type:  Option<Str>,
	/// Minimum retention promised by the artifact producer.
	pub lifetime:    ArtifactLifetime,
}

/// Borrowed durable call supplied to a pure revision lift.
#[derive(Clone, Copy, Debug)]
pub struct RecordedCall<'a> {
	/// Exact original model-emitted argument bytes.
	pub raw_args: &'a [u8],
	/// Exact structured verdict JSON bytes.
	pub verdict:  &'a [u8],
}

/// Owned result of one successful pure revision lift.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct LiftedCall {
	/// Arguments expressed in the target revision.
	pub raw_args: Bytes,
	/// Verdict expressed in the target revision.
	pub verdict:  Bytes,
}

/// Owned historical call retained when projecting a transcript.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct RecordedCallOwned {
	/// Durable tool identity at recording time.
	pub identity: ToolIdentity,
	/// Exact original arguments.
	pub raw_args: Bytes,
	/// Exact original structured verdict.
	pub verdict:  Bytes,
}

impl RecordedCallOwned {
	/// Borrows the byte-stable lift input.
	pub fn as_recorded(&self) -> RecordedCall<'_> {
		RecordedCall { raw_args: &self.raw_args, verdict: &self.verdict }
	}
}

/// Serialized call-outcome details before or after blob spill.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "storage", rename_all = "snake_case")]
pub enum CallOutcomeDetails {
	/// Small outcome retained inline as structured JSON bytes.
	Inline {
		/// Complete serialized call-outcome JSON bytes.
		json: Bytes,
	},
	/// Large outcome retained by content-addressed blob reference.
	Spilled {
		/// Durable blob reference.
		blob:     BlobRef,
		/// Original serialized byte length.
		byte_len: u64,
	},
}

/// Environment-provided staged writer for durable large-outcome storage.
pub trait CallOutcomeSpill: Send + Sync {
	/// Storage error returned while opening or finalizing a stage.
	type Error;
	/// Environment-owned synchronous stage receiving exact JSON bytes.
	type Stage<'a>: Write + Send
	where
		Self: 'a;

	/// Opens one spill stage after serialization first exceeds the inline limit.
	fn open(&self) -> Result<Self::Stage<'_>, Self::Error>;

	/// Finalizes one completed stage and returns its durable blob reference.
	fn finish<'a>(
		&'a self,
		stage: Self::Stage<'a>,
	) -> impl Future<Output = Result<BlobRef, Self::Error>> + Send + 'a;
}

/// Failure while serializing or spilling a structured call outcome.
#[derive(Debug, Error)]
pub enum CallOutcomeDetailsError<E> {
	/// Structured outcome serialization failed before a spill writer failed.
	#[error("call-outcome serialization failed: {0}")]
	Serialize(serde_json::Error),
	/// The environment could not open a spill stage.
	#[error("call-outcome spill open failed")]
	SpillOpen(E),
	/// The environment-owned spill writer rejected serialized bytes.
	#[error("call-outcome spill write failed: {0}")]
	SpillWrite(serde_json::Error),
	/// The environment could not finalize the completed spill stage.
	#[error("call-outcome spill finalize failed")]
	SpillFinalize(E),
}

enum ThresholdState<W> {
	Inline(Vec<u8>),
	Spilled(W),
}

struct ThresholdWriter<'a, S: CallOutcomeSpill> {
	spill:              &'a S,
	inline_limit:       usize,
	state:              ThresholdState<S::Stage<'a>>,
	byte_len:           u64,
	open_error:         Option<S::Error>,
	spill_write_failed: bool,
}

impl<'a, S: CallOutcomeSpill> ThresholdWriter<'a, S> {
	const fn new(spill: &'a S, inline_limit: usize) -> Self {
		Self {
			spill,
			inline_limit,
			state: ThresholdState::Inline(Vec::new()),
			byte_len: 0,
			open_error: None,
			spill_write_failed: false,
		}
	}
}

impl<S: CallOutcomeSpill> Write for ThresholdWriter<'_, S> {
	fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
		if self.open_error.is_some() || self.spill_write_failed {
			return Err(io::Error::other("call-outcome spill writer previously failed"));
		}
		if let ThresholdState::Inline(inline) = &mut self.state
			&& bytes.len() <= self.inline_limit.saturating_sub(inline.len())
		{
			inline.extend_from_slice(bytes);
			self.byte_len = self.byte_len.saturating_add(bytes.len() as u64);
			return Ok(bytes.len());
		}
		if matches!(self.state, ThresholdState::Inline(_)) {
			let stage = match self.spill.open() {
				Ok(stage) => stage,
				Err(error) => {
					self.open_error = Some(error);
					return Err(io::Error::other("call-outcome spill open failed"));
				},
			};
			let ThresholdState::Inline(inline) =
				mem::replace(&mut self.state, ThresholdState::Spilled(stage))
			else {
				unreachable!("inline spill transition changed state")
			};
			let ThresholdState::Spilled(opened) = &mut self.state else {
				unreachable!("spill transition did not retain its stage")
			};
			if let Err(error) = opened.write_all(&inline) {
				self.spill_write_failed = true;
				return Err(error);
			}
		}
		let ThresholdState::Spilled(stage) = &mut self.state else {
			unreachable!("threshold writer was neither inline nor spilled")
		};
		if let Err(error) = stage.write_all(bytes) {
			self.spill_write_failed = true;
			return Err(error);
		}
		self.byte_len = self.byte_len.saturating_add(bytes.len() as u64);
		Ok(bytes.len())
	}

	fn flush(&mut self) -> io::Result<()> {
		match &mut self.state {
			ThresholdState::Inline(_) => Ok(()),
			ThresholdState::Spilled(stage) => stage.flush(),
		}
	}
}

/// Serializes an outcome once and spills on the first byte above
/// `inline_limit`.
///
/// The inline buffer never grows beyond the limit. After overflow, buffered
/// bytes and every later serializer write go directly to one environment-owned
/// stage in their original order, and that stage is finalized exactly once.
pub async fn call_outcome_details<P, F, S>(
	outcome: &CallOutcome<P, F>,
	inline_limit: usize,
	spill: &S,
) -> Result<CallOutcomeDetails, CallOutcomeDetailsError<S::Error>>
where
	P: Serialize + Sync,
	F: Serialize + Sync,
	S: CallOutcomeSpill,
{
	let mut writer = ThresholdWriter::new(spill, inline_limit);
	let serialized = outcome.serialize(&mut serde_json::Serializer::new(&mut writer));
	if let Err(source) = serialized {
		if let Some(error) = writer.open_error {
			return Err(CallOutcomeDetailsError::SpillOpen(error));
		}
		if writer.spill_write_failed {
			return Err(CallOutcomeDetailsError::SpillWrite(source));
		}
		return Err(CallOutcomeDetailsError::Serialize(source));
	}
	match writer.state {
		ThresholdState::Inline(json) => Ok(CallOutcomeDetails::Inline { json: Bytes::from(json) }),
		ThresholdState::Spilled(stage) => {
			let blob = spill
				.finish(stage)
				.await
				.map_err(CallOutcomeDetailsError::SpillFinalize)?;
			Ok(CallOutcomeDetails::Spilled { blob, byte_len: writer.byte_len })
		},
	}
}

#[cfg(test)]
mod tests {
	use omp_core::sf;

	use super::*;

	#[test]
	fn device_fault_round_trips_through_the_durable_verdict_codec() {
		let outcome = CallOutcome::<(), Verdict>::Faulted(Verdict::Device {
			path:  "lint@publisher/extension"
				.parse()
				.expect("valid device path"),
			rev:   Rev { family: sf!("device"), n: 3 },
			issue: DeviceIssue {
				path:     Vec::new(),
				expected: sf!("mounted device"),
				kind:     ArgIssueKind::Missing,
				example:  None,
				found:    Some(sf!("lint")),
			},
		});
		let encoded = serde_json::to_vec(&outcome).expect("fault serializes");
		let decoded: CallOutcome<(), Verdict> =
			serde_json::from_slice(&encoded).expect("fault deserializes");
		assert_eq!(decoded, outcome);
	}
}
