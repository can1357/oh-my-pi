//! Account routing, refresh, and lease coordination contracts.

use std::{
	collections::{BTreeSet, VecDeque},
	future::Future,
	pin::Pin,
	sync::{
		Arc,
		atomic::{AtomicUsize, Ordering},
	},
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use omp_ai::{
	AccountId, AccountRoutingContext, OrganizationId, PrincipalId, ProjectId, RegionId, TenantId,
	account::{
		AccountAffinity, AccountPool, AccountRecord, AccountRegistrationError,
		AccountSelectionRequest, AccountStateStore, AffinityScope, CooldownReason,
		CredentialFreshness, Eligibility, PersistentRefreshLease, ProcessRefreshRole,
		QuotaAvailability, QuotaObservation, QuotaProvenance, QuotaWindowId, RateAvailability,
		RateObservation, RateWindowId, RefreshCoordinator, RefreshErrorKind, RefreshLeaseAcquire,
		RefreshLeaseRequest, RefreshLeaseStore, RefreshLeaseWait, RefreshPolicy, RefreshPolicyError,
		RefreshReceipt, RefreshRequest, RefreshResult, RefreshStep, RefreshStoreError,
		RefreshedCredential, RetryAfterInput, RotationPolicy, parse_retry_after_inputs,
	},
};
use omp_catalog::{ProviderId, RouteId};
use parking_lot::Mutex;
use tokio::time;

fn at(seconds: u64) -> SystemTime {
	UNIX_EPOCH + Duration::from_secs(seconds)
}

fn record(account: &str, principal: &str, route: &RouteId) -> AccountRecord {
	AccountRecord {
		account:               AccountId::new(account),
		principal:             PrincipalId::new(principal),
		provider:              ProviderId::from("provider"),
		routes:                BTreeSet::from([route.clone()]),
		enabled:               true,
		credential_generation: 1,
		routing:               AccountRoutingContext::default(),
	}
}

fn selection_request(route: &RouteId, now: SystemTime) -> AccountSelectionRequest {
	AccountSelectionRequest {
		provider: ProviderId::from("provider"),
		route: route.clone(),
		affinity: None,
		previous_account: None,
		previous_principal: None,
		rotate: false,
		rotation: RotationPolicy::default(),
		now,
		quota_scope: None,
	}
}

#[test]
fn account_and_principal_are_separate_stable_identities() {
	let pool = AccountPool::new();
	let route = RouteId::from("route");
	pool
		.upsert(record("account", "principal-a", &route))
		.unwrap();
	let error = pool
		.upsert(record("account", "principal-b", &route))
		.unwrap_err();
	assert!(
		matches!(error, AccountRegistrationError::PrincipalRebind { account, .. } if account == AccountId::new("account"))
	);
	let mut wrong_provider = record("account", "principal-a", &route);
	wrong_provider.provider = ProviderId::from("other-provider");
	let error = pool.upsert(wrong_provider).unwrap_err();
	assert!(
		matches!(error, AccountRegistrationError::ProviderRebind { account, .. } if account == AccountId::new("account"))
	);
	pool
		.upsert(record("account-z", "principal-z", &route))
		.unwrap();
	assert_eq!(
		pool
			.accounts()
			.into_iter()
			.map(|record| record.account)
			.collect::<Vec<_>>(),
		vec![AccountId::new("account"), AccountId::new("account-z")],
	);
	assert_eq!(
		pool
			.account(AccountId::from_ref("account"))
			.unwrap()
			.principal,
		PrincipalId::new("principal-a")
	);
}

#[test]
fn freshness_rejection_blocks_only_the_rejected_generation() {
	let pool = AccountPool::new();
	let route = RouteId::from("route");
	let account = AccountId::new("freshness");
	let principal = PrincipalId::new("principal");
	pool
		.upsert(record("freshness", "principal", &route))
		.unwrap();
	pool.reject_credential(account.clone(), 1, at(100)).unwrap();
	let mut request = selection_request(&route, at(100));
	request.previous_account = Some(account.clone());
	request.previous_principal = Some(principal.clone());
	assert!(pool.select(&request).is_err());
	assert!(
		pool
			.update_credential_generation(&account, &principal, 2)
			.unwrap()
	);
	let selected = pool.select(&request).unwrap();
	assert_eq!(selected.record.credential_generation, 2);
	assert!(selected.account_change.preserves_account_binding());
	assert!(!selected.account_change.invalidates_account_bound_session);
}

#[test]
fn quota_and_rate_429_timelines_never_poison_each_other() {
	let pool = AccountPool::new();
	let route = RouteId::from("route");
	let account = AccountId::new("account");
	pool.upsert(record("account", "principal", &route)).unwrap();
	pool
		.record_quota_429(account.clone(), QuotaWindowId::new("monthly"), Some(at(200)), at(100))
		.unwrap();
	assert_eq!(pool.rate_state(&account).availability(at(100)), RateAvailability::Available);
	assert_eq!(pool.quota_state(&account).availability(at(100)), QuotaAvailability::Exhausted {
		reset_at: at(200),
	});
	assert_eq!(pool.quota_state(&account).availability(at(200)), QuotaAvailability::Available);

	let other = AccountId::new("other");
	pool
		.upsert(record("other", "other-principal", &route))
		.unwrap();
	pool
		.record_rate_429(other.clone(), RateWindowId::new("requests"), Some(at(150)), at(100))
		.unwrap();
	assert_eq!(pool.rate_state(&other).availability(at(100)), RateAvailability::Delayed {
		until: at(150),
	});
	assert_eq!(pool.quota_state(&other).availability(at(100)), QuotaAvailability::Available);
}

#[test]
fn quota_headroom_ranks_accounts_and_exhaustion_expires_at_provider_reset() {
	let pool = AccountPool::new();
	let route = RouteId::from("route");
	let loaded = AccountId::new("loaded");
	let sibling = AccountId::new("sibling");
	pool
		.upsert(record("loaded", "loaded-principal", &route))
		.unwrap();
	pool
		.upsert(record("sibling", "sibling-principal", &route))
		.unwrap();
	for (account, five_hour, weekly) in [(loaded.clone(), 90, 80), (sibling.clone(), 50, 50)] {
		for (window, remaining, reset_at) in
			[("5h", five_hour, at(18_100)), ("7d", weekly, at(604_900))]
		{
			pool
				.observe_quota(account.clone(), QuotaObservation {
					window:      QuotaWindowId::new(window),
					consumed:    Some(100 - remaining),
					remaining:   Some(remaining),
					limit:       Some(100),
					reset_at:    Some(reset_at),
					exhausted:   Some(false),
					provenance:  QuotaProvenance::Provider,
					observed_at: at(100),
				})
				.unwrap();
		}
	}
	assert_eq!(
		pool
			.select(&selection_request(&route, at(100)))
			.unwrap()
			.record
			.account,
		loaded
	);
	pool
		.record_quota_429(loaded.clone(), QuotaWindowId::new("5h"), Some(at(18_100)), at(101))
		.unwrap();
	assert_eq!(
		pool
			.select(&selection_request(&route, at(102)))
			.unwrap()
			.record
			.account,
		sibling
	);
	assert_eq!(
		pool
			.select(&selection_request(&route, at(18_100)))
			.unwrap()
			.record
			.account,
		loaded
	);
}

#[test]
fn model_policy_cooldown_blocks_one_route_and_rotates_to_an_entitled_sibling() {
	// A ChatGPT account denied one Codex model must stop competing
	// for that model while its other entitlements — and its siblings — keep
	// working; the block expires on its own.
	let pool = AccountPool::new();
	let denied_route = RouteId::from("codex/gpt-daybreak");
	let other_route = RouteId::from("codex/gpt-codex");
	let mut denied = record("denied", "denied-principal", &denied_route);
	denied.routes.insert(other_route.clone());
	let mut sibling = record("sibling", "sibling-principal", &denied_route);
	sibling.routes.insert(other_route.clone());
	pool.upsert(denied).unwrap();
	pool.upsert(sibling).unwrap();

	pool.cooldown_route(
		AccountId::new("denied"),
		denied_route.clone(),
		at(500),
		CooldownReason::ModelPolicy,
	);

	// The denied model rotates to the sibling, with typed cooldown evidence.
	let selection = pool
		.select(&selection_request(&denied_route, at(100)))
		.unwrap();
	assert_eq!(selection.record.account, AccountId::new("sibling"));
	let denied_evidence = selection
		.receipt
		.candidates
		.iter()
		.find(|candidate| candidate.account == AccountId::new("denied"))
		.unwrap();
	assert_eq!(denied_evidence.eligibility, Eligibility::Cooldown {
		until:  at(500),
		reason: CooldownReason::ModelPolicy,
	});
	assert_eq!(denied_evidence.eligible_at, Some(at(500)));

	// Every other model on the denied account stays eligible.
	assert_eq!(
		pool
			.select(&selection_request(&other_route, at(100)))
			.unwrap()
			.record
			.account,
		AccountId::new("denied")
	);

	// The block expires: the denied account competes for the model again.
	let recovered = pool
		.select(&selection_request(&denied_route, at(500)))
		.unwrap();
	assert_eq!(
		recovered
			.receipt
			.candidates
			.iter()
			.find(|candidate| candidate.account == AccountId::new("denied"))
			.unwrap()
			.eligibility,
		Eligibility::Eligible
	);
}

#[test]
fn partial_window_receipts_merge_fieldwise_and_reset_deterministically() {
	let pool = AccountPool::new();
	let route = RouteId::from("route");
	let account = AccountId::new("account");
	pool.upsert(record("account", "principal", &route)).unwrap();
	pool
		.observe_rate(account.clone(), RateObservation {
			window:      RateWindowId::new("requests"),
			limit:       Some(10),
			remaining:   None,
			reset_at:    Some(at(200)),
			retry_at:    None,
			observed_at: at(100),
		})
		.unwrap();
	pool
		.observe_rate(account.clone(), RateObservation {
			window:      RateWindowId::new("requests"),
			limit:       None,
			remaining:   Some(0),
			reset_at:    None,
			retry_at:    None,
			observed_at: at(101),
		})
		.unwrap();
	let rate = pool.rate_state(&account);
	let window = rate.window(&RateWindowId::new("requests")).unwrap();
	assert_eq!(window.limit.unwrap().value, 10);
	assert_eq!(window.remaining.unwrap().value, 0);
	assert_eq!(window.receipts.len(), 2);
	assert_eq!(rate.availability(at(199)), RateAvailability::Delayed { until: at(200) });
	assert_eq!(rate.availability(at(200)), RateAvailability::Available);
	pool
		.observe_quota(account.clone(), QuotaObservation {
			window:      QuotaWindowId::new("monthly"),
			consumed:    None,
			remaining:   Some(0),
			limit:       Some(100),
			reset_at:    Some(at(300)),
			exhausted:   Some(true),
			provenance:  QuotaProvenance::Error,
			observed_at: at(100),
		})
		.unwrap();
	pool
		.observe_quota(account.clone(), QuotaObservation {
			window:      QuotaWindowId::new("monthly"),
			consumed:    None,
			remaining:   Some(5),
			limit:       None,
			reset_at:    None,
			exhausted:   None,
			provenance:  QuotaProvenance::Provider,
			observed_at: at(101),
		})
		.unwrap();
	let quota = pool.quota_state(&account);
	assert_eq!(quota.availability(at(102)), QuotaAvailability::Available);
	assert_eq!(
		quota
			.window(&QuotaWindowId::new("monthly"))
			.unwrap()
			.receipts
			.len(),
		2
	);
	assert_eq!(quota.minimum_remaining(at(299)), Some(5));
	assert_eq!(quota.minimum_remaining(at(300)), None);
}

#[test]
fn durable_account_state_survives_reopen_and_account_removal() {
	let directory = tempfile::tempdir().unwrap();
	let path = directory.path().join("app.sqlite");
	let route = RouteId::from("route");
	let account = AccountId::new("durable");
	let route_b = RouteId::from("route-b");
	let principal = PrincipalId::new("principal");
	let scope = AffinityScope::new("conversation");
	{
		let store = Arc::new(AccountStateStore::open(&path).unwrap());
		let pool = AccountPool::with_store(store).unwrap();
		let mut primary = record("durable", "principal", &route);
		primary.routing.project = Some(ProjectId::new("project"));
		primary.routing.tenant = Some(TenantId::new("tenant"));
		primary.routing.organization = Some(OrganizationId::new("organization"));
		primary.routing.region = Some(RegionId::new("region"));
		pool.upsert(primary).unwrap();
		let mut secondary = record("durable-b", "principal-b", &route_b);
		secondary.provider = ProviderId::from("provider-b");
		pool.upsert(secondary).unwrap();
		pool
			.cooldown(account.clone(), at(180), CooldownReason::Health)
			.unwrap();
		pool
			.observe_rate(account.clone(), RateObservation {
				window:      RateWindowId::new("requests"),
				limit:       Some(20),
				remaining:   None,
				reset_at:    Some(at(150)),
				retry_at:    None,
				observed_at: at(100),
			})
			.unwrap();
		pool
			.observe_rate(account.clone(), RateObservation {
				window:      RateWindowId::new("requests"),
				limit:       None,
				remaining:   Some(0),
				reset_at:    None,
				retry_at:    None,
				observed_at: at(101),
			})
			.unwrap();
		pool
			.record_quota_429(account.clone(), QuotaWindowId::new("monthly"), Some(at(170)), at(102))
			.unwrap();
		assert_eq!(
			pool
				.save_affinity(AccountAffinity {
					scope:      AffinityScope::new("invalid"),
					account:    account.clone(),
					principal:  PrincipalId::new("other-principal"),
					updated_at: at(102),
				})
				.unwrap_err(),
			omp_ai::account::AccountStateStoreError::IdentityConflict,
		);
		pool
			.save_affinity(AccountAffinity {
				scope:      scope.clone(),
				account:    account.clone(),
				principal:  principal.clone(),
				updated_at: at(103),
			})
			.unwrap();
		assert!(pool.remove(&account).is_some());
	}
	let store = Arc::new(AccountStateStore::open(&path).unwrap());
	let pool = AccountPool::with_store(store).unwrap();
	assert_eq!(pool.account(&account).unwrap().provider, ProviderId::from("provider"));
	assert_eq!(pool.account(&account).unwrap().routes, BTreeSet::from([route.clone()]));
	assert_eq!(pool.account(&account).unwrap().routing.project, Some(ProjectId::new("project")));
	let cross_provider = pool
		.select(&selection_request(&route_b, at(180)))
		.unwrap_err();
	assert_eq!(cross_provider.receipt.candidates.len(), 1);
	assert_eq!(cross_provider.receipt.candidates[0].eligibility, Eligibility::RouteIneligible);
	let selected_b = pool
		.select(&AccountSelectionRequest {
			provider:           ProviderId::from("provider-b"),
			route:              route_b.clone(),
			affinity:           None,
			previous_account:   None,
			previous_principal: None,
			rotate:             false,
			rotation:           RotationPolicy::default(),
			now:                at(180),
			quota_scope:        None,
		})
		.unwrap();
	assert_eq!(selected_b.record.account, AccountId::new("durable-b"));
	assert_eq!(
		pool
			.rate_state(&account)
			.window(&RateWindowId::new("requests"))
			.unwrap()
			.receipts
			.len(),
		2
	);
	assert_eq!(pool.rate_state(&account).availability(at(120)), RateAvailability::Delayed {
		until: at(150),
	});
	assert_eq!(pool.quota_state(&account).availability(at(120)), QuotaAvailability::Exhausted {
		reset_at: at(170),
	});
	assert_eq!(pool.affinity(&scope).unwrap().unwrap().principal, principal);
	let mut request = selection_request(&route, at(120));
	request.previous_account = Some(account.clone());
	request.previous_principal = Some(PrincipalId::new("principal"));
	let error = pool.select(&request).unwrap_err();
	assert_eq!(error.receipt.retry_at, Some(at(180)));
	request.now = at(180);
	assert_eq!(pool.select(&request).unwrap().record.account, account);
	assert!(
		pool
			.update_credential_generation(
				AccountId::from_ref("durable"),
				PrincipalId::from_ref("principal"),
				2,
			)
			.unwrap()
	);
	pool.upsert(record("durable", "principal", &route)).unwrap();
	assert_eq!(
		pool
			.account(AccountId::from_ref("durable"))
			.unwrap()
			.credential_generation,
		2
	);
	pool
		.reject_credential(AccountId::new("durable"), 2, at(181))
		.unwrap();
	assert!(
		pool
			.set_enabled(AccountId::from_ref("durable-b"), false)
			.unwrap()
	);
	drop(pool);
	let pool = AccountPool::with_store(Arc::new(AccountStateStore::open(&path).unwrap())).unwrap();
	assert_eq!(
		pool
			.account(AccountId::from_ref("durable"))
			.unwrap()
			.credential_generation,
		2
	);
	assert!(
		!pool
			.account(AccountId::from_ref("durable-b"))
			.unwrap()
			.enabled
	);
	let rejection = pool
		.select(&selection_request(&route, at(181)))
		.unwrap_err();
	assert_eq!(rejection.receipt.candidates[0].eligibility, Eligibility::CredentialRejected {
		rejected_generation: 2,
	},);
	assert!(
		pool
			.update_credential_generation(
				AccountId::from_ref("durable"),
				PrincipalId::from_ref("principal"),
				3,
			)
			.unwrap()
	);
	assert_eq!(
		pool
			.select(&selection_request(&route, at(181)))
			.unwrap()
			.record
			.credential_generation,
		3
	);
	assert!(
		pool
			.select(&AccountSelectionRequest {
				provider:           ProviderId::from("provider-b"),
				route:              route_b,
				affinity:           None,
				previous_account:   None,
				previous_principal: None,
				rotate:             false,
				rotation:           RotationPolicy::default(),
				now:                at(181),
				quota_scope:        None,
			})
			.is_err()
	);
}
#[test]
fn affinity_rotation_and_session_invalidation_are_deterministic() {
	let pool = AccountPool::new();
	let route = RouteId::from("route");
	pool.upsert(record("a", "principal-a", &route)).unwrap();
	pool.upsert(record("b", "principal-b", &route)).unwrap();
	let mut request = selection_request(&route, at(100));
	request.affinity = Some(PrincipalId::new("principal-b"));
	let selected = pool.select(&request).unwrap();
	assert_eq!(selected.routing.credential_generation, Some(1));
	assert_eq!(selected.record.account, AccountId::new("b"));
	assert!(!selected.account_change.invalidates_account_bound_session);
	assert_eq!(selected.routing.account, Some(AccountId::new("b")));
	assert_eq!(selected.routing.principal, Some(PrincipalId::new("principal-b")));

	request.previous_account = Some(AccountId::new("b"));
	request.previous_principal = Some(PrincipalId::new("principal-b"));
	request.rotate = true;
	let rotated = pool.select(&request).unwrap();
	assert_eq!(rotated.record.account, AccountId::new("a"));
	assert!(rotated.account_change.invalidates_account_bound_session);
	assert!(rotated.receipt.candidates.iter().any(|candidate| {
		candidate.account == AccountId::new("b")
			&& candidate.eligibility == Eligibility::PreviousAccount
	}));
}

#[test]
fn forbidden_rotation_retains_partial_candidate_evidence() {
	let pool = AccountPool::new();
	let route = RouteId::from("route");
	pool.upsert(record("a", "principal-a", &route)).unwrap();
	pool.upsert(record("b", "principal-b", &route)).unwrap();
	pool
		.cooldown(AccountId::new("a"), at(200), CooldownReason::Health)
		.unwrap();
	let mut request = selection_request(&route, at(100));
	request.previous_account = Some(AccountId::new("a"));
	request.previous_principal = Some(PrincipalId::new("principal-a"));
	request.rotation.allow_account_change = false;
	let error = pool.select(&request).unwrap_err();
	assert_eq!(error.receipt.retry_at, Some(at(200)));
	assert_eq!(error.receipt.candidates.len(), 2);
	assert!(error.receipt.candidates.iter().any(|candidate| {
		candidate.account == AccountId::new("b")
			&& candidate.eligibility == Eligibility::RotationForbidden
	}));
}

#[test]
fn proactive_freshness_uses_explicit_clock_and_skew() {
	let freshness = CredentialFreshness {
		generation:  1,
		issued_at:   Some(at(10)),
		expires_at:  Some(at(200)),
		observed_at: at(100),
	};
	assert!(!freshness.needs_refresh(at(100), Duration::from_secs(99)));
	assert!(freshness.needs_refresh(at(100), Duration::from_secs(100)));
}

#[test]
fn retry_after_inputs_preserve_parse_failures_and_choose_latest_time() {
	let parsed = parse_retry_after_inputs(
		[
			RetryAfterInput::Header("10"),
			RetryAfterInput::Header("Sun, 06 Nov 1994 08:49:37 GMT"),
			RetryAfterInput::Header("Mon, 06 Nov 1994 08:49:37 GMT"),
			RetryAfterInput::UnixSeconds("bad"),
		],
		at(784_111_700),
	);
	assert_eq!(parsed.selected.unwrap().until, at(784_111_777));
	assert_eq!(parsed.rejected.len(), 2);
}

#[derive(Default)]
struct MockStore {
	acquires:       AtomicUsize,
	renews:         AtomicUsize,
	releases:       AtomicUsize,
	acquire_script: Mutex<VecDeque<RefreshLeaseAcquire>>,
	wait_script:    Mutex<VecDeque<RefreshLeaseWait>>,
	published:      Mutex<Option<RefreshResult>>,
}

impl MockStore {
	fn acquired(account: &AccountId<str>) -> RefreshLeaseAcquire {
		RefreshLeaseAcquire::Acquired(PersistentRefreshLease {
			id:         "lease".into(),
			account:    account.to_owned(),
			owner:      "process".into(),
			expires_at: at(200),
		})
	}
}

impl RefreshLeaseStore for MockStore {
	fn try_acquire<'a>(
		&'a self,
		request: &'a RefreshLeaseRequest,
	) -> Pin<Box<dyn Future<Output = Result<RefreshLeaseAcquire, RefreshStoreError>> + Send + 'a>> {
		self.acquires.fetch_add(1, Ordering::SeqCst);
		let result = self
			.acquire_script
			.lock()
			.pop_front()
			.unwrap_or_else(|| Self::acquired(&request.account));
		Box::pin(async move { Ok(result) })
	}

	fn wait_for_newer<'a>(
		&'a self,
		_account: &'a AccountId<str>,
		_minimum_generation: u64,
		_lease_expires_at: SystemTime,
	) -> Pin<Box<dyn Future<Output = Result<RefreshLeaseWait, RefreshStoreError>> + Send + 'a>> {
		let result = self
			.wait_script
			.lock()
			.pop_front()
			.expect("scripted wait result");
		Box::pin(async move { Ok(result) })
	}

	fn renew<'a>(
		&'a self,
		lease: &'a mut PersistentRefreshLease,
		now: SystemTime,
		ttl: Duration,
	) -> Pin<Box<dyn Future<Output = Result<bool, RefreshStoreError>> + Send + 'a>> {
		self.renews.fetch_add(1, Ordering::SeqCst);
		lease.expires_at = now + ttl;
		Box::pin(async { Ok(true) })
	}

	fn publish<'a>(
		&'a self,
		_lease: &'a PersistentRefreshLease,
		result: &'a RefreshResult,
	) -> Pin<Box<dyn Future<Output = Result<(), RefreshStoreError>> + Send + 'a>> {
		*self.published.lock() = Some(result.clone());
		Box::pin(async { Ok(()) })
	}

	fn release<'a>(
		&'a self,
		_lease: &'a PersistentRefreshLease,
	) -> Pin<Box<dyn Future<Output = Result<(), RefreshStoreError>> + Send + 'a>> {
		self.releases.fetch_add(1, Ordering::SeqCst);
		Box::pin(async { Ok(()) })
	}
}

