//! Process-wide single-flight refresh with persistent lease coordination.

use std::{
	collections::BTreeMap,
	future::Future,
	mem,
	pin::Pin,
	sync::{Arc, LazyLock},
	time::{Duration, SystemTime},
};

use futures::channel::oneshot;
use omp_core::Str;
use parking_lot::Mutex;
use tokio::time;

use crate::id::{AccountId, PrincipalId};

/// Non-secret freshness metadata for one credential generation.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CredentialFreshness {
	/// Monotonic generation persisted with the credential.
	pub generation:  u64,
	/// Provider issue time, when known.
	pub issued_at:   Option<SystemTime>,
	/// Provider expiry time, when known.
	pub expires_at:  Option<SystemTime>,
	/// Time at which this generation was read or rejected.
	pub observed_at: SystemTime,
}

impl CredentialFreshness {
	/// Returns whether a proactive refresh is due within the supplied expiry
	/// skew.
	pub fn needs_refresh(&self, now: SystemTime, skew: Duration) -> bool {
		self.expires_at.is_some_and(|expires_at| {
			now.checked_add(skew)
				.is_none_or(|refresh_at| refresh_at >= expires_at)
		})
	}

	/// Returns whether this generation is strictly fresher than a rejected
	/// generation.
	pub const fn is_newer_than(&self, rejected: &Self) -> bool {
		self.generation > rejected.generation
	}
}

/// Inputs required to reject a stale credential and refresh the same principal.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RefreshRequest {
	/// Account whose credential was rejected.
	pub account:      AccountId,
	/// Principal that refresh is required to preserve.
	pub principal:    PrincipalId,
	/// Exact rejected credential generation.
	pub rejected:     CredentialFreshness,
	/// Deterministic coordination start time.
	pub requested_at: SystemTime,
}

/// Persistent refresh coordination policy.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct RefreshPolicy {
	/// Duration of an acquired persistent lease.
	pub lease_ttl:         Duration,
	/// Interval at which a running refresh renews its persistent lease.
	pub renew_interval:    Duration,
	/// Maximum expired peer leases followed before failing safely.
	pub max_peer_handoffs: u32,
}

impl Default for RefreshPolicy {
	fn default() -> Self {
		Self {
			lease_ttl:         Duration::from_secs(30),
			renew_interval:    Duration::from_secs(10),
			max_peer_handoffs: 4,
		}
	}
}

/// Invalid persistent-refresh timing policy.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum RefreshPolicyError {
	/// A lease with zero lifetime cannot fence a refresh.
	#[error("refresh lease TTL must be nonzero")]
	ZeroLeaseTtl,
	/// A zero heartbeat interval would spin.
	#[error("refresh renewal interval must be nonzero")]
	ZeroRenewInterval,
	/// Heartbeats must run before the lease can expire.
	#[error("refresh renewal interval must be shorter than lease TTL")]
	RenewalNotBeforeExpiry,
}

/// Request to atomically acquire a metadata-only persistent refresh lease.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RefreshLeaseRequest {
	/// Account being refreshed.
	pub account:            AccountId,
	/// Stable process owner token; it is not credential material.
	pub owner:              Str,
	/// Lease acquisition clock instant.
	pub now:                SystemTime,
	/// Requested lease duration.
	pub ttl:                Duration,
	/// Lowest acceptable published credential generation.
	pub minimum_generation: u64,
}

/// Opaque metadata proving ownership of a persistent refresh lease.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PersistentRefreshLease {
	/// Store-generated lease identity.
	pub id:         Str,
	/// Account protected by the lease.
	pub account:    AccountId,
	/// Stable process owner token.
	pub owner:      Str,
	/// Lease expiry used for crash recovery.
	pub expires_at: SystemTime,
}

