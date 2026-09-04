//! Capability, invocation-authority, lease, and quota enforcement for DATA.

use std::{
	collections::HashMap,
	path::{Path, PathBuf},
	str::FromStr,
	sync::{
		Arc,
		atomic::{AtomicU64, Ordering},
	},
};

use async_trait::async_trait;
use bytes::Bytes;
use omp_agent::{
	ApprovalDecision, ApprovalRoute, ApprovalScope, ApprovalSource, ApprovalSpec, ApprovalTicket,
	TicketState,
};
use omp_core::{InvocationPhase, LifecyclePhase, Str};
use omp_proto::policy::v1;
use parking_lot::Mutex;
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use thiserror::Error;
use url::Url;

use super::{
	admission,
	exthost::control::{
		ControlAuthority, ControlConnectionIdentity, ControlEffect, ControlInvocationAuthority,
		ControlProtocolError, ControlRequestContext,
	},
	worker::HostKey,
};

/// Capabilities implemented by the environment DATA plane.
pub const CAPABILITIES: &[&str] = &[
	"invocation",
	"env.exec",
	"env.process",
	"env.net",
	"env.workspace.snapshot",
	"env.worktree",
	"env.blob",
	"env.doc.read",
	"env.doc.write",
	"env.fs.read",
	"env.fs.write",
	"env.search",
	"env.lsp",
	"env.dap.read",
	"env.dap.execute",
];

/// An exact, wildcard-free set of DATA grants.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Grants(Arc<[Str]>);

impl Grants {
	/// Returns every capability this Environment actually implements.
	pub fn all() -> Self {
		Self(CAPABILITIES.iter().copied().map(Str::new_static).collect())
	}

	/// Retains supported capabilities from `grants`, removing duplicates.
	pub fn supported<I, S>(grants: I) -> Self
	where
		I: IntoIterator<Item = S>,
		S: AsRef<str>,
	{
		let mut values: Vec<Str> = grants
			.into_iter()
			.filter_map(|grant| {
				let grant = grant.as_ref();
				CAPABILITIES.contains(&grant).then(|| Str::from(grant))
			})
			.collect();
		values.sort_unstable();
		values.dedup();
		Self(values.into())
	}

	/// Computes the requested intersection without granting unsupported names.
	pub fn requested(&self, requested: &[String]) -> Self {
		Self::supported(
			requested
				.iter()
				.map(String::as_str)
				.filter(|capability| self.contains(capability)),
		)
	}

	/// Computes an exact set intersection.
	pub fn intersection(&self, other: &Self) -> Self {
		Self::supported(self.iter().filter(|capability| other.contains(capability)))
	}

	/// Returns whether this set contains `capability` exactly.
	pub fn contains(&self, capability: &str) -> bool {
		self.0.iter().any(|grant| grant.as_str() == capability)
	}

	/// Iterates grants in stable lexical order.
	pub fn iter(&self) -> impl ExactSizeIterator<Item = &str> + DoubleEndedIterator + Clone + '_ {
		self.0.iter().map(Str::as_str)
	}

	/// Converts Core's narrowed effect envelope into exact DATA capability
	/// bounds.
	pub fn from_effect_envelope(envelope: &v1::EffectEnvelope) -> Self {
		let mut grants = Vec::with_capacity(10);
		if let Some(documents) = &envelope.documents {
			if documents.read {
				grants.extend([
					"env.doc.read",
					"env.fs.read",
					"env.search",
					"env.lsp",
					"env.dap.read",
					"env.blob",
				]);
			}
			if !documents.write_globs.is_empty() {
				grants.extend(["env.doc.write", "env.fs.write", "env.blob"]);
			}
		}
		if let Some(exec) = &envelope.exec {
			if !exec.commands.is_empty() {
				grants.extend(["env.exec", "env.dap.read", "env.dap.execute", "env.blob"]);
			}
			if exec.network {
				grants.push("env.net");
			}
		}
		if let Some(desktop) = &envelope.desktop {
			if desktop.capture {
				grants.extend(["env.desktop.capture", "env.blob"]);
			}
			if desktop.accessibility {
				grants.push("env.desktop.accessibility");
			}
			if desktop.input {
				grants.push("env.desktop.input");
			}
		}
		Self::supported(grants)
	}
}

/// Immutable Environment tier for a language-server operation.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LspOperationTier {
	/// Query-only operation.
	ReadOnly,
	/// Operation that may mutate workspace state or execute a server command.
	Mutation,
}

/// Returns the immutable tier for one raw LSP request method.
pub fn lsp_request_tier(method: &str) -> LspOperationTier {
	match method {
		"workspace/executeCommand"
		| "textDocument/rename"
		| "workspace/willCreateFiles"
		| "workspace/willRenameFiles"
		| "workspace/willDeleteFiles" => LspOperationTier::Mutation,
		_ => LspOperationTier::ReadOnly,
	}
}

/// Returns the immutable tier for one raw LSP notification method.
///
/// Only connection lifecycle controls are query-tier. Every other raw
/// notification fails closed as a mutation because vendor methods can execute
/// arbitrary server commands.
pub fn lsp_notification_tier(method: &str) -> LspOperationTier {
	match method {
		"initialized" | "$/cancelRequest" | "$/setTrace" | "exit" => LspOperationTier::ReadOnly,
		_ => LspOperationTier::Mutation,
	}
}

/// Returns the exact grant required by an LSP operation tier.
pub const fn lsp_tier_capability(tier: LspOperationTier) -> &'static str {
	match tier {
		LspOperationTier::ReadOnly => "env.lsp",
		LspOperationTier::Mutation => "env.doc.write",
	}
}

/// Returns the immutable Environment tier for one DAP action.
pub const fn dap_action_tier(
	action: crate::docserver::DapAction,
) -> crate::docserver::DapApprovalTier {
	action.approval_tier()
}

/// Classifies one DAP wire action, failing closed for unknown/custom commands.
pub fn dap_command_tier(command: &str) -> crate::docserver::DapApprovalTier {
	command
		.parse::<crate::docserver::DapAction>()
		.map_or(crate::docserver::DapApprovalTier::Execution, dap_action_tier)
}

/// Returns the exact DATA capability required by one DAP action.
pub const fn dap_action_capability(action: crate::docserver::DapAction) -> &'static str {
	match dap_action_tier(action) {
		crate::docserver::DapApprovalTier::ReadOnly => "env.dap.read",
		crate::docserver::DapApprovalTier::Execution => "env.dap.execute",
	}
}

/// Returns the exact DATA capability required by one DAP wire command.
pub fn dap_command_capability(command: &str) -> &'static str {
	match dap_command_tier(command) {
		crate::docserver::DapApprovalTier::ReadOnly => "env.dap.read",
		crate::docserver::DapApprovalTier::Execution => "env.dap.execute",
	}
}

/// Invocation-scoped credentials carried by every DATA request.
pub struct DataAuthority<'a> {
	/// Stable invocation identity.
	pub invocation_id:      &'a str,
	/// Opaque Core-minted effect token.
	pub effect_token:       &'a [u8],
	/// Extension-host process generation.
	pub host_generation:    u64,
	/// Owning session generation.
	pub session_generation: u64,
}

/// A typed fail-closed DATA authorization refusal.
#[derive(Clone, Debug, Eq, Error, PartialEq)]
pub enum PolicyError {
	/// The invocation has not reached `EFFECTS_AUTHORIZED`, or has settled.
	#[error("invocation effects are not authorized")]
	EffectsNotAuthorized,
	/// The connection or invocation envelope lacks a required capability.
	#[error("capability denied: {capability}")]
	Denied {
		/// Exact capability required by the refused operation.
		capability: &'static str,
	},
	/// The effect token is absent, mismatched, revoked, or claimed by another
	/// connection.
	#[error("effect token is invalid or revoked")]
	InvalidEffectToken,
	/// The request was minted by a stale host or session generation.
	#[error("host or session generation is stale")]
	StaleGeneration,
	/// A document lease belongs to another connection.
	#[error("document lease is owned by another connection")]
	LeaseNotOwned,
	/// ENFORCE was requested while sandbox installation remains deferred.
	#[error("sandbox ENFORCE is unavailable")]
	EnforcementUnavailable,
	/// A per-extension DATA quota is exhausted.
	#[error("quota {quota} exhausted ({used}/{limit})")]
	QuotaExceeded {
		/// Stable name of the exhausted DATA resource.
		quota: &'static str,
		/// Maximum resources permitted per extension.
		limit: u64,
		/// Resources already charged when the operation was refused.
		used:  u64,
	},
}

