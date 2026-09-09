use std::{
	future::Future,
	pin::Pin,
	sync::{
		Arc,
		atomic::{AtomicUsize, Ordering},
	},
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use omp_ai::{
	AccountId, PrincipalId,
	account::{
		CredentialFreshness, PersistentRefreshLease, RefreshLeaseAcquire, RefreshLeaseRequest,
		RefreshLeaseStore, RefreshLeaseWait, RefreshRequest, RefreshResult, RefreshStoreError,
		RefreshedCredential,
	},
};

pub fn at(seconds: u64) -> SystemTime {
	UNIX_EPOCH + Duration::from_secs(seconds)
}

#[derive(Default)]
pub struct SharedRefreshStore {
	pub acquires:  AtomicUsize,
	pub publishes: AtomicUsize,
	pub releases:  AtomicUsize,
}

impl RefreshLeaseStore for SharedRefreshStore {
	fn try_acquire<'a>(
		&'a self,
		request: &'a RefreshLeaseRequest,
	) -> Pin<Box<dyn Future<Output = Result<RefreshLeaseAcquire, RefreshStoreError>> + Send + 'a>> {
		self.acquires.fetch_add(1, Ordering::SeqCst);
		let lease = PersistentRefreshLease {
			id:         "conformance-lease".into(),
			account:    request.account.clone(),
			owner:      request.owner.clone(),
			expires_at: at(200),
		};
		Box::pin(async move { Ok(RefreshLeaseAcquire::Acquired(lease)) })
	}

	fn wait_for_newer<'a>(
		&'a self,
		_account: &'a AccountId<str>,
		_minimum_generation: u64,
		_lease_expires_at: SystemTime,
	) -> Pin<Box<dyn Future<Output = Result<RefreshLeaseWait, RefreshStoreError>> + Send + 'a>> {
		Box::pin(async {
			Err(RefreshStoreError {
				code:    "unexpected-wait".into(),
				summary: "in-process waiter must share the leader future".into(),
			})
		})
	}

	fn renew<'a>(
		&'a self,
		lease: &'a mut PersistentRefreshLease,
		now: SystemTime,
		ttl: Duration,
	) -> Pin<Box<dyn Future<Output = Result<bool, RefreshStoreError>> + Send + 'a>> {
		lease.expires_at = now + ttl;
		Box::pin(async { Ok(true) })
	}

	fn publish<'a>(
		&'a self,
		_lease: &'a PersistentRefreshLease,
		_result: &'a RefreshResult,
	) -> Pin<Box<dyn Future<Output = Result<(), RefreshStoreError>> + Send + 'a>> {
		self.publishes.fetch_add(1, Ordering::SeqCst);
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

pub fn request(account: &str) -> RefreshRequest {
	RefreshRequest {
		account:      AccountId::new(account),
		principal:    PrincipalId::new("fixture-principal"),
		rejected:     CredentialFreshness {
			generation:  4,
			issued_at:   Some(at(10)),
			expires_at:  Some(at(90)),
			observed_at: at(100),
		},
		requested_at: at(100),
	}
}

pub fn refreshed(account: &str) -> RefreshedCredential {
	RefreshedCredential {
		account:   AccountId::new(account),
		principal: PrincipalId::new("fixture-principal"),
		freshness: CredentialFreshness {
			generation:  5,
			issued_at:   Some(at(100)),
			expires_at:  Some(at(500)),
			observed_at: at(101),
		},
	}
}

pub fn shared() -> Arc<SharedRefreshStore> {
	Arc::new(SharedRefreshStore::default())
}
