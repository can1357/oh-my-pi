//! Deterministic account eligibility, affinity, cooldown, and rotation.

use std::{
	collections::{BTreeMap, BTreeSet},
	sync::Arc,
	time::SystemTime,
};

use omp_catalog::{ProviderId, RouteId};
use omp_core::Str;
use parking_lot::RwLock;
use tokio::sync::broadcast;

use super::{
	AccountAffinity, AccountChangeEvidence, AccountStateStore, AccountStateStoreError,
	AffinityScope, PersistedAccountState, PersistedCooldown, PersistedRejection, QuotaAvailability,
	QuotaObservation, QuotaProvenance, QuotaState, QuotaWindowId, RateAvailability, RateObservation,
	RateState, RateWindowId,
};
use crate::{
	call::AccountRoutingContext,
	id::{AccountId, PrincipalId},
};

/// Static and credential-generation metadata for an account.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AccountRecord {
	/// Credential-bearing account identity.
	pub account:               AccountId,
	/// Stable authenticated principal; token refresh must not change it.
	pub principal:             PrincipalId,
	/// Provider that owns the account.
	pub provider:              ProviderId,
	/// Routes on which the account may be used.
	pub routes:                BTreeSet<RouteId>,
	/// Whether policy permits new attempts with this account.
	pub enabled:               bool,
	/// Monotonic persisted credential generation.
	pub credential_generation: u64,
	/// Non-secret project, tenant, organization, and region routing metadata.
	pub routing:               AccountRoutingContext,
}

impl AccountRecord {
	/// Returns routing metadata with canonical account and principal identity
	/// populated.
	pub fn routing_context(&self) -> AccountRoutingContext {
		let mut routing = self.routing.clone();
		routing.account = Some(self.account.clone());
		routing.principal = Some(self.principal.clone());
		routing.credential_generation = Some(self.credential_generation);
		routing
	}
}

#[allow(
	missing_docs,
	reason = "strum generates the public string-conversion method in this private module"
)]
mod cooldown_reason {
	use strum::{Display, EnumString, IntoStaticStr};

	/// Why an account was placed in cooldown.
	#[derive(Clone, Copy, Debug, Display, EnumString, Eq, IntoStaticStr, PartialEq)]
	#[strum(serialize_all = "snake_case", const_into_str)]
	pub enum CooldownReason {
		/// Structured evidence disabled or revoked the credential.
		CredentialRejected,
		/// Structured evidence disabled the account itself.
		AccountDisabled,
		/// A caller explicitly imposed a temporary health cooldown.
		Health,
		/// Provider denied the account exactly one requested model
		/// entitlement.
		ModelPolicy,
	}
}

use std::cmp;

#[doc(inline)]
pub use cooldown_reason::CooldownReason;

/// Current attempt eligibility for one candidate.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum Eligibility {
	/// Candidate may be selected immediately.
	Eligible,
	/// Account is administratively disabled.
	Disabled,
	/// Account does not support the requested route.
	RouteIneligible,
	/// The current credential generation has been rejected as stale.
	CredentialRejected {
		/// Credential generation rejected as stale.
		rejected_generation: u64,
	},
	/// Account is in a non-rate, non-quota cooldown.
	Cooldown {
		/// When the cooldown expires.
		until:  SystemTime,
		/// Evidence that imposed the cooldown.
		reason: CooldownReason,
	},
	/// Request-rate state delays another attempt.
	RateLimited {
		/// Known rate-limit reset time, if supplied by the provider.
		until: Option<SystemTime>,
	},
	/// Quota state prohibits another attempt.
	QuotaExhausted {
		/// Known quota reset time, if supplied by the provider.
		reset_at: Option<SystemTime>,
	},
	/// Known quota remains, but policy reserves it for higher-priority work.
	QuotaReserved {
		/// Smallest observed remaining amount.
		remaining: Option<u64>,
		/// Configured remaining percentage threshold.
		percent:   u8,
	},
	/// Rotation policy forbids leaving the previous account.
	RotationForbidden,
	/// Rotation policy requires the previous principal.
	PrincipalMismatch,
	/// Explicit rotation excludes the preceding account.
	PreviousAccount,
}