/// Refuses ENFORCE while kernel sandbox installation is explicitly deferred.
///
/// OBSERVE/OFF policy remains outside this deferred enforcement path.
pub const fn require_sandbox_enforcement(enforce: bool) -> Result<(), PolicyError> {
	if enforce {
		Err(PolicyError::EnforcementUnavailable)
	} else {
		Ok(())
	}
}
/// Manifest capability required for extension-owned sandbox mutations.
pub const POLICY_WRITE_CAPABILITY: &str = "policy.write";
/// Manifest capability required for extension-sourced approval decisions.
pub const APPROVAL_DECIDE_CAPABILITY: &str = "approvals.decide";

/// Scope of a sandbox contribution or durable approval.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum PolicyScope {
	/// One decision offer.
	Once,
	/// Current invocation.
	Call,
	/// Current turn.
	Turn,
	/// Current session generation.
	Session,
	/// Durable operator policy.
	Persist,
}

/// Sandbox enforcement posture.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum SandboxMode {
	/// No observation or enforcement.
	Off,
	/// Observe violations without blocking.
	Observe,
	/// Enforce every requested restriction.
	Enforce,
}
impl Default for SandboxMode {
	fn default() -> Self {
		Self::Enforce
	}
}

/// One path restriction in a sandbox profile.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SandboxPathRule {
	/// Absolute or backend-scoped path.
	pub path:      Str,
	/// Whether descendants are covered.
	#[serde(default = "default_true")]
	pub recursive: bool,
	/// Whether creation is allowed.
	#[serde(default)]
	pub create:    bool,
	/// Whether deletion is allowed.
	#[serde(default)]
	pub delete:    bool,
}

const fn default_true() -> bool {
	true
}

fn default_allow() -> Str {
	Str::new_static("allow")
}

fn default_deny() -> Str {
	Str::new_static("deny")
}

fn default_proxy() -> Str {
	Str::new_static("proxy")
}

fn default_proxy_only() -> Str {
	Str::new_static("proxy_only")
}

fn default_ports() -> Vec<u16> {
	vec![80, 443]
}

/// Filesystem portion of a sandbox profile.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct SandboxFilesystemPolicy {
	/// Explicit read grants.
	pub allow_read:      Vec<SandboxPathRule>,
	/// Explicit read denials.
	pub deny_read:       Vec<SandboxPathRule>,
	/// Explicit write grants.
	pub allow_write:     Vec<SandboxPathRule>,
	/// Explicit write denials.
	pub deny_write:      Vec<SandboxPathRule>,
	/// Explicit execute grants.
	pub allow_exec:      Vec<SandboxPathRule>,
	/// Explicit execute denials.
	pub deny_exec:       Vec<SandboxPathRule>,
	/// Whether symlink traversal is permitted.
	pub follow_symlinks: bool,
	/// Optional confined temporary directory.
	pub tmpdir:          Option<Str>,
	/// Default read effect (`allow` or `deny`).
	pub read_default:    Str,
	/// Default write effect (`allow` or `deny`).
	pub write_default:   Str,
	/// Default execute effect (`allow` or `deny`).
	pub exec_default:    Str,
}

impl Default for SandboxFilesystemPolicy {
	fn default() -> Self {
		Self {
			allow_read:      Vec::new(),
			deny_read:       Vec::new(),
			allow_write:     Vec::new(),
			deny_write:      Vec::new(),
			allow_exec:      Vec::new(),
			deny_exec:       Vec::new(),
			follow_symlinks: false,
			tmpdir:          None,
			read_default:    default_deny(),
			write_default:   default_deny(),
			exec_default:    default_allow(),
		}
	}
}

/// One host and port restriction.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct SandboxDomainRule {
	/// DNS name or exact host pattern.
	pub domain: Str,
	/// Covered ports, or every port when empty.
	#[serde(default)]
	pub ports:  Vec<u16>,
}

/// Network portion of a sandbox profile.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct SandboxNetworkPolicy {
	/// `open`, `proxy`, or `deny`.
	pub mode:               Str,
	/// Explicit domain grants.
	pub allow_domains:      Vec<SandboxDomainRule>,
	/// Explicit domain denials.
	pub deny_domains:       Vec<SandboxDomainRule>,
	/// Explicit port grants.
	pub allow_ports:        Vec<u16>,
	/// Whether loopback is reachable.
	pub allow_localhost:    bool,
	/// Allowed Unix-domain socket paths.
	pub allow_unix_sockets: Vec<Str>,
	/// Allowed Mach service lookups.
	pub allow_mach_lookup:  Vec<Str>,
	/// `proxy_only`, `allow`, or `deny`.
	pub dns:                Str,
	/// Whether the runtime injects its egress proxy environment.
	pub inject_proxy_env:   bool,
}

impl Default for SandboxNetworkPolicy {
	fn default() -> Self {
		Self {
			mode:               default_proxy(),
			allow_domains:      Vec::new(),
			deny_domains:       Vec::new(),
			allow_ports:        default_ports(),
			allow_localhost:    false,
			allow_unix_sockets: Vec::new(),
			allow_mach_lookup:  Vec::new(),
			dns:                default_proxy_only(),
			inject_proxy_env:   true,
		}
	}
}

/// Process portion of a sandbox profile.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct SandboxExecPolicy {
	/// Explicit executable grants.
	pub allow:              Vec<Str>,
	/// Explicit executable denials.
	pub deny:               Vec<Str>,
	/// Default executable effect (`allow` or `deny`).
	pub default:            Str,
	/// Whether interpreter execution is permitted.
	pub allow_interpreters: bool,
	/// Whether set-id execution is permitted.
	pub allow_setuid:       bool,
	/// Whether tracing another process is permitted.
	pub allow_ptrace:       bool,
	/// Whether creating a new session is permitted.
	pub allow_new_session:  bool,
	/// Optional child-process ceiling.
	pub max_children:       Option<u32>,
}

impl Default for SandboxExecPolicy {
	fn default() -> Self {
		Self {
			allow:              Vec::new(),
			deny:               Vec::new(),
			default:            default_allow(),
			allow_interpreters: true,
			allow_setuid:       false,
			allow_ptrace:       false,
			allow_new_session:  false,
			max_children:       None,
		}
	}
}

/// Process resource ceilings. Durations are canonical wire seconds.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct SandboxResourceBudget {
	/// Wall-clock seconds.
	pub wall:             Option<f64>,
	/// CPU seconds.
	pub cpu:              Option<f64>,
	/// Resident-memory ceiling.
	pub memory_bytes:     Option<u64>,
	/// Per-file size ceiling.
	pub file_size_bytes:  Option<u64>,
	/// Open-file ceiling.
	pub open_files:       Option<u64>,
	/// Process-count ceiling.
	pub processes:        Option<u64>,
	/// Aggregate write ceiling.
	pub disk_write_bytes: Option<u64>,
	/// Captured stdout ceiling.
	pub stdout_bytes:     Option<u64>,
}

/// Complete typed sandbox contribution passed to the native runtime.
#[derive(Clone, Debug, Deserialize, PartialEq, Serialize)]
#[serde(default, deny_unknown_fields)]
pub struct SandboxProfile {
	/// Enforcement posture.
	pub mode:              SandboxMode,
	/// Filesystem restrictions.
	pub filesystem:        SandboxFilesystemPolicy,
	/// Network restrictions.
	pub network:           SandboxNetworkPolicy,
	/// Process restrictions.
	pub exec:              SandboxExecPolicy,
	/// Resource ceilings.
	pub resources:         SandboxResourceBudget,
	/// Audit label.
	pub label:             Str,
	/// Explicit violation classes ignored while observing.
	pub ignore_violations: Vec<Str>,
	/// Backends which must be present.
	pub require:           Vec<Str>,
}

impl Default for SandboxProfile {
	fn default() -> Self {
		Self {
			mode:              SandboxMode::Enforce,
			filesystem:        SandboxFilesystemPolicy::default(),
			network:           SandboxNetworkPolicy::default(),
			exec:              SandboxExecPolicy::default(),
			resources:         SandboxResourceBudget::default(),
			label:             Str::new_static(""),
			ignore_violations: Vec::new(),
			require:           Vec::new(),
		}
	}
}

