//! Typed provider-side session bindings and deterministic reseed policy.

use std::time::{Duration, SystemTime};

use bytes::Bytes;
use omp_catalog::{
	id::{ModelKey, RouteId},
	provider::TrustDomain,
};
use omp_core::{Hash32, Str};
use serde::{Deserialize, Serialize};
use strum::IntoStaticStr;

use crate::{
	account::AccountChangeEvidence,
	body::{AttemptBodyEvidence, RetryDecision},
	codec::ProviderStateEvent,
	id::{AccountId, ConversationId, PrincipalId, Revision},
};

/// Journal-safe opaque evidence identifying a credential affinity.
///
/// The digest is keyed by installation-owned random bytes. It can be compared
/// across revival without revealing an account id, principal, or credential.
#[derive(Clone, Debug, Deserialize, Eq, Hash, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(transparent)]
pub struct CredentialAffinityDigest(Str);

impl CredentialAffinityDigest {
	/// Computes a domain-separated affinity digest from inference-owned
	/// identity.
	///
	/// `key` must come from the credential authority and must never be
	/// journaled.
	pub fn derive(
		key: &[u8; 32],
		provider: &omp_catalog::ProviderId<str>,
		account: &AccountId<str>,
		principal: &PrincipalId<str>,
	) -> Self {
		let mut hasher = Hash32::hasher();
		hasher
			.update(b"omp.credential-affinity.v1\0")
			.update(key)
			.update(b"\0provider\0")
			.update(provider.as_str().as_bytes())
			.update(b"\0account\0")
			.update(account.as_str().as_bytes())
			.update(b"\0principal\0")
			.update(principal.as_str().as_bytes());
		Self(Str::new(hasher.finalize().to_hex().as_str()))
	}

	/// Restores already-derived opaque journal evidence.
	///
	/// Only canonical lowercase BLAKE3-256 hex is accepted.
	pub fn parse(value: &str) -> Option<Self> {
		value
			.parse::<Hash32>()
			.ok()
			.map(|digest| Self(Str::new(digest.to_hex().as_str())))
	}

	/// Borrows the opaque canonical digest.
	pub fn as_str(&self) -> &str {
		self.0.as_str()
	}
}

/// Determines whether credential refresh invalidates provider-side state.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum CredentialGenerationPolicy {
	/// The handle remains valid across refreshes that preserve the principal.
	PrincipalBound,
	/// Any credential generation change invalidates the handle.
	CredentialGenerationBound,
}

/// The complete identity and trust scope of a provider-side state handle.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct BindingKey {
	/// Conversation branch for which the handle was captured.
	pub conversation:          ConversationId,
	/// Concrete route that issued the handle.
	pub route:                 RouteId,
	/// Normalized model deployment used to create the state.
	pub model:                 ModelKey,
	/// Authenticated principal that owns the state.
	pub principal:             PrincipalId,
	/// Credential-forwarding boundary under which the handle is trusted.
	pub trust_domain:          TrustDomain,
	/// Last committed revision represented by the handle.
	pub base_revision:         Revision,
	/// Credential generation at capture time.
	pub credential_generation: u64,
	/// Route policy governing ordinary credential refreshes.
	pub credential_policy:     CredentialGenerationPolicy,
}

/// A typed opaque provider-side state handle committed with conversation
/// history.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ServerStateBinding {
	/// Identity, trust, and history scope of the handle.
	pub key:        BindingKey,
	/// Time at which successful output captured the handle.
	pub created_at: SystemTime,
	/// Provider-declared absolute expiry, when available.
	pub expires_at: Option<SystemTime>,
	/// Opaque wire handle; generic policy never interprets its bytes.
	pub handle:     Bytes,
}

/// Successful-attempt state awaiting the committed revision assigned by the
/// store.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct PendingServerStateBinding {
	/// Conversation branch for which the handle was captured.
	pub conversation:          ConversationId,
	/// Concrete route that issued the handle.
	pub route:                 RouteId,
	/// Normalized model deployment used to create the state.
	pub model:                 ModelKey,
	/// Authenticated principal that owns the state.
	pub principal:             PrincipalId,
	/// Credential-forwarding boundary under which the handle is trusted.
	pub trust_domain:          TrustDomain,
	/// Credential generation at capture time.
	pub credential_generation: u64,
	/// Route policy governing ordinary credential refreshes.
	pub credential_policy:     CredentialGenerationPolicy,
	/// Time at which successful output captured the handle.
	pub created_at:            SystemTime,
	/// Provider-declared absolute expiry, when available.
	pub expires_at:            Option<SystemTime>,
	/// Opaque wire handle.
	pub handle:                Bytes,
}

