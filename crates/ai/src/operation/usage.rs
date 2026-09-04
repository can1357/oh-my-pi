//! Account usage/quota service composition and typed window normalization.

pub mod alibaba_token_plan;
pub mod claude;
pub mod cursor;
pub mod gemini;
pub mod github_copilot;
pub mod google_antigravity;
pub mod kimi;
pub mod minimax_code;
pub mod ollama;
pub mod openai_codex;
pub mod opencode_go;
pub mod synthetic;
pub mod umans;
pub mod xai_oauth;
pub mod zai;
use std::{
	future::Future,
	sync::Arc,
	task::{Context, Poll},
	time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use dashmap::DashMap;
use omp_core::{SecretString, Str, sf};
use tower::Service;

use crate::{
	account::{AccountPool, QuotaProvenance, QuotaState, QuotaWindowId, RateState},
	answer::{
		Answer, AnswerBody, UsageAccountMetadata, UsageAmount, UsageQuantity, UsageReport,
		UsageResetCredits, UsageUnit, UsageWindow, UsageWindowKind,
	},
	auth::{AuthRejection, AuthRejectionKind, CredentialBroker, CredentialNeed, CredentialSource},
	call::{Call, OperationCall, UsageRequest, UsageScope},
	catalog::{OperationKind, ProviderId, RouteId, snapshot::Catalog},
	error::{Error, ErrorDetail, ErrorKind, ErrorPhase, RetryAction},
	id::{AccountId, PrincipalId},
	operation::{OperationRequest, OperationResponse},
	receipt::{ExecutionReceipt, ReasonId, UsageSource},
};

/// Whether a usage fetcher consumes broker credential material.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum UsageCredentialRequirement {
	/// A fresh scalar credential lease is required.
	Required,
	/// A scalar lease is forwarded when the provider has one, but anonymous
	/// callbacks remain valid.
	Optional,
	/// The provider exposes usage without credentials or network authentication.
	None,
}

/// Typed, secret-free usage-fetch failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum UsageFetchError {
	/// The provider is temporarily unavailable; callers may retain last-good
	/// data.
	#[error("usage endpoint is temporarily unavailable")]
	Unavailable,
	/// The provider rejected the credential and account health must be updated.
	#[error("usage endpoint rejected the credential")]
	AuthRejected,
	/// The provider returned a response that violates its usage contract.
	#[error("usage endpoint returned an invalid response")]
	Protocol,
}

/// Secret-bearing provider usage boundary installed by the application.
pub trait ConsoleUsageFetcher: Send + Sync {
	/// Provider whose credential envelopes this fetcher understands.
	fn provider(&self) -> &ProviderId<str>;
	/// Declares whether the manager must acquire a credential lease.
	fn credential_requirement(&self) -> UsageCredentialRequirement;
	/// Fetches usage under the supplied deadline.
	fn fetch<'a>(
		&'a self,
		credential: Option<&'a SecretString>,
		now: SystemTime,
		deadline: Option<Instant>,
	) -> futures::future::BoxFuture<'a, Result<ConsoleUsageObservation, UsageFetchError>>;
}

/// Secret-free output shared by provider console usage fetchers.
#[derive(Clone, Debug)]
pub struct ConsoleUsageObservation {
	/// Provider account metadata safe to expose to callers.
	pub account_meta:  UsageAccountMetadata,
	/// Provider plan or tier display name.
	pub plan:          Option<Str>,
	/// Provider-defined source label.
	pub source_label:  Option<Str>,
	/// Provider-wide advisory notes.
	pub notes:         Box<[Str]>,
	/// Saved rate-limit reset credits.
	pub reset_credits: Option<UsageResetCredits>,
	/// Normalized quota, balance, billing, or rate windows.
	pub windows:       Vec<UsageWindow>,
}

#[derive(Clone)]
struct RuntimeUsageFetcher {
	registration: Str,
	fetcher:      Arc<dyn ConsoleUsageFetcher>,
}

#[derive(Default)]
struct UsageFetcherState {
	builtins:    DashMap<ProviderId, Arc<dyn ConsoleUsageFetcher>>,
	overrides:   DashMap<ProviderId, Vec<RuntimeUsageFetcher>>,
	generations: DashMap<ProviderId, u64>,
}