/// Usage-aware reserve behavior applied before credential or network work.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum QuotaReservePolicy {
	/// Do not reserve known provider quota.
	#[default]
	Disabled,
	/// Degrade through the preplanned model/route fallback chain when any known
	/// window falls below this remaining percentage.
	FallbackPercent(u8),
	/// Refuse the call rather than consuming the reserve.
	FailClosedPercent(u8),
}

impl QuotaReservePolicy {
	fn percent(self) -> Option<u8> {
		match self {
			Self::Disabled => None,
			Self::FallbackPercent(percent) | Self::FailClosedPercent(percent) => {
				Some(percent.min(100))
			},
		}
	}
}

/// Evidence retained for every account considered by a selection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CandidateEvidence {
	/// Candidate account.
	pub account:         AccountId,
	/// Candidate principal.
	pub principal:       PrincipalId,
	/// Eligibility decision.
	pub eligibility:     Eligibility,
	/// Known smallest quota remainder used for ranking.
	pub quota_remaining: Option<u64>,
	/// Independent rate-window evidence, even when another blocker wins
	/// eligibility.
	pub rate:            RateAvailability,
	/// Independent quota-window evidence, even when another blocker wins
	/// eligibility.
	pub quota:           QuotaAvailability,
	/// Earliest instant all known temporary blockers clear; `None` denotes
	/// permanent or unknown.
	pub eligible_at:     Option<SystemTime>,
	/// Whether the candidate matched principal affinity.
	pub affinity_match:  bool,
	/// Whether this was the preceding account.
	pub previous_match:  bool,
}

/// Complete, replayable evidence for one deterministic pool decision.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SelectionReceipt {
	/// Provider requested.
	pub provider:    ProviderId,
	/// Route requested.
	pub route:       RouteId,
	/// Selection clock instant.
	pub selected_at: SystemTime,
	/// Every matching-provider account in stable account-ID order.
	pub candidates:  Vec<CandidateEvidence>,
	/// Earliest known time at which any rejected candidate can become eligible.
	pub retry_at:    Option<SystemTime>,
}

/// Successful account selection and session-invalidation evidence.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AccountSelection {
	/// Selected account record snapshot.
	pub record:         AccountRecord,
	/// Complete selection receipt.
	pub receipt:        SelectionReceipt,
	/// Evidence consumed by the session layer.
	pub account_change: AccountChangeEvidence,
	/// Non-secret routing metadata passed inward to encoding.
	pub routing:        AccountRoutingContext,
}

/// Account rotation controls.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RotationPolicy {
	/// Whether a different account may be selected.
	pub allow_account_change: bool,
	/// Whether rotation must retain the previous principal.
	pub preserve_principal:   bool,
}

impl Default for RotationPolicy {
	fn default() -> Self {
		Self { allow_account_change: true, preserve_principal: false }
	}
}

/// Inputs to deterministic account selection.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AccountSelectionRequest {
	/// Provider being executed.
	pub provider:           ProviderId,
	/// Concrete route being executed.
	pub route:              RouteId,
	/// Preferred principal for affinity.
	pub affinity:           Option<PrincipalId>,
	/// Account used by the preceding attempt, if any.
	pub previous_account:   Option<AccountId>,
	/// Principal used by the preceding attempt, if known.
	pub previous_principal: Option<PrincipalId>,
	/// Whether this decision explicitly rotates away from the preceding account.
	pub rotate:             bool,
	/// Rotation constraints.
	pub rotation:           RotationPolicy,
	/// Deterministic clock instant.
	pub now:                SystemTime,
	/// Catalog-resolved independent quota meter for this request.
	pub quota_scope:        Option<Str>,
}

/// Failure selecting an eligible account; always carries partial decision
/// evidence.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
#[error("no eligible account")]
pub struct AccountPoolError {
	/// Complete evidence accumulated before failure.
	pub receipt:        SelectionReceipt,
	/// Reserve policy responsible for the preflight refusal, if any.
	pub reserve_policy: Option<QuotaReservePolicy>,
}