fn refresh_request(account: &str, principal: &str) -> RefreshRequest {
	RefreshRequest {
		account:      AccountId::new(account),
		principal:    PrincipalId::new(principal),
		rejected:     CredentialFreshness {
			generation:  4,
			issued_at:   Some(at(10)),
			expires_at:  Some(at(90)),
			observed_at: at(100),
		},
		requested_at: at(100),
	}
}

fn refreshed(account: &str, principal: &str, generation: u64) -> RefreshedCredential {
	RefreshedCredential {
		account:   AccountId::new(account),
		principal: PrincipalId::new(principal),
		freshness: CredentialFreshness {
			generation,
			issued_at: Some(at(100)),
			expires_at: Some(at(500)),
			observed_at: at(101),
		},
	}
}

#[test]
fn invalid_lease_timing_is_rejected_before_refresh() {
	let error = RefreshCoordinator::new("process", RefreshPolicy {
		lease_ttl:         Duration::from_secs(1),
		renew_interval:    Duration::from_secs(1),
		max_peer_handoffs: 1,
	})
	.unwrap_err();
	assert_eq!(error, RefreshPolicyError::RenewalNotBeforeExpiry);
}

#[tokio::test]

async fn concurrent_expiry_performs_one_refresh_and_waiters_share_exact_result() {
	let store = Arc::new(MockStore::default());
	let coordinator = RefreshCoordinator::new("process", RefreshPolicy::default()).unwrap();
	let calls = Arc::new(AtomicUsize::new(0));
	let first_calls = Arc::clone(&calls);
	let second_calls = Arc::clone(&calls);
	let first = coordinator.refresh(
		Arc::clone(&store),
		refresh_request("single-flight", "principal"),
		move |_| async move {
			first_calls.fetch_add(1, Ordering::SeqCst);
			time::sleep(Duration::from_millis(20)).await;
			Ok(refreshed("single-flight", "principal", 5))
		},
	);
	let second = coordinator.refresh(
		Arc::clone(&store),
		refresh_request("single-flight", "principal"),
		move |_| async move {
			second_calls.fetch_add(1, Ordering::SeqCst);
			Ok(refreshed("single-flight", "principal", 5))
		},
	);
	let (first, second) = tokio::join!(first, second);
	let first = first.unwrap();
	let second = second.unwrap();
	assert_eq!(calls.load(Ordering::SeqCst), 1);
	assert_eq!(store.acquires.load(Ordering::SeqCst), 1);
	assert_eq!(first.result, second.result);
	assert_ne!(first.process_role, second.process_role);
	assert!([first.process_role, second.process_role].contains(&ProcessRefreshRole::Waiter));
}