/// Native sandbox facilities available to the session.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SandboxCapabilities {
	/// Available backend names.
	pub backends:         Vec<Str>,
	/// Available Landlock ABI, when applicable.
	pub landlock_abi:     Option<u32>,
	/// Whether filesystem enforcement exists.
	pub filesystem:       bool,
	/// Whether network enforcement exists.
	pub network:          bool,
	/// Whether domain filtering exists.
	pub domain_filtering: bool,
	/// Whether resource ceilings exist.
	pub resource_limits:  bool,
	/// Fail-closed degradation diagnostics.
	pub degraded:         Vec<Str>,
}

/// Receipt from the sandbox process which installed confinement.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SandboxEnforcement {
	/// `hard`, `brokered`, `best_effort`, or `none`.
	pub filesystem:       Str,
	/// `hard`, `proxy_only`, or `none`.
	pub network:          Str,
	/// `hard`, `partial`, or `none`.
	pub process:          Str,
	/// Backend which produced the receipt.
	pub backend:          Str,
	/// Restrictions the backend could not install.
	pub degraded_reasons: Vec<Str>,
}

/// Result of a native profile installation.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct InstalledSandboxProfile {
	/// Runtime-owned opaque handle.
	pub handle_id: Str,
	/// Effective installed profile, which may be narrower than requested.
	pub profile:   SandboxProfile,
}

/// Typed rejection from the policy owner or native sandbox runtime.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum PolicyControlFailure {
	/// The authenticated connection was replaced.
	#[error("the policy authority belongs to a stale connection generation")]
	StaleGeneration,
	/// The caller lacks an exact manifest capability.
	#[error("policy capability denied: {0}")]
	Capability(&'static str),
	/// The request is illegal in the current callback phase.
	#[error("policy operation is illegal in the current invocation phase")]
	Phase,
	/// An argument or profile is malformed.
	#[error("policy request is malformed: {0}")]
	Invalid(Str),
	/// A contribution would loosen installed confinement.
	#[error("sandbox profile would widen installed confinement")]
	ProfileWidened,
	/// No backend can satisfy the requested profile.
	#[error("sandbox enforcement is unavailable: {0}")]
	EnforcementUnavailable(Str),
	/// A runtime-owned profile handle does not exist for this authority.
	#[error("sandbox profile handle was not found")]
	UnknownHandle,
	/// Approval ticket does not exist.
	#[error("approval ticket was not found")]
	UnknownTicket,
	/// A different durable decision already owns the ticket.
	#[error("approval ticket already has a different decision")]
	DecisionConflict,
	/// The ticket carries a `require_human` reason and the decision did not
	/// come from a human-facing route.
	#[error("approval ticket requires a human decision")]
	HumanRequired,
	/// Durable audit failed before state could change.
	#[error("policy audit append failed: {0}")]
	Audit(Str),
}

impl PolicyControlFailure {
	fn protocol(&self) -> ControlProtocolError {
		let code = match self {
			Self::StaleGeneration => "StaleGeneration",
			Self::Capability(_) => "PermissionDenied",
			Self::Phase => "InvalidPhase",
			Self::Invalid(_) => "ProfileRejected",
			Self::ProfileWidened => "ProfileWidened",
			Self::EnforcementUnavailable(_) => "EnforcementUnavailable",
			Self::UnknownHandle => "UnknownProfileHandle",
			Self::UnknownTicket => "UnknownApprovalTicket",
			Self::DecisionConflict => "ApprovalDecisionConflict",
			Self::HumanRequired => "ApprovalHumanRequired",
			Self::Audit(_) => "PolicyAuditFailed",
		};
		ControlProtocolError::new(code, Str::from(self.to_string()))
	}
}

/// Existing sandbox/admission process boundary. The CONTROL owner never
/// evaluates or stores profiles locally.
#[async_trait]
pub trait SandboxPolicyRuntime: Send + Sync + 'static {
	/// Returns host sandbox facilities.
	async fn capabilities(&self) -> Result<SandboxCapabilities, PolicyControlFailure>;
	/// Returns the native runtime's effective profile.
	async fn effective_profile(&self, session: &str)
	-> Result<SandboxProfile, PolicyControlFailure>;
	/// Returns the native runtime's installation receipt.
	async fn enforcement(&self, session: &str) -> Result<SandboxEnforcement, PolicyControlFailure>;
	/// Installs a narrowing contribution in the existing sandbox process.
	async fn install(
		&self,
		owner: &str,
		session: &str,
		profile: SandboxProfile,
		scope: PolicyScope,
	) -> Result<InstalledSandboxProfile, PolicyControlFailure>;
	/// Revokes one runtime-owned contribution.
	async fn revoke(&self, owner: &str, handle_id: &str) -> Result<(), PolicyControlFailure>;
	/// Applies an approved narrowing amendment.
	async fn amend(
		&self,
		owner: &str,
		session: &str,
		patch: SandboxProfile,
		scope: PolicyScope,
		reason: Str,
		approval: Option<ApprovalSpec>,
	) -> Result<(), PolicyControlFailure>;
}

/// Durable journal boundary used before approval state changes.
#[async_trait]
pub trait PolicyAuditSink: Send + Sync + 'static {
	/// Persists the exact terminal approval record.
	async fn approval_decided(&self, ticket: &ApprovalTicket) -> Result<(), PolicyControlFailure>;
}

/// Authoritative policy/profile/approval CONTROL owner for one authenticated
/// extension-host connection.
pub struct PolicyControlOwner {
	identity:  Arc<ControlConnectionIdentity>,
	runtime:   Arc<dyn SandboxPolicyRuntime>,
	approvals: ApprovalRoute,
	audit:     Arc<dyn PolicyAuditSink>,
}

impl PolicyControlOwner {
	/// Binds policy authority to one authenticated connection generation.
	pub fn new(
		identity: Arc<ControlConnectionIdentity>,
		runtime: Arc<dyn SandboxPolicyRuntime>,
		approvals: ApprovalRoute,
		audit: Arc<dyn PolicyAuditSink>,
	) -> Self {
		Self { identity, runtime, approvals, audit }
	}

	fn validate_connection(
		&self,
		context: &ControlRequestContext,
	) -> Result<(), PolicyControlFailure> {
		let actual = &context.connection;
		if actual.extension == self.identity.extension
			&& actual.host_generation == self.identity.host_generation
			&& actual.session_generation == self.identity.session_generation
			&& actual.artifact_digest == self.identity.artifact_digest
			&& actual.capabilities == self.identity.capabilities
		{
			Ok(())
		} else {
			Err(PolicyControlFailure::StaleGeneration)
		}
	}

	fn require_capability(&self, capability: &'static str) -> Result<(), PolicyControlFailure> {
		if self.identity.capabilities.contains(capability) {
			Ok(())
		} else {
			Err(PolicyControlFailure::Capability(capability))
		}
	}