/// Failure registering metadata that would violate stable account routing
/// identity.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum AccountRegistrationError {
	/// An existing account would be rebound to another principal.
	#[error("account routing identity is inconsistent")]
	PrincipalRebind {
		/// Account whose stable identity would be violated.
		account:   AccountId,
		/// Existing stable principal.
		existing:  PrincipalId,
		/// Rejected replacement principal.
		attempted: PrincipalId,
	},
	/// An existing account would be rebound to another provider.
	#[error("account routing identity is inconsistent")]
	ProviderRebind {
		/// Account whose provider ownership would be violated.
		account:   AccountId,
		/// Existing stable provider.
		existing:  ProviderId,
		/// Rejected replacement provider.
		attempted: ProviderId,
	},
	/// Routing metadata names an account other than the containing record.
	#[error("account routing identity is inconsistent")]
	RoutingAccountMismatch {
		/// Canonical record account.
		account:         AccountId,
		/// Rejected routing-context account.
		routing_account: AccountId,
	},
	/// Routing metadata names a principal other than the containing record.
	#[error("account routing identity is inconsistent")]
	RoutingPrincipalMismatch {
		/// Canonical record principal.
		principal:         PrincipalId,
		/// Rejected routing-context principal.
		routing_principal: PrincipalId,
	},
	/// Durable account-state storage failed before registration completed.
	#[error("{summary}")]
	StateStore {
		/// Sanitized failure summary.
		summary: Str,
	},
}

#[derive(Clone, Debug)]
struct Cooldown {
	until:  SystemTime,
	reason: CooldownReason,
}

#[derive(Clone, Debug)]
struct Rejection {
	generation:   u64,
	_observed_at: SystemTime,
}

#[derive(Default)]
struct PoolState {
	accounts:        BTreeMap<AccountId, AccountRecord>,
	cooldowns:       BTreeMap<AccountId, Cooldown>,
	/// Route-scoped cooldowns; process-local because model-entitlement denials
	/// are re-observed cheaply and must not outlive the credential set that
	/// produced them.
	route_cooldowns: BTreeMap<AccountId, BTreeMap<RouteId, Cooldown>>,
	rejections:      BTreeMap<AccountId, Rejection>,
	rate:            BTreeMap<AccountId, RateState>,
	quota:           BTreeMap<AccountId, QuotaState>,
	quota_reserve:   QuotaReservePolicy,
	affinities:      BTreeMap<AffinityScope, AccountAffinity>,
}

/// Concurrent, durable-aware account metadata and eligibility state.
#[derive(Clone)]
pub struct AccountPool {
	state:   Arc<RwLock<PoolState>>,
	store:   Option<Arc<AccountStateStore>>,
	changes: broadcast::Sender<AccountPoolEvent>,
}

/// Secret-free mutation emitted by the canonical account pool.
#[derive(Clone, Debug)]
pub enum AccountPoolEvent {
	/// Account metadata was inserted or replaced.
	Upserted(AccountRecord),
	/// Account metadata was removed.
	Deleted(AccountId),
}

impl Default for AccountPool {
	fn default() -> Self {
		let (changes, _) = broadcast::channel(64);
		Self { state: Arc::default(), store: None, changes }
	}
}

impl AccountPool {
	/// Creates an empty account pool.
	pub fn new() -> Self {
		Self::default()
	}

	/// Hydrates every static and dynamic account record from durable storage.
	pub fn with_store(store: Arc<AccountStateStore>) -> Result<Self, AccountStateStoreError> {
		let mut state = PoolState::default();
		for record in store.load_accounts()? {
			let account = record.account.clone();
			let persisted = store.load_account(&account)?;
			state.accounts.insert(account.clone(), record);
			hydrate_account_state(&mut state, account, persisted);
		}
		let (changes, _) = broadcast::channel(64);
		Ok(Self { state: Arc::new(RwLock::new(state)), store: Some(store), changes })
	}

	/// Returns the durable account-state dependency, when configured.
	pub const fn state_store(&self) -> Option<&Arc<AccountStateStore>> {
		self.store.as_ref()
	}

