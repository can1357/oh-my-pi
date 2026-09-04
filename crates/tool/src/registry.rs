//! One-time type erasure, live advertisement, and historical lift composition.

use std::{
	collections::{BTreeMap, BTreeSet},
	future::Future,
	iter,
	mem::size_of,
	pin::Pin,
	slice,
	sync::Arc,
	task::{Context, Poll},
};

use async_stream::stream;
use bytes::Bytes;
use futures::{Stream, StreamExt, pin_mut};
use omp_ai::{
	Adjustment, FREEFORM_INPUT_PROPERTY, FeatureId, OpaqueJson, ReasonId, ToolDefinition,
	ToolGrammar, ToolGrammarSyntax, ToolInputConstraint,
	recovery::tools::{ToolAssemblyLimits, schema_within_strict_subset},
};
use omp_catalog::GrammarBits;
use omp_core::{Hash32, SparseMap, Str, hash32::Hasher, sf};
use omp_proto::inference::{v1, v1::InvokeInput};
use parking_lot::{Mutex, RwLock};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use smallvec::SmallVec;
use thiserror::Error;
use tokio_util::sync::CancellationToken;

use crate::{
	Abort, ArgIssue, ArgIssueKind, ArgPath, ArgSpec, ArgSpecRegistry, ArgSpecRegistryError,
	CallOutcome, Constraint, DeviceIssue, DevicePath, Effects, ExecutionMode, GrammarSyntax,
	IncomingParams, JobRef, LiftedCall, Part, Presentation, ProjectionAuthorizationError,
	ProjectionSpan, PromptCaps, RecordedCall, RecordedCallOwned, Rev, Tool, ToolIdentity,
	ToolPromptExample, ToolSpec, VisibilityReceipt,
};

/// Catalog capabilities needed for deterministic tool lowering.
#[derive(Clone, Copy, Debug)]
pub struct LoweringCaps {
	/// Whether per-tool strict JSON Schema is supported.
	pub strict_schema:  bool,
	/// Supported freeform grammar languages.
	pub grammar:        GrammarBits,
	/// Maximum model-visible tool declarations, when the route declares one.
	pub maximum_tools:  Option<u16>,
	/// Maximum native strict JSON Schema declarations, when the route declares
	/// one.
	pub maximum_strict: Option<u16>,
}

/// Strength retained after capability-aware constraint lowering.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ConstraintDisposition {
	/// Route can honor the requested constraint.
	Required,
	/// Request remains a preference and is receipted when unavailable.
	Prefer,
}
/// Worker placement site used by a supervised device route.
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
pub enum WorkerSiteKind {
	/// The environment-local worker site.
	Env,
	/// The client-local worker site.
	Local,
	/// A pre-attached external worker site.
	Attached,
}

/// Process boundary at which a tool executes.
#[derive(Clone, Copy, Debug, Eq, Hash, PartialEq)]
pub enum ToolLocus {
	/// Tool executes in the project environment host.
	Environment,
	/// Tool executes in the calling session host.
	Session,
}

/// Execution route associated with a live registry entry.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ToolRoute {
	/// In-process typed Rust executor erased at registration.
	Native,
	/// Presentation-only declaration executed by the remote environment host.
	Remote,
	/// Externally supervised worker executor and its resolved placement.
	Worker {
		/// Worker site kind.
		site: WorkerSiteKind,
		/// Named worker target at that site.
		name: Str,
	},
}

const fn is_model_callable(route: &ToolRoute) -> bool {
	match route {
		ToolRoute::Native | ToolRoute::Worker { .. } => true,
		ToolRoute::Remote => true,
	}
}
/// Model-visible tool declaration supplied by an attached RPC host.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct HostToolSpec {
	/// Direct model-visible tool name.
	pub name:        Str,
	/// Model-facing purpose and usage guidance.
	pub description: Str,
	/// JSON Schema for the tool argument object.
	pub parameters:  Value,
	/// Exact semantic revision when the host contract declares one.
	#[serde(default, skip_serializing_if = "Option::is_none")]
	pub rev:         Option<Rev>,
}

/// One correlated invocation delivered to an attached RPC host.
#[derive(Clone, Debug)]
pub struct HostToolInvocation {
	/// Stable invocation correlation identifier.
	pub invocation_id: Str,
	/// Provider-authored tool-call identifier.
	pub tool_call_id:  Str,
	/// Direct model-visible tool name.
	pub name:          Str,
	/// Fully committed argument object.
	pub arguments:     Map<String, Value>,
}

/// Terminal value returned by an attached RPC host tool.
#[derive(Clone, Debug)]
pub struct HostToolResult {
	/// JSON result supplied by the host.
	pub result:   Value,
	/// Whether the host classified the result as an error.
	pub is_error: bool,
}

/// Non-terminal update publisher for one host tool invocation.
#[derive(Clone)]
pub struct HostToolUpdateSink {
	sender: flume::Sender<Value>,
}

impl HostToolUpdateSink {
	/// Publishes one partial result while the invocation remains live.
	pub fn send(&self, value: Value) -> Result<(), Value> {
		self.sender.send(value).map_err(|error| error.into_inner())
	}
}

/// Asynchronous bridge from registry dispatch to an attached RPC host.
pub trait HostToolExecutor: Send + Sync + 'static {
	/// Emits a correlated request and resolves its terminal result.
	fn execute(
		&self,
		invocation: HostToolInvocation,
		updates: HostToolUpdateSink,
		cancellation: CancellationToken,
	) -> Pin<Box<dyn Future<Output = Result<HostToolResult, Str>> + Send + 'static>>;
}

/// Declared priority for resolving competing claims on one tool name.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct Precedence(pub i32);

impl Precedence {
	/// Harness-owned core tool precedence.
	pub const CORE: Self = Self(1_000);
	/// Ordinary extension precedence.
	pub const DEFAULT: Self = Self(0);
	/// Enhancement of an existing capability.
	pub const ENHANCEMENT: Self = Self(500);
	/// Deliberate last-resort implementation.
	pub const FALLBACK: Self = Self(-500);
	/// First-party or protocol integration precedence.
	pub const INTEGRATION: Self = Self(700);
}

/// Claim metadata supplied with one tool registration.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Claims {
	/// Priority used to resolve this name.
	pub precedence: Precedence,
	/// Publisher-qualified implementation identity, such as `ff-labs/fff`.
	pub claimant:   Str,
	/// Name explicitly replaced by this claim, when replacement is intended.
	pub replaces:   Option<Str>,
}

/// Available memory-backed tool portfolio.
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
	strum::IntoStaticStr,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum MemoryToolState {
	/// Memory tools and URLs are unavailable.
	#[default]
	Disabled,
	/// The Mnemopi tool portfolio is live.
	Mnemopi,
}

/// Frozen durable goal state used while resolving one tool snapshot.
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
	strum::IntoStaticStr,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum GoalToolState {
	/// Goal mode is disabled by settings.
	#[default]
	Disabled,
	/// Goal mode is enabled but no goal record exists yet.
	NoGoal,
	/// An active goal may be inspected or settled.
	Active,
	/// A paused goal is not advertised.
	Paused,
	/// A completed goal is not advertised.
	Complete,
	/// A dropped goal may be replaced.
	Dropped,
}

/// Frozen inputs for deterministic per-session tool inclusion.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct InclusionPolicy {
	/// The caller owns a restricted explicit tool list.
	pub restricted:        bool,
	/// This is the top-level agent rather than a child.
	pub top_level:         bool,
	/// Checkpoint/rewind support is live.
	pub checkpoint:        bool,
	/// AST grep/edit implementations are live.
	pub ast:               bool,
	/// Memory portfolio available to this session.
	pub memory:            MemoryToolState,
	/// The active model delegates thinking to the external think tool.
	pub external_thinking: bool,
	/// Durable goal state frozen at the snapshot boundary.
	pub goal:              GoalToolState,
	/// Autolearn policy is active.
	pub autolearn:         bool,
}

/// Provenance retained for a non-winning claim.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ShadowClaim {
	/// Current schema revision supplied by this claimant.
	pub rev:        Rev,
	/// Declared priority.
	pub precedence: Precedence,
	/// Publisher-qualified implementation identity.
	pub claimant:   Str,
	/// Explicit replacement target, when declared.
	pub replaces:   Option<Str>,
}

/// Policy-resolved claim for one stable tool name.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Claim {
	/// Current schema revision of the winning claimant.
	pub rev:        Rev,
	/// Winning priority.
	pub precedence: Precedence,
	/// Publisher-qualified winning implementation.
	pub claimant:   Str,
	/// Explicit replacement target, when declared.
	pub replaces:   Option<Str>,
	/// Losing claims retained in deterministic precedence order.
	pub shadowed:   SmallVec<ShadowClaim, 1>,
}

/// Borrowed catalog view of one policy-resolved device.
#[derive(Clone, Copy, Debug)]
pub struct MountedDevice<'a> {
	/// Stable catalog name.
	pub name:       &'a Str,
	/// Current schema revision.
	pub rev:        &'a Rev,
	/// Publisher-qualified implementation identity.
	pub claimant:   &'a Str,
	/// Winning claimant precedence.
	pub precedence: Precedence,
	/// Short catalog summary.
	pub summary:    &'a Str,
	/// Complete JSON Schema bytes.
	pub schema:     &'a [u8],
	/// Maximum declared authority before per-invocation narrowing.
	pub effects:    &'a Effects,
	/// Long-form documentation, when supplied by the declaration surface.
	pub docs:       Option<&'a str>,
	/// Execution placement, independent of device presentation.
	pub route:      &'a ToolRoute,
	/// Authenticated extension provenance retained by the mount path, when
	/// available.
	pub metadata:   Option<&'a DeviceMetadata>,
}

/// Authenticated device provenance known by the registry mount path.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct DeviceMetadata {
	/// Artifact publisher, when retained by the mount owner.
	pub publisher:       Option<Str>,
	/// Stable extension identity.
	pub extension_id:    Option<Str>,
	/// Artifact version, when retained by the mount owner.
	pub version:         Option<Str>,
	/// Verified artifact digest, when retained by the mount owner.
	pub artifact_digest: Option<Str>,
	/// Extension resolution layer.
	pub layer:           Option<Str>,
	/// Extension trust tier.
	pub tier:            Option<Str>,
	/// Live host generation, when retained by the mount owner.
	pub generation:      Option<u64>,
}
/// Resolved device dispatch target.
///
/// This borrows registry provenance while keeping a device's semantic
/// revision separate from its claimant-qualified tool-tree address.
#[derive(Clone, Copy, Debug)]
pub struct DeviceTarget<'a> {
	/// Stable root device token.
	pub name:     &'a Str,
	/// Semantic revision selected for this claimant.
	pub rev:      &'a Rev,
	/// Publisher-qualified implementation identity and worker extension key.
	pub claimant: &'a Str,
	/// Execution placement selected by the declaration.
	pub route:    &'a ToolRoute,
	/// Maximum effect envelope of the exact selected claimant and revision.
	pub effects:  &'a Effects,
}

impl DeviceTarget<'_> {
	/// Returns the durable identity selected by this device address.
	pub fn identity(&self) -> ToolIdentity {
		ToolIdentity { name: self.name.clone(), rev: self.rev.clone() }
	}
}
/// One worker-reported availability transition.
///
/// The registry accepts only unmount transitions from this transport. A later
/// registration or explicit refresh may mount a declaration again; a stale
/// worker can never make an unavailable device reachable.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AvailabilityDelta {
	/// Root device name whose live mount state changed.
	pub name:    Str,
	/// Reported reachability state.
	pub mounted: bool,
	/// Human-readable explanation for an unavailable device.
	pub reason:  Option<Str>,
}

/// Dynamic leaf owner qualified by mounted root and authenticated claimant.
#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct LeafOwner {
	/// Canonical mounted root.
	pub root:     Str,
	/// Authenticated claimant identity.
	pub claimant: Str,
}

/// Monotone manager fence for one dynamic leaf owner.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct LeafVersion {
	/// Manager process generation.
	pub manager_generation: u64,
	/// Definition epoch within that manager generation.
	pub definition_epoch:   u64,
}

/// One versioned dynamic registry leaf.
pub struct RegistryLeaf<T> {
	/// Canonical leaf name.
	pub name:  Str,
	/// Semantic tool revision.
	pub rev:   Rev,
	/// Digest of the effective declaration and implementation binding.
	pub code:  Hash32,
	/// Owner-specific runtime implementation.
	pub value: Arc<T>,
}

impl<T> Clone for RegistryLeaf<T> {
	fn clone(&self) -> Self {
		Self {
			name:  self.name.clone(),
			rev:   self.rev.clone(),
			code:  self.code,
			value: Arc::clone(&self.value),
		}
	}
}

/// One owner-qualified leaf in a published catalog snapshot.
pub struct PublishedLeaf<T> {
	/// Authenticated dynamic owner.
	pub owner:   LeafOwner,
	/// Canonical leaf name.
	pub name:    Str,
	/// Semantic tool revision.
	pub rev:     Rev,
	/// Effective declaration and binding digest.
	pub code:    Hash32,
	/// Current authoritative reachability.
	pub mounted: bool,
	/// Reason supplied by the owner for an unavailable leaf.
	pub reason:  Option<Str>,
	/// Owner-specific runtime implementation.
	pub value:   Arc<T>,
}

impl<T> Clone for PublishedLeaf<T> {
	fn clone(&self) -> Self {
		Self {
			owner:   self.owner.clone(),
			name:    self.name.clone(),
			rev:     self.rev.clone(),
			code:    self.code,
			mounted: self.mounted,
			reason:  self.reason.clone(),
			value:   Arc::clone(&self.value),
		}
	}
}

/// Immutable old-or-new snapshot of every effective dynamic leaf.
pub struct LeafCatalogSnapshot<T> {
	/// Catalog epoch published for this exact effective set.
	pub epoch:  u64,
	/// Deterministically ordered leaves.
	pub leaves: Arc<[PublishedLeaf<T>]>,
}

impl<T> Clone for LeafCatalogSnapshot<T> {
	fn clone(&self) -> Self {
		Self { epoch: self.epoch, leaves: Arc::clone(&self.leaves) }
	}
}

/// Fenced dynamic leaf replacement failure.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum LeafReplacementError {
	/// Manager generation or definition epoch moved backwards.
	#[error("dynamic leaf replacement is older than the published owner fence")]
	Stale {
		/// Submitted manager generation.
		manager_generation: u64,
		/// Submitted definition epoch.
		definition_epoch:   u64,
		/// Current manager generation.
		current_generation: u64,
		/// Current definition epoch.
		current_epoch:      u64,
	},
	/// One replacement set repeated a canonical leaf name.
	#[error("dynamic leaf replacement contains a duplicate canonical name")]
	DuplicateName,
	/// A replacement reused one fence for a different effective leaf set.
	#[error("dynamic leaf replacement changed without advancing its owner fence")]
	ConflictingVersion,
	/// An availability mutation did not name the exact active manager
	/// generation.
	#[error("dynamic leaf availability generation mismatch: expected {expected}, got {actual}")]
	Generation {
		/// Current active manager generation.
		expected: u64,
		/// Submitted manager generation.
		actual:   u64,
	},
	/// An availability mutation named a leaf not owned by this live owner.
	#[error("dynamic leaf availability named unknown leaf {0}")]
	UnknownName(Str),
	/// One availability batch repeated a canonical leaf name.
	#[error("dynamic leaf availability contains a duplicate canonical name")]
	DuplicateAvailability,
	/// A reachable leaf cannot retain an unavailable reason.
	#[error("mounted dynamic leaf cannot carry an unavailable reason")]
	MountedWithReason,
}

struct LeafCatalogState<T> {
	epoch:        u64,
	fences:       BTreeMap<LeafOwner, LeafVersion>,
	live:         BTreeMap<(LeafOwner, Str), RegistryLeaf<T>>,
	availability: BTreeMap<(LeafOwner, Str), (bool, Option<Str>)>,
	historical:   BTreeMap<(LeafOwner, Str, Rev), Arc<T>>,
}

impl<T> Default for LeafCatalogState<T> {
	fn default() -> Self {
		Self {
			epoch:        0,
			fences:       BTreeMap::new(),
			live:         BTreeMap::new(),
			availability: BTreeMap::new(),
			historical:   BTreeMap::new(),
		}
	}
}