/// Result of an atomic persistent lease acquisition.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RefreshLeaseAcquire {
	/// This process owns the refresh lease.
	Acquired(PersistentRefreshLease),
	/// Another process owns the lease until the supplied instant.
	HeldByPeer {
		/// Expiry at which another process's lease ceases to fence refresh work.
		expires_at: SystemTime,
	},
}

/// Result of waiting for another process to publish or abandon refresh work.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RefreshLeaseWait {
	/// The peer published its exact non-secret refresh result.
	Published(Box<RefreshResult>),
	/// No result was published before the lease expired.
	LeaseExpired {
		/// Time at which the lease expiry was observed.
		observed_at: SystemTime,
	},
}

/// Sanitized persistent-store coordination failure.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
#[error("refresh coordination {code}: {summary}")]
pub struct RefreshStoreError {
	/// Stable machine-readable classification.
	pub code:    Str,
	/// Bounded secret-free context.
	pub summary: Str,
}

/// Cold persistent lease boundary; implementations may box one I/O future per
/// method.
pub trait RefreshLeaseStore: Send + Sync + 'static {
	/// Attempts to acquire the account-scoped lease atomically.
	fn try_acquire<'a>(
		&'a self,
		request: &'a RefreshLeaseRequest,
	) -> Pin<Box<dyn Future<Output = Result<RefreshLeaseAcquire, RefreshStoreError>> + Send + 'a>>;

	/// Waits for a generation newer than `minimum_generation` or lease expiry.
	fn wait_for_newer<'a>(
		&'a self,
		account: &'a AccountId<str>,
		minimum_generation: u64,
		lease_expires_at: SystemTime,
	) -> Pin<Box<dyn Future<Output = Result<RefreshLeaseWait, RefreshStoreError>> + Send + 'a>>;

	/// Renews a still-owned lease and updates its expiry.
	fn renew<'a>(
		&'a self,
		lease: &'a mut PersistentRefreshLease,
		now: SystemTime,
		ttl: Duration,
	) -> Pin<Box<dyn Future<Output = Result<bool, RefreshStoreError>> + Send + 'a>>;

	/// Publishes non-secret result metadata for cross-process waiters.
	fn publish<'a>(
		&'a self,
		lease: &'a PersistentRefreshLease,
		result: &'a RefreshResult,
	) -> Pin<Box<dyn Future<Output = Result<(), RefreshStoreError>> + Send + 'a>>;

	/// Releases a held lease; leases still expire if the owner is cancelled or
	/// crashes.
	fn release<'a>(
		&'a self,
		lease: &'a PersistentRefreshLease,
	) -> Pin<Box<dyn Future<Output = Result<(), RefreshStoreError>> + Send + 'a>>;
}

/// Non-secret output returned by the credential refresh operation after
/// persistence.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RefreshedCredential {
	/// Account written by the refresh operation.
	pub account:   AccountId,
	/// Principal proven by the refreshed credential.
	pub principal: PrincipalId,
	/// New persisted freshness metadata.
	pub freshness: CredentialFreshness,
}

/// Sanitized provider refresh-operation failure.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
#[error("credential refresh {code}: {summary}")]
pub struct RefreshOperationError {
	/// Stable machine-readable failure code.
	pub code:    Str,
	/// Bounded secret-free context.
	pub summary: Str,
}

/// One observable step in refresh coordination.
#[derive(Clone, Debug, Eq, PartialEq)]
pub enum RefreshStep {
	/// This caller created the process-wide flight.
	ProcessLeader,
	/// A persistent lease was acquired.
	PersistentLeaseAcquired {
		/// Expiry of the lease this process acquired.
		expires_at: SystemTime,
	},
	/// Another process held the persistent lease.
	PersistentLeaseObserved {
		/// Expiry of the lease held by another process.
		expires_at: SystemTime,
	},
	/// The peer lease expired without a result.
	PersistentLeaseExpired {
		/// Time at which the peer lease expiry was observed.
		observed_at: SystemTime,
	},
	/// A running refresh renewed its persistent lease.
	PersistentLeaseRenewed {
		/// Updated expiry of the renewed lease.
		expires_at: SystemTime,
	},
	/// Credential exchange and persistence completed.
	CredentialPersisted {
		/// Fresh credential generation that was persisted.
		generation: u64,
	},
	/// Result metadata was published for peer processes.
	ResultPublished,
	/// Persistent lease release completed.
	LeaseReleased,
	/// Lease release failed after publication; expiry remains the recovery
	/// boundary.
	LeaseReleaseDeferred {
		/// Expiry at which the unreleased lease becomes recoverable.
		expires_at: SystemTime,
	},
	/// A peer process published the shared result.
	PeerResultObserved {
		/// Fresh credential generation observed from the peer.
		generation: u64,
	},
}