	/// Replaces the account-pool quota reserve used by the attempt spine.
	///
	/// The preflight uses only provider-observed remaining/limit pairs. Unknown
	/// quota never becomes an invented denial.
	pub fn set_quota_reserve(&self, policy: QuotaReservePolicy) {
		self.state.write().quota_reserve = policy;
	}

	/// Returns the active usage-aware reserve policy.
	pub fn quota_reserve(&self) -> QuotaReservePolicy {
		self.state.read().quota_reserve
	}

	/// Inserts or atomically replaces metadata while enforcing stable account
	/// routing identity.
	pub fn upsert(&self, mut record: AccountRecord) -> Result<(), AccountRegistrationError> {
		if let Some(routing_account) = &record.routing.account
			&& routing_account != &record.account
		{
			return Err(AccountRegistrationError::RoutingAccountMismatch {
				account:         record.account.clone(),
				routing_account: routing_account.clone(),
			});
		}
		if let Some(routing_principal) = &record.routing.principal
			&& routing_principal != &record.principal
		{
			return Err(AccountRegistrationError::RoutingPrincipalMismatch {
				principal:         record.principal.clone(),
				routing_principal: routing_principal.clone(),
			});
		}
		let mut state = self.state.write();
		if let Some(previous) = state.accounts.get(&record.account) {
			if previous.principal != record.principal {
				return Err(AccountRegistrationError::PrincipalRebind {
					account:   record.account.clone(),
					existing:  previous.principal.clone(),
					attempted: record.principal.clone(),
				});
			}
			if previous.provider != record.provider {
				return Err(AccountRegistrationError::ProviderRebind {
					account:   record.account.clone(),
					existing:  previous.provider.clone(),
					attempted: record.provider.clone(),
				});
			}
		}
		let persisted = self
			.store
			.as_ref()
			.map(|store| {
				record.credential_generation = store.upsert_account(&record)?;
				store.load_account(&record.account)
			})
			.transpose()
			.map_err(|error| AccountRegistrationError::StateStore {
				summary: Str::new(error.to_string()),
			})?;
		let account = record.account.clone();
		let event = record.clone();
		state.accounts.insert(account.clone(), record);
		if let Some(persisted) = persisted {
			hydrate_account_state(&mut state, account, persisted);
		}
		drop(state);
		let _ = self.changes.send(AccountPoolEvent::Upserted(event));
		Ok(())
	}

	/// Removes account metadata while retaining independent cooldown, rate, and
	/// quota observations.
	pub fn remove(&self, account: &AccountId<str>) -> Option<AccountRecord> {
		let removed = self.state.write().accounts.remove(account);
		if removed.is_some() {
			let _ = self
				.changes
				.send(AccountPoolEvent::Deleted(account.to_owned()));
		}
		removed
	}

	pub(crate) fn subscribe(&self) -> broadcast::Receiver<AccountPoolEvent> {
		self.changes.subscribe()
	}

	/// Returns an account metadata snapshot.
	pub fn account(&self, account: &AccountId<str>) -> Option<AccountRecord> {
		self.state.read().accounts.get(account).cloned()
	}

	/// Returns every account metadata snapshot in stable account-ID order.
	pub fn accounts(&self) -> Vec<AccountRecord> {
		self.state.read().accounts.values().cloned().collect()
	}

	/// Enables or disables a static account without deleting accounting history.
	pub fn set_enabled(
		&self,
		account: &AccountId<str>,
		enabled: bool,
	) -> Result<bool, AccountStateStoreError> {
		if let Some(store) = &self.store
			&& !store.set_account_enabled(account, enabled)?
		{
			return Ok(false);
		}
		let mut state = self.state.write();
		let Some(record) = state.accounts.get_mut(account) else {
			return Ok(false);
		};
		record.enabled = enabled;
		let event = record.clone();
		drop(state);
		let _ = self.changes.send(AccountPoolEvent::Upserted(event));
		Ok(true)
	}

