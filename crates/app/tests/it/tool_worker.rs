//! Native extension-host process contract tests.

use std::{
	collections::BTreeMap,
	fs,
	path::Path,
	sync::{Arc, Mutex},
	time::Duration,
};

use bytes::Bytes;
use omp_core::{ArtifactDigest, Principal, Provenance, Str, sf};
use omp_envd::{
	DeviceCatalogObserver, DeviceControlFactory, DeviceInvocationAdmission,
	DynamicDeviceCatalogEntry, RegistryControlFactory,
	blobs::BlobHost,
	exthost::{
		ActivationTrigger, AvailabilityBatch, AvailabilitySink, DeclarationSet, ExtensionManifest,
		ServiceManifest, ToolDeclarationKey,
		control::{
			ControlAuthority, ControlAuthorityFactory, ControlAuthoritySnapshot, ControlEffect,
			ControlProtocolError, ControlRequestContext, EnvdControlAuthorities,
			ExternalControlAuthorities,
			FixedControlAuthorityFactory, HostControlAuthorityFactory, PersistenceControlAuthorities,
			PolicyControlAuthorities, PresentationControlAuthorities, ProviderControlAuthorities,
			RegistryControlAuthorities,
		},
		dispatch::CallbackDispatcherSlot,
	},
	worker::{
		ExtHostAbortKind, ExtHostCompletion, ExtHostConfig, ExtHostError, ExtHostEvent,
		ExtHostInvocation, ExtHostOutcomeKind, ExtHostSpec, ExtHostSupervisor, ExtHostToolCall,
		HostKey,
	},
};
use omp_ext::config::{
	CliContribution, CliContributionSet, CliValueKind, CliValueSink, ContributedCliValue,
	ContributedValue, StaticDeclaration, StaticDeclarations,
};
use omp_proto::env::v1::ArgsCommitted;
use serde_json::{Value, json};
use tokio::time;

const PRIMARY_EXTENSION: &str = r#"
import ctypes
import os
import signal
import omp

signal.signal(signal.SIGINT, signal.SIG_IGN)
_libc = ctypes.CDLL(None)
_sleep = _libc.sleep
_sleep.argtypes = [ctypes.c_uint]
_sleep.restype = ctypes.c_uint

@omp.tool("control_echo", kind="soft")
def control_echo(message: str) -> dict:
    return {"message": message, "pid": os.getpid()}

@omp.tool("control_block", kind="soft")
def control_block(started: str, seconds: int) -> dict:
    with open(started, "w", encoding="utf-8") as marker:
        marker.write(str(os.getpid()))
        marker.flush()
    _sleep(seconds)
    return {"pid": os.getpid()}
"#;

const SIBLING_EXTENSION: &str = r#"
import os
import omp

@omp.tool("control_sibling", kind="soft")
def control_sibling(message: str) -> dict:
    return {"message": message, "pid": os.getpid()}
"#;

const CONTROL_FEATURES_EXTENSION: &str = r#"
import asyncio
import omp

_active = 0
_overlap = asyncio.Event()

@omp.tool("control_progress", kind="soft")
async def control_progress(value: str, ctx: omp.Context) -> dict:
    ctx.update({"stage": "running", "value": value})
    await asyncio.sleep(0.01)
    return {"value": value}

@omp.tool("control_overlap", kind="soft")
async def control_overlap(value: str) -> dict:
    global _active
    _active += 1
    if _active == 2:
        _overlap.set()
    await asyncio.wait_for(_overlap.wait(), timeout=1.0)
    return {"value": value, "active": _active}

@omp.tool("control_large", kind="soft")
async def control_large(size: int) -> str:
    return "x" * size

@omp.device("control_unavailable", available=lambda: False)
async def control_unavailable() -> str:
    return "unreachable"
"#;