/// Secret-free, partial-preserving refresh timeline.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RefreshReceipt {
	/// Account being refreshed.
	pub account:              AccountId,
	/// Principal that must be preserved.
	pub principal:            PrincipalId,
	/// Rejected generation that authorized refresh.
	pub rejected_generation:  u64,
	/// New generation, once proven fresh.
	pub resulting_generation: Option<u64>,
	/// Every completed coordination step in order.
	pub steps:                Vec<RefreshStep>,
}

impl RefreshReceipt {
	fn new(request: &RefreshRequest) -> Self {
		Self {
			account:              request.account.clone(),
			principal:            request.principal.clone(),
			rejected_generation:  request.rejected.generation,
			resulting_generation: None,
			steps:                vec![RefreshStep::ProcessLeader],
		}
	}
}

/// Exact non-secret result shared with every waiter.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RefreshResult {
	/// Refreshed account.
	pub account:   AccountId,
	/// Preserved principal.
	pub principal: PrincipalId,
	/// Fresh credential generation metadata.
	pub freshness: CredentialFreshness,
	/// Complete leader timeline shared unchanged with waiters.
	pub receipt:   RefreshReceipt,
}

/// Process-local participation in a refresh flight.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ProcessRefreshRole {
	/// This caller performed or coordinated persistent refresh work.
	Leader,
	/// This caller waited and received the leader's exact result.
	Waiter,
}

/// Successful refresh response.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct RefreshOutcome {
	/// Exact shared result.
	pub result:       RefreshResult,
	/// This caller's process-local participation.
	pub process_role: ProcessRefreshRole,
}

/// Refresh failure classification.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
pub enum RefreshErrorKind {
	/// Persistent lease storage failed.
	#[error("{0}")]
	Store(RefreshStoreError),
	/// Credential refresh operation failed.
	#[error("{0}")]
	Operation(RefreshOperationError),
	/// Refresh attempted to bind the account to another principal.
	#[error("credential refresh changed principal")]
	PrincipalChanged {
		/// Principal returned by the refresh operation.
		actual: PrincipalId,
	},
	/// Published credentials were not newer than the rejected generation.
	#[error("credential refresh returned stale generation")]
	StaleGeneration {
		/// Credential generation returned by the refresh operation.
		actual: u64,
	},
	/// Refresh operation returned metadata for another account.
	#[error("credential refresh changed account")]
	AccountChanged {
		/// Account returned by the refresh operation.
		actual: AccountId,
	},
	/// The persistent fencing lease was lost while refresh was still running.
	#[error("persistent refresh lease lost")]
	LeaseLost,
	/// Persistent peer leases repeatedly expired without publishing.
	#[error("refresh coordination exhausted")]
	CoordinationExhausted,
	/// The process leader was cancelled before sharing a result.
	#[error("refresh leader cancelled")]
	LeaderCancelled,
}

/// Cloneable refresh failure carrying every completed receipt step.
#[derive(Clone, Debug, Eq, PartialEq, thiserror::Error)]
#[error("{kind}")]
pub struct RefreshError {
	/// Failure classification.
	pub kind:    RefreshErrorKind,
	/// Partial coordination timeline.
	pub receipt: Box<RefreshReceipt>,
}