/// Atomic, owner-fenced runtime leaf replacement catalog.
///
/// One write swaps an owner's complete leaf set under a single lock. Snapshot
/// readers copy only `Arc` handles and therefore observe the complete old or
/// new publication. Historical `(owner, name, revision)` bindings remain
/// reachable after omission from the live set.
pub struct LeafReplacementRegistry<T> {
	state: RwLock<LeafCatalogState<T>>,
}

impl<T> Default for LeafReplacementRegistry<T> {
	fn default() -> Self {
		Self { state: RwLock::new(LeafCatalogState::default()) }
	}
}

impl<T> LeafReplacementRegistry<T> {
	/// Creates an empty dynamic leaf catalog at epoch zero.
	pub fn new() -> Self {
		Self::default()
	}

	/// Atomically replaces one owner's complete live set and returns the
	/// published catalog epoch.
	pub fn replace(
		&self,
		owner: LeafOwner,
		version: LeafVersion,
		mut leaves: Vec<RegistryLeaf<T>>,
	) -> Result<u64, LeafReplacementError> {
		leaves.sort_by(|left, right| {
			left
				.name
				.cmp(&right.name)
				.then_with(|| left.rev.cmp(&right.rev))
		});
		if leaves.windows(2).any(|pair| pair[0].name == pair[1].name) {
			return Err(LeafReplacementError::DuplicateName);
		}

		let mut state = self.state.write();
		let current_version = state.fences.get(&owner).copied();
		if let Some(current) = current_version
			&& (version.manager_generation < current.manager_generation
				|| (version.manager_generation == current.manager_generation
					&& version.definition_epoch < current.definition_epoch))
		{
			return Err(LeafReplacementError::Stale {
				manager_generation: version.manager_generation,
				definition_epoch:   version.definition_epoch,
				current_generation: current.manager_generation,
				current_epoch:      current.definition_epoch,
			});
		}

		let current = state
			.live
			.iter()
			.filter(|((leaf_owner, _), _)| leaf_owner == &owner)
			.map(|(_, leaf)| leaf)
			.collect::<Vec<_>>();
		let changed = current.len() != leaves.len()
			|| current.iter().zip(&leaves).any(|(left, right)| {
				left.name != right.name || left.rev != right.rev || left.code != right.code
			});
		if !changed {
			state.fences.insert(owner, version);
			return Ok(state.epoch);
		}
		if current_version == Some(version) {
			return Err(LeafReplacementError::ConflictingVersion);
		}

		state.live.retain(|(leaf_owner, _), _| leaf_owner != &owner);
		state.availability.retain(|(leaf_owner, name), _| {
			leaf_owner != &owner || leaves.iter().any(|leaf| &leaf.name == name)
		});
		for leaf in leaves {
			state
				.availability
				.entry((owner.clone(), leaf.name.clone()))
				.or_insert((true, None));
			state
				.historical
				.insert((owner.clone(), leaf.name.clone(), leaf.rev.clone()), Arc::clone(&leaf.value));
			state.live.insert((owner.clone(), leaf.name.clone()), leaf);
		}
		state.fences.insert(owner, version);
		state.epoch = state.epoch.saturating_add(1);
		Ok(state.epoch)
	}

	/// Returns an immutable old-or-new snapshot ordered by name, revision,
	/// root, then claimant.
	pub fn snapshot(&self) -> LeafCatalogSnapshot<T> {
		let state = self.state.read();
		let mut leaves = state
			.live
			.iter()
			.map(|((owner, _), leaf)| PublishedLeaf {
				owner:   owner.clone(),
				name:    leaf.name.clone(),
				rev:     leaf.rev.clone(),
				code:    leaf.code,
				mounted: state
					.availability
					.get(&(owner.clone(), leaf.name.clone()))
					.is_some_and(|(mounted, _)| *mounted),
				reason:  state
					.availability
					.get(&(owner.clone(), leaf.name.clone()))
					.and_then(|(_, reason)| reason.clone()),
				value:   Arc::clone(&leaf.value),
			})
			.collect::<Vec<_>>();
		leaves.sort_by(|left, right| {
			left
				.name
				.cmp(&right.name)
				.then_with(|| left.rev.cmp(&right.rev))
				.then_with(|| left.owner.cmp(&right.owner))
		});
		LeafCatalogSnapshot { epoch: state.epoch, leaves: Arc::from(leaves) }
	}

	/// Returns the current published catalog epoch.
	pub fn epoch(&self) -> u64 {
		self.state.read().epoch
	}

	/// Applies one atomic availability batch for an exact owner generation.
	///
	/// Registration and availability are deliberately independent: replacing
	/// definitions retains reachability for unchanged names, while this method
	/// never creates, replaces, or removes an implementation binding.
	pub fn set_availability(
		&self,
		owner: &LeafOwner,
		manager_generation: u64,
		deltas: &[AvailabilityDelta],
	) -> Result<u64, LeafReplacementError> {
		let mut names = BTreeSet::new();
		for delta in deltas {
			if !names.insert(delta.name.clone()) {
				return Err(LeafReplacementError::DuplicateAvailability);
			}
			if delta.mounted && delta.reason.is_some() {
				return Err(LeafReplacementError::MountedWithReason);
			}
		}
		let mut state = self.state.write();
		let expected = state
			.fences
			.get(owner)
			.map_or(manager_generation, |version| version.manager_generation);
		if expected != manager_generation {
			return Err(LeafReplacementError::Generation { expected, actual: manager_generation });
		}
		for delta in deltas {
			if !state
				.live
				.contains_key(&(owner.clone(), delta.name.clone()))
			{
				return Err(LeafReplacementError::UnknownName(delta.name.clone()));
			}
		}
		let mut changed = false;
		for delta in deltas {
			let next = (delta.mounted, delta.reason.clone());
			let current = state
				.availability
				.get_mut(&(owner.clone(), delta.name.clone()))
				.expect("validated live leaf has availability state");
			if *current != next {
				*current = next;
				changed = true;
			}
		}
		if changed {
			state.epoch = state.epoch.saturating_add(1);
		}
		Ok(state.epoch)
	}

	/// Resolves one current mounted binding for an exact authenticated owner.
	pub fn resolve(&self, owner: &LeafOwner, name: &str) -> Option<PublishedLeaf<T>> {
		let state = self.state.read();
		let key = (owner.clone(), Str::new(name));
		let leaf = state.live.get(&key)?;
		let (mounted, _) = state.availability.get(&key)?;
		if !mounted {
			return None;
		}
		Some(PublishedLeaf {
			owner:   owner.clone(),
			name:    leaf.name.clone(),
			rev:     leaf.rev.clone(),
			code:    leaf.code,
			mounted: true,
			reason:  None,
			value:   Arc::clone(&leaf.value),
		})
	}

	/// Applies one atomic cross-owner availability transition for an exact
	/// manager generation and publishes at most one catalog epoch.
	pub fn set_availability_many(
		&self,
		manager_generation: u64,
		deltas: &[(LeafOwner, AvailabilityDelta)],
	) -> Result<u64, LeafReplacementError> {
		let mut keys = BTreeSet::new();
		for (owner, delta) in deltas {
			if !keys.insert((owner.clone(), delta.name.clone())) {
				return Err(LeafReplacementError::DuplicateAvailability);
			}
			if delta.mounted && delta.reason.is_some() {
				return Err(LeafReplacementError::MountedWithReason);
			}
		}
		let mut state = self.state.write();
		for (owner, delta) in deltas {
			let expected = state
				.fences
				.get(owner)
				.map_or(manager_generation, |version| version.manager_generation);
			if expected != manager_generation {
				return Err(LeafReplacementError::Generation { expected, actual: manager_generation });
			}
			if !state
				.live
				.contains_key(&(owner.clone(), delta.name.clone()))
			{
				return Err(LeafReplacementError::UnknownName(delta.name.clone()));
			}
		}
		let mut changed = false;
		for (owner, delta) in deltas {
			let next = (delta.mounted, delta.reason.clone());
			let current = state
				.availability
				.get_mut(&(owner.clone(), delta.name.clone()))
				.expect("validated live leaf has availability state");
			if *current != next {
				*current = next;
				changed = true;
			}
		}
		if changed {
			state.epoch = state.epoch.saturating_add(1);
		}
		Ok(state.epoch)
	}

	/// Resolves a retained historical owner/name/revision implementation.
	pub fn historical(&self, owner: &LeafOwner, name: &str, rev: &Rev) -> Option<Arc<T>> {
		self
			.state
			.read()
			.historical
			.get(&(owner.clone(), Str::new(name), rev.clone()))
			.map(Arc::clone)
	}
}

/// One borrowed model-facing tool declaration from the authoritative registry.
#[derive(Clone, Copy, Debug)]
pub struct ToolPromptEntry<'a> {
	/// Policy-resolved wire name.
	pub name:        &'a Str,
	/// Exact argument and projection revision.
	pub revision:    &'a Rev,
	/// Model-facing purpose.
	pub description: &'a Str,
	/// Authoritative JSON Schema bytes.
	pub schema:      &'a Bytes,
	/// Declared examples; empty when the tool supplies none.
	pub examples:    &'a [ToolPromptExample],
	/// Optional long-form documentation.
	pub docs:        Option<&'a str>,
}

/// Allocation-free borrowed view of policy-resolved callable tools.
///
/// Entries borrow the registry's exact winning declarations. With a selected
/// name set, hidden tools appear only when explicitly selected; device-only
/// declarations never enter the callable inventory.
#[derive(Clone, Copy)]
pub struct ToolPromptProjection<'a> {
	registry: &'a Registry,
	selected: Option<&'a [Str]>,
}

impl ToolPromptProjection<'_> {
	/// Iterates exact model-facing declarations in deterministic wire-name
	/// order.
	pub fn entries(&self) -> impl DoubleEndedIterator<Item = ToolPromptEntry<'_>> + '_ {
		self.registry.live.iter().filter_map(|(name, claim)| {
			let entry = self.registry.versions.get(name)?.get(&claim.rev)?;
			let included = match self.selected {
				Some(selected) => {
					selected.iter().any(|selected| selected == name)
						&& matches!(entry.presentation, Presentation::Slot | Presentation::Hidden)
				},
				None => entry.presentation == Presentation::Slot,
			};
			(included && is_model_callable(entry.tool.route())).then(|| ToolPromptEntry {
				name,
				revision: &claim.rev,
				description: &entry.tool.spec().description,
				schema: &entry.tool.spec().schema,
				examples: entry.tool.prompt_examples(),
				docs: entry.tool.prompt_docs(),
			})
		})
	}
}

/// One live tool declaration ready for inference request construction.
#[derive(Clone, Debug)]
pub struct LoweredTool {
	/// Durable live identity.
	pub identity:    ToolIdentity,
	/// Canonical inference declaration.
	pub definition:  ToolDefinition,
	/// Constraint strength after catalog-aware lowering, if requested.
	pub disposition: Option<ConstraintDisposition>,
	/// Original constraint priority, if requested.
	pub priority:    Option<u8>,
	/// Explicit degradation receipts; unsupported constraints are never silent.
	pub adjustments: Vec<Adjustment>,
}

/// Type-erased event emitted across the environment dispatch boundary.
#[derive(Clone, Debug)]
pub enum ErasedEv {
	/// Serialized typed update.
	Update(Bytes),
	/// Terminal serialized outcome.
	Done(ErasedOutcome),
}

/// Type-erased terminal tool outcome.
#[derive(Clone, Debug)]
pub enum ErasedOutcome {
	/// Structured journal verdict with compaction metadata.
	Done {
		/// Exact serialized [`CallOutcome`] JSON.
		verdict: Bytes,
		/// Whether projected parts may be compacted.
		useless: bool,
	},
	/// Detached work.
	Detached(JobRef),
}

/// Cold dispatch stream allocated once for an erased invocation.
pub type ErasedStream<'a> =
	Pin<Box<dyn Stream<Item = Result<ErasedEv, RegistryError>> + Send + 'a>>;

/// Projection result for a durable historical call.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ProjectedCall {
	/// Call is expressed in the live revision and may be emitted as a tool item.
	Live(RecordedCallOwned),
	/// No complete lift path exists; preserve the original call as transcript
	/// data.
	Data(RecordedCallOwned),
}

/// Stable cache identity for one verdict projection.
///
/// The digest includes every input which may change model-facing parts:
/// verdict bytes, projection caps, semantic revision, and projection-code
/// identity.
#[derive(Clone, Debug, Eq, Hash, PartialEq)]
pub struct ProjectionKey {
	/// Exact tool revision whose typed verdict decoder is selected.
	pub identity:        ToolIdentity,
	/// Digest of the model projection budget.
	pub caps_hash:       Hash32,
	/// Registry-wide identity of projection implementations.
	pub projection_hash: Hash32,
	cache_hash:          [u8; 32],
}

impl ProjectionKey {
	/// Creates the content-addressed key for one exact verdict and projection
	/// context.
	pub fn new(
		identity: &ToolIdentity,
		verdict: &[u8],
		caps: &PromptCaps,
		projection_hash: Hash32,
	) -> Self {
		let caps_hash = projection_caps_hash(caps);
		let mut hasher = Hash32::hasher();
		hash_field(&mut hasher, verdict);
		hash_field(&mut hasher, &caps.maximum_parts.to_le_bytes());
		hash_field(&mut hasher, &caps.maximum_text_bytes.to_le_bytes());
		hash_field(&mut hasher, &[u8::from(caps.media)]);
		hash_field(&mut hasher, &[caps.dialect as u8]);
		hash_field(&mut hasher, &[caps.model_class as u8]);
		hash_identity(&mut hasher, &identity.name, &identity.rev);
		hash_field(&mut hasher, projection_hash.as_bytes());
		Self {
			identity: identity.clone(),
			caps_hash,
			projection_hash,
			cache_hash: hasher.finalize().into_bytes(),
		}
	}

	/// Returns the opaque cache digest.
	pub const fn digest(&self) -> [u8; 32] {
		self.cache_hash
	}
}

/// One verdict projection which must be materialized during a turn's warm
/// pre-pass.
#[derive(Clone, Debug)]
pub struct ProjectionRequest<'a> {
	/// Cache identity and target tool revision.
	pub key:              ProjectionKey,
	/// Projection budget represented by [`ProjectionKey::caps_hash`].
	pub caps:             PromptCaps,
	/// Exact canonical structured verdict bytes.
	pub verdict:          &'a [u8],
	/// Durable compaction hint recorded with this call.
	pub recorded_useless: bool,
}

/// Authoritative model projection and branch metadata decoded from one verdict.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ProjectedVerdict {
	/// Model-facing parts under the supplied current-model capabilities.
	///
	/// Shared ownership avoids copying immutable parts into each projected
	/// thread item.
	pub parts:      Arc<[Part]>,
	/// Source ranges awaiting the live dispatcher's final visibility receipt.
	pub visibility: Arc<[ProjectionSpan]>,
	/// Whether the decoded verdict branch is a fault, argument error, or abort.
	pub is_error:   bool,
	/// Durable compaction hint, forced false for argument errors and aborts.
	pub useless:    bool,
}

struct ProjectionCache {
	inner: Mutex<ProjectionCacheInner>,
}

struct ProjectionCacheInner {
	by_device: SparseMap<u32, ProjectionLru>,
	bytes:     usize,
	clock:     u64,
}

struct ProjectionLru {
	entries: SmallVec<ProjectionCacheEntry, 4>,
}

struct ProjectionCacheEntry {
	hash:  [u8; 32],
	value: Arc<ProjectedVerdict>,
	bytes: usize,
	used:  u64,
}

impl Default for ProjectionCache {
	fn default() -> Self {
		Self {
			inner: Mutex::new(ProjectionCacheInner {
				by_device: SparseMap::new(),
				bytes:     0,
				clock:     0,
			}),
		}
	}
}

impl ProjectionCache {
	const MAX_PART_BYTES: usize = 4 * 1024 * 1024;

	fn get(&self, device_id: u32, key: &ProjectionKey) -> Option<Arc<ProjectedVerdict>> {
		let mut inner = self.inner.lock();
		inner.clock = inner.clock.wrapping_add(1);
		let used = inner.clock;
		let entry = inner
			.by_device
			.get_mut(device_id)?
			.entries
			.iter_mut()
			.find(|entry| entry.hash == key.cache_hash)?;
		entry.used = used;
		Some(Arc::clone(&entry.value))
	}