#[tokio::test]
async fn trusted_cli_module_activates_from_its_exact_file() {
	let scratch = tempfile::tempdir().expect("trusted module scratch");
	let module = scratch.path().join("json.py");
	let marker = scratch.path().join("activated");
	let marker_json =
		serde_json::to_string(marker.to_string_lossy().as_ref()).expect("encode marker path");
	fs::write(
		&module,
		format!(
			"import omp\n\n@omp.tool(\"trusted_echo\", kind=\"hard\")\nasync def trusted_echo(value: \
			 str) -> str:\n    return value\n\ndef extension_activate(_event, _context):\n    with \
			 open({marker_json}, 'w', encoding='utf-8') as marker:\n        marker.write(__file__)\n",
		),
	)
	.expect("write trusted extension module");

	let mut extension = omp_app::cli::trusted_extension(
		omp_envd::validate_trusted_module(&module).expect("validate trusted module"),
	);
	extension.data_socket = Some(scratch.path().join("trusted-data.sock"));
	let mut config = test_config();
	config.extensions.push(extension);
	let callbacks = bind_test_control(&mut config);
	let supervisor = Arc::new(
		time::timeout(Duration::from_secs(60), ExtHostSupervisor::spawn(config))
			.await
			.expect("extension registry timed out")
			.expect("spawn trusted extension host"),
	);
	callbacks.bind(supervisor.clone());
	supervisor
		.activate_control_hosts()
		.await
		.expect("activate trusted extension");
	assert_eq!(
		fs::read_to_string(&marker).expect("activation marker"),
		fs::canonicalize(&module)
			.expect("canonical trusted module")
			.to_string_lossy(),
	);
	let [registration] = supervisor.registrations() else {
		panic!("expected one trusted declaration");
	};
	assert!(registration.hard_granted);
	assert_eq!(
		registration
			.declaration
			.definition
			.as_ref()
			.expect("trusted tool definition")
			.name,
		"trusted_echo",
	);
	supervisor.shutdown().await;
}

#[derive(Default)]
struct CapturedAvailability(Mutex<Vec<AvailabilityBatch>>);

impl AvailabilitySink for CapturedAvailability {
	fn set_availability(&self, batch: AvailabilityBatch) {
		self.0.lock().expect("availability capture").push(batch);
	}
}

#[tokio::test]
async fn control_progress_parallelism_availability_and_result_spill_are_preserved() {
	let site = tempfile::tempdir().expect("Python site scratch directory");
	fs::write(site.path().join("control_features.py"), CONTROL_FEATURES_EXTENSION)
		.expect("write CONTROL feature extension");

	let key = HostKey::new("workspace", "trusted", "control-features");
	let mut extension = ExtHostSpec::new(
		key.clone(),
		test_manifest(
			&key,
			"control_features",
			[
				"control_progress",
				"control_overlap",
				"control_large",
				"control_unavailable",
			],
		),
	);
	extension.python_site = Some(site.path().to_owned());
	extension.data_socket = Some(site.path().join("features-data.sock"));

	let mut config = test_config();
	config.bind_result_store(
		BlobHost::open(site.path().join("result-cas")).expect("open result CAS"),
	);
	config.extensions.push(extension);
	let callbacks = bind_test_control(&mut config);
	let supervisor = Arc::new(
		time::timeout(Duration::from_secs(60), ExtHostSupervisor::spawn(config))
			.await
			.expect("extension registry timed out")
			.expect("spawn CONTROL feature host"),
	);
	callbacks.bind(supervisor.clone());
	let availability = Arc::new(CapturedAvailability::default());
	supervisor.bind_availability_sink(availability.clone());
	supervisor
		.activate_control_hosts()
		.await
		.expect("activate CONTROL feature host");

	let batches = availability.0.lock().expect("availability capture");
	assert!(batches.iter().flat_map(|batch| batch.deltas.iter()).any(|delta| {
		delta.name == "control_unavailable" && !delta.mounted
	}));
	drop(batches);

	let mut progress = open_committed(
		&supervisor,
		"progress",
		"control_progress",
		json!({"value": "visible"}),
		Duration::from_secs(5),
	)
	.expect("dispatch progress invocation");
	let update = match time::timeout(Duration::from_secs(2), progress.next())
		.await
		.expect("progress update timed out")
		.expect("progress event channel closed")
	{
		ExtHostEvent::Update(update) => {
			serde_json::from_slice::<Value>(&update.json).expect("progress JSON")
		},
		event => panic!("expected progress before terminal response, got {event:?}"),
	};
	assert_eq!(update, json!({"stage": "running", "value": "visible"}));
	assert!(matches!(
		progress.next().await.expect("progress terminal"),
		ExtHostEvent::Complete(_)
	));

	let overlap = time::timeout(Duration::from_secs(3), async {
		tokio::join!(
			invoke(
				&supervisor,
				"overlap-a",
				"control_overlap",
				json!({"value": "a"}),
				Duration::from_secs(2),
			),
			invoke(
				&supervisor,
				"overlap-b",
				"control_overlap",
				json!({"value": "b"}),
				Duration::from_secs(2),
			),
		)
	})
	.await
	.expect("parallel CONTROL declarations were serialized");
	assert_eq!(completion_value(&overlap.0)["active"], 2);
	assert_eq!(completion_value(&overlap.1)["active"], 2);

	let large = invoke(
		&supervisor,
		"large",
		"control_large",
		json!({"size": 70_000}),
		Duration::from_secs(5),
	)
	.await;
	assert!(large.details_json.is_none());
	assert_eq!(large.details_blob.as_ref().map(|blob| blob.size), Some(70_002));

	supervisor.shutdown().await;
}