type SharedResult = Result<RefreshResult, RefreshError>;

#[derive(Default)]
struct ProcessFlight {
	waiters: Mutex<Vec<oneshot::Sender<SharedResult>>>,
}

static FLIGHTS: LazyLock<Mutex<BTreeMap<AccountId, Arc<ProcessFlight>>>> =
	LazyLock::new(|| Mutex::new(BTreeMap::new()));

struct FlightGuard {
	account:  AccountId,
	flight:   Arc<ProcessFlight>,
	fallback: Mutex<RefreshReceipt>,
	finished: bool,
}

impl FlightGuard {
	fn update_receipt(&self, receipt: &RefreshReceipt) {
		*self.fallback.lock() = receipt.clone();
	}

	fn finish(mut self, result: SharedResult) {
		self.finished = true;
		remove_flight(&self.account, &self.flight);
		let waiters = mem::take(&mut *self.flight.waiters.lock());
		for waiter in waiters {
			let _ = waiter.send(result.clone());
		}
	}
}

impl Drop for FlightGuard {
	fn drop(&mut self) {
		if self.finished {
			return;
		}
		remove_flight(&self.account, &self.flight);
		let error = RefreshError {
			kind:    RefreshErrorKind::LeaderCancelled,
			receipt: Box::new(self.fallback.lock().clone()),
		};
		let waiters = mem::take(&mut *self.flight.waiters.lock());
		for waiter in waiters {
			let _ = waiter.send(Err(error.clone()));
		}
	}
}

fn remove_flight(account: &AccountId<str>, flight: &Arc<ProcessFlight>) {
	let mut active = FLIGHTS.lock();
	if active
		.get(account)
		.is_some_and(|current| Arc::ptr_eq(current, flight))
	{
		active.remove(account);
	}
}

/// Clone-cheap process refresh coordinator.
#[derive(Clone, Debug)]
pub struct RefreshCoordinator {
	owner:  Str,
	policy: RefreshPolicy,
}

impl RefreshCoordinator {
	/// Creates a coordinator with a validated lease policy and stable non-secret
	/// owner token.
	pub fn new(owner: impl Into<Str>, policy: RefreshPolicy) -> Result<Self, RefreshPolicyError> {
		if policy.lease_ttl.is_zero() {
			return Err(RefreshPolicyError::ZeroLeaseTtl);
		}
		if policy.renew_interval.is_zero() {
			return Err(RefreshPolicyError::ZeroRenewInterval);
		}
		if policy.renew_interval >= policy.lease_ttl {
			return Err(RefreshPolicyError::RenewalNotBeforeExpiry);
		}
		Ok(Self { owner: owner.into(), policy })
	}

	/// Refreshes once process-wide, coordinates with peer processes, and shares
	/// the exact result.
	pub async fn refresh<S, O, F>(
		&self,
		store: Arc<S>,
		request: RefreshRequest,
		operation: O,
	) -> Result<RefreshOutcome, RefreshError>
	where
		S: RefreshLeaseStore,
		O: FnOnce(PersistentRefreshLease) -> F + Send,
		F: Future<Output = Result<RefreshedCredential, RefreshOperationError>> + Send,
	{
		let (flight, receiver) = {
			let mut active = FLIGHTS.lock();
			if let Some(flight) = active.get(&request.account) {
				let (sender, receiver) = oneshot::channel();
				flight.waiters.lock().push(sender);
				(Arc::clone(flight), Some(receiver))
			} else {
				let flight = Arc::new(ProcessFlight::default());
				active.insert(request.account.clone(), Arc::clone(&flight));
				(flight, None)
			}
		};
		if let Some(receiver) = receiver {
			let result = receiver.await.unwrap_or_else(|_| {
				Err(RefreshError {
					kind:    RefreshErrorKind::LeaderCancelled,
					receipt: Box::new(RefreshReceipt::new(&request)),
				})
			})?;
			validate_result(
				&request,
				&result.account,
				&result.principal,
				&result.freshness,
				&result.receipt,
			)?;
			return Ok(RefreshOutcome { result, process_role: ProcessRefreshRole::Waiter });
		}

		let mut receipt = RefreshReceipt::new(&request);
		let guard = FlightGuard {
			account: request.account.clone(),
			flight,
			fallback: Mutex::new(receipt.clone()),
			finished: false,
		};
		let result = self
			.run_leader(store.as_ref(), &request, &mut receipt, operation, &guard)
			.await;
		guard.finish(result.clone());
		result.map(|result| RefreshOutcome { result, process_role: ProcessRefreshRole::Leader })
	}