#[tokio::test]
async fn long_refresh_renews_the_persistent_lease() {
	let store = Arc::new(MockStore::default());
	let policy = RefreshPolicy {
		lease_ttl:         Duration::from_millis(30),
		renew_interval:    Duration::from_millis(5),
		max_peer_handoffs: 1,
	};
	let outcome = RefreshCoordinator::new("process", policy)
		.unwrap()
		.refresh(Arc::clone(&store), refresh_request("renewal", "principal"), |_| async {
			time::sleep(Duration::from_millis(12)).await;
			Ok(refreshed("renewal", "principal", 5))
		})
		.await
		.unwrap();
	assert!(store.renews.load(Ordering::SeqCst) >= 1);
	assert!(
		outcome
			.result
			.receipt
			.steps
			.iter()
			.any(|step| { matches!(step, RefreshStep::PersistentLeaseRenewed { .. }) })
	);
}

#[tokio::test]
async fn expired_persistent_lease_is_recovered_and_timeline_is_preserved() {
	let store = Arc::new(MockStore::default());
	store.acquire_script.lock().extend([
		RefreshLeaseAcquire::HeldByPeer { expires_at: at(110) },
		MockStore::acquired(AccountId::from_ref("recovery")),
	]);
	store
		.wait_script
		.lock()
		.push_back(RefreshLeaseWait::LeaseExpired { observed_at: at(111) });
	let outcome = RefreshCoordinator::new("process", RefreshPolicy::default())
		.unwrap()
		.refresh(Arc::clone(&store), refresh_request("recovery", "principal"), |_| async {
			Ok(refreshed("recovery", "principal", 5))
		})
		.await
		.unwrap();
	assert_eq!(store.acquires.load(Ordering::SeqCst), 2);
	assert!(
		outcome
			.result
			.receipt
			.steps
			.contains(&RefreshStep::PersistentLeaseExpired { observed_at: at(111) })
	);
	assert_eq!(outcome.result.receipt.resulting_generation, Some(5));
}

