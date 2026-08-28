//! Proves normal server construction installs live production CONTROL owners.
use std::{collections::BTreeSet, path::PathBuf, sync::Arc};

use omp_core::{Principal, sf};
use omp_envd::{
	EnvServer, EnvdError, RegistryBridges, exthost::control::ControlConnectionIdentity,
	worker::ExtHostConfig,
};
use omp_tool::{Claims, Precedence, Presentation, Registry, RegistryError};

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
	let server = EnvServer::open_local(
		project.path(),
		state.path(),
		Registry::new(),
		config,
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

#[tokio::test]
async fn production_assembly_rejects_preloaded_omp_core_claimant() {
	let project = tempfile::tempdir().expect("project directory");
	let state = tempfile::tempdir().expect("state directory");
	let principal = Principal::new(sf!("fixture-principal"), sf!("Fixture Principal"));
	let config = ExtHostConfig::new(
		PathBuf::from("unused-with-empty-extension-set"),
		principal,
		sf!("fixture-session"),
		11,
	);
	let mut registry = Registry::new();
	registry
		.register(omp_tools::think::tool(), Presentation::Slot, Claims {
			precedence: Precedence::CORE,
			claimant:   sf!("omp/core"),
			replaces:   None,
		})
		.expect("preloaded omp/core claim registers before the composition gate");

	let Err(error) = EnvServer::open_local(
		project.path(),
		state.path(),
		registry,
		config,
		RegistryBridges::default(),
	)
	.await
	else {
		panic!("production assembly must reject a preloaded omp/core claimant");
	};

	assert!(
		matches!(
			error,
			EnvdError::Registry(RegistryError::ReservedClaimant { ref name }) if name == "think"
		),
		"expected ReservedClaimant for think, got {error:?}"
	);
}