	async fn run_leader<S, O, F>(
		&self,
		store: &S,
		request: &RefreshRequest,
		receipt: &mut RefreshReceipt,
		operation: O,
		guard: &FlightGuard,
	) -> SharedResult
	where
		S: RefreshLeaseStore,
		O: FnOnce(PersistentRefreshLease) -> F + Send,
		F: Future<Output = Result<RefreshedCredential, RefreshOperationError>> + Send,
	{
		let minimum_generation = request.rejected.generation.saturating_add(1);
		let mut now = request.requested_at;
		let mut operation = Some(operation);
		for _ in 0..=self.policy.max_peer_handoffs {
			let lease_request = RefreshLeaseRequest {
				account: request.account.clone(),
				owner: self.owner.clone(),
				now,
				ttl: self.policy.lease_ttl,
				minimum_generation,
			};
			let acquired = store
				.try_acquire(&lease_request)
				.await
				.map_err(|error| RefreshError {
					kind:    RefreshErrorKind::Store(error),
					receipt: Box::new(receipt.clone()),
				})?;
			match acquired {
				RefreshLeaseAcquire::HeldByPeer { expires_at } => {
					receipt
						.steps
						.push(RefreshStep::PersistentLeaseObserved { expires_at });
					guard.update_receipt(receipt);
					match store
						.wait_for_newer(&request.account, minimum_generation, expires_at)
						.await
						.map_err(|error| RefreshError {
							kind:    RefreshErrorKind::Store(error),
							receipt: Box::new(receipt.clone()),
						})? {
						RefreshLeaseWait::Published(result) => {
							validate_result(
								request,
								&result.account,
								&result.principal,
								&result.freshness,
								receipt,
							)?;
							return Ok(*result);
						},
						RefreshLeaseWait::LeaseExpired { observed_at } => {
							receipt
								.steps
								.push(RefreshStep::PersistentLeaseExpired { observed_at });
							guard.update_receipt(receipt);
							now = observed_at;
						},
					}
				},
				RefreshLeaseAcquire::Acquired(mut lease) => {
					receipt
						.steps
						.push(RefreshStep::PersistentLeaseAcquired { expires_at: lease.expires_at });
					guard.update_receipt(receipt);
					let Some(refresh) = operation.take() else {
						record_release(store, &lease, receipt).await;
						guard.update_receipt(receipt);
						return Err(RefreshError {
							kind:    RefreshErrorKind::CoordinationExhausted,
							receipt: Box::new(receipt.clone()),
						});
					};
					let refresh_future = refresh(lease.clone());
					let refreshed = match self
						.run_refresh_operation(store, &mut lease, refresh_future, receipt, guard)
						.await
					{
						Ok(refreshed) => refreshed,
						Err(error) => {
							record_release(store, &lease, receipt).await;
							guard.update_receipt(receipt);
							return Err(error);
						},
					};
					if let Err(error) = validate_result(
						request,
						&refreshed.account,
						&refreshed.principal,
						&refreshed.freshness,
						receipt,
					) {
						record_release(store, &lease, receipt).await;
						guard.update_receipt(receipt);
						return Err(RefreshError { receipt: Box::new(receipt.clone()), ..error });
					}
					receipt.resulting_generation = Some(refreshed.freshness.generation);
					receipt.steps.push(RefreshStep::CredentialPersisted {
						generation: refreshed.freshness.generation,
					});
					guard.update_receipt(receipt);
					let mut result = RefreshResult {
						account:   refreshed.account,
						principal: refreshed.principal,
						freshness: refreshed.freshness,
						receipt:   receipt.clone(),
					};
					if let Err(error) = store.publish(&lease, &result).await {
						record_release(store, &lease, receipt).await;
						guard.update_receipt(receipt);
						return Err(RefreshError {
							kind:    RefreshErrorKind::Store(error),
							receipt: Box::new(receipt.clone()),
						});
					}
					receipt.steps.push(RefreshStep::ResultPublished);
					guard.update_receipt(receipt);
					record_release(store, &lease, receipt).await;
					result.receipt = receipt.clone();
					return Ok(result);
				},
			}
		}
		Err(RefreshError {
			kind:    RefreshErrorKind::CoordinationExhausted,
			receipt: Box::new(receipt.clone()),
		})
	}