impl PendingServerStateBinding {
	pub(crate) fn commit(self, revision: Revision) -> ServerStateBinding {
		ServerStateBinding {
			key:        BindingKey {
				conversation:          self.conversation,
				route:                 self.route,
				model:                 self.model,
				principal:             self.principal,
				trust_domain:          self.trust_domain,
				base_revision:         revision,
				credential_generation: self.credential_generation,
				credential_policy:     self.credential_policy,
			},
			created_at: self.created_at,
			expires_at: self.expires_at,
			handle:     self.handle,
		}
	}
}

/// Postcard-safe typed provider-state snapshot retained inside an opaque
/// binding.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub enum StoredProviderStateEvent {
	/// Opaque continuation handle for a subsequent provider request.
	Continuation {
		/// Provider-issued continuation handle.
		handle: Str,
	},
	/// Provider-issued signature that validates a reasoning item.
	ReasoningSignature {
		/// Position of the reasoning item in the provider transcript.
		index:     u32,
		/// Opaque provider signature.
		signature: Bytes,
	},
	/// Provider proof attached to a tool-call item.
	ToolCallProof {
		/// Position of the tool-call item in the provider transcript.
		index: u32,
		/// Opaque provider proof.
		value: Bytes,
	},
	/// Provider-specific serialized history item.
	HistoryBlock {
		/// Position of the history item in the provider transcript.
		index: u32,
		/// Opaque serialized history item.
		data:  Bytes,
	},
	/// Provider identifier for an output item.
	OutputItem {
		/// Position of the output item in the provider transcript.
		index: u32,
		/// Provider-issued output-item identifier.
		id:    Str,
	},
	/// Opaque provider checkpoint that may have an identifier.
	Checkpoint {
		/// Provider-issued checkpoint identifier, when supplied.
		id:   Option<Str>,
		/// Opaque checkpoint data.
		data: Bytes,
	},
}

impl From<ProviderStateEvent> for StoredProviderStateEvent {
	fn from(event: ProviderStateEvent) -> Self {
		match event {
			ProviderStateEvent::Continuation { handle } => Self::Continuation { handle },
			ProviderStateEvent::ReasoningSignature { index, signature } => {
				Self::ReasoningSignature { index, signature }
			},
			ProviderStateEvent::ToolCallProof { index, value } => Self::ToolCallProof { index, value },
			ProviderStateEvent::HistoryBlock { index, data } => Self::HistoryBlock { index, data },
			ProviderStateEvent::OutputItem { index, id } => Self::OutputItem { index, id },
			ProviderStateEvent::Checkpoint { id, data } => Self::Checkpoint { id, data },
		}
	}
}

impl ServerStateBinding {
	/// Decodes the typed provider-state snapshot without interpreting vendor
	/// semantics.
	pub fn provider_state(&self) -> Result<Vec<StoredProviderStateEvent>, postcard::Error> {
		postcard::from_bytes(&self.handle)
	}
}

/// Current execution scope against which a binding is validated.
#[derive(Clone, Debug)]
pub struct BindingContext<'a> {
	/// Active conversation branch.
	pub conversation:          &'a ConversationId<str>,
	/// Selected concrete route.
	pub route:                 &'a RouteId<str>,
	/// Selected normalized model deployment.
	pub model:                 &'a ModelKey<str>,
	/// Authenticated principal.
	pub principal:             &'a PrincipalId<str>,
	/// Account-selection evidence, when execution follows an earlier attempt.
	pub account_change:        Option<&'a AccountChangeEvidence>,
	/// Selected route's current trust boundary.
	pub trust_domain:          &'a TrustDomain,
	/// Current credential generation.
	pub credential_generation: u64,
	/// Current wall-clock evidence.
	pub now:                   SystemTime,
	/// Caller policy limiting accepted handle age.
	pub max_age:               Option<Duration>,
}

/// Deterministic reason canonical history must reseed provider-side state.
#[derive(Clone, Copy, Debug, Eq, IntoStaticStr, PartialEq)]
pub enum ReseedReason {
	/// No provider-side state has been captured yet.
	#[strum(serialize = "FirstTurn")]
	FirstTurn,
	/// Execution moved to another conversation branch.
	#[strum(serialize = "Fork")]
	Fork,
	/// Route selection changed.
	#[strum(serialize = "RouteChanged")]
	RouteChanged,
	/// Model selection changed.
	#[strum(serialize = "ModelChanged")]
	ModelChanged,
	/// Route trust configuration changed.
	#[strum(serialize = "TrustDomainChanged")]
	TrustDomainChanged,
	/// Authenticated principal changed.
	#[strum(serialize = "PrincipalChanged")]
	PrincipalChanged,
	/// Execution rotated to a different account, even if it represents the same
	/// principal.
	#[strum(serialize = "AccountChanged")]
	AccountChanged,
	/// Route policy binds state to a replaced credential generation.
	#[strum(serialize = "CredentialGenerationChanged")]
	CredentialGenerationChanged,
	/// Caller requested fresh provider-native state and account selection.
	#[strum(serialize = "ProviderReset")]
	ProviderReset,
	/// Provider-declared expiry elapsed.
	#[strum(serialize = "ProviderExpired")]
	ProviderExpired,
	/// Caller maximum-age policy elapsed.
	#[strum(serialize = "MaximumAgeExceeded")]
	MaximumAgeExceeded,
	/// Binding base is not an ancestor of the requested revision.
	#[strum(serialize = "DivergedHistory")]
	DivergedHistory,
}

