use std::sync::Arc;

use futures::{FutureExt as _, future::BoxFuture};
use omp_ai::{
	AccountId,
	account::AccountPool,
	answer::{AccountSummary, AuthSession},
	auth::{
		AuthLoginEngine, AuthManager, AuthRefreshEngine, CredentialBroker, CredentialBrokerEngines,
		CredentialStore, HeadlessKeySource, KeyId,
	},
	call::{AuthMethod, LoginRequest},
	error::{Error, ErrorKind, ErrorPhase, RetryAction},
	receipt::ExecutionReceipt,
};
use omp_catalog::{AuthSpecId, Catalog};

#[derive(Clone, Copy)]
struct UnusedLogin(AuthMethod);

impl AuthLoginEngine for UnusedLogin {
	fn method(&self) -> AuthMethod {
		self.0
	}

	fn supports(&self, _provider: &omp_catalog::ProviderId<str>) -> bool {
		true
	}

	fn begin(
		&self,
		_request: LoginRequest,
		_spec: AuthSpecId,
	) -> BoxFuture<'_, Result<AuthSession, Error>> {
		async { Err(unused_error()) }.boxed()
	}
}

struct UnusedRefresh;

impl AuthRefreshEngine for UnusedRefresh {
	fn refresh(&self, _account: AccountId) -> BoxFuture<'_, Result<AccountSummary, Error>> {
		async { Err(unused_error()) }.boxed()
	}
}

fn unused_error() -> Error {
	Error::new(
		ErrorKind::InternalInvariant,
		ErrorPhase::Authentication,
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
}

pub fn headless_manager(catalog: Arc<Catalog>) -> (AuthManager, tempfile::TempDir) {
	let directory = tempfile::tempdir().expect("headless credential directory");
	let store = Arc::new(
		CredentialStore::open(
			directory.path().join("credentials.sqlite"),
			Arc::new(HeadlessKeySource::new(KeyId::new("conformance"), [7; 32])),
		)
		.expect("headless credential store"),
	);
	let broker = CredentialBroker::system(&catalog, CredentialBrokerEngines::default())
		.expect("catalog credential broker");
	let methods = [
		AuthMethod::ApiKey,
		AuthMethod::OAuthPkce,
		AuthMethod::OAuthDevice,
		AuthMethod::ApplicationDefault,
		AuthMethod::AwsCredentialChain,
		AuthMethod::SessionToken,
	];
	let engines = methods
		.into_iter()
		.map(|method| Arc::new(UnusedLogin(method)) as Arc<dyn AuthLoginEngine>)
		.collect();
	let manager = AuthManager::new(
		catalog,
		store,
		broker,
		AccountPool::new(),
		engines,
		Arc::new(UnusedRefresh),
	)
	.expect("headless auth manager");
	(manager, directory)
}