/// Clone-cheap provider-id registry for built-in and runtime usage fetchers.
///
/// Runtime registrations are scoped by an opaque registration id. The newest
/// registration for a provider wins; removing it restores the previous
/// registration or built-in without disturbing other providers.
#[derive(Clone, Default)]
pub struct UsageFetcherRegistry {
	state: Arc<UsageFetcherState>,
}

impl UsageFetcherRegistry {
	/// Builds one registry and installs its built-in fetchers.
	pub fn new(fetchers: impl IntoIterator<Item = Arc<dyn ConsoleUsageFetcher>>) -> Self {
		let registry = Self::default();
		registry.install_builtins(fetchers);
		registry
	}

	/// Installs built-in fetchers into a shared preallocated registry handle.
	pub fn install_builtins(
		&self,
		fetchers: impl IntoIterator<Item = Arc<dyn ConsoleUsageFetcher>>,
	) {
		for fetcher in fetchers {
			self
				.state
				.builtins
				.insert(fetcher.provider().to_owned(), fetcher);
		}
	}

	/// Installs or replaces one registration-scoped runtime override.
	///
	/// Re-registering the same id replaces its callback and moves it to the
	/// front of precedence. The returned generation is suitable for inclusion
	/// in a caller's provider-report cache key.
	pub fn register_runtime(
		&self,
		registration: impl Into<Str>,
		fetcher: Arc<dyn ConsoleUsageFetcher>,
	) -> u64 {
		let registration = registration.into();
		let provider = fetcher.provider().to_owned();
		let mut entries = self.state.overrides.entry(provider.clone()).or_default();
		entries.retain(|entry| entry.registration != registration);
		entries.push(RuntimeUsageFetcher { registration, fetcher });
		drop(entries);
		bump_usage_generation(&self.state, &provider)
	}

	/// Removes one exact runtime registration and restores its predecessor.
	///
	/// Returns the new cache generation when a registration was removed.
	pub fn unregister_runtime(&self, provider: &ProviderId<str>, registration: &str) -> Option<u64> {
		let mut entries = self.state.overrides.get_mut(provider)?;
		let before = entries.len();
		entries.retain(|entry| entry.registration != registration);
		if entries.len() == before {
			return None;
		}
		let empty = entries.is_empty();
		drop(entries);
		if empty {
			self.state.overrides.remove(provider);
		}
		Some(bump_usage_generation(&self.state, provider))
	}

	/// Returns the provider-scoped cache generation.
	///
	/// Every effective registration or unregistration increments this value,
	/// invalidating snapshots fetched through an earlier implementation.
	pub fn cache_generation(&self, provider: &ProviderId<str>) -> u64 {
		self
			.state
			.generations
			.get(provider)
			.map(|generation| *generation)
			.unwrap_or_default()
	}

	fn get(&self, provider: &ProviderId<str>) -> Option<Arc<dyn ConsoleUsageFetcher>> {
		self
			.state
			.overrides
			.get(provider)
			.and_then(|entries| entries.last().map(|entry| Arc::clone(&entry.fetcher)))
			.or_else(|| {
				self
					.state
					.builtins
					.get(provider)
					.map(|fetcher| Arc::clone(&*fetcher))
			})
	}
}

fn bump_usage_generation(state: &UsageFetcherState, provider: &ProviderId<str>) -> u64 {
	let mut generation = state.generations.entry(provider.to_owned()).or_default();
	*generation = generation.saturating_add(1);
	*generation
}

/// Route-independent provider console usage dispatcher.
///
/// The application composition root installs this service beside the auth
/// manager. It acquires a fresh raw lease only for fetchers that require one,
/// preserving credential envelopes without placing console cookies on
/// inference requests. Authentication rejections are sent through the broker's
/// existing credential-rejection path before a typed authentication error is
/// surfaced.
#[derive(Clone)]
pub struct ConsoleUsageManager {
	catalog:     Arc<Catalog>,
	credentials: CredentialBroker,
	accounts:    AccountPool,
	fetchers:    UsageFetcherRegistry,
}

impl ConsoleUsageManager {
	/// Constructs a manager over application-registered usage fetchers.
	pub const fn new(
		catalog: Arc<Catalog>,
		credentials: CredentialBroker,
		accounts: AccountPool,
		fetchers: UsageFetcherRegistry,
	) -> Self {
		Self { catalog, credentials, accounts, fetchers }
	}

	/// Returns the shared registry used for runtime usage-provider overlays.
	pub fn fetchers(&self) -> UsageFetcherRegistry {
		self.fetchers.clone()
	}