	fn require_active<'a>(
		&self,
		context: &'a ControlRequestContext,
		minimum: InvocationPhase,
	) -> Result<&'a ControlInvocationAuthority, PolicyControlFailure> {
		let invocation = context
			.invocation
			.as_ref()
			.ok_or(PolicyControlFailure::Phase)?;
		if invocation.lifecycle == LifecyclePhase::Active
			&& invocation.phase.allows_operation(minimum)
		{
			Ok(invocation)
		} else {
			Err(PolicyControlFailure::Phase)
		}
	}

	fn session<'a>(
		&'a self,
		context: &'a ControlRequestContext,
		arguments: &'a serde_json::Map<String, Value>,
	) -> Result<&'a str, PolicyControlFailure> {
		if let Some(session) = arguments.get("session").and_then(Value::as_str) {
			if context
				.invocation
				.as_ref()
				.is_none_or(|invocation| invocation.session.as_str() != session)
			{
				return Err(PolicyControlFailure::Capability("session scope"));
			}
			return Ok(session);
		}
		context
			.invocation
			.as_ref()
			.map(|invocation| invocation.session.as_str())
			.ok_or(PolicyControlFailure::Phase)
	}

	async fn decide(&self, ticket_id: &str, value: Value) -> Result<(), PolicyControlFailure> {
		#[derive(Deserialize)]
		struct Decision {
			approved:   bool,
			scope:      PolicyScope,
			source:     Str,
			decided_by: Option<Str>,
			reason:     Option<Str>,
			audited:    bool,
		}
		let decision: Decision = serde_json::from_value(value)
			.map_err(|error| PolicyControlFailure::Invalid(Str::from(error.to_string())))?;
		let source = ApprovalSource::from_str(decision.source.as_str())
			.map_err(|_| PolicyControlFailure::Invalid(Str::new_static("unknown approval source")))?;
		let scope = match decision.scope {
			PolicyScope::Once => Str::new_static("once"),
			PolicyScope::Call => Str::new_static("call"),
			PolicyScope::Turn => Str::new_static("turn"),
			PolicyScope::Session => Str::new_static("session"),
			PolicyScope::Persist => Str::new_static("persist"),
		};
		let decision = ApprovalDecision {
			approved: decision.approved,
			scope: ApprovalScope::from_str(scope.as_str())
				.expect("approval scope parsing is infallible"),
			source,
			decided_by: decision.decided_by,
			reason: decision.reason,
			audited: decision.audited,
		};
		let existing = self
			.approvals
			.ticket(ticket_id)
			.ok_or(PolicyControlFailure::UnknownTicket)?;
		if let Some(prior) = &existing.decision {
			return if prior == &decision {
				Ok(())
			} else {
				Err(PolicyControlFailure::DecisionConflict)
			};
		}
		// One human-only reason makes the whole merged prompt human-only.
		// Forwarding, configuration, extensions, and synthesized fallbacks
		// remain non-human even when they arrive through an authenticated
		// policy connection.
		if !matches!(decision.source, ApprovalSource::User | ApprovalSource::External)
			&& existing.reasons.iter().any(|reason| reason.require_human)
		{
			return Err(PolicyControlFailure::HumanRequired);
		}
		let mut durable = existing;
		durable.state = TicketState::Decided;
		durable.decision = Some(decision.clone());
		self.audit.approval_decided(&durable).await?;
		self
			.approvals
			.decide(ticket_id, decision)
			.ok_or(PolicyControlFailure::UnknownTicket)?;
		Ok(())
	}
}
#[async_trait]
impl ControlAuthority for PolicyControlOwner {
	fn handles(&self, operation: &str) -> bool {
		operation.starts_with("omp.policy.")
	}

	fn authorize(
		&self,
		context: &ControlRequestContext,
		operation: &str,
		_arguments: &serde_json::Map<String, Value>,
	) -> Result<(), ControlProtocolError> {
		self
			.validate_connection(context)
			.map_err(|error| error.protocol())?;
		match operation {
			"omp.policy.parse"
			| "omp.policy.match_paths"
			| "omp.policy.capabilities"
			| "omp.policy.effective_profile"
			| "omp.policy.enforcement"
			| "omp.policy.pending" => {
				if context
					.invocation
					.as_ref()
					.is_some_and(|invocation| invocation.lifecycle == LifecyclePhase::Degraded)
				{
					return Err(PolicyControlFailure::Phase.protocol());
				}
			},
			"omp.policy.install" | "omp.policy.revoke" => {
				self
					.require_capability(POLICY_WRITE_CAPABILITY)
					.map_err(|error| error.protocol())?;
				self
					.require_active(context, InvocationPhase::Open)
					.map_err(|error| error.protocol())?;
			},
			"omp.policy.amend" => {
				self
					.require_capability(POLICY_WRITE_CAPABILITY)
					.map_err(|error| error.protocol())?;
				self
					.require_active(context, InvocationPhase::Admission)
					.map_err(|error| error.protocol())?;
			},
			"omp.policy.decide" => {
				self
					.require_capability(APPROVAL_DECIDE_CAPABILITY)
					.map_err(|error| error.protocol())?;
				self
					.require_active(context, InvocationPhase::Open)
					.map_err(|error| error.protocol())?;
			},
			_ => {
				return Err(ControlProtocolError::new("UnknownOperation", "unknown policy operation"));
			},
		}
		Ok(())
	}

	async fn request(
		&self,
		context: ControlRequestContext,
		operation: Str,
		mut arguments: serde_json::Map<String, Value>,
	) -> Result<Value, ControlProtocolError> {
		self.authorize(&context, operation.as_str(), &arguments)?;
		match operation.as_str() {
			"omp.policy.parse" => {
				let script = take_string(&mut arguments, "script")?;
				if script.len() > 262_144 {
					return Err(ControlProtocolError::new(
						"PolicyInputTooLarge",
						"shell source exceeds 262144 bytes",
					));
				}
				let cwd = policy_cwd(&context, arguments.remove("cwd").as_ref())?;
				Ok(user_bash_ir(&script, &cwd, &policy_root(&context)?))
			},
			"omp.policy.match_paths" => match_paths_json(&context, &mut arguments),
			"omp.policy.capabilities" => serde_json::to_value(
				self
					.runtime
					.capabilities()
					.await
					.map_err(|error| error.protocol())?,
			)
			.map_err(policy_serialization),
			"omp.policy.effective_profile" => {
				let session = self
					.session(&context, &arguments)
					.map_err(|error| error.protocol())?;
				serde_json::to_value(
					self
						.runtime
						.effective_profile(session)
						.await
						.map_err(|error| error.protocol())?,
				)
				.map_err(policy_serialization)
			},
			"omp.policy.enforcement" => {
				let session = self
					.session(&context, &arguments)
					.map_err(|error| error.protocol())?;
				serde_json::to_value(
					self
						.runtime
						.enforcement(session)
						.await
						.map_err(|error| error.protocol())?,
				)
				.map_err(policy_serialization)
			},
			"omp.policy.install" => {
				let invocation = self
					.require_active(&context, InvocationPhase::Open)
					.map_err(|error| error.protocol())?;
				let profile = take_typed(&mut arguments, "profile")?;
				let scope = take_typed(&mut arguments, "scope")?;
				serde_json::to_value(
					self
						.runtime
						.install(
							self.identity.extension.as_str(),
							invocation.session.as_str(),
							profile,
							scope,
						)
						.await
						.map_err(|error| error.protocol())?,
				)
				.map_err(policy_serialization)
			},
			"omp.policy.revoke" => {
				let handle_id = take_string(&mut arguments, "handle_id")?;
				self
					.runtime
					.revoke(self.identity.extension.as_str(), &handle_id)
					.await
					.map_err(|error| error.protocol())?;
				Ok(Value::Null)
			},
			"omp.policy.amend" => {
				let invocation = self
					.require_active(&context, InvocationPhase::Admission)
					.map_err(|error| error.protocol())?;
				let patch = take_typed(&mut arguments, "patch")?;
				let scope = take_typed(&mut arguments, "scope")?;
				let reason = Str::from(take_string(&mut arguments, "reason")?);
				let approval = arguments
					.remove("approval")
					.filter(|value| !value.is_null())
					.map(approval_spec)
					.transpose()?;
				self
					.runtime
					.amend(
						self.identity.extension.as_str(),
						invocation.session.as_str(),
						patch,
						scope,
						reason,
						approval,
					)
					.await
					.map_err(|error| error.protocol())?;
				Ok(Value::Null)
			},
			"omp.policy.pending" => Ok(Value::Array(
				self
					.approvals
					.pending()
					.iter()
					.map(approval_ticket_json)
					.collect(),
			)),
			"omp.policy.decide" => {
				let ticket_id = take_string(&mut arguments, "ticket_id")?;
				let decision = arguments.remove("decision").ok_or_else(|| {
					ControlProtocolError::new("InvalidArguments", "approval decision is required")
				})?;
				self
					.decide(&ticket_id, decision)
					.await
					.map_err(|error| error.protocol())?;
				Ok(Value::Null)
			},
			_ => unreachable!("authorize rejects unknown policy operations"),
		}
	}

	async fn effect(
		&self,
		context: ControlRequestContext,
		_effect: ControlEffect,
	) -> Result<(), ControlProtocolError> {
		self
			.validate_connection(&context)
			.map_err(|error| error.protocol())?;
		Err(ControlProtocolError::new("UnsupportedEffect", "policy authority accepts requests only"))
	}
}