#[tokio::test]
async fn refresh_rejects_stale_generation_and_principal_change_with_partial_receipts() {
	let coordinator = RefreshCoordinator::new("process", RefreshPolicy::default()).unwrap();
	let stale = coordinator
		.refresh(Arc::new(MockStore::default()), refresh_request("stale", "principal"), |_| async {
			Ok(refreshed("stale", "principal", 4))
		})
		.await
		.unwrap_err();
	assert!(matches!(stale.kind, RefreshErrorKind::StaleGeneration { actual: 4 }));
	assert!(
		stale
			.receipt
			.steps
			.iter()
			.any(|step| matches!(step, RefreshStep::PersistentLeaseAcquired { .. }))
	);

	let changed = coordinator
		.refresh(Arc::new(MockStore::default()), refresh_request("changed", "principal"), |_| async {
			Ok(refreshed("changed", "other-principal", 5))
		})
		.await
		.unwrap_err();
	assert!(matches!(changed.kind, RefreshErrorKind::PrincipalChanged { .. }));
}

#[tokio::test]
async fn peer_process_waiters_receive_the_published_result_without_refreshing() {
	let store = Arc::new(MockStore::default());
	let receipt = RefreshReceipt {
		account:              AccountId::new("peer"),
		principal:            PrincipalId::new("principal"),
		rejected_generation:  4,
		resulting_generation: Some(5),
		steps:                vec![RefreshStep::PeerResultObserved { generation: 5 }],
	};
	let published = RefreshResult {
		account: AccountId::new("peer"),
		principal: PrincipalId::new("principal"),
		freshness: refreshed("peer", "principal", 5).freshness,
		receipt,
	};
	store
		.acquire_script
		.lock()
		.push_back(RefreshLeaseAcquire::HeldByPeer { expires_at: at(110) });
	store
		.wait_script
		.lock()
		.push_back(RefreshLeaseWait::Published(Box::new(published.clone())));
	let calls = Arc::new(AtomicUsize::new(0));
	let operation_calls = Arc::clone(&calls);
	let outcome = RefreshCoordinator::new("process", RefreshPolicy::default())
		.unwrap()
		.refresh(Arc::clone(&store), refresh_request("peer", "principal"), move |_| async move {
			operation_calls.fetch_add(1, Ordering::SeqCst);
			Ok(refreshed("peer", "principal", 6))
		})
		.await
		.unwrap();
	assert_eq!(calls.load(Ordering::SeqCst), 0);
	assert_eq!(outcome.result, published);
}