	fn insert(&self, device_id: u32, key: &ProjectionKey, value: ProjectedVerdict) {
		let bytes = projected_part_bytes(&value.parts).saturating_add(value.visibility.iter().fold(
			0,
			|bytes, span| {
				bytes
					.saturating_add(size_of::<ProjectionSpan>())
					.saturating_add(span.source_key.len())
			},
		));
		if bytes > Self::MAX_PART_BYTES {
			return;
		}
		let value = Arc::new(value);
		let mut inner = self.inner.lock();
		inner.clock = inner.clock.wrapping_add(1);
		let used = inner.clock;
		let previous_bytes = {
			let lru = inner
				.by_device
				.get_or_insert_with(device_id, || ProjectionLru { entries: SmallVec::new() });
			if let Some(entry) = lru
				.entries
				.iter_mut()
				.find(|entry| entry.hash == key.cache_hash)
			{
				let previous = entry.bytes;
				*entry = ProjectionCacheEntry { hash: key.cache_hash, value, bytes, used };
				Some(previous)
			} else {
				lru.entries
					.push(ProjectionCacheEntry { hash: key.cache_hash, value, bytes, used });
				None
			}
		};
		let current_bytes = inner.bytes;
		inner.bytes = previous_bytes.map_or_else(
			|| current_bytes.saturating_add(bytes),
			|previous| current_bytes.saturating_sub(previous).saturating_add(bytes),
		);
		while inner.bytes > Self::MAX_PART_BYTES {
			let victim = inner
				.by_device
				.iter()
				.flat_map(|(device_id, lru)| {
					lru.entries
						.iter()
						.enumerate()
						.map(move |(index, entry)| (device_id, index, entry.used))
				})
				.min_by_key(|(_, _, used)| *used);
			let Some((device_id, index, _)) = victim else {
				break;
			};
			let removed = inner
				.by_device
				.get_mut(device_id)
				.expect("selected projection-cache device remains present")
				.entries
				.remove(index);
			inner.bytes = inner.bytes.saturating_sub(removed.bytes);
		}
	}
}

struct ProjectionWarm {
	result: Option<Result<(), RegistryError>>,
}

impl ProjectionWarm {
	const fn ready(result: Result<(), RegistryError>) -> Self {
		Self { result: Some(result) }
	}

	fn into_ready(mut self) -> Result<(), RegistryError> {
		self
			.result
			.take()
			.expect("projection warm future is consumed once")
	}
}

impl Future for ProjectionWarm {
	type Output = Result<(), RegistryError>;

	fn poll(mut self: Pin<&mut Self>, _: &mut Context<'_>) -> Poll<Self::Output> {
		Poll::Ready(
			self
				.result
				.take()
				.expect("projection warm future polled after completion"),
		)
	}
}

/// Registry construction, dispatch, serialization, or projection failure.
#[derive(Debug, Error)]
pub enum RegistryError {
	/// `(name, revision)` was registered twice.
	#[error("tool revision already registered: {0}@{1}")]
	Duplicate(Str, Rev),
	/// Registered tool revisions exhausted the dense projection-cache id
	/// space.
	#[error("too many registered tool revisions for the projection cache")]
	ProjectionCacheIdLimit,
	/// A synchronous caller requested a projection which failed to warm its
	/// cache entry.
	#[error("projection cache remained cold for {0:?}")]
	ProjectionCacheMiss(ToolIdentity),
	/// Tool name is not registered.
	#[error("unknown tool: {0}")]
	UnknownTool(Str),
	/// Host roster revision did not advance monotonically.
	#[error("stale host tool roster for {claimant}: current {current}, received {received}")]
	StaleHostRoster {
		/// Attached host claimant.
		claimant: Str,
		/// Installed roster revision.
		current:  u64,
		/// Rejected roster revision.
		received: u64,
	},
	/// Dynamic host tool name conflicts with a native or another host roster.
	#[error("host tool name {name} from {claimant} conflicts with {owner}")]
	HostToolConflict {
		/// Contested direct model-visible name.
		name:     Str,
		/// Rejected claimant.
		claimant: Str,
		/// Existing owner.
		owner:    Str,
	},
	/// Host declaration is not executable as a direct argument-object tool.
	#[error("invalid host tool {name}: {message}")]
	InvalidHostToolSpec {
		/// Rejected model-visible name.
		name:    Str,
		/// Exact validation failure.
		message: Str,
	},
	/// Two distinct claimants declared the same precedence for one name.
	#[error("tool precedence tie for {name}: {first} and {second}")]
	PrecedenceTie {
		/// Contested tool name.
		name:   Str,
		/// Lexicographically first claimant.
		first:  Str,
		/// Lexicographically second claimant.
		second: Str,
	},
	/// A declaration attempted to occupy or outrank a reserved core name.
	#[error("claimant {claimant} cannot claim reserved core precedence for {name}: {precedence:?}")]
	CoreNameClaim {
		/// Contested tool name.
		name:       Str,
		/// Rejected device claimant.
		claimant:   Str,
		/// Rejected precedence value.
		precedence: Precedence,
	},
	/// Operation requires a native pure or execution surface unavailable for a
	/// worker declaration.
	#[error("tool {name}@{rev} is worker-routed and cannot perform registry operation {operation}")]
	UnsupportedExternal {
		/// Tool name.
		name:      Str,
		/// Exact registered revision.
		rev:       Rev,
		/// Requested registry operation.
		operation: &'static str,
	},
	/// Registered schema is not one complete JSON value.
	#[error("invalid JSON Schema for {name}@{rev}: {source}")]
	InvalidSchema {
		/// Tool name.
		name:   Str,
		/// Tool revision.
		rev:    Rev,
		/// Parser failure.
		source: serde_json::Error,
	},
	/// A grammar-constrained declaration cannot receive canonicalized freeform
	/// input.
	#[error(
		"grammar tool {name}@{rev} must declare a string `input` property: freeform calls \
		 canonicalize into it"
	)]
	GrammarInputProperty {
		/// Tool name.
		name: Str,
		/// Tool revision.
		rev:  Rev,
	},
	/// Typed event or verdict serialization failed.
	#[error("tool value serialization failed: {0}")]
	Serialize(#[from] serde_json::Error),
	/// Stored verdict does not match its registered typed revision.
	#[error("stored verdict does not match registered tool revision: {0}")]
	VerdictShape(Str),
	/// Serialized update does not match its registered typed revision.
	#[error("tool update does not match registered revision {name}@{rev}: {source}")]
	UpdateShape {
		/// Tool name.
		name:   Str,
		/// Exact registered revision.
		rev:    Rev,
		/// Typed update decoder failure.
		source: serde_json::Error,
	},
	/// A document authority rejected the dispatcher's visibility receipt.
	#[error("tool {name} rejected its model visibility receipt")]
	ProjectionAuthorization {
		/// Tool receiving the receipt.
		name:   Str,
		/// Typed authority failure.
		#[source]
		source: ProjectionAuthorizationError,
	},
	/// Selected route cannot honor a constraint whose fallback is `ERROR`.
	#[error("tool {name}@{rev} requires unsupported constraint: {feature}")]
	UnsupportedConstraint {
		/// Tool name.
		name:    Str,
		/// Exact registered revision.
		rev:     Rev,
		/// Unsupported constraint feature.
		feature: &'static str,
	},
}

