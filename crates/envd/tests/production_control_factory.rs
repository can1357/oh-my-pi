//! Proves normal server construction installs live production CONTROL owners.
use std::{collections::BTreeSet, path::PathBuf, sync::Arc};

use omp_con::Ctx;
use omp_core::{Principal, sf};
use omp_envd::{
	EnvServer, RegistryBridges, exthost::control::ControlConnectionIdentity, worker::ExtHostConfig,
};
use omp_tool::Registry;

fn identity(principal: Principal) -> Arc<ControlConnectionIdentity> {
	Arc::new(ControlConnectionIdentity {
		extension: sf!("fixture.extension"),
		principal,
		artifact_digest: sf!("sha256:fixture"),
		layer: sf!("workspace"),
		tier: sf!("trusted"),
		trust: sf!("trusted"),
		host_generation: 7,
		session_generation: 11,
		capabilities: Arc::new(BTreeSet::new()),
	})
}

#[tokio::test]
async fn normal_server_refuses_control_identity_without_admitted_manifest() {
	let project = tempfile::tempdir().expect("project directory");
	let state = tempfile::tempdir().expect("state directory");
	let principal = Principal::new(sf!("fixture-principal"), sf!("Fixture Principal"));
	let config = ExtHostConfig::new(
		PathBuf::from("unused-with-empty-extension-set"),
		principal.clone(),
		sf!("fixture-session"),
		11,
	);
	let con = Arc::new(Ctx::new());
	let convars = Arc::new(omp_envd::exthost::ConvarControlFactory::new(Arc::clone(&con)));
	let server = EnvServer::open_local(
		project.path(),
		state.path(),
		Registry::new(),
		config,
		&con,
		convars,
		RegistryBridges::default(),
	)
	.await
	.expect("production Environment");

	let identity = identity(principal);
	assert!(
		server.extension_control_authority(identity).is_err(),
		"an identity without an admitted deployment manifest must not gain CONTROL authority"
	);
}