fn take_string(
	arguments: &mut serde_json::Map<String, Value>,
	name: &'static str,
) -> Result<String, ControlProtocolError> {
	arguments
		.remove(name)
		.and_then(|value| value.as_str().map(ToOwned::to_owned))
		.filter(|value| !value.is_empty())
		.ok_or_else(|| {
			ControlProtocolError::new("InvalidArguments", format!("{name} must be a non-empty string"))
		})
}
fn policy_serialization(error: serde_json::Error) -> ControlProtocolError {
	ControlProtocolError::new("PolicySerialization", Str::from(error.to_string()))
}

fn take_typed<T: for<'de> Deserialize<'de>>(
	arguments: &mut serde_json::Map<String, Value>,
	name: &'static str,
) -> Result<T, ControlProtocolError> {
	let value = arguments.remove(name).ok_or_else(|| {
		ControlProtocolError::new("InvalidArguments", format!("{name} is required"))
	})?;
	serde_json::from_value(value)
		.map_err(|error| ControlProtocolError::new("InvalidArguments", format!("{name}: {error}")))
}

fn policy_cwd(
	context: &ControlRequestContext,
	requested: Option<&Value>,
) -> Result<PathBuf, ControlProtocolError> {
	let invocation = context.invocation.as_ref().ok_or_else(|| {
		ControlProtocolError::new(
			"InvalidPhase",
			"policy path analysis requires invocation workspace roots",
		)
	})?;
	let roots = invocation
		.roots
		.iter()
		.map(|root| control_root_path(root.as_str()))
		.collect::<Vec<_>>();
	let root = roots.first().ok_or_else(|| {
		ControlProtocolError::new(
			"WorkspaceScopeDenied",
			"policy path analysis requires an authenticated workspace root",
		)
	})?;
	let cwd = requested
		.and_then(Value::as_str)
		.filter(|value| !value.is_empty())
		.map_or_else(|| root.clone(), PathBuf::from);
	let cwd = if cwd.is_absolute() {
		cwd
	} else {
		root.join(cwd)
	};
	if roots.iter().any(|candidate| cwd.starts_with(candidate)) {
		Ok(cwd)
	} else {
		Err(ControlProtocolError::new(
			"WorkspaceScopeDenied",
			"policy cwd is outside authenticated workspace roots",
		))
	}
}
fn control_root_path(root: &str) -> PathBuf {
	Url::parse(root)
		.ok()
		.and_then(|url| url.to_file_path().ok())
		.unwrap_or_else(|| PathBuf::from(root))
}
fn policy_root(context: &ControlRequestContext) -> Result<PathBuf, ControlProtocolError> {
	context
		.invocation
		.as_ref()
		.and_then(|invocation| invocation.roots.first())
		.map(|root| control_root_path(root.as_str()))
		.ok_or_else(|| {
			ControlProtocolError::new(
				"WorkspaceScopeDenied",
				"policy analysis requires an authenticated workspace root",
			)
		})
}

fn span_json(span: Option<&v1::Span>) -> Value {
	let span = span.cloned().unwrap_or_default();
	json!({"start": span.start, "end": span.end, "line": span.line, "column": span.column})
}

fn path_ref_json(path: &v1::PathRef) -> Value {
	json!({
		"lexical": path.lexical,
		"resolved": path.resolved,
		"absolute": path.absolute,
		"access": path.access,
		"origin": match path.origin.as_str() {
			"redirect" => "redirect",
			"assignment" => "assignment",
			"cwd" => "cwd",
			"heredoc" => "heredoc",
			"interpreter" => "interpreter",
			"process_sub" => "process_sub",
			"test" => "test",
			_ => "argv",
		},
		"command_index": path.command_index,
		"outside_workspace": path.outside_workspace,
		"exists": path.exists,
		"dynamic": path.dynamic,
		"span": span_json(path.span.as_ref()),
	})
}

fn net_ref_json(net: &v1::NetRef) -> Value {
	json!({
		"kind": match net.kind.as_str() {
			"http" | "https" | "url" => "http",
			"git" | "git_remote" => "git_remote",
			"ssh" => "ssh",
			"scp" => "scp",
			"rsync" => "rsync",
			"dns" => "dns",
			"socket" | "raw_socket" => "raw_socket",
			"package_manager" => "package_manager",
			_ => "unknown",
		},
		"direction": if net.direction == "outbound" { "egress" } else { net.direction.as_str() },
		"host": net.host,
		"port": net.port,
		"scheme": net.scheme,
		"url": net.url,
		"command_index": net.command_index,
		"dynamic": net.dynamic,
		"span": span_json(net.span.as_ref()),
	})
}

fn redirect_json(redirect: &v1::BashRedirect) -> Value {
	json!({
		"fd": redirect.fd,
		"op": match redirect.op.as_str() {
			"<" => "read",
			">" => "write",
			">>" => "append",
			"<>" => "read_write",
			">|" => "clobber",
			"<&" => "dup_in",
			">&" => "dup_out",
			"<<" | "<<-" => "here_doc",
			"<<<" => "here_string",
			"&>" | "&>>" | ">&>>" => "out_and_err",
			value => value,
		},
		"target_kind": match redirect.target_kind.as_str() {
			"filename" => "file",
			"process_substitution" => "process_sub",
			value => value,
		},
		"target": redirect.target,
		"target_fd": redirect.target_fd,
		"process_sub": Value::Null,
		"heredoc": Value::Null,
		"dynamism": redirect.dynamism,
		"path": redirect.path.as_ref().map(path_ref_json),
		"span": span_json(redirect.span.as_ref()),
	})
}

fn command_json(command: &v1::BashCommand) -> Value {
	json!({
		"index": command.index,
		"name": command.name,
		"argv": command.argv.iter().map(|arg| json!({
			"text": literal_argument_text(arg.text.as_str()),
			"dynamic": arg.dynamic,
			"dynamism": arg.dynamism,
			"quoting": if arg.quoting.is_empty() { "bare" } else { arg.quoting.as_str() },
			"span": span_json(arg.span.as_ref()),
		})).collect::<Vec<_>>(),
		"dynamic_args": command.dynamic_args,
		"env": Vec::<Value>::new(),
		"redirects": command.redirects.iter().map(redirect_json).collect::<Vec<_>>(),
		"process_subs": Vec::<Value>::new(),
		"reads": command.reads.iter().map(path_ref_json).collect::<Vec<_>>(),
		"writes": command.writes.iter().map(path_ref_json).collect::<Vec<_>>(),
		"net": command.net.iter().map(net_ref_json).collect::<Vec<_>>(),
		"cwd": command.cwd,
		"depth": command.depth,
		"container": if command.container.is_empty() { Value::Null } else { Value::String(command.container.clone()) },
		"subshell": command.subshell,
		"builtin": command.classification & 1 != 0,
		"coreutil": command.classification & 2 != 0,
		"external": command.classification == 0 || command.classification & 4 != 0,
		"read_only": command.writes.is_empty()
			&& command.net.is_empty()
			&& command.interpreter_code.is_none()
			&& matches!(
				command.name.as_deref(),
				Some(
					"cat"
						| "head"
						| "tail"
						| "less"
						| "more"
						| "wc"
						| "ls"
						| "stat"
						| "file"
						| "sort"
						| "uniq"
						| "cut"
						| "readlink"
						| "realpath"
						| "grep"
						| "tr"
						| "basename"
						| "dirname"
						| "which"
						| "pwd"
						| "env"
						| "date"
						| "echo"
						| "printf"
						| "true"
						| "false"
						| "test"
						| "["
						| "]"
				)
			),
		"interpreter_code": command.interpreter_code,
		"span": span_json(command.span.as_ref()),
	})
}
fn literal_argument_text(text: &str) -> &str {
	match text.as_bytes() {
		[first, .., last] if first == last && matches!(first, b'\'' | b'"') => {
			&text[1..text.len() - 1]
		},
		_ => text,
	}
}

/// Parses one direct user shell submission into the canonical BashIR JSON
/// consumed by policy and hook admission.
pub fn user_bash_ir(script: &str, cwd: &Path, root: &Path) -> Value {
	let ir = admission::bash_ir("bash", &json!({"command": script}), cwd, root)
		.expect("shell analysis always returns BashIr");
	bash_ir_json(&ir, script)
}