trait ErasedTool: Send + Sync {
	fn spec(&self) -> &ToolSpec;
	fn prompt_examples(&self) -> &[ToolPromptExample];
	fn prompt_docs(&self) -> Option<&str>;
	fn route(&self) -> &ToolRoute;
	fn schema(&self) -> &OpaqueJson;
	fn call<'a>(&'a self, params: IncomingParams<'a>) -> ErasedStream<'a>;
	fn project_cached(&self, key: &ProjectionKey) -> Option<Arc<ProjectedVerdict>>;
	fn cache_projected(&self, key: &ProjectionKey, projected: ProjectedVerdict);
	fn warm(&self, requests: &[ProjectionRequest<'_>]) -> ProjectionWarm;
	fn authorize_visibility(
		&self,
		verdict: &[u8],
		receipt: &VisibilityReceipt,
	) -> Result<(), RegistryError>;
	fn invoke_input(
		&self,
		invocation_id: &str,
		json: &[u8],
	) -> Result<Option<InvokeInput>, RegistryError>;
	fn lift(&self, from: &Rev, call: RecordedCall<'_>) -> Option<LiftedCall>;
}
static NATIVE_TOOL_ROUTE: ToolRoute = ToolRoute::Native;

struct HostTool {
	spec:     ToolSpec,
	schema:   OpaqueJson,
	cache:    Arc<ProjectionCache>,
	cache_id: u32,
}

impl HostTool {
	fn project_fresh(
		&self,
		verdict: &[u8],
		recorded_useless: bool,
	) -> Result<ProjectedVerdict, RegistryError> {
		let verdict: CallOutcome<Value, Value> = serde_json::from_slice(verdict)
			.map_err(|_| RegistryError::VerdictShape(self.spec.name.clone()))?;
		let (value, is_error, useless) = match verdict {
			CallOutcome::Ok(value) => (value, false, recorded_useless),
			CallOutcome::Faulted(value) => (value, true, recorded_useless),
			CallOutcome::ArgsRejected(issue) => {
				return Ok(ProjectedVerdict {
					parts:      vec![Part::Text { text: render_arg_issue(&issue) }].into(),
					visibility: Arc::from([]),
					is_error:   true,
					useless:    false,
				});
			},
			CallOutcome::Aborted { abort, .. } => {
				return Ok(ProjectedVerdict {
					parts:      vec![Part::Text { text: abort.render() }].into(),
					visibility: Arc::from([]),
					is_error:   true,
					useless:    false,
				});
			},
		};
		let text = serde_json::to_string(&value).map_err(RegistryError::Serialize)?;
		Ok(ProjectedVerdict {
			parts: vec![Part::Text { text: Str::new(text) }].into(),
			visibility: Arc::from([]),
			is_error,
			useless,
		})
	}
}

impl ErasedTool for HostTool {
	fn spec(&self) -> &ToolSpec {
		&self.spec
	}

	fn prompt_examples(&self) -> &[ToolPromptExample] {
		&[]
	}

	fn prompt_docs(&self) -> Option<&str> {
		None
	}

	fn route(&self) -> &ToolRoute {
		&NATIVE_TOOL_ROUTE
	}

	fn schema(&self) -> &OpaqueJson {
		&self.schema
	}

	fn call<'a>(&'a self, _params: IncomingParams<'a>) -> ErasedStream<'a> {
		let error = external_error(&self.spec, "uncorrelated host invoke");
		Box::pin(futures::stream::once(async move { Err(error) }))
	}

	fn project_cached(&self, key: &ProjectionKey) -> Option<Arc<ProjectedVerdict>> {
		self.cache.get(self.cache_id, key)
	}

	fn cache_projected(&self, key: &ProjectionKey, projected: ProjectedVerdict) {
		self.cache.insert(self.cache_id, key, projected);
	}

	fn warm(&self, requests: &[ProjectionRequest<'_>]) -> ProjectionWarm {
		let identity = self.spec.identity();
		let result = requests
			.iter()
			.filter(|request| request.key.identity == identity)
			.filter(|request| self.cache.get(self.cache_id, &request.key).is_none())
			.try_for_each(|request| {
				let value = self.project_fresh(request.verdict, request.recorded_useless)?;
				self.cache.insert(self.cache_id, &request.key, value);
				Ok(())
			});
		ProjectionWarm::ready(result)
	}

	fn authorize_visibility(
		&self,
		_verdict: &[u8],
		_receipt: &VisibilityReceipt,
	) -> Result<(), RegistryError> {
		Ok(())
	}

	fn invoke_input(
		&self,
		_invocation_id: &str,
		_json: &[u8],
	) -> Result<Option<InvokeInput>, RegistryError> {
		Ok(None)
	}

	fn lift(&self, _from: &Rev, _call: RecordedCall<'_>) -> Option<LiftedCall> {
		None
	}
}

#[derive(Clone)]
struct HostToolRoster {
	revision: u64,
	executor: Arc<dyn HostToolExecutor>,
	entries:  BTreeMap<Str, RegistryEntry>,
}

#[derive(Default)]
struct HostToolState {
	rosters: BTreeMap<Str, HostToolRoster>,
	live:    BTreeMap<Str, Str>,
	history: BTreeMap<ToolIdentity, Arc<dyn ErasedTool>>,
}

struct Worker {
	spec:     ToolSpec,
	schema:   OpaqueJson,
	route:    ToolRoute,
	cache:    Arc<ProjectionCache>,
	cache_id: u32,
}

impl ErasedTool for Worker {
	fn spec(&self) -> &ToolSpec {
		&self.spec
	}

	fn prompt_examples(&self) -> &[ToolPromptExample] {
		&[]
	}

	fn prompt_docs(&self) -> Option<&str> {
		None
	}

	fn route(&self) -> &ToolRoute {
		&self.route
	}

	fn schema(&self) -> &OpaqueJson {
		&self.schema
	}

	fn call<'a>(&'a self, _params: IncomingParams<'a>) -> ErasedStream<'a> {
		let error = external_error(&self.spec, "invoke");
		Box::pin(futures::stream::once(async move { Err(error) }))
	}

	fn project_cached(&self, key: &ProjectionKey) -> Option<Arc<ProjectedVerdict>> {
		self.cache.get(self.cache_id, key)
	}

	fn cache_projected(&self, key: &ProjectionKey, projected: ProjectedVerdict) {
		self.cache.insert(self.cache_id, key, projected);
	}

	fn warm(&self, _requests: &[ProjectionRequest<'_>]) -> ProjectionWarm {
		ProjectionWarm::ready(Err(external_error(&self.spec, "warm")))
	}

	fn authorize_visibility(
		&self,
		_verdict: &[u8],
		_receipt: &VisibilityReceipt,
	) -> Result<(), RegistryError> {
		Ok(())
	}

	fn invoke_input(
		&self,
		_invocation_id: &str,
		_json: &[u8],
	) -> Result<Option<InvokeInput>, RegistryError> {
		Err(external_error(&self.spec, "invoke_input"))
	}

	fn lift(&self, _from: &Rev, _call: RecordedCall<'_>) -> Option<LiftedCall> {
		None
	}
}

struct Registered<T> {
	tool:     T,
	schema:   OpaqueJson,
	cache:    Arc<ProjectionCache>,
	cache_id: u32,
}

impl<T: Tool> Registered<T> {
	fn project_fresh(
		&self,
		verdict: &[u8],
		recorded_useless: bool,
		caps: PromptCaps,
	) -> Result<ProjectedVerdict, RegistryError> {
		let verdict: CallOutcome<T::Payload, T::Fault> = serde_json::from_slice(verdict)
			.map_err(|_| RegistryError::VerdictShape(self.tool.spec().name.clone()))?;
		Ok(match &verdict {
			CallOutcome::Ok(payload) => {
				let projected = self.tool.projection(Ok(payload), &caps);
				ProjectedVerdict {
					parts:      projected.parts.into(),
					visibility: projected.visibility.into(),
					is_error:   false,
					useless:    recorded_useless,
				}
			},
			CallOutcome::Faulted(fault) => {
				let projected = self.tool.projection(Err(fault), &caps);
				ProjectedVerdict {
					parts:      projected.parts.into(),
					visibility: projected.visibility.into(),
					is_error:   true,
					useless:    recorded_useless,
				}
			},
			CallOutcome::ArgsRejected(issue) => ProjectedVerdict {
				parts:      vec![Part::Text { text: render_arg_issue(issue) }].into(),
				visibility: Arc::from([]),
				is_error:   true,
				useless:    false,
			},
			CallOutcome::Aborted { abort, .. } => ProjectedVerdict {
				parts:      vec![Part::Text { text: abort.render() }].into(),
				visibility: Arc::from([]),
				is_error:   true,
				useless:    false,
			},
		})
	}
}

impl<T: Tool> ErasedTool for Registered<T> {
	fn spec(&self) -> &ToolSpec {
		self.tool.spec()
	}

	fn prompt_examples(&self) -> &[ToolPromptExample] {
		self.tool.prompt_examples()
	}

	fn prompt_docs(&self) -> Option<&str> {
		self.tool.prompt_docs()
	}

	fn route(&self) -> &ToolRoute {
		&NATIVE_TOOL_ROUTE
	}

	fn schema(&self) -> &OpaqueJson {
		&self.schema
	}

	fn call<'a>(&'a self, params: IncomingParams<'a>) -> ErasedStream<'a> {
		let events = self.tool.call(params);
		Box::pin(stream! {
			pin_mut!(events);
			let mut terminal = false;
			while let Some(event) = events.next().await {
				match event {
					crate::Ev::Update(update) => match serde_json::to_vec(&update) {
						Ok(json) => yield Ok(ErasedEv::Update(Bytes::from(json))),
						Err(error) => {
							terminal = true;
							yield Err(RegistryError::Serialize(error));
							break;
						},
					},
					crate::Ev::Diag(diag) => {
						match serde_json::to_vec(&crate::DiagEnvelope { diag: &diag }) {
							Ok(json) => yield Ok(ErasedEv::Update(Bytes::from(json))),
							Err(error) => {
								terminal = true;
								yield Err(RegistryError::Serialize(error));
								break;
							},
						}
					},
					crate::Ev::Args(issue) => {
						terminal = true;
						let verdict = CallOutcome::<T::Payload, T::Fault>::ArgsRejected(issue);
						match serde_json::to_vec(&verdict) {
							Ok(json) => yield Ok(ErasedEv::Done(ErasedOutcome::Done {
								verdict: Bytes::from(json),
								useless: false,
							})),
							Err(error) => yield Err(RegistryError::Serialize(error)),
						}
						break;
					},
					crate::Ev::Aborted(abort) => {
						terminal = true;
						let verdict = CallOutcome::<T::Payload, T::Fault>::aborted(abort);
						match serde_json::to_vec(&verdict) {
							Ok(json) => yield Ok(ErasedEv::Done(ErasedOutcome::Done {
								verdict: Bytes::from(json),
								useless: false,
							})),
							Err(error) => yield Err(RegistryError::Serialize(error)),
						}
						break;
					},
					crate::Ev::Done(outcome) => {
						terminal = true;
						let erased = match outcome {
							crate::ToolTerminal::Done { result, useless } => {
								let verdict = match result {
									Ok(payload) => CallOutcome::<T::Payload, T::Fault>::Ok(payload),
									Err(fault) => CallOutcome::<T::Payload, T::Fault>::Faulted(fault),
								};
								match serde_json::to_vec(&verdict) {
									Ok(json) => ErasedOutcome::Done {
										verdict: Bytes::from(json),
										useless,
									},
									Err(error) => {
										yield Err(RegistryError::Serialize(error));
										break;
									},
								}
							},
							crate::ToolTerminal::Detached(job) => ErasedOutcome::Detached(job),
						};
						yield Ok(ErasedEv::Done(erased));
						break;
					},
				}
			}
			if !terminal {
				let verdict = CallOutcome::<Value, Value>::aborted(Abort::MissingOutcome);
				match serde_json::to_vec(&verdict) {
					Ok(json) => yield Ok(ErasedEv::Done(ErasedOutcome::Done {
						verdict: Bytes::from(json),
						useless: false,
					})),
					Err(error) => yield Err(RegistryError::Serialize(error)),
				}
			}
		})
	}

	fn project_cached(&self, key: &ProjectionKey) -> Option<Arc<ProjectedVerdict>> {
		self.cache.get(self.cache_id, key)
	}

	fn cache_projected(&self, key: &ProjectionKey, projected: ProjectedVerdict) {
		self.cache.insert(self.cache_id, key, projected);
	}

	fn warm(&self, requests: &[ProjectionRequest<'_>]) -> ProjectionWarm {
		let identity = self.tool.spec().identity();
		let result = requests
			.iter()
			.filter(|request| request.key.identity == identity)
			.filter(|request| self.cache.get(self.cache_id, &request.key).is_none())
			.try_for_each(|request| {
				let value =
					self.project_fresh(request.verdict, request.recorded_useless, request.caps)?;
				self.cache.insert(self.cache_id, &request.key, value);
				Ok(())
			});
		ProjectionWarm::ready(result)
	}

	fn authorize_visibility(
		&self,
		verdict: &[u8],
		receipt: &VisibilityReceipt,
	) -> Result<(), RegistryError> {
		let verdict: CallOutcome<T::Payload, T::Fault> = serde_json::from_slice(verdict)
			.map_err(|_| RegistryError::VerdictShape(self.tool.spec().name.clone()))?;
		let view = match &verdict {
			CallOutcome::Ok(payload) => Ok(payload),
			CallOutcome::Faulted(fault) => Err(fault),
			CallOutcome::ArgsRejected(_) | CallOutcome::Aborted { .. } => return Ok(()),
		};
		self
			.tool
			.authorize_visibility(view, receipt)
			.map_err(|source| RegistryError::ProjectionAuthorization {
				name: self.tool.spec().name.clone(),
				source,
			})
	}

	fn invoke_input(
		&self,
		invocation_id: &str,
		json: &[u8],
	) -> Result<Option<InvokeInput>, RegistryError> {
		let update: T::Update =
			serde_json::from_slice(json).map_err(|source| RegistryError::UpdateShape {
				name: self.tool.spec().name.clone(),
				rev: self.tool.spec().rev.clone(),
				source,
			})?;
		Ok(self.tool.invoke_input(&update, invocation_id))
	}

	fn lift(&self, from: &Rev, call: RecordedCall<'_>) -> Option<LiftedCall> {
		self.tool.lift(from, call)
	}
}

#[derive(Clone)]
struct RegistryEntry {
	tool:         Arc<dyn ErasedTool>,
	presentation: Presentation,
	claims:       Claims,
	execution:    ExecutionMode,
	locus:        ToolLocus,
}

/// Revision-aware tool registry.
///
/// Concrete associated types are erased exactly once by
/// [`register`](Self::register). Every revision remains available only for pure
/// projection/lift code; dispatch and advertisement always select the one live
/// revision per stable name.
#[derive(Default)]
pub struct Registry {
	versions:         BTreeMap<Str, BTreeMap<Rev, RegistryEntry>>,
	live:             BTreeMap<Str, Claim>,
	device_metadata:  BTreeMap<(Str, Str), DeviceMetadata>,
	protected_core:   BTreeSet<Str>,
	arg_specs:        ArgSpecRegistry,
	projection_cache: Arc<ProjectionCache>,
	host_tools:       RwLock<HostToolState>,
	/// Conservatively unmounted device roots keyed by name, with the reported
	/// unavailability reason. Populated only by
	/// [`Registry::apply_availability`]; cleared by fresh registry composition.
	unmounted:        RwLock<BTreeMap<Str, Option<Str>>>,
}

impl Registry {
	/// Creates an empty registry.
	pub fn new() -> Self {
		Self::default()
	}

	/// Projects this registry onto an explicit stable-name allow-list: the
	/// returned registry knows only the named
	/// tools, so a kernel built on it neither advertises nor dispatches any
	/// other native or host tool. Unknown names are ignored; the caller
	/// validates them against [`Self::live_identities`] first when a typo
	/// must be an error.
	///
	/// Revision history, arg specs, and the projection cache travel with the
	/// retained names so historical lifts keep working for them.
	#[must_use]
	pub fn restrict<'a>(&self, names: impl IntoIterator<Item = &'a str>) -> Self {
		let names = names.into_iter().map(Str::new).collect::<BTreeSet<Str>>();
		let keep = |name: &Str| names.contains(name);
		let host_tools = {
			let state = self.host_tools.read();
			HostToolState {
				rosters: state
					.rosters
					.iter()
					.map(|(claimant, roster)| {
						(claimant.clone(), HostToolRoster {
							revision: roster.revision,
							executor: Arc::clone(&roster.executor),
							entries:  roster
								.entries
								.iter()
								.filter(|(name, _)| keep(name))
								.map(|(name, entry)| (name.clone(), entry.clone()))
								.collect(),
						})
					})
					.collect(),
				live:    state
					.live
					.iter()
					.filter(|(name, _)| keep(name))
					.map(|(name, claimant)| (name.clone(), claimant.clone()))
					.collect(),
				history: state
					.history
					.iter()
					.filter(|(identity, _)| keep(&identity.name))
					.map(|(identity, tool)| (identity.clone(), Arc::clone(tool)))
					.collect(),
			}
		};
		Self {
			versions:         self
				.versions
				.iter()
				.filter(|(name, _)| keep(name))
				.map(|(name, revisions)| (name.clone(), revisions.clone()))
				.collect(),
			live:             self
				.live
				.iter()
				.filter(|(name, _)| keep(name))
				.map(|(name, claim)| (name.clone(), claim.clone()))
				.collect(),
			device_metadata:  self
				.device_metadata
				.iter()
				.filter(|((name, _), _)| keep(name))
				.map(|(key, metadata)| (key.clone(), metadata.clone()))
				.collect(),
			protected_core:   self
				.protected_core
				.iter()
				.filter(|name| keep(name))
				.cloned()
				.collect(),
			arg_specs:        self.arg_specs.clone(),
			projection_cache: Arc::clone(&self.projection_cache),
			host_tools:       RwLock::new(host_tools),
			unmounted:        RwLock::new(self.unmounted.read().clone()),
		}
	}

	/// Retains authenticated mount provenance for one exact device claimant.
	///
	/// Metadata never participates in claim resolution or either registry hash.
	pub fn bind_device_metadata(
		&mut self,
		name: impl Into<Str>,
		claimant: impl Into<Str>,
		metadata: DeviceMetadata,
	) {
		self
			.device_metadata
			.insert((name.into(), claimant.into()), metadata);
	}

	/// Atomically replaces one attached host's complete model-visible tool
	/// roster.
	pub fn replace_host_tools(
		&self,
		claimant: Str,
		roster_revision: u64,
		specs: Vec<HostToolSpec>,
		executor: Arc<dyn HostToolExecutor>,
	) -> Result<(), RegistryError> {
		let mut state = self.host_tools.write();
		if let Some(current) = state.rosters.get(&claimant).map(|roster| roster.revision)
			&& roster_revision <= current
		{
			return Err(RegistryError::StaleHostRoster {
				claimant,
				current,
				received: roster_revision,
			});
		}
		let mut names = BTreeSet::new();
		for spec in &specs {
			if spec.name.trim().is_empty()
				|| !spec.parameters.is_object()
				|| spec.rev.as_ref().is_some_and(|rev| rev.n == 0)
			{
				return Err(RegistryError::InvalidHostToolSpec {
					name:    spec.name.clone(),
					message: sf!(
						"name must be non-empty, parameters must be a JSON Schema object, and an \
						 explicit revision must be nonzero"
					),
				});
			}
			let owner = if !names.insert(spec.name.clone()) {
				Some(claimant.clone())
			} else if self.live.contains_key(&spec.name) {
				Some(sf!("native registry"))
			} else {
				state
					.live
					.get(&spec.name)
					.filter(|owner| *owner != &claimant)
					.cloned()
			};
			if let Some(owner) = owner {
				return Err(RegistryError::HostToolConflict {
					name: spec.name.clone(),
					claimant,
					owner,
				});
			}
		}
		let base_cache_id = self.next_projection_cache_id()?;
		let family = sf!("host/{claimant}/{roster_revision}");
		let mut entries = BTreeMap::new();
		for (index, declared) in specs.into_iter().enumerate() {
			let schema = serde_json::to_vec(&declared.parameters)?;
			let rev = declared
				.rev
				.unwrap_or_else(|| Rev { family: family.clone(), n: 1 });
			let value = serde_json::from_slice(&schema).map_err(|source| {
				RegistryError::InvalidSchema { name: declared.name.clone(), rev: rev.clone(), source }
			})?;
			let mut projection_hasher = Hash32::hasher();
			projection_hasher.update(&schema);
			projection_hasher.update(declared.description.as_bytes());
			let projection_code = projection_hasher.finalize().into();
			let tool_spec = ToolSpec {
				name: declared.name.clone(),
				rev,
				description: declared.description,
				schema: Bytes::from(schema.clone()),
				constraint: Constraint::Schema {
					priority:       100,
					on_unsupported: crate::Fallback::Unspecified,
				},
				effects: Effects::default(),
				projection_code,
			};
			let cache_id = base_cache_id.saturating_add(u32::try_from(index).unwrap_or(u32::MAX));
			entries.insert(declared.name.clone(), RegistryEntry {
				tool:         Arc::new(HostTool {
					spec: tool_spec,
					schema: OpaqueJson::new(value),
					cache: Arc::clone(&self.projection_cache),
					cache_id,
				}),
				presentation: Presentation::Slot,
				execution:    ExecutionMode::Parallel,
				locus:        ToolLocus::Session,
				claims:       Claims {
					precedence: Precedence::INTEGRATION,
					claimant:   claimant.clone(),
					replaces:   None,
				},
			});
		}
		if let Some(old) = state.rosters.remove(&claimant) {
			for (name, entry) in old.entries {
				state.live.remove(&name);
				state
					.history
					.insert(entry.tool.spec().identity(), entry.tool);
			}
		}
		for name in entries.keys() {
			state.live.insert(name.clone(), claimant.clone());
		}
		state.rosters.insert(claimant, HostToolRoster {
			revision: roster_revision,
			executor,
			entries,
		});
		Ok(())
	}

	/// Returns one attached host's installed roster revision.
	pub fn host_tool_revision(&self, claimant: &str) -> Option<u64> {
		self
			.host_tools
			.read()
			.rosters
			.get(claimant)
			.map(|roster| roster.revision)
	}

	/// Returns all live host-tool declarations in deterministic name order.
	pub fn host_tool_specs(&self) -> Vec<HostToolSpec> {
		let state = self.host_tools.read();
		state
			.live
			.iter()
			.filter_map(|(name, claimant)| {
				let entry = state.rosters.get(claimant)?.entries.get(name)?;
				let spec = entry.tool.spec();
				Some(HostToolSpec {
					name:        spec.name.clone(),
					description: spec.description.clone(),
					parameters:  serde_json::from_slice(&spec.schema).ok()?,
					rev:         Some(spec.rev.clone()),
				})
			})
			.collect()
	}

	/// Reserves essential built-in names for harness-owned core claims.
	///
	/// Reservations are monotone and may be installed before or after the core
	/// implementation. Later non-core claims fail instead of shadowing,
	/// demoting, or blocking the essential slot.
	pub fn protect_core_claims<I, S>(&mut self, names: I)
	where
		I: IntoIterator<Item = S>,
		S: Into<Str>,
	{
		self
			.protected_core
			.extend(names.into_iter().map(Into::into));
	}

	/// Computes the exact live slot names for one frozen session policy.
	///
	/// Checkpoint/rewind pairing is a safety invariant and therefore applies to
	/// restricted lists. Every other convenience expansion is top-level only
	/// and never widens a restricted child.
	pub fn resolve_inclusions(
		&self,
		requested: Option<&[Str]>,
		policy: InclusionPolicy,
	) -> Vec<Str> {
		let mut names = Vec::new();
		let mut seen = BTreeSet::new();
		let push = |name: &str, names: &mut Vec<Str>, seen: &mut BTreeSet<Str>| {
			if seen.contains(name) || !self.inclusion_allowed(name, requested.is_some(), policy) {
				return;
			}
			let host_visible = {
				let state = self.host_tools.read();
				state
					.live
					.get(name)
					.and_then(|claimant| state.rosters.get(claimant))
					.and_then(|roster| roster.entries.get(name))
					.is_some_and(|entry| {
						matches!(entry.presentation, Presentation::Slot | Presentation::Hidden)
					})
			};
			if self.live_entry(name).is_ok_and(|entry| {
				matches!(entry.presentation, Presentation::Slot | Presentation::Hidden)
			}) || host_visible
			{
				let name = Str::new(name);
				seen.insert(name.clone());
				names.push(name);
			}
		};

		if let Some(requested) = requested {
			for name in requested {
				push(name, &mut names, &mut seen);
			}
			if policy.checkpoint {
				if seen.contains("checkpoint") {
					push("rewind", &mut names, &mut seen);
				} else if seen.contains("rewind") {
					push("checkpoint", &mut names, &mut seen);
				}
			}
			if !policy.restricted {
				if seen.contains("grep") && policy.ast {
					push("ast_grep", &mut names, &mut seen);
				}
				if seen.contains("edit") && policy.ast {
					push("ast_edit", &mut names, &mut seen);
				}
				if policy.memory == MemoryToolState::Mnemopi {
					for name in ["recall", "retain", "reflect", "memory_edit"] {
						push(name, &mut names, &mut seen);
					}
				}
				if policy.external_thinking {
					push("think", &mut names, &mut seen);
				}
				if policy.goal == GoalToolState::Active {
					push("goal", &mut names, &mut seen);
				}
				if policy.autolearn && policy.top_level {
					push("manage_skill", &mut names, &mut seen);
					if policy.memory == MemoryToolState::Mnemopi {
						push("learn", &mut names, &mut seen);
					}
				}
			}
		} else {
			for name in self.live.keys() {
				push(name, &mut names, &mut seen);
			}
			let host_names = self
				.host_tools
				.read()
				.live
				.keys()
				.cloned()
				.collect::<Vec<_>>();
			for name in &host_names {
				push(name, &mut names, &mut seen);
			}
		}
		names
	}

	fn inclusion_allowed(&self, name: &str, explicit: bool, policy: InclusionPolicy) -> bool {
		match name {
			"checkpoint" | "rewind" => policy.checkpoint && (policy.top_level || explicit),
			"ast_grep" | "ast_edit" => policy.ast,
			"recall" | "retain" | "reflect" | "memory_edit" => {
				policy.memory == MemoryToolState::Mnemopi
			},
			"think" => policy.external_thinking,
			"goal" => {
				!policy.restricted
					&& if explicit {
						matches!(
							policy.goal,
							GoalToolState::NoGoal | GoalToolState::Active | GoalToolState::Dropped
						)
					} else {
						policy.goal == GoalToolState::Active
					}
			},
			"manage_skill" => policy.autolearn && (policy.top_level || explicit),
			"learn" => {
				policy.autolearn
					&& policy.memory == MemoryToolState::Mnemopi
					&& (policy.top_level || explicit)
			},
			_ => true,
		}
	}

	/// Registers one argument declaration for one exact revision.
	pub fn register_arg_spec(
		&mut self,
		rev: Rev,
		spec: ArgSpec,
	) -> Result<(), ArgSpecRegistryError> {
		self.arg_specs.register(rev, spec)
	}

	/// Seals argument declarations against every later mutation.
	pub const fn seal_arg_specs(&mut self) {
		self.arg_specs.seal();
	}

	/// Borrows one exact-revision argument declaration by canonical or alias
	/// path.
	pub fn arg_spec(&self, rev: &Rev, path: &[ArgPath]) -> Option<&ArgSpec> {
		self.arg_specs.get(rev, path)
	}

	fn next_projection_cache_id(&self) -> Result<u32, RegistryError> {
		let count = self.versions.values().map(BTreeMap::len).sum::<usize>();
		u32::try_from(count).map_err(|_| RegistryError::ProjectionCacheIdLimit)
	}

	/// Registers a typed tool under one presentation and claimant.
	///
	/// Older revisions from the same claimant remain only as pure lift steps.
	/// Competing lower-precedence claimants remain qualified-addressable.
	pub fn register<T: Tool>(
		&mut self,
		tool: T,
		presentation: Presentation,
		claims: Claims,
	) -> Result<(), RegistryError> {
		self.register_typed(tool, presentation, claims, ToolLocus::Session)
	}

	/// Registers a typed tool that executes in the project environment host.
	///
	/// Older revisions from the same claimant remain only as pure lift steps.
	/// Competing lower-precedence claimants remain qualified-addressable.
	pub fn register_environment<T: Tool>(
		&mut self,
		tool: T,
		presentation: Presentation,
		claims: Claims,
	) -> Result<(), RegistryError> {
		self.register_typed(tool, presentation, claims, ToolLocus::Environment)
	}

	fn register_typed<T: Tool>(
		&mut self,
		tool: T,
		presentation: Presentation,
		claims: Claims,
		locus: ToolLocus,
	) -> Result<(), RegistryError> {
		let execution = tool.execution_mode();
		let spec = tool.spec();
		let name = spec.name.clone();
		let rev = spec.rev.clone();
		let value = serde_json::from_slice(&spec.schema).map_err(|source| {
			RegistryError::InvalidSchema { name: name.clone(), rev: rev.clone(), source }
		})?;
		validate_grammar_schema(spec, &value)?;
		let cache_id = self.next_projection_cache_id()?;
		let entry = RegistryEntry {
			tool: Arc::new(Registered {
				tool,
				schema: OpaqueJson::new(value),
				cache: Arc::clone(&self.projection_cache),
				cache_id,
			}),
			presentation,
			claims,
			execution,
			locus,
		};
		self.insert(name, rev, entry)
	}

	/// Registers an externally supervised declaration under the default
	/// environment worker whose name matches the device token.
	pub fn register_worker(
		&mut self,
		spec: ToolSpec,
		presentation: Presentation,
		claims: Claims,
	) -> Result<(), RegistryError> {
		let worker_name = spec.name.clone();
		self.register_worker_at_with_mode(
			spec,
			presentation,
			claims,
			WorkerSiteKind::Env,
			worker_name,
			ExecutionMode::Parallel,
		)
	}

	/// Registers an externally supervised declaration with a batch scheduling
	/// constraint.
	pub fn register_worker_with_mode(
		&mut self,
		spec: ToolSpec,
		presentation: Presentation,
		claims: Claims,
		execution: ExecutionMode,
	) -> Result<(), RegistryError> {
		let worker_name = spec.name.clone();
		self.register_worker_at_with_mode(
			spec,
			presentation,
			claims,
			WorkerSiteKind::Env,
			worker_name,
			execution,
		)
	}

	/// Registers an externally supervised declaration with its resolved worker
	/// placement.
	pub fn register_worker_at(
		&mut self,
		spec: ToolSpec,
		presentation: Presentation,
		claims: Claims,
		site: WorkerSiteKind,
		worker_name: Str,
	) -> Result<(), RegistryError> {
		self.register_worker_at_with_mode(
			spec,
			presentation,
			claims,
			site,
			worker_name,
			ExecutionMode::Parallel,
		)
	}

	/// Registers an externally supervised declaration at a placement with
	/// scheduling metadata.
	pub fn register_worker_at_with_mode(
		&mut self,
		spec: ToolSpec,
		presentation: Presentation,
		claims: Claims,
		site: WorkerSiteKind,
		worker_name: Str,
		execution: ExecutionMode,
	) -> Result<(), RegistryError> {
		self.register_external(
			spec,
			presentation,
			claims,
			execution,
			ToolRoute::Worker { site, name: worker_name },
			ToolLocus::Session,
		)
	}

	/// Declares a presentation-only tool executed by the remote environment.
	///
	/// The declaration participates in model advertisement and projection
	/// identity, but direct registry invocation is rejected as externally
	/// routed.
	pub fn declare_remote(
		&mut self,
		spec: ToolSpec,
		presentation: Presentation,
		claims: Claims,
		execution: ExecutionMode,
	) -> Result<(), RegistryError> {
		self.register_external(
			spec,
			presentation,
			claims,
			execution,
			ToolRoute::Remote,
			ToolLocus::Environment,
		)
	}

	fn register_external(
		&mut self,
		spec: ToolSpec,
		presentation: Presentation,
		claims: Claims,
		execution: ExecutionMode,
		route: ToolRoute,
		locus: ToolLocus,
	) -> Result<(), RegistryError> {
		let name = spec.name.clone();
		let rev = spec.rev.clone();
		let value = serde_json::from_slice(&spec.schema).map_err(|source| {
			RegistryError::InvalidSchema { name: name.clone(), rev: rev.clone(), source }
		})?;
		validate_grammar_schema(&spec, &value)?;
		let cache_id = self.next_projection_cache_id()?;
		let entry = RegistryEntry {
			tool: Arc::new(Worker {
				spec,
				schema: OpaqueJson::new(value),
				route,
				cache: Arc::clone(&self.projection_cache),
				cache_id,
			}),
			presentation,
			claims,
			execution,
			locus,
		};
		self.insert(name, rev, entry)
	}

	fn insert(&mut self, name: Str, rev: Rev, entry: RegistryEntry) -> Result<(), RegistryError> {
		if self.protected_core.contains(&name) && entry.claims.claimant != "omp/core" {
			return Err(RegistryError::CoreNameClaim {
				name,
				claimant: entry.claims.claimant,
				precedence: entry.claims.precedence,
			});
		}
		if entry.claims.precedence > Precedence::CORE
			|| (entry.presentation == Presentation::Device
				&& entry.claims.precedence >= Precedence::CORE)
		{
			return Err(RegistryError::CoreNameClaim {
				name,
				claimant: entry.claims.claimant,
				precedence: entry.claims.precedence,
			});
		}
		if self
			.versions
			.get(&name)
			.is_some_and(|versions| versions.contains_key(&rev))
		{
			return Err(RegistryError::Duplicate(name, rev));
		}
		let claim = resolve_claim(&name, self.live.get(&name), rev.clone(), &entry.claims)?;
		self
			.versions
			.entry(name.clone())
			.or_default()
			.insert(rev, entry);
		self.live.insert(name, claim);
		Ok(())
	}

	/// Borrows the exact policy-resolved `(name, revision)` identity.
	///
	/// A claimant-qualified name resolves a shadow without promoting it into
	/// catalog iteration.
	pub fn live_identity(&self, name: &str) -> Option<(&Str, &Rev)> {
		let (name, claimant) = split_claimant(name);
		let (stored_name, claim) = self.live.get_key_value(name)?;
		Some((stored_name, claim_revision(claim, claimant)?))
	}

	/// Returns an owned live identity from either native or replaceable host
	/// tools.
	pub fn resolved_identity(&self, name: &str) -> Option<ToolIdentity> {
		if let Some((name, rev)) = self.live_identity(name) {
			return Some(ToolIdentity { name: name.clone(), rev: rev.clone() });
		}
		let state = self.host_tools.read();
		let claimant = state.live.get(name)?;
		let entry = state.rosters.get(claimant)?.entries.get(name)?;
		Some(entry.tool.spec().identity())
	}

	/// Borrows callable prompt declarations from the exact winning registry.
	///
	/// `selected = None` projects all visible slots. A selected set matches
	/// [`Self::advertise_selected`] inclusion semantics, including explicitly
	/// selected hidden slots. Device declarations are absent.
	pub const fn prompt_projection<'a>(
		&'a self,
		selected: Option<&'a [Str]>,
	) -> ToolPromptProjection<'a> {
		ToolPromptProjection { registry: self, selected }
	}

	/// Borrows the complete policy-resolved specification.
	///
	/// Claimant-qualified names resolve their shadow without promoting it.
	pub fn live_spec(&self, name: &str) -> Result<&ToolSpec, RegistryError> {
		Ok(self.live_entry(name)?.tool.spec())
	}

	/// Borrows the declared maximum effect envelope of a resolved tool.
	pub fn effects(&self, name: &str) -> Result<&Effects, RegistryError> {
		Ok(&self.live_spec(name)?.effects)
	}

	/// Returns an owned effect envelope from either native or replaceable host
	/// tools.
	pub fn effects_owned(&self, name: &str) -> Result<Effects, RegistryError> {
		if let Ok(effects) = self.effects(name) {
			return Ok(effects.clone());
		}
		let state = self.host_tools.read();
		let claimant = state
			.live
			.get(name)
			.ok_or_else(|| RegistryError::UnknownTool(Str::new(name)))?;
		let entry = state
			.rosters
			.get(claimant)
			.and_then(|roster| roster.entries.get(name))
			.ok_or_else(|| RegistryError::UnknownTool(Str::new(name)))?;
		Ok(entry.tool.spec().effects.clone())
	}

	/// Iterates winning native identities in deterministic name order.
	pub fn live_identities(
		&self,
	) -> impl DoubleEndedIterator<Item = (&Str, &Rev)> + ExactSizeIterator + '_ {
		self.live.iter().map(|(name, claim)| (name, &claim.rev))
	}

	/// Snapshots every live stable name, including replaceable host tools.
	///
	/// Unlike [`Self::live_identities`], this is the complete allow-list needed
	/// when a composition projects the registry without silently dropping
	/// dynamic host declarations.
	#[must_use]
	pub fn live_names(&self) -> Vec<Str> {
		let mut names = self.live.keys().cloned().collect::<BTreeSet<_>>();
		names.extend(self.host_tools.read().live.keys().cloned());
		names.into_iter().collect()
	}

	/// Borrows the resolved claim and its shadow provenance.
	pub fn claim(&self, name: &str) -> Option<&Claim> {
		self.live.get(name)
	}

	/// Returns the execution route of a winning or claimant-qualified entry.
	pub fn route(&self, name: &str) -> Result<ToolRoute, RegistryError> {
		if let Ok(entry) = self.live_entry(name) {
			return Ok(entry.tool.route().clone());
		}
		let state = self.host_tools.read();
		let claimant = state
			.live
			.get(name)
			.ok_or_else(|| RegistryError::UnknownTool(Str::new(name)))?;
		let entry = state
			.rosters
			.get(claimant)
			.and_then(|roster| roster.entries.get(name))
			.ok_or_else(|| RegistryError::UnknownTool(Str::new(name)))?;
		Ok(entry.tool.route().clone())
	}

	/// Returns the execution locus of a winning or claimant-qualified entry.
	pub fn locus(&self, name: &str) -> Result<ToolLocus, RegistryError> {
		if let Ok(entry) = self.live_entry(name) {
			return Ok(entry.locus);
		}
		let state = self.host_tools.read();
		let claimant = state
			.live
			.get(name)
			.ok_or_else(|| RegistryError::UnknownTool(Str::new(name)))?;
		state
			.rosters
			.get(claimant)
			.and_then(|roster| roster.entries.get(name))
			.map(|entry| entry.locus)
			.ok_or_else(|| RegistryError::UnknownTool(Str::new(name)))
	}

	/// Returns the presentation of a winning or claimant-qualified entry.
	pub fn presentation(&self, name: &str) -> Result<Presentation, RegistryError> {
		if let Ok(entry) = self.live_entry(name) {
			return Ok(entry.presentation);
		}
		let state = self.host_tools.read();
		let claimant = state
			.live
			.get(name)
			.ok_or_else(|| RegistryError::UnknownTool(Str::new(name)))?;
		state
			.rosters
			.get(claimant)
			.and_then(|roster| roster.entries.get(name))
			.map(|entry| entry.presentation)
			.ok_or_else(|| RegistryError::UnknownTool(Str::new(name)))
	}

	/// Returns the batch scheduling constraint of the resolved live tool.
	pub fn execution_mode(&self, name: &str) -> Result<ExecutionMode, RegistryError> {
		if let Ok(entry) = self.live_entry(name) {
			return Ok(entry.execution);
		}
		let state = self.host_tools.read();
		let claimant = state
			.live
			.get(name)
			.ok_or_else(|| RegistryError::UnknownTool(Str::new(name)))?;
		state
			.rosters
			.get(claimant)
			.and_then(|roster| roster.entries.get(name))
			.map(|entry| entry.execution)
			.ok_or_else(|| RegistryError::UnknownTool(Str::new(name)))
	}

	/// Resolves a typed device path without admitting it to the model slot
	/// catalog.
	///
	/// The optional sub-tool component remains owned by the `dyn` router; the
	/// registry resolves the root claim and its live semantic revision.
	pub fn resolve_device(&self, path: &DevicePath) -> Result<DeviceTarget<'_>, DeviceIssue> {
		if self.unmounted.read().contains_key(path.root()) {
			return Err(device_issue(path));
		}
		let Some((name, claim)) = self.live.get_key_value(path.root()) else {
			return Err(device_issue(path));
		};
		let Some(selected) = claim_entries(claim).find(|candidate| {
			path
				.claimant
				.as_ref()
				.is_none_or(|claimant| candidate.claimant == claimant)
		}) else {
			return Err(device_issue(path));
		};
		let Some(entry) = self
			.versions
			.get(name)
			.and_then(|versions| versions.get(selected.rev))
		else {
			return Err(device_issue(path));
		};
		if entry.presentation != Presentation::Device {
			return Err(device_issue(path));
		}
		Ok(DeviceTarget {
			name,
			rev: selected.rev,
			claimant: selected.claimant,
			route: entry.tool.route(),
			effects: &entry.tool.spec().effects,
		})
	}

	/// Conservatively applies worker availability reports and returns the
	/// transitions that actually unmounted live devices.
	///
	/// `mounted=true` is deliberately ignored: only a fresh registry
	/// composition may make a device reachable after a worker report.
	pub fn apply_availability(
		&self,
		deltas: &[AvailabilityDelta],
	) -> SmallVec<AvailabilityDelta, 2> {
		let mut applied = SmallVec::new();
		let mut unmounted = self.unmounted.write();
		for delta in deltas {
			if delta.mounted
				|| unmounted.contains_key(&delta.name)
				|| !self.live.get(&delta.name).is_some_and(|claim| {
					self
						.versions
						.get(&delta.name)
						.and_then(|versions| versions.get(&claim.rev))
						.is_some_and(|entry| entry.presentation == Presentation::Device)
				}) {
				continue;
			}
			unmounted.insert(delta.name.clone(), delta.reason.clone());
			applied.push(delta.clone());
		}
		applied
	}

	/// Iterates mounted catalog devices without allocating.
	///
	/// Shadowed and conservatively unmounted devices are intentionally absent.
	pub fn devices(&self) -> impl DoubleEndedIterator<Item = MountedDevice<'_>> + '_ {
		self.live.iter().filter_map(|(name, claim)| {
			let entry = self.versions.get(name)?.get(&claim.rev)?;
			(!self.unmounted.read().contains_key(name) && entry.presentation == Presentation::Device)
				.then(|| MountedDevice {
					name,
					rev: &claim.rev,
					claimant: &claim.claimant,
					precedence: claim.precedence,
					summary: &entry.tool.spec().description,
					schema: entry.tool.spec().schema.as_ref(),
					effects: &entry.tool.spec().effects,
					docs: None,
					route: entry.tool.route(),
					metadata: self
						.device_metadata
						.get(&(name.clone(), claim.claimant.clone())),
				})
		})
	}

	/// Returns the BLAKE3-256 digest of policy-resolved model-visible slots.
	pub fn slot_hash(&self) -> Hash32 {
		let mut hasher = Hash32::hasher();
		hasher.update(b"omp-tool/slots/v1\0");
		for (name, claim) in &self.live {
			let Some(entry) = self
				.versions
				.get(name)
				.and_then(|versions| versions.get(&claim.rev))
			else {
				continue;
			};
			if entry.presentation == Presentation::Slot && is_model_callable(entry.tool.route()) {
				hash_identity(&mut hasher, name, &claim.rev);
			}
		}
		let host_tools = self.host_tools.read();
		for (name, claimant) in &host_tools.live {
			if let Some(entry) = host_tools
				.rosters
				.get(claimant)
				.and_then(|roster| roster.entries.get(name))
				.filter(|entry| is_model_callable(entry.tool.route()))
			{
				hash_identity(&mut hasher, name, &entry.tool.spec().rev);
			}
		}
		hasher.finalize()
	}

	/// Returns the BLAKE3-256 digest of mounted device availability and
	/// claimant-qualified reachability.
	pub fn device_hash(&self) -> Hash32 {
		let mut hasher = Hash32::hasher();
		hasher.update(b"omp-tool/devices/v1\0");
		let unmounted = self.unmounted.read();
		for (name, claim) in &self.live {
			if unmounted.contains_key(name) {
				continue;
			}
			for shadow in claim_entries(claim) {
				let Some(entry) = self
					.versions
					.get(name)
					.and_then(|versions| versions.get(shadow.rev))
				else {
					continue;
				};
				if entry.presentation != Presentation::Device {
					continue;
				}
				hash_identity(&mut hasher, name, shadow.rev);
				hash_field(&mut hasher, shadow.claimant.as_bytes());
				hash_field(
					&mut hasher,
					shadow
						.replaces
						.map_or(&[][..], |replacement| replacement.as_bytes()),
				);
				hasher.update(shadow.precedence.0.to_le_bytes());
				hash_tool_route(&mut hasher, entry.tool.route());
			}
		}
		hasher.finalize()
	}

	/// Returns the BLAKE3-256 digest of every registered revision and its
	/// projection implementation.
	pub fn projection_hash(&self) -> Hash32 {
		let mut hasher = Hash32::hasher();
		hasher.update(b"omp-tool/projections/v1\0");
		for (name, versions) in &self.versions {
			for (rev, entry) in versions {
				hash_identity(&mut hasher, name, rev);
				hash_field(&mut hasher, &entry.tool.spec().projection_code);
			}
		}
		let host_tools = self.host_tools.read();
		for (name, claimant) in &host_tools.live {
			if let Some(entry) = host_tools
				.rosters
				.get(claimant)
				.and_then(|roster| roster.entries.get(name))
			{
				hash_identity(&mut hasher, name, &entry.tool.spec().rev);
				hash_field(&mut hasher, &entry.tool.spec().projection_code);
			}
		}
		hasher.finalize()
	}

	/// Dispatches only the policy-resolved or claimant-qualified revision.
	pub fn invoke<'a>(
		&'a self,
		name: &str,
		mut params: IncomingParams<'a>,
	) -> Result<ErasedStream<'a>, RegistryError> {
		if let Ok(entry) = self.live_entry(name) {
			if !matches!(entry.tool.route(), ToolRoute::Native) {
				return Err(external_error(entry.tool.spec(), "invoke"));
			}
			params.bind_arg_specs(&entry.tool.spec().rev, &self.arg_specs);
			return Ok(entry.tool.call(params));
		}
		let correlation = Str::from(omp_core::Ulid::generate().to_string());
		self.invoke_host(name, correlation.clone(), correlation, params)
	}

	/// Dispatches one host tool with caller-supplied transport correlation.
	pub fn invoke_host<'a>(
		&'a self,
		name: &str,
		invocation_id: Str,
		tool_call_id: Str,
		params: IncomingParams<'a>,
	) -> Result<ErasedStream<'a>, RegistryError> {
		let (executor, tool_name) = {
			let state = self.host_tools.read();
			let claimant = state
				.live
				.get(name)
				.ok_or_else(|| RegistryError::UnknownTool(Str::new(name)))?;
			let roster = state
				.rosters
				.get(claimant)
				.ok_or_else(|| RegistryError::UnknownTool(Str::new(name)))?;
			let entry = roster
				.entries
				.get(name)
				.ok_or_else(|| RegistryError::UnknownTool(Str::new(name)))?;
			(Arc::clone(&roster.executor), entry.tool.spec().name.clone())
		};
		Ok(host_tool_stream(
			executor,
			HostToolInvocation { invocation_id, tool_call_id, name: tool_name, arguments: Map::new() },
			params,
		))
	}

	/// Dispatches one resolved native device while preserving the normal slot
	/// invocation path unchanged.
	///
	/// Externally routed devices are intentionally rejected here: the
	/// environment router owns their `InvokeTool` transport after inspecting
	/// [`DeviceTarget::route`] from [`Self::resolve_device`].
	pub fn invoke_device<'a>(
		&'a self,
		path: &DevicePath,
		mut params: IncomingParams<'a>,
	) -> Result<ErasedStream<'a>, RegistryError> {
		let target = self
			.resolve_device(path)
			.map_err(|_| RegistryError::UnknownTool(Str::new(path.to_string())))?;
		let entry = self
			.versions
			.get(target.name)
			.and_then(|versions| versions.get(target.rev))
			.expect("resolved device target must retain its registered entry");
		if !matches!(entry.tool.route(), ToolRoute::Native) {
			return Err(external_error(entry.tool.spec(), "invoke_device"));
		}
		params.bind_arg_specs(&entry.tool.spec().rev, &self.arg_specs);
		Ok(entry.tool.call(params))
	}

	/// Lowers policy-resolved model-visible slots in priority order.
	///
	/// Larger priorities win. Core slots occupy the upper priority band, so an
	/// extension declaration can never displace a core intent when a route is
	/// capacity-constrained.
	pub fn advertise(&self, caps: LoweringCaps) -> Result<Vec<LoweredTool>, RegistryError> {
		self.advertise_matching(caps, |entry| entry.presentation == Presentation::Slot)
	}

	/// Lowers an exact frozen session selection, including selected hidden
	/// tools.
	///
	/// Unknown, device-only, and unselected declarations are omitted. Callers
	/// should obtain `names` from [`Self::resolve_inclusions`].
	pub fn advertise_selected(
		&self,
		caps: LoweringCaps,
		names: &[Str],
	) -> Result<Vec<LoweredTool>, RegistryError> {
		let selected = names.iter().collect::<BTreeSet<_>>();
		self.advertise_matching(caps, |entry| {
			selected.contains(&entry.tool.spec().name)
				&& matches!(entry.presentation, Presentation::Slot | Presentation::Hidden)
		})
	}

	fn advertise_matching(
		&self,
		caps: LoweringCaps,
		include: impl Fn(&RegistryEntry) -> bool,
	) -> Result<Vec<LoweredTool>, RegistryError> {
		let mut entries = self
			.live
			.iter()
			.filter_map(|(name, claim)| {
				let entry = self.versions.get(name)?.get(&claim.rev)?;
				(include(entry) && is_model_callable(entry.tool.route())).then_some(entry)
			})
			.collect::<Vec<_>>();
		let host_tools = self.host_tools.read();
		entries.extend(host_tools.live.iter().filter_map(|(name, claimant)| {
			let roster = host_tools.rosters.get(claimant)?;
			let entry = roster.entries.get(name)?;
			(include(entry) && is_model_callable(entry.tool.route())).then_some(entry)
		}));
		entries.sort_by(|left, right| {
			advertisement_priority(right)
				.cmp(&advertisement_priority(left))
				.then_with(|| left.tool.spec().name.cmp(&right.tool.spec().name))
		});

		let mut lowered = Vec::with_capacity(entries.len());
		let mut strict = 0_usize;
		for entry in entries {
			if caps
				.maximum_tools
				.is_some_and(|limit| lowered.len() >= limit as usize)
			{
				if constraint_requires_capacity(entry.tool.spec()) {
					return Err(budget_constraint_error(entry.tool.spec(), "tool-count-budget"));
				}
				continue;
			}
			let mut tool = lower(entry.tool.as_ref(), caps)?;
			tool.priority = constraint_priority(&entry.tool.spec().constraint)
				.map(|_| advertisement_priority(entry));
			if is_native_strict(&tool)
				&& caps
					.maximum_strict
					.is_some_and(|limit| strict >= limit as usize)
			{
				if constraint_requires_capacity(entry.tool.spec()) {
					return Err(budget_constraint_error(entry.tool.spec(), "strict-schema-budget"));
				}
				downgrade_strict(&mut tool);
			}
			if is_native_strict(&tool) {
				strict = strict.saturating_add(1);
			}
			lowered.push(tool);
		}
		Ok(lowered)
	}

	/// Deterministically projects a structured live verdict through its tool.
	pub fn prompt(
		&self,
		identity: &ToolIdentity,
		verdict: &[u8],
		caps: &PromptCaps,
	) -> Result<Option<Arc<[Part]>>, RegistryError> {
		let projected = self.project_verdict(identity, verdict, false, caps)?;
		Ok(Some(Arc::clone(&projected.parts)))
	}

	/// Builds one cache-addressed projection request for a complete turn
	/// pre-pass.
	pub fn projection_request<'a>(
		&self,
		identity: &ToolIdentity,
		verdict: &'a [u8],
		recorded_useless: bool,
		caps: &PromptCaps,
	) -> Result<ProjectionRequest<'a>, RegistryError> {
		self.projection_tool(identity)?;
		Ok(ProjectionRequest {
			key: ProjectionKey::new(identity, verdict, caps, self.projection_hash()),
			caps: *caps,
			verdict,
			recorded_useless,
		})
	}

	/// Probes the projection cache without allocating or invoking a worker.
	pub fn project_cached(
		&self,
		key: &ProjectionKey,
	) -> Result<Option<Arc<ProjectedVerdict>>, RegistryError> {
		Ok(self.projection_tool(&key.identity)?.project_cached(key))
	}

	/// Stores a projection returned by a worker batch in the matching cache
	/// partition.
	pub fn cache_projected(
		&self,
		key: &ProjectionKey,
		projected: ProjectedVerdict,
	) -> Result<(), RegistryError> {
		self
			.projection_tool(&key.identity)?
			.cache_projected(key, projected);
		Ok(())
	}

	/// Warms every cache miss for one turn before prompt assembly.
	pub async fn warm(&self, requests: &[ProjectionRequest<'_>]) -> Result<(), RegistryError> {
		for (index, request) in requests.iter().enumerate() {
			if requests[..index]
				.iter()
				.any(|earlier| earlier.key.identity == request.key.identity)
			{
				continue;
			}
			let entry = self.projection_tool(&request.key.identity)?;
			entry.warm(requests).await?;
		}
		Ok(())
	}

	/// Decodes one recorded verdict into current model parts and branch
	/// metadata.
	///
	/// The durable `recorded_useless` hint is preserved for tool-owned `Ok` and
	/// `Fault` branches. Harness-owned `Args` and `Aborted` branches always
	/// force it false.
	pub fn project_verdict(
		&self,
		identity: &ToolIdentity,
		verdict: &[u8],
		recorded_useless: bool,
		caps: &PromptCaps,
	) -> Result<Arc<ProjectedVerdict>, RegistryError> {
		let request = self.projection_request(identity, verdict, recorded_useless, caps)?;
		let entry = self.projection_tool(identity)?;
		if let Some(projected) = entry.project_cached(&request.key) {
			return Ok(projected);
		}
		entry.warm(slice::from_ref(&request)).into_ready()?;
		entry
			.project_cached(&request.key)
			.ok_or_else(|| RegistryError::ProjectionCacheMiss(identity.clone()))
	}

	/// Returns the live dispatcher's final source visibility receipt to the
	/// exact registered tool revision.
	pub fn authorize_visibility(
		&self,
		identity: &ToolIdentity,
		verdict: &[u8],
		receipt: &VisibilityReceipt,
	) -> Result<(), RegistryError> {
		self
			.projection_tool(identity)?
			.authorize_visibility(verdict, receipt)
	}

	/// Projects one exact serialized update through its registered typed tool.
	pub fn invoke_input(
		&self,
		identity: &ToolIdentity,
		invocation_id: &str,
		json: &[u8],
	) -> Result<Option<InvokeInput>, RegistryError> {
		let entry = self.projection_tool(identity)?;
		entry.invoke_input(invocation_id, json)
	}

	/// Composes registered adjacent lift steps toward the live revision.
	///
	/// Failure of any step returns the exact original bytes as `Data`; partially
	/// migrated history is never exposed or mistaken for a live schema.
	pub fn project(&self, original: RecordedCallOwned) -> ProjectedCall {
		let lifted = self.project_lift_chain(&original);
		#[cfg(debug_assertions)]
		if let Some(first) = &lifted {
			let second = self
				.project_lift_chain(&original)
				.expect("a successful lift chain must remain successful on identical input");
			debug_assert_eq!(
				first.raw_args, second.raw_args,
				"lift chains must re-express arguments byte-identically"
			);
			debug_assert_eq!(
				first.verdict, second.verdict,
				"lift chains must re-express verdicts byte-identically"
			);
		}
		lifted.map_or(ProjectedCall::Data(original), ProjectedCall::Live)
	}

	fn project_lift_chain(&self, original: &RecordedCallOwned) -> Option<RecordedCallOwned> {
		let live_claim = self.live.get(&original.identity.name)?;
		let live_rev = &live_claim.rev;
		if &original.identity.rev == live_rev {
			return Some(original.clone());
		}
		let versions = self.versions.get(&original.identity.name)?;
		let mut current_rev = original.identity.rev.clone();
		let mut current =
			LiftedCall { raw_args: original.raw_args.clone(), verdict: original.verdict.clone() };
		while &current_rev != live_rev {
			let next_rev = if current_rev.family == live_rev.family && current_rev.n < live_rev.n {
				Rev { family: current_rev.family.clone(), n: current_rev.n.saturating_add(1) }
			} else {
				live_rev.clone()
			};
			let step = versions.get(&next_rev)?;
			let lifted = step.tool.lift(&current_rev, RecordedCall {
				raw_args: &current.raw_args,
				verdict:  &current.verdict,
			})?;
			current = lifted;
			current_rev = next_rev;
		}
		Some(RecordedCallOwned {
			identity: ToolIdentity { name: original.identity.name.clone(), rev: current_rev },
			raw_args: current.raw_args,
			verdict:  current.verdict,
		})
	}

	fn projection_tool(
		&self,
		identity: &ToolIdentity,
	) -> Result<Arc<dyn ErasedTool>, RegistryError> {
		if let Some(entry) = self
			.versions
			.get(&identity.name)
			.and_then(|versions| versions.get(&identity.rev))
		{
			return Ok(Arc::clone(&entry.tool));
		}
		let state = self.host_tools.read();
		if let Some(tool) = state.history.get(identity) {
			return Ok(Arc::clone(tool));
		}
		let claimant = state
			.live
			.get(&identity.name)
			.ok_or_else(|| RegistryError::UnknownTool(identity.name.clone()))?;
		let entry = state
			.rosters
			.get(claimant)
			.and_then(|roster| roster.entries.get(&identity.name))
			.filter(|entry| entry.tool.spec().rev == identity.rev)
			.ok_or_else(|| RegistryError::UnknownTool(identity.name.clone()))?;
		Ok(Arc::clone(&entry.tool))
	}

	fn live_entry(&self, path: &str) -> Result<&RegistryEntry, RegistryError> {
		let (name, claimant) = split_claimant(path);
		let claim = self
			.live
			.get(name)
			.ok_or_else(|| RegistryError::UnknownTool(Str::new(path)))?;
		let rev = claim_revision(claim, claimant)
			.ok_or_else(|| RegistryError::UnknownTool(Str::new(path)))?;
		self
			.versions
			.get(name)
			.and_then(|versions| versions.get(rev))
			.ok_or_else(|| RegistryError::UnknownTool(Str::new(path)))
	}
}