	async fn run_refresh_operation<S, F>(
		&self,
		store: &S,
		lease: &mut PersistentRefreshLease,
		future: F,
		receipt: &mut RefreshReceipt,
		guard: &FlightGuard,
	) -> Result<RefreshedCredential, RefreshError>
	where
		S: RefreshLeaseStore,
		F: Future<Output = Result<RefreshedCredential, RefreshOperationError>> + Send,
	{
		let interval = self.policy.renew_interval;
		tokio::pin!(future);
		loop {
			let sleep = time::sleep(interval);
			tokio::pin!(sleep);
			tokio::select! {
				result = &mut future => {
					return result.map_err(|error| RefreshError {
						kind: RefreshErrorKind::Operation(error),
						receipt: Box::new(receipt.clone()),
					});
				},
				() = &mut sleep => {
					let renewed = store.renew(lease, SystemTime::now(), self.policy.lease_ttl).await
						.map_err(|error| RefreshError {
							kind: RefreshErrorKind::Store(error),
							receipt: Box::new(receipt.clone()),
						})?;
					if !renewed {
						return Err(RefreshError {
							kind: RefreshErrorKind::LeaseLost,
							receipt: Box::new(receipt.clone()),
						});
					}
					receipt.steps.push(RefreshStep::PersistentLeaseRenewed {
						expires_at: lease.expires_at,
					});
					guard.update_receipt(receipt);
				},
			}
		}
	}
}

async fn record_release<S: RefreshLeaseStore>(
	store: &S,
	lease: &PersistentRefreshLease,
	receipt: &mut RefreshReceipt,
) {
	match store.release(lease).await {
		Ok(()) => receipt.steps.push(RefreshStep::LeaseReleased),
		Err(_) => receipt
			.steps
			.push(RefreshStep::LeaseReleaseDeferred { expires_at: lease.expires_at }),
	}
}

fn validate_result(
	request: &RefreshRequest,
	account: &AccountId<str>,
	principal: &PrincipalId<str>,
	freshness: &CredentialFreshness,
	receipt: &RefreshReceipt,
) -> Result<(), RefreshError> {
	if account != &request.account {
		return Err(RefreshError {
			kind:    RefreshErrorKind::AccountChanged { actual: account.to_owned() },
			receipt: Box::new(receipt.clone()),
		});
	}
	if principal != &request.principal {
		return Err(RefreshError {
			kind:    RefreshErrorKind::PrincipalChanged { actual: principal.to_owned() },
			receipt: Box::new(receipt.clone()),
		});
	}
	if !freshness.is_newer_than(&request.rejected) {
		return Err(RefreshError {
			kind:    RefreshErrorKind::StaleGeneration { actual: freshness.generation },
			receipt: Box::new(receipt.clone()),
		});
	}
	Ok(())
}