/// Projects one environment-produced Bash IR fact into the public hook shape.
pub(crate) fn bash_ir_json(ir: &v1::BashIr, script: &str) -> Value {
	let parse_error = ir
		.parse_error
		.as_ref()
		.map(|message| json!({"kind": "syntax", "message": message, "span": Value::Null}));
	let opaque = ir
		.opaque
		.iter()
		.map(|name| {
			json!({
				"command_index": 0,
				"name": name,
				"reason": if name == "eval" { "eval" } else { "dynamic_name" },
				"span": span_json(None),
			})
		})
		.collect::<Vec<_>>();
	let command_values = ir.commands.iter().map(command_json).collect::<Vec<_>>();
	let mut pipeline_commands = vec![Vec::<Value>::new()];
	let mut operators = Vec::<&str>::new();
	for (index, command) in ir.commands.iter().enumerate() {
		if index > 0 {
			let previous_end = ir.commands[index - 1]
				.span
				.as_ref()
				.map_or(0, |span| span.end as usize);
			let next_start = command
				.span
				.as_ref()
				.map_or(previous_end, |span| span.start as usize);
			let separator = script.get(previous_end..next_start).unwrap_or_default();
			if separator.contains("&&") || separator.contains("||") {
				operators.push(if separator.contains("&&") {
					"and"
				} else {
					"or"
				});
				pipeline_commands.push(Vec::new());
			}
		}
		pipeline_commands
			.last_mut()
			.expect("at least one pipeline exists")
			.push(command_values[index].clone());
	}
	let lists = (!command_values.is_empty()).then(|| {
		let pipelines = pipeline_commands
			.into_iter()
			.map(|commands| {
				let span = commands
					.first()
					.and_then(|command| command.get("span"))
					.cloned()
					.unwrap_or_else(|| span_json(None));
				json!({"commands": commands, "negated": false, "timed": false, "span": span})
			})
			.collect::<Vec<_>>();
		json!({
			"pipelines": pipelines,
			"operators": operators,
			"separator": "sequence",
			"span": span_json(ir.commands.first().and_then(|command| command.span.as_ref())),
		})
	});
	json!({
		"source": script,
		"rev": if ir.rev.is_empty() { "bashir@3" } else { ir.rev.as_str() },
		"parser_rev": if ir.parser_rev.is_empty() { "omp-shell" } else { ir.parser_rev.as_str() },
		"parse_ok": ir.parse_ok,
		"parse_error": parse_error,
		"truncated": ir.truncated,
		"node_count": ir.node_count,
		"is_compound": ir.is_compound,
		"has_dynamic_eval": ir.has_dynamic_eval,
		"lists": lists.into_iter().collect::<Vec<_>>(),
		"commands": command_values,
		"functions": Vec::<Value>::new(),
		"reads": ir.reads.iter().map(path_ref_json).collect::<Vec<_>>(),
		"writes": ir.writes.iter().map(path_ref_json).collect::<Vec<_>>(),
		"net": ir.net.iter().map(net_ref_json).collect::<Vec<_>>(),
		"opaque": opaque,
	})
}

fn match_paths_json(
	context: &ControlRequestContext,
	arguments: &mut serde_json::Map<String, Value>,
) -> Result<Value, ControlProtocolError> {
	let lexical = take_string(arguments, "path")?;
	let patterns = arguments
		.remove("patterns")
		.and_then(|value| value.as_array().cloned())
		.unwrap_or_default()
		.into_iter()
		.map(|value| {
			value.as_str().map(ToOwned::to_owned).ok_or_else(|| {
				ControlProtocolError::new("InvalidArguments", "path patterns must be strings")
			})
		})
		.collect::<Result<Vec<_>, _>>()?;
	let cwd = policy_cwd(context, arguments.remove("cwd").as_ref())?;
	let resolved = if Path::new(&lexical).is_absolute() {
		PathBuf::from(&lexical)
	} else {
		cwd.join(&lexical)
	};
	let matched = if patterns.is_empty() {
		true
	} else {
		let mut builder = globset::GlobSetBuilder::new();
		for pattern in &patterns {
			builder.add(globset::Glob::new(pattern).map_err(|error| {
				ControlProtocolError::new("InvalidPattern", Str::from(error.to_string()))
			})?);
		}
		let set = builder.build().map_err(|error| {
			ControlProtocolError::new("InvalidPattern", Str::from(error.to_string()))
		})?;
		set.is_match(&lexical) || set.is_match(&resolved)
	};
	if !matched {
		return Ok(Value::Array(Vec::new()));
	}
	let invocation = context.invocation.as_ref().ok_or_else(|| {
		ControlProtocolError::new("InvalidPhase", "path matching requires invocation authority")
	})?;
	let within = invocation
		.roots
		.iter()
		.any(|root| resolved.starts_with(root.as_str()));
	let access = arguments
		.remove("access")
		.and_then(|value| value.as_u64())
		.unwrap_or(0);
	Ok(Value::Array(vec![json!({
		"lexical": lexical,
		"resolved": resolved.to_string_lossy(),
		"absolute": resolved.to_string_lossy(),
		"access": access,
		"origin": "argv",
		"command_index": 0,
		"outside_workspace": !within,
		"exists": within && resolved.try_exists().unwrap_or(false),
		"dynamic": false,
		"span": {"start": 0, "end": 0, "line": 1, "column": 1},
	})]))
}

pub(crate) fn approval_spec(value: Value) -> Result<ApprovalSpec, ControlProtocolError> {
	let object = value
		.as_object()
		.ok_or_else(|| ControlProtocolError::new("InvalidArguments", "approval must be an object"))?;
	let required = |name: &'static str| {
		object
			.get(name)
			.and_then(Value::as_str)
			.filter(|value| !value.is_empty())
			.map(Str::from)
			.ok_or_else(|| {
				ControlProtocolError::new("InvalidArguments", format!("approval {name} is required"))
			})
	};
	let scopes = object
		.get("scopes")
		.and_then(Value::as_array)
		.map(|values| {
			values
				.iter()
				.filter_map(Value::as_str)
				.map(Str::from)
				.collect()
		})
		.unwrap_or_else(|| vec![Str::new_static("once"), Str::new_static("session")]);
	let timeout_ms = object
		.get("timeout")
		.and_then(Value::as_f64)
		.map_or(300_000, |seconds| (seconds.max(0.0) * 1_000.0) as u64);
	Ok(ApprovalSpec {
		title: required("title")?,
		body: required("body")?,
		subject: required("subject")?,
		kind: object
			.get("kind")
			.and_then(Value::as_str)
			.map_or_else(|| Str::new_static("exec"), Str::from),
		scopes,
		default: object.get("default").and_then(Value::as_bool),
		route: object
			.get("route")
			.and_then(Value::as_str)
			.map_or_else(|| Str::new_static("auto"), Str::from),
		approver: object
			.get("approver")
			.and_then(Value::as_str)
			.map(Str::from),
		timeout_ms,
		unreachable: object
			.get("unreachable")
			.and_then(Value::as_str)
			.map_or_else(|| Str::new_static("fail_closed"), Str::from),
		require_human: object
			.get("require_human")
			.and_then(Value::as_bool)
			.unwrap_or(false),
		pattern: object.get("pattern").and_then(Value::as_str).map(Str::from),
		evidence: object
			.get("evidence")
			.and_then(Value::as_array)
			.into_iter()
			.flatten()
			.filter_map(Value::as_str)
			.map(Str::from)
			.collect(),
	})
}

fn approval_decision_json(decision: &ApprovalDecision) -> Value {
	json!({
		"approved": decision.approved,
		"scope": decision.scope,
		"source": <&'static str>::from(decision.source),
		"decided_by": decision.decided_by,
		"reason": decision.reason,
		"audited": decision.audited,
	})
}

fn approval_ticket_json(ticket: &ApprovalTicket) -> Value {
	json!({
		"ticket_id": ticket.ticket_id,
		"invocation_id": ticket.invocation_id,
		"reasons": ticket.reasons.iter().map(|reason| json!({
			"title": reason.title,
			"body": reason.body,
			"subject": reason.subject,
			"kind": reason.kind,
			"scopes": reason.scopes,
			"default": reason.default,
			"route": reason.route,
			"approver": reason.approver,
			"timeout": reason.timeout_ms as f64 / 1_000.0,
			"unreachable": reason.unreachable,
			"require_human": reason.require_human,
			"pattern": reason.pattern,
			"evidence": reason.evidence,
		})).collect::<Vec<_>>(),
		"state": <&'static str>::from(ticket.state),
		"decision": ticket.decision.as_ref().map(approval_decision_json),
		"created_at": ticket.created_at_ms as f64 / 1_000.0,
	})
}