#[derive(Clone, Copy)]
struct ClaimRef<'a> {
	rev:        &'a Rev,
	precedence: Precedence,
	claimant:   &'a Str,
	replaces:   Option<&'a Str>,
}

fn resolve_claim(
	name: &Str,
	existing: Option<&Claim>,
	rev: Rev,
	claims: &Claims,
) -> Result<Claim, RegistryError> {
	let mut contenders = SmallVec::<ShadowClaim, 2>::new();
	if let Some(existing) = existing {
		contenders.push(ShadowClaim {
			rev:        existing.rev.clone(),
			precedence: existing.precedence,
			claimant:   existing.claimant.clone(),
			replaces:   existing.replaces.clone(),
		});
		contenders.extend(existing.shadowed.iter().cloned());
	}
	if let Some(position) = contenders
		.iter()
		.position(|candidate| candidate.claimant == claims.claimant)
	{
		contenders.remove(position);
	}
	contenders.push(ShadowClaim {
		rev,
		precedence: claims.precedence,
		claimant: claims.claimant.clone(),
		replaces: claims.replaces.clone(),
	});
	contenders.sort_by(|left, right| {
		right
			.precedence
			.cmp(&left.precedence)
			.then_with(|| left.claimant.cmp(&right.claimant))
	});
	for pair in contenders.windows(2) {
		if pair[0].precedence == pair[1].precedence {
			let (first, second) = if pair[0].claimant <= pair[1].claimant {
				(pair[0].claimant.clone(), pair[1].claimant.clone())
			} else {
				(pair[1].claimant.clone(), pair[0].claimant.clone())
			};
			return Err(RegistryError::PrecedenceTie { name: name.clone(), first, second });
		}
	}
	let winner = contenders.remove(0);
	Ok(Claim {
		rev:        winner.rev,
		precedence: winner.precedence,
		claimant:   winner.claimant,
		replaces:   winner.replaces,
		shadowed:   contenders.into_iter().collect(),
	})
}