	/// Applies and durably records an explicit cooldown independent of rate and
	/// quota windows.
	pub fn cooldown(
		&self,
		account: AccountId,
		until: SystemTime,
		reason: CooldownReason,
	) -> Result<(), AccountStateStoreError> {
		if let Some(store) = &self.store {
			store.save_cooldown(&PersistedCooldown { account: account.clone(), until, reason })?;
		}
		self
			.state
			.write()
			.cooldowns
			.insert(account, Cooldown { until, reason });
		Ok(())
	}

	/// Clears only the explicit cooldown while preserving rate and quota
	/// receipts.
	pub fn clear_cooldown(&self, account: &AccountId<str>) -> Result<(), AccountStateStoreError> {
		if let Some(store) = &self.store {
			store.clear_cooldown(account)?;
		}
		self.state.write().cooldowns.remove(account);
		Ok(())
	}

	/// Blocks one account on exactly one route, leaving every other route
	/// eligible.
	///
	/// Used for provider model-entitlement denials (for example a `ChatGPT`
	/// account that lacks one requested Codex model): rotation must reach an
	/// entitled sibling while the denied account keeps serving the models it is
	/// entitled to. Process-local by design; the denial is re-observed cheaply.
	pub fn cooldown_route(
		&self,
		account: AccountId,
		route: RouteId,
		until: SystemTime,
		reason: CooldownReason,
	) {
		self
			.state
			.write()
			.route_cooldowns
			.entry(account)
			.or_default()
			.insert(route, Cooldown { until, reason });
	}

	/// Rejects exactly the observed credential generation without changing the
	/// principal.
	pub fn reject_credential(
		&self,
		account: AccountId,
		generation: u64,
		observed_at: SystemTime,
	) -> Result<(), AccountStateStoreError> {
		if let Some(store) = &self.store {
			store.save_rejection(&account, &PersistedRejection { generation, observed_at })?;
		}
		let mut state = self.state.write();
		let rejection = state
			.rejections
			.entry(account)
			.or_insert(Rejection { generation, _observed_at: observed_at });
		if generation >= rejection.generation {
			*rejection = Rejection { generation, _observed_at: observed_at };
		}
		Ok(())
	}

	/// Updates fresh credential metadata without changing stable principal or
	/// provider ownership.
	pub fn update_credential_generation(
		&self,
		account: &AccountId<str>,
		principal: &PrincipalId<str>,
		generation: u64,
	) -> Result<bool, AccountStateStoreError> {
		if self
			.state
			.read()
			.accounts
			.get(account)
			.is_none_or(|record| {
				&record.principal != principal || generation < record.credential_generation
			}) {
			return Ok(false);
		}
		if let Some(store) = &self.store
			&& !store.update_generation(account, principal, generation)?
		{
			return Ok(false);
		}
		let mut state = self.state.write();
		let Some(record) = state.accounts.get_mut(account) else {
			return Ok(false);
		};
		if &record.principal != principal || generation < record.credential_generation {
			return Ok(false);
		}
		record.credential_generation = generation;
		let event = record.clone();
		if state
			.rejections
			.get(account)
			.is_some_and(|rejection| generation > rejection.generation)
		{
			state.rejections.remove(account);
		}
		drop(state);
		let _ = self.changes.send(AccountPoolEvent::Upserted(event));
		Ok(true)
	}

	/// Applies and durably records a request-rate observation only in rate
	/// state.
	pub fn observe_rate(
		&self,
		account: AccountId,
		observation: RateObservation,
	) -> Result<(), AccountStateStoreError> {
		if let Some(store) = &self.store {
			store.append_rate(&account, &observation)?;
		}
		self
			.state
			.write()
			.rate
			.entry(account)
			.or_default()
			.apply(observation);
		Ok(())
	}

	/// Applies and durably records a quota observation only in quota state.
	pub fn observe_quota(
		&self,
		account: AccountId,
		observation: QuotaObservation,
	) -> Result<(), AccountStateStoreError> {
		if let Some(store) = &self.store {
			store.append_quota(&account, &observation)?;
		}
		self
			.state
			.write()
			.quota
			.entry(account)
			.or_default()
			.apply(observation);
		Ok(())
	}