#[derive(Clone)]
struct AuthorizedInvocation {
	phase:              omp_core::InvocationPhase,
	effect_token:       Bytes,
	envelope:           Grants,
	authorized_at_ms:   u64,
	host_generation:    u64,
	session_generation: u64,
	claimed_by:         Option<u64>,
}

#[derive(Default)]
struct HostAuthority {
	grants:      Grants,
	invocations: HashMap<Str, AuthorizedInvocation>,
	quota:       [u64; Quota::COUNT],
}

#[derive(Default)]
struct AuthorityState {
	hosts:  HashMap<HostKey, HostAuthority>,
	leases: HashMap<Bytes, u64>,
}

/// Shared authoritative invocation/token table for all connections of one
/// Environment.
#[derive(Default)]
pub struct AuthorityTable {
	state:           Mutex<AuthorityState>,
	next_connection: AtomicU64,
}

impl AuthorityTable {
	/// Allocates an opaque connection owner used to bind tokens and leases.
	pub fn connection_owner(&self) -> u64 {
		self
			.next_connection
			.fetch_add(1, Ordering::Relaxed)
			.wrapping_add(1)
	}

	/// Installs the manifest-derived extension grants for one host.
	pub fn register_host(&self, host: HostKey, grants: Grants) {
		let mut state = self.state.lock();
		state.hosts.entry(host).or_default().grants = grants;
	}

	/// Records a newly opened extension invocation at `OPEN`.
	pub fn open(&self, host: HostKey, invocation_id: Str) {
		let mut state = self.state.lock();
		state.hosts.entry(host).or_default().invocations.insert(
			invocation_id,
			AuthorizedInvocation {
				phase:              omp_core::InvocationPhase::Open,
				effect_token:       Bytes::new(),
				envelope:           Grants::default(),
				authorized_at_ms:   0,
				host_generation:    0,
				session_generation: 0,
				claimed_by:         None,
			},
		);
	}

	/// Advances an open invocation through the canonical seven-phase machine and
	/// installs the exact Core-minted effect token and narrowed envelope.
	pub fn authorize(
		&self,
		host: &HostKey,
		invocation_id: &str,
		effect_token: Bytes,
		envelope: Grants,
		authorized_at_ms: u64,
		host_generation: u64,
		session_generation: u64,
	) -> Result<(), PolicyError> {
		if effect_token.is_empty() {
			return Err(PolicyError::InvalidEffectToken);
		}
		if authorized_at_ms == 0 {
			return Err(PolicyError::EffectsNotAuthorized);
		}
		let mut state = self.state.lock();
		let Some(host_authority) = state.hosts.get_mut(host) else {
			return Err(PolicyError::Denied { capability: "extension host" });
		};
		let bounded_envelope = host_authority.grants.intersection(&envelope);
		let Some(invocation) = host_authority.invocations.get_mut(invocation_id) else {
			return Err(PolicyError::EffectsNotAuthorized);
		};
		if invocation.phase != omp_core::InvocationPhase::Open {
			return Err(PolicyError::InvalidEffectToken);
		}
		for phase in [
			omp_core::InvocationPhase::ArgsFinalized,
			omp_core::InvocationPhase::Admission,
			omp_core::InvocationPhase::Admitted,
			omp_core::InvocationPhase::AssistantItemCommitted,
			omp_core::InvocationPhase::EffectsAuthorized,
		] {
			debug_assert!(invocation.phase.can_transition_to(phase));
			invocation.phase = phase;
		}
		invocation.effect_token = effect_token;
		invocation.envelope = bounded_envelope;
		invocation.authorized_at_ms = authorized_at_ms;
		invocation.host_generation = host_generation;
		invocation.session_generation = session_generation;
		Ok(())
	}

	/// Returns whether `invocation_id` names a live extension-worker invocation.
	pub fn is_worker_invocation(&self, host: &HostKey, invocation_id: &str) -> bool {
		self
			.state
			.lock()
			.hosts
			.get(host)
			.is_some_and(|authority| authority.invocations.contains_key(invocation_id))
	}

	/// Validates phase, exact token, generations, connection binding, and effect
	/// envelope.
	pub fn validate(
		&self,
		host: &HostKey,
		connection_owner: u64,
		credentials: DataAuthority<'_>,
		capability: &'static str,
	) -> Result<(), PolicyError> {
		let mut state = self.state.lock();
		let Some(invocation) = state
			.hosts
			.get_mut(host)
			.and_then(|authority| authority.invocations.get_mut(credentials.invocation_id))
		else {
			return Err(PolicyError::EffectsNotAuthorized);
		};
		if invocation.authorized_at_ms == 0
			|| !invocation
				.phase
				.allows_operation(omp_core::InvocationPhase::EffectsAuthorized)
		{
			return Err(PolicyError::EffectsNotAuthorized);
		}
		if invocation.host_generation != credentials.host_generation
			|| invocation.session_generation != credentials.session_generation
		{
			return Err(PolicyError::StaleGeneration);
		}
		if invocation.effect_token.as_ref() != credentials.effect_token
			|| credentials.effect_token.is_empty()
		{
			return Err(PolicyError::InvalidEffectToken);
		}
		match invocation.claimed_by {
			Some(owner) if owner != connection_owner => return Err(PolicyError::InvalidEffectToken),
			Some(_) => {},
			None => invocation.claimed_by = Some(connection_owner),
		}
		if !invocation.envelope.contains(capability) {
			return Err(PolicyError::Denied { capability });
		}
		Ok(())
	}

	/// Validates a read-class DATA request's authorization phase, token,
	/// generations, and connection ownership without requiring a mutation
	/// capability in the narrowed effect envelope.
	pub fn validate_read(
		&self,
		host: &HostKey,
		connection_owner: u64,
		credentials: DataAuthority<'_>,
	) -> Result<(), PolicyError> {
		let mut state = self.state.lock();
		let Some(invocation) = state
			.hosts
			.get_mut(host)
			.and_then(|authority| authority.invocations.get_mut(credentials.invocation_id))
		else {
			return Err(PolicyError::EffectsNotAuthorized);
		};
		if invocation.authorized_at_ms == 0
			|| !invocation
				.phase
				.allows_operation(omp_core::InvocationPhase::EffectsAuthorized)
		{
			return Err(PolicyError::EffectsNotAuthorized);
		}
		if invocation.host_generation != credentials.host_generation
			|| invocation.session_generation != credentials.session_generation
		{
			return Err(PolicyError::StaleGeneration);
		}
		if invocation.effect_token.as_ref() != credentials.effect_token
			|| credentials.effect_token.is_empty()
		{
			return Err(PolicyError::InvalidEffectToken);
		}
		match invocation.claimed_by {
			Some(owner) if owner != connection_owner => return Err(PolicyError::InvalidEffectToken),
			Some(_) => {},
			None => invocation.claimed_by = Some(connection_owner),
		}
		Ok(())
	}

	/// Settles an invocation and revokes its token before returning.
	pub fn settle(&self, host: &HostKey, invocation_id: &str) {
		let mut state = self.state.lock();
		if let Some(authority) = state.hosts.get_mut(host)
			&& let Some(mut invocation) = authority.invocations.remove(invocation_id)
		{
			if invocation.phase == omp_core::InvocationPhase::EffectsAuthorized {
				invocation.phase = omp_core::InvocationPhase::Settled;
			}
			invocation.effect_token = Bytes::new();
		}
	}

	/// Records ownership of a newly opened document lease.
	pub fn register_lease(&self, lease_id: Bytes, connection_owner: u64) {
		self.state.lock().leases.insert(lease_id, connection_owner);
	}

	/// Checks that a lease belongs to the requesting connection.
	pub fn check_lease(&self, lease_id: &[u8], connection_owner: u64) -> Result<(), PolicyError> {
		match self.state.lock().leases.get(lease_id) {
			Some(owner) if *owner == connection_owner => Ok(()),
			Some(_) => Err(PolicyError::LeaseNotOwned),
			None => Ok(()),
		}
	}