#[tokio::test]
async fn activation_receives_validated_cli_values_and_session_authority() {
	let site = tempfile::tempdir().expect("Python site scratch directory");
	let module = site.path().join("activation_contract.py");
	let marker = site.path().join("activation-contract.json");
	let marker_json =
		serde_json::to_string(marker.to_string_lossy().as_ref()).expect("encode marker path");
	fs::write(
		&module,
		format!(
			r#"import json
import omp

@omp.tool("activation_echo", kind="soft")
async def activation_echo(value: str) -> str:
    return value

def extension_activate(event, _context):
    current = omp.sessions.current()
    with open({marker_json}, "w", encoding="utf-8") as marker:
        json.dump({{"cli_values": event["cli_values"], "session": current.id, "depth": omp.agents.depth, "generation": event["generation"]}}, marker)
"#,
		),
	)
	.expect("write activation extension");

	let key = HostKey::new("workspace", "trusted", "test/activation");
	let mut extension =
		ExtHostSpec::new(key.clone(), test_manifest(&key, "activation_contract", ["activation_echo"]));
	extension.python_site = Some(site.path().to_owned());
	extension.entry_path = Some(module);
	extension.data_socket = Some(site.path().join("activation-data.sock"));
	let contribution = CliContribution {
		publisher: sf!("test"),
		extension: sf!("activation"),
		name: sf!("mode"),
		description: sf!("Activation mode"),
		kind: CliValueKind::String,
		default: None,
		shadow_builtin: false,
		sink: CliValueSink { key: sf!("mode") },
	};
	let owner = contribution.qualified_name();
	extension.cli_contributions = CliContributionSet::build(
		[contribution],
		std::iter::empty::<Str>(),
	)
	.expect("valid CLI contribution");

	let mut config = test_config();
	config.contributed_values.push(ContributedCliValue {
		owner,
		sink: sf!("mode"),
		value: ContributedValue::String(sf!("strict")),
	});
	config.bind_authority_snapshot(ControlAuthoritySnapshot {
		current_session: Some(json!({
			"id": "authoritative-session",
			"title": null,
			"title_source": "system",
			"cwd": "file:///",
			"project": "file:///",
			"created_ms": 1,
			"updated_ms": 1,
			"status": "pending",
			"kind": "interactive",
			"parent": null,
			"entries": 0,
			"turns": 0,
			"usage": {},
			"cost": {"nanos_usd": 0, "estimated": false},
			"models": [],
			"remote": false,
		})),
		agent_depth: 2,
		..ControlAuthoritySnapshot::default()
	});
	config.extensions.push(extension);
	let callbacks = bind_test_control(&mut config);
	let supervisor = Arc::new(
		time::timeout(Duration::from_secs(60), ExtHostSupervisor::spawn(config))
			.await
			.expect("extension registry timed out")
			.expect("spawn activation host"),
	);
	callbacks.bind(supervisor.clone());
	supervisor
		.activate_control_hosts()
		.await
		.expect("activate extension entry callback");

	let activation: Value = serde_json::from_slice(
		&fs::read(&marker).expect("activation callback marker"),
	)
	.expect("activation callback JSON");
	assert_eq!(activation["cli_values"], json!([{"sink": "mode", "value": "strict"}]));
	assert_eq!(activation["session"], "authoritative-session");
	assert_eq!(activation["depth"], 2);
	assert_eq!(activation["generation"], 1);
	assert_eq!(
		supervisor
			.reload_extension("test/activation")
			.await
			.expect("reload activation host"),
		2,
	);
	let restarted: Value = serde_json::from_slice(
		&fs::read(&marker).expect("restart activation callback marker"),
	)
	.expect("restart activation callback JSON");
	assert_eq!(restarted["cli_values"], json!([{"sink": "mode", "value": "strict"}]));
	assert_eq!(restarted["session"], "authoritative-session");
	assert_eq!(restarted["depth"], 2);
	assert_eq!(restarted["generation"], 2);
	supervisor.shutdown().await;
}