	/// Records a structured rate 429 only in the account's rate windows.
	pub fn record_rate_429(
		&self,
		account: AccountId,
		window: RateWindowId,
		retry_at: Option<SystemTime>,
		observed_at: SystemTime,
	) -> Result<(), AccountStateStoreError> {
		self.observe_rate(account, RateObservation {
			window,
			limit: None,
			remaining: Some(0),
			reset_at: retry_at,
			retry_at,
			observed_at,
		})
	}

	/// Records a structured quota 429 only in the account's quota windows.
	pub fn record_quota_429(
		&self,
		account: AccountId,
		window: QuotaWindowId,
		reset_at: Option<SystemTime>,
		observed_at: SystemTime,
	) -> Result<(), AccountStateStoreError> {
		self.observe_quota(account, QuotaObservation {
			window,
			consumed: None,
			remaining: Some(0),
			limit: None,
			reset_at,
			exhausted: Some(true),
			provenance: QuotaProvenance::Error,
			observed_at,
		})
	}

	/// Returns an independent rate-state snapshot.
	pub fn rate_state(&self, account: &AccountId<str>) -> RateState {
		self
			.state
			.read()
			.rate
			.get(account)
			.cloned()
			.unwrap_or_default()
	}

	/// Clears selected rate-block windows for one account, or every window
	/// when the selection is empty.
	pub fn clear_rate(
		&self,
		account: &AccountId<str>,
		scopes: &[Str],
	) -> Result<(), AccountStateStoreError> {
		if let Some(store) = &self.store {
			store.clear_rate(account, scopes)?;
		}
		if let Some(rate) = self.state.write().rate.get_mut(account) {
			rate.clear(scopes);
		}
		Ok(())
	}

	/// Returns an independent quota-state snapshot.
	pub fn quota_state(&self, account: &AccountId<str>) -> QuotaState {
		self
			.state
			.read()
			.quota
			.get(account)
			.cloned()
			.unwrap_or_default()
	}

	/// Invalidates cached rate and quota observations for the selected provider
	/// or account.
	pub fn invalidate_usage(
		&self,
		provider: Option<&ProviderId<str>>,
		account: Option<&AccountId<str>>,
	) -> Result<(), AccountStateStoreError> {
		if let Some(store) = &self.store {
			store.invalidate_usage(provider, account)?;
		}
		let mut state = self.state.write();
		if let Some(account) = account {
			state.rate.remove(account);
			state.quota.remove(account);
		} else if let Some(provider) = provider {
			let accounts = state
				.accounts
				.values()
				.filter(|record| &record.provider == provider)
				.map(|record| record.account.clone())
				.collect::<Vec<_>>();
			for account in accounts {
				state.rate.remove(&account);
				state.quota.remove(&account);
			}
		} else {
			state.rate.clear();
			state.quota.clear();
		}
		Ok(())
	}

	/// Records durable scope affinity independently of credential material.
	pub fn save_affinity(&self, affinity: AccountAffinity) -> Result<(), AccountStateStoreError> {
		let mut state = self.state.write();
		if state
			.accounts
			.get(&affinity.account)
			.is_none_or(|record| record.principal != affinity.principal)
		{
			return Err(AccountStateStoreError::IdentityConflict);
		}
		if let Some(store) = &self.store {
			store.save_affinity(&affinity)?;
		}
		state.affinities.insert(affinity.scope.clone(), affinity);
		Ok(())
	}

	/// Loads scope affinity from durable storage or process-shared memory.
	pub fn affinity(
		&self,
		scope: &AffinityScope,
	) -> Result<Option<AccountAffinity>, AccountStateStoreError> {
		if let Some(store) = &self.store
			&& let Some(affinity) = store.affinity(scope)?
		{
			self
				.state
				.write()
				.affinities
				.insert(scope.clone(), affinity.clone());
			return Ok(Some(affinity));
		}
		Ok(self.state.read().affinities.get(scope).cloned())
	}