	/// Fetches and normalizes usage for one planned provider route.
	pub async fn execute(
		&self,
		provider: &ProviderId<str>,
		route: &RouteId<str>,
		request: &UsageRequest,
		deadline: Option<Instant>,
	) -> Result<UsageReport, Error> {
		let fetcher = self
			.fetchers
			.get(provider)
			.ok_or_else(|| usage_error("console_usage_backend_missing"))?;
		let record = if let Some(account) = request.account.as_ref() {
			self.accounts.account(account).filter(|record| {
				record.enabled && &record.provider == provider && record.routes.contains(route)
			})
		} else {
			self.accounts.accounts().into_iter().find(|record| {
				record.enabled && &record.provider == provider && record.routes.contains(route)
			})
		};
		let (account, principal) = match record {
			Some(record) => (record.account, record.principal),
			None if request.account.is_none() => {
				let identity = format!("{}:environment", provider.as_str());
				(AccountId::from(identity.clone()), PrincipalId::from(identity))
			},
			None => return Err(usage_error("console_usage_account_missing")),
		};
		let credential_requirement = fetcher.credential_requirement();
		let lease = match credential_requirement {
			UsageCredentialRequirement::Required | UsageCredentialRequirement::Optional => {
				let acquired = match self
					.catalog
					.route(route)
					.filter(|definition| &definition.provider == provider)
				{
					Some(route_def) => self
						.credentials
						.lease(CredentialNeed {
							spec:        route_def.auth.clone(),
							account:     Some(account.clone()),
							principal:   Some(principal.clone()),
							valid_after: SystemTime::now(),
						})
						.await
						.ok(),
					None => None,
				};
				if credential_requirement == UsageCredentialRequirement::Required && acquired.is_none()
				{
					return Err(usage_error("console_usage_credential_unavailable"));
				}
				acquired
			},
			UsageCredentialRequirement::None => None,
		};
		let credential = lease.as_ref().and_then(|lease| lease.scalar_secret());
		if credential_requirement == UsageCredentialRequirement::Required && credential.is_none() {
			return Err(usage_error("console_usage_credential_kind_unsupported"));
		}
		let observed_at = SystemTime::now();
		let fetched = match fetcher.fetch(credential, observed_at, deadline).await {
			Ok(fetched) => fetched,
			Err(UsageFetchError::AuthRejected) => {
				if let Some(lease) = lease.as_ref() {
					self
						.credentials
						.reject(lease, AuthRejection {
							kind:        AuthRejectionKind::Invalid,
							status:      None,
							code:        Some(sf!("usage-auth-rejected")),
							refreshable: false,
						})
						.await
						.map_err(|_| usage_error("console_usage_credential_rejection_failed"))?;
				}
				return Err(usage_fetch_error(UsageFetchError::AuthRejected));
			},
			Err(error) => return Err(usage_fetch_error(error)),
		};
		let (account, principal) = lease.as_ref().map_or_else(
			|| (account, Some(principal)),
			|lease| (lease.meta().account.clone(), Some(lease.meta().principal.clone())),
		);
		let mut report = UsageReport {
			provider: provider.to_owned(),
			account,
			principal,
			plan: fetched.plan,
			account_meta: fetched.account_meta,
			source_label: fetched.source_label,
			notes: fetched.notes,
			reset_credits: fetched.reset_credits,
			windows: fetched.windows,
		};
		normalize_report(&mut report, request, UsageServiceConfig {
			maximum_age: Duration::MAX,
			clock:       SystemTime::now,
		})?;
		Ok(report)
	}
}