fn split_claimant(path: &str) -> (&str, Option<&str>) {
	path
		.rsplit_once('@')
		.map_or((path, None), |(name, claimant)| {
			if name.is_empty() || claimant.is_empty() {
				(path, None)
			} else {
				(name, Some(claimant))
			}
		})
}

fn claim_revision<'a>(claim: &'a Claim, claimant: Option<&str>) -> Option<&'a Rev> {
	let Some(claimant) = claimant else {
		return Some(&claim.rev);
	};
	if claim.claimant == claimant {
		return Some(&claim.rev);
	}
	claim
		.shadowed
		.iter()
		.find(|shadow| shadow.claimant == claimant)
		.map(|shadow| &shadow.rev)
}

fn claim_entries(claim: &Claim) -> impl Iterator<Item = ClaimRef<'_>> {
	iter::once(ClaimRef {
		rev:        &claim.rev,
		precedence: claim.precedence,
		claimant:   &claim.claimant,
		replaces:   claim.replaces.as_ref(),
	})
	.chain(claim.shadowed.iter().map(|shadow| ClaimRef {
		rev:        &shadow.rev,
		precedence: shadow.precedence,
		claimant:   &shadow.claimant,
		replaces:   shadow.replaces.as_ref(),
	}))
}

fn device_issue(path: &DevicePath) -> DeviceIssue {
	DeviceIssue {
		path:     Vec::new(),
		expected: sf!("a mounted device path"),
		kind:     ArgIssueKind::Missing,
		example:  None,
		found:    Some(Str::new(path.to_string())),
	}
}