	/// Selects or rotates an account using affinity, health, quota, then
	/// account-ID tie-breaking.
	pub fn select(
		&self,
		request: &AccountSelectionRequest,
	) -> Result<AccountSelection, AccountPoolError> {
		let state = self.state.read();
		let mut ranked = Vec::new();
		let mut candidates = Vec::new();
		for record in state
			.accounts
			.values()
			.filter(|record| record.provider == request.provider)
		{
			let previous_match = request.previous_account.as_ref() == Some(&record.account);
			let affinity_match = request.affinity.as_ref() == Some(&record.principal);
			let eligibility = eligibility(&state, record, request, previous_match);
			let quota_state = state.quota.get(&record.account);
			let rate = state
				.rate
				.get(&record.account)
				.map_or(RateAvailability::Available, |rate| rate.availability(request.now));
			let quota = quota_state.map_or(QuotaAvailability::Available, |quota| {
				quota.availability_scoped(request.now, request.quota_scope.as_deref())
			});
			let quota_remaining = quota_state.and_then(|quota| {
				quota.minimum_remaining_scoped(request.now, request.quota_scope.as_deref())
			});
			let eligible_at =
				candidate_eligible_at(&state, record, request, &eligibility, rate, quota);
			let evidence = CandidateEvidence {
				account: record.account.clone(),
				principal: record.principal.clone(),
				eligibility: eligibility.clone(),
				quota_remaining,
				rate,
				quota,
				eligible_at,
				affinity_match,
				previous_match,
			};
			let evidence_index = candidates.len();
			candidates.push(evidence);
			if eligibility == Eligibility::Eligible {
				let affinity_rank = if previous_match {
					0
				} else if affinity_match {
					1
				} else {
					2
				};
				let quota_known_rank = u8::from(quota_remaining.is_none());
				let quota_rank = cmp::Reverse(quota_remaining.unwrap_or(0));
				ranked.push((
					affinity_rank,
					quota_known_rank,
					quota_rank,
					record.account.clone(),
					evidence_index,
				));
			}
		}
		ranked.sort();
		let retry_at = candidates
			.iter()
			.filter_map(|candidate| candidate.eligible_at)
			.filter(|eligible_at| eligible_at > &request.now)
			.min();
		let reserve_policy = candidates
			.iter()
			.any(|candidate| matches!(candidate.eligibility, Eligibility::QuotaReserved { .. }))
			.then_some(state.quota_reserve);
		let receipt = SelectionReceipt {
			provider: request.provider.clone(),
			route: request.route.clone(),
			selected_at: request.now,
			candidates,
			retry_at,
		};
		let Some((_, _, _, selected_id, _)) = ranked.into_iter().next() else {
			return Err(AccountPoolError { receipt, reserve_policy });
		};
		let Some(record) = state.accounts.get(&selected_id).cloned() else {
			return Err(AccountPoolError { receipt, reserve_policy });
		};
		let routing = record.routing_context();
		let account_change = AccountChangeEvidence::new(
			request.previous_account.clone(),
			request.previous_principal.clone(),
			record.account.clone(),
			record.principal.clone(),
			request.now,
		);
		Ok(AccountSelection { record, receipt, account_change, routing })
	}
}