#[tokio::test]
async fn control_cancellation_restarts_only_the_owning_extension_host() {
	let site = tempfile::tempdir().expect("Python site scratch directory");
	fs::write(site.path().join("control_primary.py"), PRIMARY_EXTENSION)
		.expect("write primary extension");
	fs::write(site.path().join("control_sibling.py"), SIBLING_EXTENSION)
		.expect("write sibling extension");

	let mut config = test_config();
	let primary_key = HostKey::new("workspace", "trusted", "control-primary");
	let mut primary = ExtHostSpec::new(
		primary_key.clone(),
		test_manifest(&primary_key, "control_primary", ["control_echo", "control_block"]),
	);
	primary.python_site = Some(site.path().to_owned());
	primary.data_socket = Some(site.path().join("primary-data.sock"));
	config.extensions.push(primary);

	let sibling_key = HostKey::new("workspace", "trusted", "control-sibling");
	let mut sibling = ExtHostSpec::new(
		sibling_key.clone(),
		test_manifest(&sibling_key, "control_sibling", ["control_sibling"]),
	);
	sibling.python_site = Some(site.path().to_owned());
	sibling.data_socket = Some(site.path().join("sibling-data.sock"));
	config.extensions.push(sibling);

	let respawn_timeout = config.spawn_timeout;
	let callbacks = bind_test_control(&mut config);
	let supervisor = Arc::new(
		time::timeout(Duration::from_secs(60), ExtHostSupervisor::spawn(config))
			.await
			.expect("extension registry timed out")
			.expect("spawn CONTROL extension hosts"),
	);
	callbacks.bind(supervisor.clone());
	let availability = Arc::new(CapturedAvailability::default());
	supervisor.bind_availability_sink(availability.clone());
	supervisor
		.activate_control_hosts()
		.await
		.expect("activate CONTROL extension hosts");

	let mut names = supervisor
		.registrations()
		.iter()
		.map(|registration| {
			registration
				.declaration
				.definition
				.as_ref()
				.expect("registered definition")
				.name
				.clone()
		})
		.collect::<Vec<_>>();
	names.sort();
	assert_eq!(names, ["control_block", "control_echo", "control_sibling"]);

	let first = invoke(
		&supervisor,
		"echo-before",
		"control_echo",
		json!({"message": "before"}),
		Duration::from_secs(5),
	)
	.await;
	let first_pid = completion_value(&first)["pid"]
		.as_i64()
		.expect("primary pid") as i32;
	let sibling_before = invoke(
		&supervisor,
		"sibling-before",
		"control_sibling",
		json!({"message": "stable"}),
		Duration::from_secs(5),
	)
	.await;
	let sibling_pid = completion_value(&sibling_before)["pid"]
		.as_i64()
		.expect("sibling pid") as i32;

	let started = site.path().join("control-call-started");
	let mut blocked = open_committed(
		&supervisor,
		"blocked",
		"control_block",
		json!({"started": started, "seconds": 30}),
		Duration::from_secs(60),
	)
	.expect("dispatch blocking CONTROL invocation");
	assert_eq!(wait_for_marker(&started).await, first_pid);
	blocked.cancel("integration cancellation");
	let abort = match time::timeout(Duration::from_secs(5), blocked.next())
		.await
		.expect("CONTROL cancellation timed out")
		.expect("CONTROL cancellation channel closed")
	{
		ExtHostEvent::Aborted(abort) => abort,
		event => panic!("cancelled invocation produced {event:?}"),
	};
	assert_eq!(abort.kind, ExtHostAbortKind::Cancelled);
	assert!(abort.effects_unknown);

	let second = time::timeout(
		respawn_timeout,
		invoke(
			&supervisor,
			"echo-after",
			"control_echo",
			json!({"message": "after"}),
			Duration::from_secs(5),
		),
	)
	.await
	.expect("replacement CONTROL host did not serve the next invocation");
	let second_pid = completion_value(&second)["pid"]
		.as_i64()
		.expect("replacement pid") as i32;
	assert_ne!(second_pid, first_pid);

	let sibling_after = invoke(
		&supervisor,
		"sibling-after",
		"control_sibling",
		json!({"message": "still stable"}),
		Duration::from_secs(5),
	)
	.await;
	assert_eq!(
		completion_value(&sibling_after)["pid"].as_i64(),
		Some(i64::from(sibling_pid)),
		"cancelling one extension restarted its independent sibling",
	);
	let availability = availability.0.lock().expect("availability capture");
	let transitions = availability
		.iter()
		.flat_map(|batch| batch.deltas.iter())
		.filter(|delta| delta.name == "control_echo")
		.map(|delta| delta.mounted)
		.collect::<Vec<_>>();
	assert!(
		transitions.windows(2).any(|window| window == [false, true]),
		"replacement host did not publish down/restored availability: {transitions:?}",
	);
	drop(availability);
	supervisor.shutdown().await;
}

