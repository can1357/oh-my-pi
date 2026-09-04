//! Proves configured CONTROL authority composition routes every owned operation
//! namespace.
use std::{
	collections::BTreeSet,
	path::PathBuf,
	sync::{Arc, Mutex},
};

use async_trait::async_trait;
use omp_core::{Principal, Str, sf};
use omp_envd::{
	exthost::control::{
		ControlAuthority, ControlAuthorityFactory, ControlConnectionIdentity, ControlEffect,
		ControlProtocolError, ControlRequestContext, EnvdControlAuthorities,
		ExternalControlAuthorities, FixedControlAuthorityFactory, HostControlAuthorityFactory,
		PersistenceControlAuthorities, PolicyControlAuthorities, PresentationControlAuthorities,
		ProviderControlAuthorities, RegistryControlAuthorities,
	},
	worker::{ExtHostConfig, ExtHostSupervisor},
};
use serde_json::{Value, json};

struct RecordingAuthority {
	name:  &'static str,
	calls: Arc<Mutex<Vec<String>>>,
}

#[async_trait]
impl ControlAuthority for RecordingAuthority {
	fn handles(&self, _operation: &str) -> bool {
		true
	}

	fn authorize(
		&self,
		_context: &ControlRequestContext,
		_operation: &str,
		_arguments: &serde_json::Map<String, Value>,
	) -> Result<(), ControlProtocolError> {
		Ok(())
	}

	async fn request(
		&self,
		context: ControlRequestContext,
		operation: Str,
		_arguments: serde_json::Map<String, Value>,
	) -> Result<Value, ControlProtocolError> {
		self
			.calls
			.lock()
			.expect("recording lock")
			.push(format!("{}:{operation}", self.name));
		Ok(json!({
			"owner": self.name,
			"extension": context.connection.extension.as_str(),
			"host_generation": context.connection.host_generation,
			"session_generation": context.connection.session_generation,
		}))
	}

	async fn effect(
		&self,
		_context: ControlRequestContext,
		_effect: ControlEffect,
	) -> Result<(), ControlProtocolError> {
		self
			.calls
			.lock()
			.expect("recording lock")
			.push(format!("{}:effect", self.name));
		Ok(())
	}
}

fn factory(
	name: &'static str,
	calls: &Arc<Mutex<Vec<String>>>,
) -> Arc<dyn ControlAuthorityFactory> {
	Arc::new(FixedControlAuthorityFactory::new(Arc::new(RecordingAuthority {
		name,
		calls: Arc::clone(calls),
	})))
}

fn identity() -> Arc<ControlConnectionIdentity> {
	Arc::new(ControlConnectionIdentity {
		extension:          sf!("test.extension"),
		principal:          Principal::new(sf!("test"), sf!("Test")),
		artifact_digest:    sf!("sha256:test"),
		layer:              sf!("project"),
		tier:               sf!("trusted"),
		trust:              sf!("trusted"),
		host_generation:    7,
		session_generation: 11,
		capabilities:       Arc::new(BTreeSet::new()),
	})
}

#[tokio::test]
async fn configured_composition_routes_every_owned_namespace() {
	let calls = Arc::new(Mutex::new(Vec::new()));
	let envd = EnvdControlAuthorities::new(
		RegistryControlAuthorities::new(factory("devices", &calls), factory("hooks", &calls)),
		PersistenceControlAuthorities::new(
			factory("sessions", &calls),
			factory("artifacts", &calls),
			factory("credentials", &calls),
		),
		PolicyControlAuthorities::new(factory("policy", &calls), factory("prompts", &calls)),
		PresentationControlAuthorities::new(
			factory("ui", &calls),
			factory("telemetry", &calls),
			factory("verdicts", &calls),
		),
		ProviderControlAuthorities::new(factory("provider", &calls), factory("services", &calls)),
		factory("auxiliary", &calls),
		factory("effects", &calls),
	);
	let host_factory = Arc::new(HostControlAuthorityFactory::new(
		envd,
		ExternalControlAuthorities::new(factory("agents", &calls), factory("mcp", &calls)),
	));
	let mut config = ExtHostConfig::new(
		PathBuf::from("unused"),
		Principal::new(sf!("test"), sf!("Test")),
		sf!("test-session"),
		11,
	);
	config.bind_control_authorities(host_factory);
	let supervisor = ExtHostSupervisor::spawn(config)
		.await
		.expect("empty configured host");
	let _agents = supervisor.bind_agents_control_authority(factory("agents", &calls));
	let identity = identity();
	let authority = supervisor
		.control_authority(Arc::clone(&identity))
		.expect("lifecycle-bound composition");
	let routes = [
		("omp.devices.invoke", "devices"),
		("omp.hooks.dispatch", "hooks"),
		("omp.state_dir", "auxiliary"),
		("omp.sessions.get", "sessions"),
		("omp.artifacts.stat", "artifacts"),
		("omp.creds.list", "credentials"),
		("omp.policy.authorize", "policy"),
		("omp.prompts.confirm", "prompts"),
		("omp.ui.form", "ui"),
		("omp.telemetry.query", "telemetry"),
		("omp.jobs.register", "verdicts"),
		("omp.provider.request", "provider"),
		("omp.services.call", "services"),
		("omp.params.pull", "auxiliary"),
		("omp.direct_filesystem.request", "auxiliary"),
		("omp.agents.spawn", "agents"),
		("omp.mcp.invoke", "mcp"),
	];
	for (request_id, (operation, owner)) in routes.into_iter().enumerate() {
		let context = ControlRequestContext {
			connection: Arc::clone(&identity),
			request_id: request_id as u64 + 1,
			invocation: None,
		};
		let arguments = serde_json::Map::new();
		authority
			.authorize(&context, operation, &arguments)
			.expect("authority gate");
		let result = authority
			.request(context, Str::from(operation), arguments)
			.await
			.expect("authoritative result");
		assert_eq!(result["owner"], owner);
		assert_eq!(result["extension"], "test.extension");
		assert_eq!(result["host_generation"], 7);
		assert_eq!(result["session_generation"], 11);
	}
	assert!(!authority.handles("omp.registry.freeze"));
	assert!(!authority.handles("omp.context.view"));
	assert!(!authority.handles("omp.journal.append"));
	assert!(!authority.handles("omp.state.latest"));
	assert!(!authority.handles("omp.regimes.start"));

	authority
		.effect(
			ControlRequestContext { connection: identity, request_id: 99, invocation: None },
			ControlEffect::Log(json!({"message": "retained"})),
		)
		.await
		.expect("effect sink");
	assert!(
		calls
			.lock()
			.expect("recording lock")
			.iter()
			.any(|call| call == "effects:effect")
	);
	supervisor.shutdown().await;
}