fn hydrate_account_state(
	state: &mut PoolState,
	account: AccountId,
	persisted: PersistedAccountState,
) {
	match persisted.cooldown {
		Some(cooldown) => {
			state
				.cooldowns
				.insert(account.clone(), Cooldown { until: cooldown.until, reason: cooldown.reason });
		},
		None => {
			state.cooldowns.remove(&account);
		},
	}
	match persisted.rejection {
		Some(rejection) => {
			state.rejections.insert(account.clone(), Rejection {
				generation:   rejection.generation,
				_observed_at: rejection.observed_at,
			});
		},
		None => {
			state.rejections.remove(&account);
		},
	}
	state.rate.insert(account.clone(), persisted.rate);
	state.quota.insert(account, persisted.quota);
}
fn eligibility(
	state: &PoolState,
	record: &AccountRecord,
	request: &AccountSelectionRequest,
	previous_match: bool,
) -> Eligibility {
	if !record.enabled {
		return Eligibility::Disabled;
	}
	if !record.routes.contains(&request.route) {
		return Eligibility::RouteIneligible;
	}
	if request.rotate && previous_match {
		return Eligibility::PreviousAccount;
	}
	if request.previous_account.is_some()
		&& !request.rotation.allow_account_change
		&& !previous_match
	{
		return Eligibility::RotationForbidden;
	}
	if request.rotation.preserve_principal
		&& request
			.previous_principal
			.as_ref()
			.is_some_and(|principal| principal != &record.principal)
	{
		return Eligibility::PrincipalMismatch;
	}
	if let Some(rejection) = state.rejections.get(&record.account)
		&& record.credential_generation <= rejection.generation
	{
		return Eligibility::CredentialRejected { rejected_generation: rejection.generation };
	}
	if let Some(cooldown) = state.cooldowns.get(&record.account)
		&& cooldown.until > request.now
	{
		return Eligibility::Cooldown { until: cooldown.until, reason: cooldown.reason };
	}
	if let Some(cooldown) = route_cooldown(state, record, request)
		&& cooldown.until > request.now
	{
		return Eligibility::Cooldown { until: cooldown.until, reason: cooldown.reason };
	}
	match state
		.quota
		.get(&record.account)
		.map_or(QuotaAvailability::Available, |quota| {
			quota.availability_scoped(request.now, request.quota_scope.as_deref())
		}) {
		QuotaAvailability::Available => {},
		QuotaAvailability::Exhausted { reset_at } => {
			return Eligibility::QuotaExhausted { reset_at: Some(reset_at) };
		},
		QuotaAvailability::ExhaustedUnknownReset => {
			return Eligibility::QuotaExhausted { reset_at: None };
		},
	}
	if let Some(percent) = state.quota_reserve.percent()
		&& let Some(quota) = state.quota.get(&record.account)
		&& quota.below_remaining_percent_scoped(request.now, percent, request.quota_scope.as_deref())
	{
		return Eligibility::QuotaReserved {
			remaining: quota.minimum_remaining_scoped(request.now, request.quota_scope.as_deref()),
			percent,
		};
	}
	match state
		.rate
		.get(&record.account)
		.map_or(RateAvailability::Available, |rate| rate.availability(request.now))
	{
		RateAvailability::Available => Eligibility::Eligible,
		RateAvailability::Delayed { until } => Eligibility::RateLimited { until: Some(until) },
		RateAvailability::ExhaustedUnknownReset => Eligibility::RateLimited { until: None },
	}
}

fn candidate_eligible_at(
	state: &PoolState,
	record: &AccountRecord,
	request: &AccountSelectionRequest,
	eligibility: &Eligibility,
	rate: RateAvailability,
	quota: QuotaAvailability,
) -> Option<SystemTime> {
	if eligibility == &Eligibility::Eligible {
		return Some(request.now);
	}
	if !matches!(
		eligibility,
		Eligibility::Cooldown { .. }
			| Eligibility::RateLimited { .. }
			| Eligibility::QuotaExhausted { .. }
	) {
		return None;
	}
	let mut ready_at = request.now;
	if let Some(cooldown) = state.cooldowns.get(&record.account)
		&& cooldown.until > ready_at
	{
		ready_at = cooldown.until;
	}
	if let Some(cooldown) = route_cooldown(state, record, request)
		&& cooldown.until > ready_at
	{
		ready_at = cooldown.until;
	}
	match rate {
		RateAvailability::Available => {},
		RateAvailability::Delayed { until } => ready_at = ready_at.max(until),
		RateAvailability::ExhaustedUnknownReset => return None,
	}
	match quota {
		QuotaAvailability::Available => {},
		QuotaAvailability::Exhausted { reset_at } => ready_at = ready_at.max(reset_at),
		QuotaAvailability::ExhaustedUnknownReset => return None,
	}
	Some(ready_at)
}

fn route_cooldown<'a>(
	state: &'a PoolState,
	record: &AccountRecord,
	request: &AccountSelectionRequest,
) -> Option<&'a Cooldown> {
	state
		.route_cooldowns
		.get(&record.account)?
		.get(&request.route)
}