fn open_committed(
	supervisor: &ExtHostSupervisor,
	invocation_id: &'static str,
	name: &'static str,
	args: Value,
	deadline: Duration,
) -> Result<ExtHostInvocation, ExtHostError> {
	let mut invocation = supervisor.open(ExtHostToolCall {
		invocation_id: sf!(invocation_id),
		name: sf!(name),
		rev: sf!("1"),
		deadline,
	})?;
	invocation.args_committed(ArgsCommitted {
		invocation_id:    invocation_id.to_owned(),
		raw:              Bytes::from(serde_json::to_vec(&args).expect("serialize arguments")),
		effect_token:     Bytes::from_static(b"test-effect-token"),
		authorized_at_ms: 1,
		effects:          None,
		props:            None,
	})?;
	Ok(invocation)
}

async fn invoke(
	supervisor: &ExtHostSupervisor,
	invocation_id: &'static str,
	name: &'static str,
	args: Value,
	deadline: Duration,
) -> ExtHostCompletion {
	let mut invocation = open_committed(supervisor, invocation_id, name, args, deadline)
		.expect("dispatch CONTROL invocation");
	match invocation.next().await.expect("CONTROL invocation event") {
		ExtHostEvent::Complete(completion) => {
			assert_eq!(completion.kind, ExtHostOutcomeKind::Ok);
			completion
		},
		ExtHostEvent::Aborted(abort) => panic!("CONTROL invocation aborted: {}", abort.reason),
		event => panic!("CONTROL invocation produced {event:?}"),
	}
}

fn completion_value(completion: &ExtHostCompletion) -> Value {
	serde_json::from_slice(
		completion
			.details_json
			.as_ref()
			.expect("CONTROL completion has inline details"),
	)
	.expect("CONTROL completion details are JSON")
}

async fn wait_for_marker(path: &Path) -> i32 {
	time::timeout(Duration::from_secs(3), async {
		loop {
			if let Ok(pid) = fs::read_to_string(path) {
				return pid.parse().expect("marker contains worker pid");
			}
			time::sleep(Duration::from_millis(10)).await;
		}
	})
	.await
	.expect("Python call did not enter native sleep")
}

struct InertAuthority;

#[async_trait::async_trait]
impl ControlAuthority for InertAuthority {
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
		_context: ControlRequestContext,
		_operation: Str,
		_arguments: serde_json::Map<String, Value>,
	) -> Result<Value, ControlProtocolError> {
		Ok(Value::Null)
	}

	async fn effect(
		&self,
		_context: ControlRequestContext,
		_effect: ControlEffect,
	) -> Result<(), ControlProtocolError> {
		Ok(())
	}
}