fn hash_identity(hasher: &mut Hasher, name: &Str, rev: &Rev) {
	hash_field(hasher, name.as_bytes());
	hash_field(hasher, rev.family.as_bytes());
	hash_field(hasher, &rev.n.to_le_bytes());
}

fn projection_caps_hash(caps: &PromptCaps) -> Hash32 {
	let mut hasher = Hash32::hasher();
	hash_field(&mut hasher, &caps.maximum_parts.to_le_bytes());
	hash_field(&mut hasher, &caps.maximum_text_bytes.to_le_bytes());
	hash_field(&mut hasher, &[u8::from(caps.media)]);
	hash_field(&mut hasher, &[caps.dialect as u8]);
	hash_field(&mut hasher, &[caps.model_class as u8]);
	hasher.finalize()
}

fn hash_tool_route(hasher: &mut Hasher, route: &ToolRoute) {
	match route {
		ToolRoute::Native => hash_field(hasher, &[0]),
		ToolRoute::Remote => hash_field(hasher, &[2]),
		ToolRoute::Worker { site, name } => {
			hash_field(hasher, &[1]);
			hash_field(hasher, &[*site as u8]);
			hash_field(hasher, name.as_bytes());
		},
	}
}

fn projected_part_bytes(parts: &[Part]) -> usize {
	parts.iter().fold(0, |bytes, part| {
		let part_bytes = match part {
			Part::Text { text } => text.len(),
			Part::Json { json } => json.len(),
			Part::Blob { blob, alt } => blob
				.hash
				.len()
				.saturating_add(blob.media_type.len())
				.saturating_add(alt.as_ref().map_or(0, Str::len))
				.saturating_add(size_of::<u64>()),
		};
		bytes.saturating_add(part_bytes)
	})
}

fn hash_field(hasher: &mut Hasher, field: &[u8]) {
	let len = u64::try_from(field.len()).expect("tool identity length fits in u64");
	hasher.update(len.to_le_bytes());
	hasher.update(field);
}

fn render_arg_issue(issue: &ArgIssue) -> Str {
	let mut path = String::from("$");
	for segment in &issue.path {
		match segment {
			ArgPath::Key(key) => {
				path.push('[');
				path.push_str(&serde_json::to_string(key.as_str()).unwrap_or_else(|_| "\"?\"".into()));
				path.push(']');
			},
			ArgPath::Index(index) => {
				path.push('[');
				path.push_str(&index.to_string());
				path.push(']');
			},
		}
	}
	let kind_json = serde_json::to_string(&issue.kind)
		.expect("serializing a fieldless argument issue kind cannot fail");
	let kind = kind_json.trim_matches('"');
	let mut text = format!("invalid arguments at {path}: expected {} ({kind})", issue.expected);
	if let Some(found) = &issue.found {
		text.push_str("; found ");
		text.push_str(found);
	}
	if let Some(example) = &issue.example {
		text.push_str("; example ");
		text.push_str(example);
	}
	Str::new(text)
}

fn host_tool_stream(
	executor: Arc<dyn HostToolExecutor>,
	mut invocation: HostToolInvocation,
	mut params: IncomingParams<'_>,
) -> ErasedStream<'_> {
	Box::pin(stream! {
		invocation.arguments = match params.whole::<Map<String, Value>>().await {
			Ok(arguments) => arguments,
			Err(crate::ParamError::Args(issue)) => {
				let verdict = CallOutcome::<Value, Value>::ArgsRejected(*issue);
				yield serde_json::to_vec(&verdict)
					.map(|json| ErasedEv::Done(ErasedOutcome::Done {
						verdict: Bytes::from(json),
						useless: false,
					}))
					.map_err(RegistryError::Serialize);
				return;
			},
			Err(crate::ParamError::Interrupted(interrupt)) => {
				let verdict = CallOutcome::<Value, Value>::aborted(
					Abort::Interrupted { reason: interrupt.reason },
				);
				yield serde_json::to_vec(&verdict)
					.map(|json| ErasedEv::Done(ErasedOutcome::Done {
						verdict: Bytes::from(json),
						useless: false,
					}))
					.map_err(RegistryError::Serialize);
				return;
			},
			Err(crate::ParamError::Protocol(message)) => {
				let verdict = CallOutcome::<Value, Value>::ArgsRejected(ArgIssue {
					path: Vec::new(),
					expected: sf!("one committed host-tool argument object"),
					kind: ArgIssueKind::Protocol,
					example: None,
					found: Some(message),
				});
				yield serde_json::to_vec(&verdict)
					.map(|json| ErasedEv::Done(ErasedOutcome::Done {
						verdict: Bytes::from(json),
						useless: false,
					}))
					.map_err(RegistryError::Serialize);
				return;
			},
		};
		let cancellation = CancellationToken::new();
		let (updates_tx, updates_rx) = flume::unbounded();
		let execution = executor.execute(
			invocation,
			HostToolUpdateSink { sender: updates_tx },
			cancellation.clone(),
		);
		tokio::pin!(execution);
		let mut updates_open = true;
		loop {
			tokio::select! {
				result = &mut execution => {
					let (value, is_error) = match result {
						Ok(result) => (result.result, result.is_error),
						Err(message) => (Value::String(message.to_string()), true),
					};
					let verdict = if is_error {
						CallOutcome::<Value, Value>::Faulted(value)
					} else {
						CallOutcome::<Value, Value>::Ok(value)
					};
					yield serde_json::to_vec(&verdict)
						.map(|json| ErasedEv::Done(ErasedOutcome::Done {
							verdict: Bytes::from(json),
							useless: false,
						}))
						.map_err(RegistryError::Serialize);
					return;
				},
				interrupt = params.next_interrupt() => {
					cancellation.cancel();
					let abort = match interrupt {
						Ok(interrupt) => Abort::Interrupted { reason: interrupt.reason },
						Err(_) => Abort::InputDropped,
					};
					let verdict = CallOutcome::<Value, Value>::aborted(abort);
					yield serde_json::to_vec(&verdict)
						.map(|json| ErasedEv::Done(ErasedOutcome::Done {
							verdict: Bytes::from(json),
							useless: false,
						}))
						.map_err(RegistryError::Serialize);
					return;
				},
				update = updates_rx.recv_async(), if updates_open => {
					match update {
						Ok(update) => yield serde_json::to_vec(&update)
							.map(|json| ErasedEv::Update(Bytes::from(json)))
							.map_err(RegistryError::Serialize),
						Err(_) => updates_open = false,
					}
				},
			}
		}
	})
}

/// Enforces the freeform canonicalization contract on grammar declarations.
///
/// Recovery canonicalizes a freeform wire call into the schema's
/// [`FREEFORM_INPUT_PROPERTY`] string property; a grammar tool whose schema
/// cannot hold it could never execute on a grammar-capable transport.
fn validate_grammar_schema(spec: &ToolSpec, schema: &Value) -> Result<(), RegistryError> {
	if !matches!(spec.constraint, Constraint::Grammar { .. }) {
		return Ok(());
	}
	let accepts_input = schema
		.get("properties")
		.and_then(|properties| properties.get(FREEFORM_INPUT_PROPERTY))
		.is_some_and(|property| match property.get("type") {
			None => true,
			Some(Value::String(kind)) => kind == "string",
			Some(Value::Array(kinds)) => kinds.iter().any(|kind| kind == "string"),
			Some(_) => false,
		});
	if accepts_input {
		Ok(())
	} else {
		Err(RegistryError::GrammarInputProperty { name: spec.name.clone(), rev: spec.rev.clone() })
	}
}

fn lower(entry: &dyn ErasedTool, caps: LoweringCaps) -> Result<LoweredTool, RegistryError> {
	let spec = entry.spec();
	let mut adjustments = Vec::new();
	let (input, disposition, priority) = match &spec.constraint {
		Constraint::None => (
			ToolInputConstraint::JsonSchema { parameters: entry.schema().clone(), strict: false },
			None,
			None,
		),
		Constraint::Schema { priority, on_unsupported }
			if caps.strict_schema
				&& !schema_within_strict_subset(
					entry.schema().as_value(),
					ToolAssemblyLimits::default(),
				) =>
		{
			// Strict runtime validation rejects any call the moment it visits a
			// keyword outside the supported subset, so an out-of-subset schema
			// must degrade to best-effort validation instead of failing every
			// invocation.
			if *on_unsupported == v1::Fallback::Error {
				return Err(RegistryError::UnsupportedConstraint {
					name:    spec.name.clone(),
					rev:     spec.rev.clone(),
					feature: "strict-schema-subset",
				});
			}
			adjustments.push(dropped(&spec.name, "schema", "tool.schema-outside-strict-subset"));
			(
				ToolInputConstraint::JsonSchema {
					parameters: entry.schema().clone(),
					strict:     false,
				},
				Some(ConstraintDisposition::Prefer),
				Some(*priority),
			)
		},
		Constraint::Schema { priority, .. } if caps.strict_schema => (
			ToolInputConstraint::JsonSchema { parameters: entry.schema().clone(), strict: true },
			Some(ConstraintDisposition::Required),
			Some(*priority),
		),
		Constraint::Schema { priority, on_unsupported } => {
			if *on_unsupported == v1::Fallback::Error {
				return Err(RegistryError::UnsupportedConstraint {
					name:    spec.name.clone(),
					rev:     spec.rev.clone(),
					feature: "schema",
				});
			}
			adjustments.push(dropped(&spec.name, "schema", "catalog.strict-schema-unsupported"));
			(
				ToolInputConstraint::JsonSchema {
					parameters: entry.schema().clone(),
					strict:     false,
				},
				Some(ConstraintDisposition::Prefer),
				Some(*priority),
			)
		},
		Constraint::Grammar { syntax, definition, priority, .. }
			if caps.grammar.contains(grammar_bit(*syntax)) =>
		{
			(
				ToolInputConstraint::Grammar {
					grammar:  ToolGrammar {
						syntax:     grammar_syntax(*syntax),
						definition: definition.clone(),
					},
					fallback: entry.schema().clone(),
				},
				Some(ConstraintDisposition::Required),
				Some(*priority),
			)
		},
		Constraint::Grammar { syntax, priority, on_unsupported, .. } => {
			if *on_unsupported == v1::Fallback::Error {
				return Err(RegistryError::UnsupportedConstraint {
					name:    spec.name.clone(),
					rev:     spec.rev.clone(),
					feature: grammar_name(*syntax),
				});
			}
			adjustments.push(dropped(
				&spec.name,
				grammar_name(*syntax),
				"catalog.grammar-unsupported",
			));
			(
				ToolInputConstraint::JsonSchema {
					parameters: entry.schema().clone(),
					strict:     false,
				},
				Some(ConstraintDisposition::Prefer),
				Some(*priority),
			)
		},
	};
	Ok(LoweredTool {
		identity: spec.identity(),
		definition: ToolDefinition {
			name: spec.name.clone(),
			description: Some(spec.description.clone()),
			input,
		},
		disposition,
		priority,
		adjustments,
	})
}
const EXTENSION_PRIORITY_MAX: u8 = 127;
const CORE_PRIORITY_MIN: u8 = 128;

const fn constraint_priority(constraint: &Constraint) -> Option<u8> {
	match constraint {
		Constraint::None => None,
		Constraint::Schema { priority, .. } | Constraint::Grammar { priority, .. } => Some(*priority),
	}
}

fn advertisement_priority(entry: &RegistryEntry) -> u8 {
	let requested = constraint_priority(&entry.tool.spec().constraint).unwrap_or_default();
	if entry.claims.precedence == Precedence::CORE {
		CORE_PRIORITY_MIN.saturating_add(requested / 2)
	} else {
		requested.min(EXTENSION_PRIORITY_MAX)
	}
}

const fn constraint_requires_capacity(spec: &ToolSpec) -> bool {
	matches!(
		&spec.constraint,
		Constraint::Schema { on_unsupported: omp_proto::inference::v1::Fallback::Error, .. }
			| Constraint::Grammar { on_unsupported: omp_proto::inference::v1::Fallback::Error, .. }
	)
}

fn budget_constraint_error(spec: &ToolSpec, feature: &'static str) -> RegistryError {
	RegistryError::UnsupportedConstraint { name: spec.name.clone(), rev: spec.rev.clone(), feature }
}

const fn is_native_strict(tool: &LoweredTool) -> bool {
	matches!(&tool.definition.input, ToolInputConstraint::JsonSchema { strict: true, .. })
}

fn downgrade_strict(tool: &mut LoweredTool) {
	if let ToolInputConstraint::JsonSchema { strict, .. } = &mut tool.definition.input {
		*strict = false;
	}
	tool.disposition = Some(ConstraintDisposition::Prefer);
	tool.adjustments.push(dropped(
		&tool.definition.name,
		"schema",
		"catalog.strict-schema-budget-exhausted",
	));
}