	/// Removes a lease from the cross-connection ownership table.
	pub fn release_lease(&self, lease_id: &[u8], connection_owner: u64) {
		let mut state = self.state.lock();
		if state.leases.get(lease_id).copied() == Some(connection_owner) {
			state.leases.remove(lease_id);
		}
	}

	fn reserve(&self, host: &HostKey, quota: Quota, amount: u64) -> Result<(), PolicyError> {
		let mut state = self.state.lock();
		let usage = &mut state.hosts.entry(host.clone()).or_default().quota[quota.index];
		let Some(next) = usage.checked_add(amount) else {
			return Err(PolicyError::QuotaExceeded {
				quota: quota.name,
				limit: quota.limit,
				used:  *usage,
			});
		};
		if next > quota.limit {
			return Err(PolicyError::QuotaExceeded {
				quota: quota.name,
				limit: quota.limit,
				used:  *usage,
			});
		}
		*usage = next;
		Ok(())
	}

	fn release(&self, host: &HostKey, quota: Quota, amount: u64) {
		let mut state = self.state.lock();
		if let Some(authority) = state.hosts.get_mut(host) {
			authority.quota[quota.index] = authority.quota[quota.index].saturating_sub(amount);
		}
	}
}

#[derive(Clone, Copy)]
struct Quota {
	index: usize,
	name:  &'static str,
	limit: u64,
}

impl Quota {
	const BLOB_INGEST: Self =
		Self { index: 2, name: "blob_ingest_bytes", limit: 256 * 1024 * 1024 };
	const COUNT: usize = 5;
	const DOCUMENT_LEASES: Self = Self { index: 0, name: "document_leases", limit: 128 };
	const EXEC_CONCURRENCY: Self = Self { index: 3, name: "exec_concurrency", limit: 32 };
	const PROCESS_CHURN: Self = Self { index: 1, name: "process_churn", limit: 256 };
	const STREAM_FANOUT: Self = Self { index: 4, name: "stream_fanout", limit: 64 };
}

/// Per-connection quota accounting backed by the extension-wide ledger.
pub struct QuotaAccount {
	table: AuthorityTableRef,
	host:  Option<HostKey>,
	usage: [u64; Quota::COUNT],
}

type AuthorityTableRef = Arc<AuthorityTable>;

impl QuotaAccount {
	/// Creates accounting for an owner or extension connection.
	pub const fn new(table: AuthorityTableRef, host: Option<HostKey>) -> Self {
		Self { table, host, usage: [0; Quota::COUNT] }
	}

	fn reserve(&mut self, quota: Quota, amount: u64) -> Result<(), PolicyError> {
		if let Some(host) = &self.host {
			self.table.reserve(host, quota, amount)?;
		}
		self.usage[quota.index] = self.usage[quota.index].saturating_add(amount);
		Ok(())
	}

	fn release(&mut self, quota: Quota, amount: u64) {
		let released = amount.min(self.usage[quota.index]);
		self.usage[quota.index] -= released;
		if let Some(host) = &self.host {
			self.table.release(host, quota, released);
		}
	}

	/// Reserves one live document lease.
	pub fn reserve_document_lease(&mut self) -> Result<(), PolicyError> {
		self.reserve(Quota::DOCUMENT_LEASES, 1)
	}

	/// Releases one live document lease.
	pub fn release_document_lease(&mut self) {
		self.release(Quota::DOCUMENT_LEASES, 1);
	}

	/// Charges one named-process start or restart.
	pub fn charge_process_start(&mut self) -> Result<(), PolicyError> {
		self.reserve(Quota::PROCESS_CHURN, 1)
	}

	/// Charges blob bytes accepted on this connection.
	pub fn charge_blob_bytes(&mut self, bytes: usize) -> Result<(), PolicyError> {
		self.reserve(Quota::BLOB_INGEST, bytes as u64)
	}

	/// Reserves one live exec session or run.
	pub fn reserve_exec(&mut self) -> Result<(), PolicyError> {
		self.reserve(Quota::EXEC_CONCURRENCY, 1)
	}

	/// Releases one live exec session or run.
	pub fn release_exec(&mut self) {
		self.release(Quota::EXEC_CONCURRENCY, 1);
	}

	/// Reserves one live event stream.
	pub fn reserve_stream(&mut self) -> Result<(), PolicyError> {
		self.reserve(Quota::STREAM_FANOUT, 1)
	}

	/// Releases one live event stream.
	pub fn release_stream(&mut self) {
		self.release(Quota::STREAM_FANOUT, 1);
	}
}

impl Drop for QuotaAccount {
	fn drop(&mut self) {
		if let Some(host) = &self.host {
			for quota in [
				Quota::DOCUMENT_LEASES,
				Quota::PROCESS_CHURN,
				Quota::BLOB_INGEST,
				Quota::EXEC_CONCURRENCY,
				Quota::STREAM_FANOUT,
			] {
				self.table.release(host, quota, self.usage[quota.index]);
			}
		}
	}
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn dap_tiers_match_pi_and_unknown_actions_fail_closed() {
		assert_eq!(dap_command_capability("variables"), "env.dap.read");
		assert_eq!(dap_command_capability("read_memory"), "env.dap.read");
		assert_eq!(dap_command_capability("evaluate"), "env.dap.execute");
		assert_eq!(dap_command_capability("continue"), "env.dap.execute");
		assert_eq!(dap_command_capability("vendor_mutation"), "env.dap.execute");
	}

	/// HTTP DATA operations require `env.net`; the closed capability set must
	/// accept the grant and network exec effects must derive it independently
	/// of process execution.
	#[test]
	fn network_effects_derive_a_grantable_env_net_capability() {
		assert!(Grants::supported(["env.net"]).contains("env.net"));
		assert!(Grants::all().contains("env.net"));
		for (commands, network, expected_net, expected_exec) in [
			(Vec::new(), false, false, false),
			(Vec::new(), true, true, false),
			(vec![String::from("curl")], false, false, true),
			(vec![String::from("curl")], true, true, true),
		] {
			let envelope = v1::EffectEnvelope {
				exec: Some(v1::ExecEffects { commands, network, props: None }),
				..v1::EffectEnvelope::default()
			};
			let grants = Grants::from_effect_envelope(&envelope);
			assert_eq!(grants.contains("env.net"), expected_net);
			assert_eq!(grants.contains("env.exec"), expected_exec);
		}
	}

	/// Both the host manifest and the authorized effect envelope must grant
	/// network access; either deny takes precedence.
	#[test]
	fn network_data_authority_requires_host_and_effect_grants() {
		for (host_grant, effect_grant, expected) in [
			(true, true, Ok(())),
			(true, false, Err(PolicyError::Denied { capability: "env.net" })),
			(false, true, Err(PolicyError::Denied { capability: "env.net" })),
			(false, false, Err(PolicyError::Denied { capability: "env.net" })),
		] {
			let table = AuthorityTable::default();
			let host = HostKey::new("project", "trusted", "fixture.extension");
			let host_grants = host_grant.then_some("env.net");
			table.register_host(host.clone(), Grants::supported(host_grants));
			table.open(host.clone(), Str::new_static("call"));
			let effect_grants = effect_grant.then_some("env.net");
			table
				.authorize(
					&host,
					"call",
					Bytes::from_static(b"token"),
					Grants::supported(effect_grants),
					1,
					7,
					11,
				)
				.expect("authorization transition succeeds");
			assert_eq!(
				table.validate(
					&host,
					1,
					DataAuthority {
						invocation_id:      "call",
						effect_token:       b"token",
						host_generation:    7,
						session_generation: 11,
					},
					"env.net",
				),
				expected,
			);
		}
	}

	#[test]
	fn mutative_lsp_methods_require_write_before_effects_authorization() {
		assert_eq!(lsp_tier_capability(lsp_request_tier("textDocument/hover")), "env.lsp");
		assert_eq!(
			lsp_tier_capability(lsp_request_tier("workspace/executeCommand")),
			"env.doc.write"
		);
		assert_eq!(
			lsp_tier_capability(lsp_notification_tier("workspace/didRenameFiles")),
			"env.doc.write"
		);
	}
}