/// Compatibility result for one typed provider-side binding.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum BindingValidity {
	/// The handle is valid and only history after its base should be sent.
	Compatible,
	/// Canonical history must be replayed for the stated reason.
	Reseed(ReseedReason),
}

impl ServerStateBinding {
	/// Validates all scope fields in a stable order before history ancestry.
	pub fn validity(&self, context: &BindingContext<'_>, base_is_ancestor: bool) -> BindingValidity {
		let key = &self.key;
		if &key.conversation != context.conversation {
			return BindingValidity::Reseed(ReseedReason::Fork);
		}
		if &key.route != context.route {
			return BindingValidity::Reseed(ReseedReason::RouteChanged);
		}
		if &key.model != context.model {
			return BindingValidity::Reseed(ReseedReason::ModelChanged);
		}
		if &key.trust_domain != context.trust_domain {
			return BindingValidity::Reseed(ReseedReason::TrustDomainChanged);
		}
		if &key.principal != context.principal {
			return BindingValidity::Reseed(ReseedReason::PrincipalChanged);
		}
		if context
			.account_change
			.is_some_and(|change| change.invalidates_account_bound_session)
		{
			return BindingValidity::Reseed(ReseedReason::AccountChanged);
		}
		if key.credential_policy == CredentialGenerationPolicy::CredentialGenerationBound
			&& key.credential_generation != context.credential_generation
		{
			return BindingValidity::Reseed(ReseedReason::CredentialGenerationChanged);
		}
		if self
			.expires_at
			.is_some_and(|expires| context.now >= expires)
		{
			return BindingValidity::Reseed(ReseedReason::ProviderExpired);
		}
		if context.max_age.is_some_and(|age| {
			context
				.now
				.duration_since(self.created_at)
				.is_ok_and(|elapsed| elapsed > age)
		}) {
			return BindingValidity::Reseed(ReseedReason::MaximumAgeExceeded);
		}
		if !base_is_ancestor {
			return BindingValidity::Reseed(ReseedReason::DivergedHistory);
		}
		BindingValidity::Compatible
	}
}

/// Structured session-expiry failure preserving committed-output evidence.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
#[error("{}", if *committed { "provider session expired after output commit" } else { "provider session expired before output commit" })]
pub struct SessionExpiryError {
	/// Whether ordinary output had already become visible.
	pub committed: bool,
	/// Policy action permitted by commit and replayability evidence.
	pub decision:  ProviderExpiryDecision,
}

impl SessionExpiryError {
	/// Constructs a pre-commit session-expiry failure.
	pub const fn uncommitted(decision: ProviderExpiryDecision) -> Self {
		Self { committed: false, decision }
	}

	/// Constructs a partial committed session-expiry failure.
	pub const fn partial() -> Self {
		Self { committed: true, decision: ProviderExpiryDecision::FailPartial }
	}
}

/// Outcome when a provider rejects server state during an attempt.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProviderExpiryDecision {
	/// Replay canonical history once before any output becomes visible.
	ReseedOnce,
	/// Fail without retry because replay is disallowed or the body is not
	/// replayable.
	FailUncommitted,
	/// Surface a partial stream error because ordinary output is already
	/// visible.
	FailPartial,
}

/// Per-call one-shot state for provider-session expiry handling.
#[derive(Clone, Debug, Default)]
pub struct ReseedState {
	reseeded:  bool,
	committed: bool,
}

impl ReseedState {
	/// Records that ordinary output has become visible and can no longer be
	/// rolled back.
	pub const fn mark_committed(&mut self) {
		self.committed = true;
	}

	/// Classifies provider expiry without ever allowing a second reseed.
	pub fn on_provider_expiry(
		&mut self,
		allow_reseed: bool,
		body: &AttemptBodyEvidence,
	) -> ProviderExpiryDecision {
		if self.committed {
			return ProviderExpiryDecision::FailPartial;
		}
		if allow_reseed && !self.reseeded && body.retry_decision == RetryDecision::Allow {
			self.reseeded = true;
			ProviderExpiryDecision::ReseedOnce
		} else {
			ProviderExpiryDecision::FailUncommitted
		}
	}

	/// Produces typed failure evidence for callers that must surface expiry.
	pub fn expiry_error(decision: ProviderExpiryDecision) -> SessionExpiryError {
		if decision == ProviderExpiryDecision::FailPartial {
			SessionExpiryError::partial()
		} else {
			SessionExpiryError::uncommitted(decision)
		}
	}

	/// Returns whether this call already consumed its only reseed allowance.
	pub const fn has_reseeded(&self) -> bool {
		self.reseeded
	}
}
