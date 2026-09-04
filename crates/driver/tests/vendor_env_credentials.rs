//! Proves the production inference stack leases a bare vendor environment
//! credential (`ANTHROPIC_API_KEY`) for a route with no stored account.
//!
//! Route execution without a durable account selects a brokered identity
//! (`CredentialNeed { account: None, principal: None }`); the environment
//! source must still lease from the catalog's ordered vendor names.

use std::{sync::Arc, time::SystemTime};

use bytes::Bytes;
use http::Request;
use omp_ai::auth::{AuthSpec, CredentialNeed, CredentialSource as _};
use omp_catalog::provider::AuthSpecKind;
use omp_driver::registry::{InferenceSessionOverrides, production_inference_for_session};

const VENDOR_NAME: &str = "ANTHROPIC_API_KEY";
const VENDOR_SECRET: &str = "vendor-env-test-secret";

#[tokio::test]
async fn bare_vendor_env_var_leases_for_brokered_anthropic_route() {
	// SAFETY: nextest runs each test in its own process and this is the first
	// statement of the test; the current-thread runtime has spawned no other
	// thread that could read the environment concurrently.
	unsafe {
		std::env::remove_var("OMP_ANTHROPIC_API_KEY");
		std::env::remove_var("OMP_ANTHROPIC_FOUNDRY_API_KEY");
		std::env::set_var(VENDOR_NAME, VENDOR_SECRET);
	}
	let data_dir = tempfile::tempdir().expect("scratch data dir");
	let inference = production_inference_for_session(
		data_dir.path(),
		Arc::new(omp_tool::Registry::default()),
		None,
		InferenceSessionOverrides::default(),
	)
	.await
	.expect("production inference composes over a fresh data dir");

	let catalog = omp_catalog::Catalog::embedded();
	let provider = catalog
		.provider(omp_catalog::ProviderId::from_ref("anthropic"))
		.expect("embedded anthropic provider");
	let auth = provider
		.auth
		.iter()
		.filter_map(|id| catalog.auth_spec(id))
		.find(|auth| auth.kind == AuthSpecKind::ApiKey)
		.expect("anthropic API-key auth spec");

	let lease = inference
		.auth_manager
		.credential_broker()
		.lease(CredentialNeed {
			spec:        auth.id.clone(),
			account:     None,
			principal:   None,
			valid_after: SystemTime::now(),
		})
		.await
		.expect("vendor environment name leases without a stored account");
	assert_eq!(lease.meta().principal.as_str(), VENDOR_NAME);

	let runtime = AuthSpec::from_catalog(auth, None, None).expect("runtime API-key spec");
	let mut request = Request::builder()
		.uri("https://api.anthropic.com/v1/messages")
		.body(Bytes::new())
		.expect("request");
	lease
		.prepare(&runtime, SystemTime::now())
		.expect("API-key lease prepares")
		.finalize_buffered(&mut request)
		.expect("API-key lease applies");
	assert_eq!(request.headers()["x-api-key"], VENDOR_SECRET);
}
