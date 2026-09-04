//! Proves credential reveal authority is provider-scoped and fenced to its
//! bound host session.

use std::{
	collections::{BTreeMap, BTreeSet},
	sync::Arc,
};

use omp_ai::auth::{CredentialGrants, CredentialScope};
use omp_core::{Principal, SecretString, Str, sf};
use omp_driver::auth_backend::{CredentialControlGrant, gateway_credential_control_factory};
use omp_envd::exthost::control::{
	ControlAuthorityFactory as _, ControlConnectionIdentity, ControlRequestContext,
};
use serde_json::{Map, Value, json};
use tonic::transport::Endpoint;

fn identity(host_generation: u64) -> Arc<ControlConnectionIdentity> {
	Arc::new(ControlConnectionIdentity {
		extension: sf!("fixture.gateway"),
		principal: Principal::new(sf!("gateway-user"), sf!("Gateway User")),
		artifact_digest: sf!("sha256:gateway-fixture"),
		layer: sf!("workspace"),
		tier: sf!("trusted"),
		trust: sf!("trusted"),
		host_generation,
		session_generation: 19,
		capabilities: Arc::new(BTreeSet::new()),
	})
}

fn arguments(provider: &str) -> Map<String, Value> {
	json!({"provider": provider, "id": 7})
		.as_object()
		.unwrap()
		.clone()
}

fn factory(reveal: &[&str]) -> omp_driver::auth_backend::GatewayCredentialSecretControlFactory {
	let reveal = reveal
		.iter()
		.map(|value| Str::new(*value))
		.collect::<Vec<_>>();
	let grant = CredentialControlGrant {
		grants:    CredentialGrants {
			allow:  CredentialScope::new(Arc::from([sf!("openai")])),
			import: CredentialScope::default(),
			reveal: CredentialScope::new(reveal.into()),
		},
		providers: Arc::from([sf!("openai")]),
	};
	gateway_credential_control_factory(
		Endpoint::from_static("http://127.0.0.1:9").connect_lazy(),
		Some(SecretString::from("gateway-token-marker")),
		omp_ai::auth::UsageAttribution::new("test-install", "test-app", Some("test-host")),
		BTreeMap::from([(sf!("fixture.gateway"), grant)]),
		Arc::from([]),
		Arc::<str>::from("gateway-test-placeholder"),
	)
}

#[tokio::test]
async fn reveal_scope_is_independent_and_provider_exact() {
	let connection = identity(5);
	let authority = factory(&["openai"])
		.bind(Arc::clone(&connection))
		.expect("authority");
	let context = ControlRequestContext { connection, request_id: 41, invocation: None };
	authority
		.authorize(&context, "omp.creds.reveal", &arguments("openai"))
		.expect("exact reveal grant");
	let denied = authority
		.authorize(&context, "omp.creds.reveal", &arguments("anthropic"))
		.expect_err("ungranted provider must be refused");
	assert_eq!(denied.code.as_str(), "PermissionError");
}

#[tokio::test]
async fn unauthorized_reveal_is_refused_before_remote_exposure() {
	let connection = identity(5);
	let authority = factory(&[])
		.bind(Arc::clone(&connection))
		.expect("authority");
	let error = authority
		.request(
			ControlRequestContext { connection, request_id: 42, invocation: None },
			sf!("omp.creds.reveal"),
			arguments("openai"),
		)
		.await
		.expect_err("reveal without a reveal grant must fail locally");
	assert_eq!(error.code.as_str(), "PermissionError");
}

#[tokio::test]
async fn reveal_is_fenced_to_the_bound_host_and_session_identity() {
	let bound = identity(5);
	let authority = factory(&["openai"]).bind(bound).expect("authority");
	let stale = ControlRequestContext { connection: identity(6), request_id: 43, invocation: None };
	let error = authority
		.authorize(&stale, "omp.creds.reveal", &arguments("openai"))
		.expect_err("replaced host generation must be refused");
	assert_eq!(error.code.as_str(), "StaleGeneration");
}