fn usage_error(reason: &'static str) -> Error {
	Error::new(
		ErrorKind::ProviderContractMismatch,
		ErrorPhase::Discovery,
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
	.detail(ErrorDetail::protocol(ReasonId(Str::new(reason))))
}

fn usage_fetch_error(error: UsageFetchError) -> Error {
	let (kind, phase, retry, reason) = match error {
		UsageFetchError::Unavailable => (
			ErrorKind::RouteUnavailable,
			ErrorPhase::Discovery,
			RetryAction::SameRoute { after: Duration::from_secs(10) },
			"console_usage_unavailable",
		),
		UsageFetchError::AuthRejected => (
			ErrorKind::Authentication,
			ErrorPhase::Authentication,
			RetryAction::Never,
			"console_usage_auth_rejected",
		),
		UsageFetchError::Protocol => (
			ErrorKind::Protocol,
			ErrorPhase::Discovery,
			RetryAction::Never,
			"console_usage_protocol_error",
		),
	};
	Error::new(kind, phase, retry, ExecutionReceipt::default())
		.detail(ErrorDetail::protocol(ReasonId(Str::new(reason))))
}

/// Configures stale-observation enforcement for a usage service.
#[derive(Clone, Copy, Debug)]
pub struct UsageServiceConfig {
	/// Largest acceptable age when the caller forbids stale observations.
	pub maximum_age: Duration,
	/// Injectable clock used for deterministic replay.
	pub clock:       fn() -> SystemTime,
}

impl UsageServiceConfig {
	/// Constructs a usage policy using the system wall clock.
	pub const fn new(maximum_age: Duration) -> Self {
		Self { maximum_age, clock: SystemTime::now }
	}
}

/// Concrete usage service over a constructed account/auth/codec backend.
#[derive(Clone, Debug)]
pub struct UsageService<S> {
	inner:  S,
	config: UsageServiceConfig,
}

impl<S> UsageService<S> {
	/// Wraps a route backend that returns typed, secret-free usage windows.
	pub const fn new(inner: S, config: UsageServiceConfig) -> Self {
		Self { inner, config }
	}
}

impl<S> Service<Call> for UsageService<S>
where
	S: Service<
			OperationRequest<UsageRequest>,
			Response = OperationResponse<UsageReport>,
			Error = Error,
		>,
	S::Future: Send + 'static,
{
	type Error = Error;
	type Response = Answer;

	type Future = impl Future<Output = Result<Answer, Error>> + Send;

	fn poll_ready(&mut self, context: &mut Context<'_>) -> Poll<Result<(), Self::Error>> {
		self.inner.poll_ready(context)
	}

	fn call(&mut self, call: Call) -> Self::Future {
		let request = match &call.operation {
			OperationCall::Usage(request) => {
				Some(OperationRequest::from_call(&call, Arc::clone(request)))
			},
			_ => None,
		};
		let pending = request
			.as_ref()
			.map(|request| self.inner.call(request.clone()));
		let config = self.config;
		async move {
			let Some(request) = request else {
				return Err(wrong_operation(&call));
			};
			let Some(pending) = pending else {
				return Err(protocol_error("usage_backend_not_called"));
			};
			let mut response = pending.await?;
			normalize_report(&mut response.output, &request.payload, config)?;
			Ok(response.into_answer(|report| AnswerBody::Usage(Box::new(report))))
		}
	}
}

/// Validates selectors, freshness, fixed-point arithmetic, metadata, and
/// requested window scope in place.
///
/// Consumed overage is valid when remaining is absent or zero; remaining itself
/// may never exceed the limit.
pub fn normalize_report(
	report: &mut UsageReport,
	request: &UsageRequest,
	config: UsageServiceConfig,
) -> Result<(), Error> {
	if request
		.provider
		.as_ref()
		.is_some_and(|provider| provider != &report.provider)
	{
		return Err(protocol_error("usage_provider_selector_mismatch"));
	}
	if request
		.account
		.as_ref()
		.is_some_and(|account| account != &report.account)
	{
		return Err(protocol_error("usage_account_selector_mismatch"));
	}
	if report
		.account_meta
		.provider_account_id
		.as_ref()
		.is_some_and(|value| value.is_empty())
		|| report
			.account_meta
			.email
			.as_ref()
			.is_some_and(|value| value.is_empty())
		|| report
			.account_meta
			.project_id
			.as_ref()
			.is_some_and(|value| value.is_empty())
		|| report
			.account_meta
			.organization_id
			.as_ref()
			.is_some_and(|value| value.is_empty())
		|| report
			.account_meta
			.organization_name
			.as_ref()
			.is_some_and(|value| value.is_empty())
	{
		return Err(protocol_error("usage_account_metadata_empty"));
	}
	if report.reset_credits.as_ref().is_some_and(|reset| {
		reset.credits.iter().any(|credit| {
			credit
				.granted_at
				.zip(credit.expires_at)
				.is_some_and(|(granted, expires)| expires < granted)
		})
	}) {
		return Err(protocol_error("usage_reset_credit_expiry_invalid"));
	}
	let now = (config.clock)();
	for window in &report.windows {
		if window.id.is_empty() {
			return Err(protocol_error("usage_window_id_missing"));
		}
		if window.dimension.is_empty() {
			return Err(protocol_error("usage_window_dimension_missing"));
		}
		if window.scope.as_ref().is_some_and(|scope| scope.is_empty()) {
			return Err(protocol_error("usage_window_scope_empty"));
		}
		if [window.amount.consumed, window.amount.remaining, window.amount.limit]
			.into_iter()
			.flatten()
			.any(|quantity| quantity.decimal_exponent > 18)
		{
			return Err(protocol_error(if window.amount.unit == UsageUnit::Usd {
				"usage_usd_exponent_out_of_range"
			} else {
				"usage_amount_exponent_out_of_range"
			}));
		}
		if window.duration.is_some_and(|duration| duration.is_zero()) {
			return Err(protocol_error("usage_window_duration_zero"));
		}
		if window
			.amount
			.limit
			.zip(window.amount.remaining)
			.is_some_and(|(limit, remaining)| quantity_exceeds(remaining, limit))
		{
			return Err(protocol_error("usage_window_remaining_exceeds_limit"));
		}
		if window
			.amount
			.limit
			.zip(window.amount.consumed)
			.is_some_and(|(limit, consumed)| {
				quantity_exceeds(consumed, limit)
					&& window
						.amount
						.remaining
						.is_some_and(|remaining| remaining.units != 0)
			}) {
			return Err(protocol_error("usage_window_overage_has_remaining"));
		}
		if !request.allow_stale
			&& now
				.duration_since(window.observed_at)
				.is_ok_and(|age| age > config.maximum_age)
		{
			return Err(stale_error(&window.dimension));
		}
	}
	report
		.windows
		.retain(|window| scope_includes(request.scope, window.kind));
	report.windows.sort_by(|left, right| {
		window_kind_rank(left.kind)
			.cmp(&window_kind_rank(right.kind))
			.then_with(|| left.dimension.cmp(&right.dimension))
			.then_with(|| left.scope.cmp(&right.scope))
			.then_with(|| left.id.cmp(&right.id))
			.then_with(|| left.observed_at.cmp(&right.observed_at))
	});
	Ok(())
}

/// Returns whether one fixed-point quantity is greater than another.
fn quantity_exceeds(left: UsageQuantity, right: UsageQuantity) -> bool {
	let exponent = left.decimal_exponent.max(right.decimal_exponent);
	let left_scale = 10_u128.pow(u32::from(exponent - left.decimal_exponent));
	let right_scale = 10_u128.pow(u32::from(exponent - right.decimal_exponent));
	u128::from(left.units) * left_scale > u128::from(right.units) * right_scale
}

/// Creates a usage report from shared account quota and rate state without
/// reading secrets.
pub fn report_from_account_state(
	provider: ProviderId,
	account: AccountId,
	principal: Option<PrincipalId>,
	quota: &QuotaState,
	rate: &RateState,
	quota_kinds: &[(QuotaWindowId, UsageWindowKind)],
) -> UsageReport {
	let mut windows = Vec::with_capacity(quota.windows().len() + rate.windows().len());
	for (id, window) in quota.windows() {
		let kind = quota_kinds
			.iter()
			.find_map(|(mapped, kind)| (mapped == id).then_some(*kind))
			.unwrap_or(UsageWindowKind::Quota);
		let observed_at = [
			window.consumed.map(|sample| sample.observed_at),
			window.remaining.map(|sample| sample.observed_at),
			window.limit.map(|sample| sample.observed_at),
			window.reset_at.map(|sample| sample.observed_at),
			window.exhausted.map(|sample| sample.observed_at),
		]
		.into_iter()
		.flatten()
		.max()
		.unwrap_or(UNIX_EPOCH);
		let source = window
			.receipts
			.last()
			.map_or(UsageSource::Unknown, |receipt| quota_source(receipt.provenance));
		windows.push(UsageWindow {
			id: id.0.clone(),
			kind,
			dimension: id.0.clone(),
			label: None,
			scope: None,
			amount: UsageAmount {
				unit:      UsageUnit::Unknown,
				consumed:  window
					.consumed
					.map(|sample| UsageQuantity::new(sample.value, 0)),
				remaining: window
					.remaining
					.map(|sample| UsageQuantity::new(sample.value, 0)),
				limit:     window
					.limit
					.map(|sample| UsageQuantity::new(sample.value, 0)),
			},
			status: None,
			duration: None,
			resets_at: window.reset_at.map(|sample| sample.value),
			reset_label: None,
			notes: Box::default(),
			source,
			observed_at,
		});
	}
	for (id, window) in rate.windows() {
		let limit = window.limit.map(|sample| sample.value);
		let remaining = window.remaining.map(|sample| sample.value);
		let consumed = limit
			.zip(remaining)
			.map(|(limit, remaining)| limit.saturating_sub(remaining));
		let observed_at = [
			window.limit.map(|sample| sample.observed_at),
			window.remaining.map(|sample| sample.observed_at),
			window.reset_at.map(|sample| sample.observed_at),
			window.retry_at.map(|sample| sample.observed_at),
		]
		.into_iter()
		.flatten()
		.max()
		.unwrap_or(UNIX_EPOCH);
		windows.push(UsageWindow {
			id: id.0.clone(),
			kind: UsageWindowKind::RateLimit,
			dimension: id.0.clone(),
			label: None,
			scope: None,
			amount: UsageAmount {
				unit:      UsageUnit::Unknown,
				consumed:  consumed.map(|value| UsageQuantity::new(value, 0)),
				remaining: remaining.map(|value| UsageQuantity::new(value, 0)),
				limit:     limit.map(|value| UsageQuantity::new(value, 0)),
			},
			status: None,
			duration: None,
			resets_at: window.reset_at.map(|sample| sample.value),
			reset_label: None,
			notes: Box::default(),
			source: UsageSource::Provider,
			observed_at,
		});
	}
	UsageReport {
		provider,
		account,
		principal,
		plan: None,
		account_meta: UsageAccountMetadata::default(),
		source_label: None,
		notes: Box::default(),
		reset_credits: None,
		windows,
	}
}

const fn quota_source(source: QuotaProvenance) -> UsageSource {
	match source {
		QuotaProvenance::Provider | QuotaProvenance::Header | QuotaProvenance::Error => {
			UsageSource::Provider
		},
		QuotaProvenance::Measured => UsageSource::Measured,
	}
}

fn scope_includes(scope: UsageScope, kind: UsageWindowKind) -> bool {
	match scope {
		UsageScope::All => true,
		UsageScope::Current => matches!(kind, UsageWindowKind::RateLimit | UsageWindowKind::Quota),
		UsageScope::Billing => matches!(kind, UsageWindowKind::Billing | UsageWindowKind::Balance),
		UsageScope::RateLimit => kind == UsageWindowKind::RateLimit,
	}
}

const fn window_kind_rank(kind: UsageWindowKind) -> u8 {
	match kind {
		UsageWindowKind::RateLimit => 0,
		UsageWindowKind::Quota => 1,
		UsageWindowKind::Billing => 2,
		UsageWindowKind::Balance => 3,
	}
}

fn wrong_operation(call: &Call) -> Error {
	Error::new(
		ErrorKind::InternalInvariant,
		ErrorPhase::Internal,
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
	.detail(ErrorDetail::capability(
		Str::new(OperationKind::Usage.to_string()),
		ReasonId(sf!("operation_service_mismatch")),
	))
	.request_id(call.id.clone())
}

fn stale_error(dimension: &str) -> Error {
	Error::new(
		ErrorKind::ProviderContractMismatch,
		ErrorPhase::Discovery,
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
	.detail(ErrorDetail::protocol(ReasonId(sf!("stale_usage_window:{dimension}"))))
}

fn protocol_error(reason: &'static str) -> Error {
	Error::new(
		ErrorKind::ProviderContractMismatch,
		ErrorPhase::Discovery,
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
	.detail(ErrorDetail::protocol(ReasonId(Str::new(reason))))
}

#[cfg(test)]
mod tests {
	use std::{
		sync::{
			Arc,
			atomic::{AtomicUsize, Ordering},
		},
		time::{self, Duration, UNIX_EPOCH},
	};

	use omp_core::sf;

	use super::{
		ConsoleUsageFetcher, ConsoleUsageObservation, UsageCredentialRequirement, UsageFetchError,
		UsageFetcherRegistry, UsageServiceConfig, normalize_report, report_from_account_state,
	};
	use crate::{
		account::{QuotaObservation, QuotaProvenance, QuotaState, QuotaWindowId, RateState},
		answer::{UsageQuantity, UsageUnit, UsageWindowKind},
		call::{UsageRequest, UsageScope},
		catalog::ProviderId,
		id::AccountId,
	};

	fn now() -> time::SystemTime {
		UNIX_EPOCH + Duration::from_secs(120)
	}
	fn late() -> time::SystemTime {
		UNIX_EPOCH + Duration::from_secs(300)
	}
	struct CountingFetcher {
		provider: ProviderId,
		calls:    Arc<AtomicUsize>,
	}

	impl ConsoleUsageFetcher for CountingFetcher {
		fn provider(&self) -> &ProviderId<str> {
			&self.provider
		}

		fn credential_requirement(&self) -> UsageCredentialRequirement {
			UsageCredentialRequirement::None
		}

		fn fetch<'a>(
			&'a self,
			_credential: Option<&'a omp_core::SecretString>,
			_now: time::SystemTime,
			_deadline: Option<time::Instant>,
		) -> futures::future::BoxFuture<'a, Result<ConsoleUsageObservation, UsageFetchError>> {
			self.calls.fetch_add(1, Ordering::Relaxed);
			Box::pin(async { Err(UsageFetchError::Unavailable) })
		}
	}

	#[test]
	fn shared_quota_state_projects_to_typed_current_window() {
		let id = QuotaWindowId::new("tokens");
		let mut quota = QuotaState::default();
		quota.apply(QuotaObservation {
			window:      id.clone(),
			consumed:    Some(40),
			remaining:   Some(60),
			limit:       Some(100),
			reset_at:    Some(now() + Duration::from_secs(60)),
			exhausted:   Some(false),
			provenance:  QuotaProvenance::Provider,
			observed_at: now(),
		});
		let provider = ProviderId::from("provider");
		let account = AccountId::from("account");
		let mut report = report_from_account_state(
			provider.clone(),
			account.clone(),
			None,
			&quota,
			&RateState::default(),
			&[(id, UsageWindowKind::Quota)],
		);
		normalize_report(
			&mut report,
			&UsageRequest {
				provider:    Some(provider),
				account:     Some(account),
				scope:       UsageScope::Current,
				allow_stale: false,
			},
			UsageServiceConfig { maximum_age: Duration::from_secs(30), clock: now },
		)
		.expect("fresh report");
		assert_eq!(report.windows[0].amount.consumed.map(|value| value.units), Some(40));
		assert_eq!(report.windows[0].amount.remaining.map(|value| value.units), Some(60));
	}

	#[test]
	fn stale_and_inconsistent_usage_windows_are_rejected() {
		let id = QuotaWindowId::new("tokens");
		let mut quota = QuotaState::default();
		quota.apply(QuotaObservation {
			window:      id.clone(),
			consumed:    Some(40),
			remaining:   Some(60),
			limit:       Some(100),
			reset_at:    None,
			exhausted:   Some(false),
			provenance:  QuotaProvenance::Provider,
			observed_at: now(),
		});
		let provider = ProviderId::from("provider");
		let account = AccountId::from("account");
		let request = UsageRequest {
			provider:    Some(provider.clone()),
			account:     Some(account.clone()),
			scope:       UsageScope::Current,
			allow_stale: false,
		};
		let mut stale = report_from_account_state(
			provider.clone(),
			account.clone(),
			None,
			&quota,
			&RateState::default(),
			&[(id.clone(), UsageWindowKind::Quota)],
		);
		assert!(
			normalize_report(&mut stale, &request, UsageServiceConfig {
				maximum_age: Duration::from_secs(30),
				clock:       late,
			},)
			.is_err()
		);

		let mut inconsistent =
			report_from_account_state(provider, account, None, &quota, &RateState::default(), &[(
				id,
				UsageWindowKind::Quota,
			)]);
		inconsistent.windows[0].amount.remaining = Some(UsageQuantity::new(101, 0));
		assert!(
			normalize_report(&mut inconsistent, &request, UsageServiceConfig {
				maximum_age: Duration::from_secs(30),
				clock:       now,
			},)
			.is_err()
		);

		inconsistent.windows[0].amount.consumed = Some(UsageQuantity::new(125, 0));
		inconsistent.windows[0].amount.remaining = Some(UsageQuantity::new(0, 0));
		normalize_report(&mut inconsistent, &request, UsageServiceConfig {
			maximum_age: Duration::from_secs(30),
			clock:       now,
		})
		.expect("overage with zero remaining");
		inconsistent.windows[0].amount.remaining = Some(UsageQuantity::new(1, 0));
		assert!(
			normalize_report(&mut inconsistent, &request, UsageServiceConfig {
				maximum_age: Duration::from_secs(30),
				clock:       now,
			},)
			.is_err()
		);
	}

	#[test]
	fn fixed_point_scope_validation_and_sorting_are_deterministic() {
		let id = QuotaWindowId::new("credits");
		let mut quota = QuotaState::default();
		quota.apply(QuotaObservation {
			window:      id.clone(),
			consumed:    Some(100),
			remaining:   Some(900),
			limit:       Some(1_000),
			reset_at:    None,
			exhausted:   Some(false),
			provenance:  QuotaProvenance::Provider,
			observed_at: now(),
		});
		let provider = ProviderId::from("provider");
		let account = AccountId::from("account");
		let request = UsageRequest {
			provider:    Some(provider.clone()),
			account:     Some(account.clone()),
			scope:       UsageScope::All,
			allow_stale: false,
		};
		let mut report =
			report_from_account_state(provider, account, None, &quota, &RateState::default(), &[(
				id,
				UsageWindowKind::Billing,
			)]);
		report.windows[0].amount.unit = UsageUnit::Usd;
		report.windows[0].amount.consumed = Some(UsageQuantity::new(100, 2));
		report.windows[0].scope = Some(sf!("model:z"));
		let mut earlier_scope = report.windows[0].clone();
		earlier_scope.id = sf!("credits:a");
		earlier_scope.scope = Some(sf!("model:a"));
		report.windows.push(earlier_scope);
		normalize_report(&mut report, &request, UsageServiceConfig {
			maximum_age: Duration::from_secs(30),
			clock:       now,
		})
		.expect("valid fixed-point report");
		assert_eq!(report.windows[0].scope.as_deref(), Some("model:a"));

		report.windows[0].scope = Some(Default::default());
		assert!(
			normalize_report(&mut report, &request, UsageServiceConfig {
				maximum_age: Duration::from_secs(30),
				clock:       now,
			},)
			.is_err()
		);
		report.windows[0].scope = Some(sf!("model:a"));
		report.windows[0].amount.consumed = Some(UsageQuantity::new(100, 19));
		assert!(
			normalize_report(&mut report, &request, UsageServiceConfig {
				maximum_age: Duration::from_secs(30),
				clock:       now,
			},)
			.is_err()
		);
	}
	#[tokio::test]
	async fn runtime_usage_overrides_restore_and_invalidate_per_provider() {
		let provider = ProviderId::from("extension");
		let other = ProviderId::from("other");
		let builtin_calls = Arc::new(AtomicUsize::new(0));
		let first_calls = Arc::new(AtomicUsize::new(0));
		let second_calls = Arc::new(AtomicUsize::new(0));
		let registry = UsageFetcherRegistry::new([
			Arc::new(CountingFetcher {
				provider: provider.clone(),
				calls:    Arc::clone(&builtin_calls),
			}) as Arc<dyn ConsoleUsageFetcher>,
			Arc::new(CountingFetcher {
				provider: other.clone(),
				calls:    Arc::new(AtomicUsize::new(0)),
			}),
		]);
		assert_eq!(registry.cache_generation(&provider), 0);
		let first_generation = registry.register_runtime(
			"extension-a",
			Arc::new(CountingFetcher {
				provider: provider.clone(),
				calls:    Arc::clone(&first_calls),
			}),
		);
		let second_generation = registry.register_runtime(
			"extension-b",
			Arc::new(CountingFetcher {
				provider: provider.clone(),
				calls:    Arc::clone(&second_calls),
			}),
		);
		assert_eq!(first_generation, 1);
		assert_eq!(second_generation, 2);
		assert_eq!(registry.cache_generation(&other), 0);
		let _ = registry
			.get(&provider)
			.expect("latest override")
			.fetch(None, now(), None)
			.await;
		assert_eq!(second_calls.load(Ordering::Relaxed), 1);
		assert_eq!(registry.unregister_runtime(&provider, "extension-b"), Some(3));
		let _ = registry
			.get(&provider)
			.expect("previous override")
			.fetch(None, now(), None)
			.await;
		assert_eq!(first_calls.load(Ordering::Relaxed), 1);
		assert_eq!(registry.unregister_runtime(&provider, "extension-a"), Some(4));
		let _ = registry
			.get(&provider)
			.expect("restored builtin")
			.fetch(None, now(), None)
			.await;
		assert_eq!(builtin_calls.load(Ordering::Relaxed), 1);
		assert_eq!(registry.unregister_runtime(&provider, "missing"), None);
	}
}
