//! Account identity, selection, throttling, quota, and refresh coordination.

mod pool;
mod quota;
mod rate;
mod refresh;
mod store;

use std::time::SystemTime;

pub use pool::{
	AccountPool, AccountPoolError, AccountPoolEvent, AccountRecord, AccountRegistrationError,
	AccountSelection, AccountSelectionRequest, CandidateEvidence, CooldownReason, Eligibility,
	QuotaReservePolicy, RotationPolicy, SelectionReceipt,
};
pub use quota::{
	QuotaAvailability, QuotaObservation, QuotaProvenance, QuotaState, QuotaWindow, QuotaWindowId,
};
pub use rate::{
	ParsedRetryAfter, RateAvailability, RateObservation, RateState, RateWindow, RateWindowId,
	RetryAfterInput, RetryAfterParse, RetryAfterParseError, RetryAfterParseErrorKind,
	RetryAfterSource, Sample, parse_retry_after, parse_retry_after_inputs,
};
pub use refresh::{
	CredentialFreshness, PersistentRefreshLease, ProcessRefreshRole, RefreshCoordinator,
	RefreshError, RefreshErrorKind, RefreshLeaseAcquire, RefreshLeaseRequest, RefreshLeaseStore,
	RefreshLeaseWait, RefreshOperationError, RefreshOutcome, RefreshPolicy, RefreshPolicyError,
	RefreshReceipt, RefreshRequest, RefreshResult, RefreshStep, RefreshStoreError,
	RefreshedCredential,
};
pub use store::{
	AccountAffinity, AccountStateStore, AccountStateStoreError, AffinityScope,
	PersistedAccountState, PersistedCooldown, PersistedRejection,
};

use crate::id::{AccountId, PrincipalId};

/// Evidence that an execution retained or changed its account binding.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AccountChangeEvidence {
	/// Account used by the preceding attempt, if any.
	pub previous_account: Option<AccountId>,
	/// Principal used by the preceding attempt, if known.
	pub previous_principal: Option<PrincipalId>,
	/// Account selected for the next attempt.
	pub selected_account: AccountId,
	/// Principal represented by the selected account.
	pub selected_principal: PrincipalId,
	/// Time at which the selection was made.
	pub selected_at: SystemTime,
	/// Whether account-bound provider session state must be discarded.
	pub invalidates_account_bound_session: bool,
}

impl AccountChangeEvidence {
	/// Builds account-change evidence; any account ID change invalidates
	/// account-bound state.
	pub fn new(
		previous_account: Option<AccountId>,
		previous_principal: Option<PrincipalId>,
		selected_account: AccountId,
		selected_principal: PrincipalId,
		selected_at: SystemTime,
	) -> Self {
		let invalidates_account_bound_session = previous_account
			.as_ref()
			.is_some_and(|previous| previous != &selected_account);
		Self {
			previous_account,
			previous_principal,
			selected_account,
			selected_principal,
			selected_at,
			invalidates_account_bound_session,
		}
	}

	/// Returns whether this is a token refresh on the same account and
	/// principal.
	pub fn preserves_account_binding(&self) -> bool {
		self.previous_account.as_ref() == Some(&self.selected_account)
			&& self.previous_principal.as_ref() == Some(&self.selected_principal)
	}
}