struct IgnoreCatalog;

impl DeviceCatalogObserver for IgnoreCatalog {
	fn catalog_changed(&self, _epoch: u64, _catalog: Arc<[DynamicDeviceCatalogEntry]>) {}
}

struct AllowDevices;

#[async_trait::async_trait]
impl DeviceInvocationAdmission for AllowDevices {
	async fn admit(
		&self,
		_caller: &ControlRequestContext,
		_target: &DynamicDeviceCatalogEntry,
		_arguments: &serde_json::Map<String, Value>,
	) -> Result<(), ControlProtocolError> {
		Ok(())
	}
}

fn inert_factory() -> Arc<dyn ControlAuthorityFactory> {
	Arc::new(FixedControlAuthorityFactory::new(Arc::new(InertAuthority)))
}

fn host_factory(devices: Arc<dyn ControlAuthorityFactory>) -> Arc<HostControlAuthorityFactory> {
	let envd = EnvdControlAuthorities::new(
		RegistryControlAuthorities::new(devices, inert_factory()),
		PersistenceControlAuthorities::new(inert_factory(), inert_factory(), inert_factory()),
		PolicyControlAuthorities::new(inert_factory(), inert_factory()),
		PresentationControlAuthorities::new(inert_factory(), inert_factory(), inert_factory()),
		ProviderControlAuthorities::new(inert_factory(), inert_factory()),
		inert_factory(),
		inert_factory(),
	);
	Arc::new(HostControlAuthorityFactory::new(
		envd,
		ExternalControlAuthorities::new(inert_factory(), inert_factory()),
	))
}

fn bind_test_control(config: &mut ExtHostConfig) -> Arc<CallbackDispatcherSlot> {
	let manifests = config
		.extensions
		.iter()
		.map(|extension| {
			(
				(
					extension.key.layer().clone(),
					extension.key.tier().clone(),
					extension.key.extension().clone(),
				),
				extension.manifest.clone(),
			)
		})
		.collect::<BTreeMap<_, _>>();
	let registry = RegistryControlFactory::new(manifests);
	let callbacks = CallbackDispatcherSlot::new();
	let devices: Arc<dyn ControlAuthorityFactory> = DeviceControlFactory::new(
		Arc::clone(&registry),
		callbacks.clone(),
		Arc::new(IgnoreCatalog),
		Arc::new(AllowDevices),
	);
	config.bind_control_authorities(host_factory(devices));
	config.bind_registry_control(registry);
	callbacks
}

fn test_config() -> ExtHostConfig {
	ExtHostConfig::new(
		env!("CARGO_BIN_EXE_omp").into(),
		Principal::new(sf!("test"), sf!("Test")),
		sf!("test-session"),
		1,
	)
}

fn test_manifest<const N: usize>(
	key: &HostKey,
	entry: &'static str,
	tools: [&'static str; N],
) -> ExtensionManifest {
	let tools = tools
		.into_iter()
		.map(|name| ToolDeclarationKey::new(name, "", 1))
		.collect::<Vec<_>>();
	let ordered = tools
		.iter()
		.map(|tool| StaticDeclaration {
			id: Str::from(format!("{}@.1", tool.name)),
			kind: sf!("soft"),
			module: Str::from(entry),
			trigger: sf!("lazy"),
			key: Str::from(format!("{}@.1", tool.name)),
			api: 1,
			failure: sf!("fault"),
			..StaticDeclaration::default()
		})
		.collect::<Vec<_>>();
	ExtensionManifest::new_with_static(
		test_provenance(key),
		entry,
		[],
		DeclarationSet::new(tools, []),
		ServiceManifest::default(),
		StaticDeclarations {
			ordered: ordered.clone().into_boxed_slice(),
			tools: ordered.into_boxed_slice(),
			..StaticDeclarations::default()
		},
		[],
		[ActivationTrigger::FirstReach],
	)
}

fn test_provenance(key: &HostKey) -> Provenance {
	Provenance::new(
		sf!("test-publisher"),
		key.extension().clone(),
		sf!("1.0.0"),
		ArtifactDigest::new([0; 32]),
		key.layer().clone(),
		key.tier().clone(),
		1,
	)
}