fn external_error(spec: &ToolSpec, operation: &'static str) -> RegistryError {
	RegistryError::UnsupportedExternal { name: spec.name.clone(), rev: spec.rev.clone(), operation }
}

const fn grammar_syntax(syntax: GrammarSyntax) -> ToolGrammarSyntax {
	match syntax {
		GrammarSyntax::Lark => ToolGrammarSyntax::Lark,
		GrammarSyntax::Regex => ToolGrammarSyntax::Regex,
		GrammarSyntax::Ebnf => ToolGrammarSyntax::Ebnf,
	}
}

const fn grammar_bit(syntax: GrammarSyntax) -> GrammarBits {
	match syntax {
		GrammarSyntax::Lark => GrammarBits::LARK,
		GrammarSyntax::Regex => GrammarBits::REGEX,
		GrammarSyntax::Ebnf => GrammarBits::EBNF,
	}
}

const fn grammar_name(syntax: GrammarSyntax) -> &'static str {
	match syntax {
		GrammarSyntax::Lark => "lark",
		GrammarSyntax::Regex => "regex",
		GrammarSyntax::Ebnf => "ebnf",
	}
}

fn dropped(name: &Str, feature: &str, reason: &'static str) -> Adjustment {
	Adjustment::Dropped {
		feature: FeatureId(sf!("tool.{name}.{feature}")),
		reason:  ReasonId(Str::new(reason)),
	}
}

#[cfg(test)]
mod tests {

	use super::*;
	use crate::{Dialect, Effects, Ev, ExecEffects, ModelClass, ToolSpec};

	struct LiftTool {
		spec: ToolSpec,
	}

	impl Tool for LiftTool {
		type Fault = Value;
		type Params = Value;
		type Payload = Value;
		type Update = Value;

		fn spec(&self) -> &ToolSpec {
			&self.spec
		}

		fn prompt_docs(&self) -> Option<&str> {
			Some("long-form lift docs")
		}

		fn call<'c>(
			&'c self,
			_params: IncomingParams<'c>,
		) -> impl Stream<Item = Ev<Self::Update, Self::Payload, Self::Fault>> + Send + 'c {
			futures::stream::empty()
		}

		fn prompt(
			&self,
			_view: Result<&Self::Payload, &Self::Fault>,
			_caps: &PromptCaps,
		) -> Vec<Part> {
			Vec::new()
		}

		fn lift(&self, _from: &Rev, call: RecordedCall<'_>) -> Option<LiftedCall> {
			Some(LiftedCall {
				raw_args: Bytes::copy_from_slice(call.raw_args),
				verdict:  Bytes::copy_from_slice(call.verdict),
			})
		}
	}

	fn identity(n: u16) -> ToolIdentity {
		ToolIdentity { name: sf!("lift"), rev: Rev { family: sf!("x"), n } }
	}

	fn caps() -> PromptCaps {
		PromptCaps {
			maximum_parts:      1,
			maximum_text_bytes: 1,
			media:              false,
			dialect:            Dialect::Native,
			model_class:        ModelClass::Standard,
		}
	}

	fn tool(n: u16) -> LiftTool {
		LiftTool {
			spec: ToolSpec {
				name:            sf!("lift"),
				rev:             identity(n).rev,
				description:     sf!("lift test"),
				schema:          Bytes::from_static(b"{}"),
				constraint:      Constraint::None,
				effects:         Effects::empty(),
				projection_code: [n as u8; 32],
			},
		}
	}

	#[test]
	fn prompt_projection_borrows_exact_live_name_revision_schema_and_docs() {
		let mut registry = Registry::new();
		registry
			.register(tool(1), Presentation::Slot, Claims {
				precedence: Precedence::DEFAULT,
				claimant:   sf!("test/prompt"),
				replaces:   None,
			})
			.expect("slot registers");
		let projection = registry.prompt_projection(None);
		let entries = projection.entries().collect::<Vec<_>>();
		assert_eq!(entries.len(), 1);
		assert_eq!(entries[0].name, "lift");
		assert_eq!(entries[0].revision, &identity(1).rev);
		assert_eq!(entries[0].description, "lift test");
		assert_eq!(entries[0].schema.as_ref(), b"{}");
		assert!(entries[0].examples.is_empty());
		assert_eq!(entries[0].docs, Some("long-form lift docs"));
		assert!(std::ptr::eq(
			entries[0].schema,
			&registry.live_spec("lift").expect("live spec").schema
		));
	}

	#[test]
	fn projection_cache_returns_the_same_arc_only_for_the_same_key() {
		let cache = ProjectionCache::default();
		let key = ProjectionKey::new(&identity(1), b"{\"kind\":\"ok\"}", &caps(), [1; 32].into());
		let different =
			ProjectionKey::new(&identity(1), b"{\"kind\":\"ok\"}", &caps(), [2; 32].into());
		assert!(cache.get(0, &key).is_none());
		cache.insert(0, &key, ProjectedVerdict {
			parts:      Arc::<[Part]>::from([]),
			visibility: Arc::from([]),
			is_error:   false,
			useless:    false,
		});
		let hit = cache.get(0, &key).expect("matching key hits");
		assert!(Arc::ptr_eq(&hit, &cache.get(0, &key).expect("second matching key hits")));
		assert!(cache.get(0, &different).is_none());
	}

	#[test]
	fn claimant_qualified_device_retains_exact_selected_effects() {
		let mut registry = Registry::new();
		let low = tool(1);
		registry
			.register(low, Presentation::Device, Claims {
				precedence: Precedence::DEFAULT,
				claimant:   sf!("test/low"),
				replaces:   None,
			})
			.expect("low claimant");
		let mut high = tool(2);
		high.spec.effects = Effects {
			exec: Some(ExecEffects { commands: Arc::from([sf!("*")]), network: true }),
			..Effects::empty()
		};
		registry
			.register(high, Presentation::Device, Claims {
				precedence: Precedence::ENHANCEMENT,
				claimant:   sf!("test/high"),
				replaces:   None,
			})
			.expect("high claimant");

		let live = registry
			.resolve_device(&DevicePath::parse("lift").expect("live path"))
			.expect("live target");
		assert!(!live.effects.is_empty());
		let shadow = registry
			.resolve_device(&DevicePath::parse("lift@test/low").expect("shadow path"))
			.expect("shadow target");
		assert!(shadow.effects.is_empty());
		assert_eq!(shadow.claimant, "test/low");
	}

	#[test]
	fn registered_lift_runs_byte_stably() {
		let mut registry = Registry::new();
		let claims =
			Claims { precedence: Precedence::DEFAULT, claimant: sf!("test/lift"), replaces: None };
		registry
			.register(tool(1), Presentation::Device, claims.clone())
			.expect("first revision registers");
		registry
			.register(tool(2), Presentation::Device, claims)
			.expect("live revision registers");
		let original = RecordedCallOwned {
			identity: identity(1),
			raw_args: Bytes::from_static(br#"{"old":true}"#),
			verdict:  Bytes::from_static(br#"{"kind":"ok","value":null}"#),
		};
		let ProjectedCall::Live(lifted) = registry.project(original.clone()) else {
			panic!("registered lift must dispatch");
		};
		assert_eq!(lifted.identity, identity(2));
		assert_eq!(lifted.raw_args, original.raw_args);
		assert_eq!(lifted.verdict, original.verdict);
	}

	#[test]
	fn registrations_retain_locus_and_remote_entries_are_presentation_only() {
		let claims = Claims {
			precedence: Precedence::DEFAULT,
			claimant:   sf!("test/locus"),
			replaces:   None,
		};

		let mut session = Registry::new();
		session
			.register(tool(1), Presentation::Slot, claims.clone())
			.expect("session tool registers");
		assert_eq!(session.locus("lift").expect("session locus resolves"), ToolLocus::Session);

		let mut environment = Registry::new();
		environment
			.register_environment(tool(1), Presentation::Slot, claims.clone())
			.expect("environment tool registers");
		assert_eq!(
			environment
				.locus("lift")
				.expect("environment locus resolves"),
			ToolLocus::Environment
		);

		let mut qualified = Registry::new();
		qualified
			.register(tool(1), Presentation::Slot, Claims {
				precedence: Precedence::DEFAULT,
				claimant:   sf!("test/session"),
				replaces:   None,
			})
			.expect("qualified session tool registers");
		qualified
			.register_environment(tool(2), Presentation::Slot, Claims {
				precedence: Precedence::ENHANCEMENT,
				claimant:   sf!("test/environment"),
				replaces:   None,
			})
			.expect("winning environment tool registers");
		assert_eq!(qualified.locus("lift").expect("winning locus resolves"), ToolLocus::Environment);
		assert_eq!(
			qualified
				.locus("lift@test/session")
				.expect("claimant-qualified locus resolves"),
			ToolLocus::Session
		);

		let mut worker = Registry::new();
		worker
			.register_worker(tool(1).spec, Presentation::Slot, claims.clone())
			.expect("worker tool registers");
		assert_eq!(worker.locus("lift").expect("worker locus resolves"), ToolLocus::Session);

		let mut remote = Registry::new();
		let spec = tool(1).spec;
		let expected_spec = spec.clone();
		remote
			.declare_remote(spec, Presentation::Slot, claims, ExecutionMode::Parallel)
			.expect("remote declaration registers");
		assert_eq!(remote.locus("lift").expect("remote locus resolves"), ToolLocus::Environment);
		assert_eq!(remote.route("lift").expect("remote route resolves"), ToolRoute::Remote);
		assert_eq!(remote.live_spec("lift").expect("remote spec is live"), &expected_spec);
		assert_eq!(
			remote
				.advertise(LoweringCaps {
					strict_schema:  true,
					grammar:        GrammarBits::empty(),
					maximum_tools:  None,
					maximum_strict: None,
				})
				.expect("remote declaration advertises")
				.len(),
			1
		);
		let projection_key = ProjectionKey::new(
			&expected_spec.identity(),
			br#"{"kind":"ok","value":null}"#,
			&caps(),
			remote.projection_hash(),
		);
		let projected = ProjectedVerdict {
			parts:      Arc::<[Part]>::from([]),
			visibility: Arc::from([]),
			is_error:   false,
			useless:    false,
		};
		remote
			.cache_projected(&projection_key, projected.clone())
			.expect("remote projection can be supplied externally");
		assert_eq!(
			remote
				.project_cached(&projection_key)
				.expect("remote projection cache is readable")
				.expect("remote projection cache hits")
				.as_ref(),
			&projected
		);
		let (_feed, params) = IncomingParams::channel();
		assert!(matches!(
			remote.invoke("lift", params),
			Err(RegistryError::UnsupportedExternal { operation: "invoke", .. })
		));
	}

	struct HostExecutor;

	impl HostToolExecutor for HostExecutor {
		fn execute(
			&self,
			_invocation: HostToolInvocation,
			_updates: HostToolUpdateSink,
			_cancellation: CancellationToken,
		) -> Pin<Box<dyn Future<Output = Result<HostToolResult, Str>> + Send + 'static>> {
			Box::pin(futures::future::ready(Ok(HostToolResult {
				result:   serde_json::json!({"ok": true}),
				is_error: false,
			})))
		}
	}

	#[test]
	fn child_local_host_roster_does_not_mutate_parent_and_keeps_declared_revision() {
		let mut parent = Registry::new();
		parent
			.register(tool(1), Presentation::Slot, Claims {
				precedence: Precedence::DEFAULT,
				claimant:   sf!("test/native"),
				replaces:   None,
			})
			.expect("native tool registers");
		let names = parent.live_names();
		let child = parent.restrict(names.iter().map(Str::as_str));
		child
			.replace_host_tools(
				sf!("eval/owner/generation/handler"),
				1,
				vec![HostToolSpec {
					name:        sf!("score"),
					description: sf!("Score a candidate"),
					parameters:  serde_json::json!({"type":"object"}),
					rev:         Some(Rev { family: Str::default(), n: 9 }),
				}],
				Arc::new(HostExecutor),
			)
			.expect("child roster installs");
		assert!(parent.resolved_identity("score").is_none());
		assert_eq!(
			child
				.resolved_identity("score")
				.map(|identity| identity.rev.n),
			Some(9)
		);
		assert_eq!(child.live_names(), vec![sf!("lift"), sf!("score")]);
	}

	#[test]
	fn host_roster_replacement_is_atomic_revisioned_and_preserves_native_tools() {
		let mut registry = Registry::new();
		registry
			.register(tool(1), Presentation::Slot, Claims {
				precedence: Precedence::DEFAULT,
				claimant:   sf!("test/native"),
				replaces:   None,
			})
			.expect("native tool registers");
		let executor: Arc<dyn HostToolExecutor> = Arc::new(HostExecutor);
		registry
			.replace_host_tools(
				sf!("rpc/client"),
				1,
				vec![HostToolSpec {
					name:        sf!("alpha"),
					description: sf!("alpha host tool"),
					parameters:  serde_json::json!({"type": "object"}),
					rev:         Some(Rev { family: Str::default(), n: 7 }),
				}],
				Arc::clone(&executor),
			)
			.expect("first host roster installs");
		assert!(registry.resolved_identity("lift").is_some());
		assert_eq!(
			registry
				.resolved_identity("alpha")
				.map(|identity| identity.rev.n),
			Some(7)
		);
		assert_eq!(registry.live_names(), vec![sf!("alpha"), sf!("lift")]);
		registry
			.replace_host_tools(
				sf!("rpc/client"),
				2,
				vec![HostToolSpec {
					name:        sf!("beta"),
					description: sf!("beta host tool"),
					parameters:  serde_json::json!({"type": "object"}),
					rev:         None,
				}],
				executor,
			)
			.expect("replacement host roster installs");
		assert!(registry.resolved_identity("alpha").is_none());
		assert!(registry.resolved_identity("beta").is_some());
		assert_eq!(registry.live_names(), vec![sf!("beta"), sf!("lift")]);
		assert_eq!(registry.locus("beta").expect("host locus resolves"), ToolLocus::Session);
		assert!(matches!(
			registry.replace_host_tools(sf!("rpc/client"), 2, Vec::new(), Arc::new(HostExecutor),),
			Err(RegistryError::StaleHostRoster { .. })
		));
	}

	/// An allow-list bounds both what the model sees and what can execute, for
	/// native and host tools alike.
	#[test]
	fn restrict_keeps_only_the_named_native_and_host_tools() {
		let mut registry = Registry::new();
		registry
			.register(tool(1), Presentation::Slot, Claims {
				precedence: Precedence::DEFAULT,
				claimant:   sf!("test/native"),
				replaces:   None,
			})
			.expect("native tool registers");
		let mut other = tool(1);
		other.spec.name = sf!("other");
		registry
			.register(other, Presentation::Slot, Claims {
				precedence: Precedence::DEFAULT,
				claimant:   sf!("test/native"),
				replaces:   None,
			})
			.expect("second native tool registers");
		registry
			.replace_host_tools(
				sf!("rpc/client"),
				1,
				vec![
					HostToolSpec {
						name:        sf!("alpha"),
						description: sf!("alpha host tool"),
						parameters:  serde_json::json!({"type": "object"}),
						rev:         None,
					},
					HostToolSpec {
						name:        sf!("beta"),
						description: sf!("beta host tool"),
						parameters:  serde_json::json!({"type": "object"}),
						rev:         None,
					},
				],
				Arc::new(HostExecutor),
			)
			.expect("host roster installs");

		let restricted = registry.restrict(["lift", "beta", "missing"]);
		let advertised = restricted
			.advertise(LoweringCaps {
				strict_schema:  false,
				grammar:        GrammarBits::empty(),
				maximum_tools:  None,
				maximum_strict: None,
			})
			.expect("restricted registry advertises")
			.into_iter()
			.map(|tool| tool.definition.name)
			.collect::<Vec<_>>();
		assert_eq!(advertised, vec![sf!("beta"), sf!("lift")]);
		assert!(restricted.resolved_identity("other").is_none());
		assert!(restricted.resolved_identity("alpha").is_none());
		assert!(matches!(restricted.live_spec("other"), Err(RegistryError::UnknownTool(_))));
		let (_feed, params) = IncomingParams::channel();
		assert!(matches!(restricted.invoke("other", params), Err(RegistryError::UnknownTool(_))));
		assert_eq!(restricted.host_tool_revision("rpc/client"), Some(1));
		assert!(registry.resolved_identity("other").is_some(), "the source is untouched");
	}
}
