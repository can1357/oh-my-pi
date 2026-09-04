//! End-to-end environment daemon contract tests.

use std::{
	env, fs, future, io,
	path::{Path, PathBuf},
	process,
	sync::Arc,
	time::{Duration, Instant},
};

use async_stream::stream;
use bytes::Bytes;
use futures::Stream;
use omp_core::{ArtifactDigest, Principal, Provenance, Str, sf};
use omp_env::{
	Admitter, BlobDownloadEvent, EnvClient, ExecEvent, InvocationEvent, ProcessAttachmentEvent,
};
use omp_envd::{
	AttachOptions, EnvServer, ExtensionDataBinding, ProjectEnvironment, RegistryBridges,
	eval::{
		BridgeHostError, BridgeProgressSink, EvalSessionConfig, ParentBindingLease, ParentSessionHost,
	},
	exec::{ExecEvent as HostExecEvent, ExecHost},
	exthost::{
		ActivationTrigger, DeclarationSet, ExtensionManifest, ServiceManifest, ToolDeclarationKey,
	},
	policy::Grants,
	worker::{ExtHostConfig, ExtHostSpec, HostKey},
	workspace::{WorkspaceError, WorkspaceHost, WorkspaceSearchOptions},
};
use omp_ext::config::{StaticDeclaration, StaticDeclarations};
use omp_proto::{
	SCHEMA_REV,
	blob::v1::{Chunk, GetRequest},
	env::{
		v1,
		v1::{
			Admission, AdmitInvocation, ClientHello, ExecOutcome, ExecRequest, InvokeTool,
			ListProcesses, OpenSessionRequest, ProcessSpec, RegisterPresence, ReleasePresence, Script,
			StartProcess, StopProcess,
		},
	},
};
use omp_tool::{
	Abort, CallOutcome, Claims, Constraint, DocEffects, Effects, Ev, IncomingParams, LoweringCaps,
	Part, Precedence, Presentation, PromptCaps, Registry, Rev, Tool, ToolLocus, ToolRoute, ToolSpec,
};
use omp_tools::eval;
use serde_json::{Value, json};
use tempfile::TempDir;
use tokio::{
	net::UnixStream,
	task::{self, JoinHandle},
	time,
};
use tokio_util::sync::CancellationToken;
use url::Url;
struct AllowAdmission;

impl Admitter for AllowAdmission {
	type Future<'client> = future::Ready<Admission>;

	fn admit(&self, query: AdmitInvocation) -> Self::Future<'_> {
		future::ready(Admission {
			invocation_id: query.invocation_id,
			allow: true,
			..Admission::default()
		})
	}
}

const fn test_claims() -> Claims {
	Claims { precedence: Precedence::CORE, claimant: sf!("omp/core"), replaces: None }
}

fn file_write_effects() -> Effects {
	Effects {
		documents: Some(DocEffects {
			read:        false,
			write_globs: [sf!("**")].into_iter().collect(),
		}),
		exec:      None,
		inference: None,
		desktop:   None,
		subagents: 0,
	}
}

struct EffectTool {
	spec:   ToolSpec,
	marker: PathBuf,
}

impl EffectTool {
	fn new(marker: PathBuf) -> Self {
		Self::named("effect_probe", marker)
	}

	fn named(name: &'static str, marker: PathBuf) -> Self {
		Self {
			spec: ToolSpec {
				name:            sf!(name),
				rev:             Rev { family: sf!("test"), n: 1 },
				description:     sf!("records a committed invocation"),
				schema:          Bytes::from_static(br#"{"type":"object"}"#),
				constraint:      Constraint::None,
				effects:         file_write_effects(),
				projection_code: [0; 32],
			},
			marker,
		}
	}
}

impl Tool for EffectTool {
	type Fault = Value;
	type Params = Value;
	type Payload = Value;
	type Update = Value;

	fn spec(&self) -> &ToolSpec {
		&self.spec
	}

	fn call<'c>(
		&'c self,
		mut params: IncomingParams<'c>,
	) -> impl Stream<Item = Ev<Value, Value, Value>> + Send + 'c {
		stream! {
			match params.whole::<Value>().await {
				Ok(value) => {
					fs::write(&self.marker, b"committed").expect("write effect marker");
					yield Ev::Done(omp_tool::ToolTerminal::Done { result: Ok(value), useless: true });
				},
				Err(error) => yield Ev::Done(omp_tool::ToolTerminal::Done {
					result: Err(json!({"error": error.to_string()})),
					useless: false,
				}),
			}
		}
	}

	fn prompt(&self, _view: Result<&Value, &Value>, _caps: &PromptCaps) -> Vec<Part> {
		Vec::new()
	}
}
struct SpeculativeLease {
	marker: PathBuf,
}

impl Drop for SpeculativeLease {
	fn drop(&mut self) {
		let _ = fs::remove_file(&self.marker);
	}
}

struct StreamingTool {
	spec:   ToolSpec,
	lease:  PathBuf,
	effect: PathBuf,
}

impl StreamingTool {
	fn new(lease: PathBuf, effect: PathBuf) -> Self {
		Self {
			spec: ToolSpec {
				name:            sf!("streaming_probe"),
				rev:             Rev { family: sf!("test"), n: 1 },
				description:     sf!("prepares from streamed arguments before commitment"),
				schema:          Bytes::from_static(
					br#"{"type":"object","properties":{"path":{"type":"string"}},"required":["path"]}"#,
				),
				constraint:      Constraint::None,
				effects:         file_write_effects(),
				projection_code: [0; 32],
			},
			lease,
			effect,
		}
	}
}

impl Tool for StreamingTool {
	type Fault = Value;
	type Params = Value;
	type Payload = Value;
	type Update = Value;

	fn spec(&self) -> &ToolSpec {
		&self.spec
	}

	fn call<'c>(
		&'c self,
		mut params: IncomingParams<'c>,
	) -> impl Stream<Item = Ev<Value, Value, Value>> + Send + 'c {
		stream! {
			let Ok(path) = params.pull(|mut doc| async move {
				doc.json().object().key("path").string().finish().await
			}).await else {
				yield Ev::Aborted(Abort::InputDropped);
				return;
			};
			fs::write(&self.lease, path.as_bytes()).expect("open speculative lease");
			let _lease = SpeculativeLease { marker: self.lease.clone() };
			yield Ev::Update(json!({"state": "prepared", "path": path}));
			if params.committed().await.is_err() {
				yield Ev::Aborted(Abort::InputDropped);
				return;
			}
			fs::write(&self.effect, path.as_bytes()).expect("record committed effect");
			tokio::time::sleep(Duration::from_millis(100)).await;
			yield Ev::Done(omp_tool::ToolTerminal::Done {
				result: Ok(json!({"path": path})),
				useless: false,
			});
		}
	}

	fn prompt(&self, _view: Result<&Value, &Value>, _caps: &PromptCaps) -> Vec<Part> {
		Vec::new()
	}
}

struct BlockingTool {
	spec:    ToolSpec,
	started: PathBuf,
}

impl BlockingTool {
	fn new(started: PathBuf) -> Self {
		Self {
			spec: ToolSpec {
				name:            sf!("native_block"),
				rev:             Rev { family: sf!("test"), n: 1 },
				description:     sf!("waits until the environment cancels it"),
				schema:          Bytes::from_static(br#"{"type":"object"}"#),
				constraint:      Constraint::None,
				effects:         file_write_effects(),
				projection_code: [0; 32],
			},
			started,
		}
	}
}

impl Tool for BlockingTool {
	type Fault = Value;
	type Params = Value;
	type Payload = Value;
	type Update = Value;

	fn spec(&self) -> &ToolSpec {
		&self.spec
	}

	fn call<'c>(
		&'c self,
		mut params: IncomingParams<'c>,
	) -> impl Stream<Item = Ev<Value, Value, Value>> + Send + 'c {
		stream! {
			match params.committed().await {
				Ok(_) => {
					fs::write(&self.started, b"started").expect("write native start marker");
					yield Ev::Update(json!({"state": "started"}));
					future::pending::<()>().await;
				},
				Err(_) => yield Ev::Aborted(Abort::InputDropped),
			}
		}
	}

	fn prompt(&self, _view: Result<&Value, &Value>, _caps: &PromptCaps) -> Vec<Part> {
		Vec::new()
	}
}

struct CooperativeInterruptTool {
	spec: ToolSpec,
}

impl CooperativeInterruptTool {
	const fn new() -> Self {
		Self {
			spec: ToolSpec {
				name:            sf!("cooperative_interrupt"),
				rev:             Rev { family: sf!("test"), n: 1 },
				description:     sf!("reports cooperative interrupt truth"),
				schema:          Bytes::from_static(br#"{"type":"object"}"#),
				constraint:      Constraint::None,
				effects:         Effects::empty(),
				projection_code: [0; 32],
			},
		}
	}
}

impl Tool for CooperativeInterruptTool {
	type Fault = Value;
	type Params = Value;
	type Payload = Value;
	type Update = Value;

	fn spec(&self) -> &ToolSpec {
		&self.spec
	}

	fn call<'c>(
		&'c self,
		mut params: IncomingParams<'c>,
	) -> impl Stream<Item = Ev<Value, Value, Value>> + Send + 'c {
		stream! {
			if params.committed().await.is_err() {
				yield Ev::Aborted(Abort::InputDropped);
				return;
			}
			yield Ev::Update(json!({"state": "waiting"}));
			let interrupted: Result<(), omp_tool::ParamError> = params
				.interruptable()
				.pull(|_| async { future::pending().await })
				.await;
			match interrupted {
				Err(omp_tool::ParamError::Interrupted(interrupt)) => {
					yield Ev::Aborted(Abort::Interrupted { reason: interrupt.reason });
				},
				_ => yield Ev::Aborted(Abort::MissingOutcome),
			}
		}
	}

	fn prompt(&self, _view: Result<&Value, &Value>, _caps: &PromptCaps) -> Vec<Part> {
		Vec::new()
	}
}

const PRELUDE_HELPER_EXTENSION_MODULE: &str = "envd_prelude_helper";

const PRELUDE_HELPER_EXTENSION: &str = r#"
import omp

@omp.prelude
def helper_echo(value):
    return {"value": value}
"#;

const ENV_DATA_EXTENSION: &str = r#"
import omp
import omp.env as env

try:
    env.info()
except env.EnvUnavailable:
    DECLARATION_DATA_DENIED = True
else:
    DECLARATION_DATA_DENIED = False

@omp.tool(
    "env_data_probe",
    effects=omp.Effects(
        documents=omp.DocEffects(read=True, write_globs=("**",)),
    ),
)
async def env_data_probe(path: str):
    target = env.EnvPath(path)
    metadata = await env.fs.stat(target)
    document = await env.docs.open(target)
    try:
        await document.write("updated through extension DATA")
    finally:
        await document.close()
    return {
        "parts": [],
        "details": {
            "declaration_data_denied": DECLARATION_DATA_DENIED,
            "kind": metadata.kind.value,
        },
    }
"#;

const WORKER_CANCEL_EXTENSION: &str = r#"
import ctypes
import os
import signal

signal.signal(signal.SIGINT, signal.SIG_IGN)
_sleep = ctypes.CDLL(None).sleep
_sleep.argtypes = [ctypes.c_uint]
_sleep.restype = ctypes.c_uint

def block(params):
    with open(params["started"], "w", encoding="utf-8") as marker:
        marker.write(str(os.getpid()))
        marker.flush()
    _sleep(params["seconds"])
    return {"parts": [], "details": {"unexpected": "completed"}}

def echo(params):
    return {"parts": [], "details": {"message": params["message"]}}

def fail(params):
    return {"parts": [], "details": {"code": params["code"]}, "is_error": True}

OMP_TOOLS = [
    {
        "name": "worker_block",
        "description": "blocks in native code until killed",
        "schema": {
            "type": "object",
            "properties": {
                "started": {"type": "string"},
                "seconds": {"type": "integer"},
            },
            "required": ["started", "seconds"],
            "additionalProperties": False,
        },
        "rev": "r.1",
        "strict": True,
        "handler": block,
    },
    {
        "name": "worker_echo",
        "description": "serves the request after cancellation respawn",
        "schema": {
            "type": "object",
            "properties": {"message": {"type": "string"}},
            "required": ["message"],
            "additionalProperties": False,
        },
        "rev": "r.1",
        "strict": True,
        "handler": echo,
    },
    {
        "name": "worker_fail",
        "description": "returns a structured tool fault",
        "schema": {
            "type": "object",
            "properties": {"code": {"type": "integer"}},
            "required": ["code"],
            "additionalProperties": False,
        },
        "rev": "r.1",
        "strict": True,
        "handler": fail,
    },
]

"#;
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

fn test_manifest(
	key: &HostKey,
	entry: &str,
	tools: impl IntoIterator<Item = ToolDeclarationKey>,
) -> ExtensionManifest {
	let tools = tools.into_iter().collect::<Vec<_>>();
	let ordered = tools
		.iter()
		.map(|tool| StaticDeclaration {
			id: Str::from(format!("{}@{}.{}", tool.name, tool.family, tool.rev)),
			kind: sf!("soft"),
			module: Str::from(entry),
			trigger: sf!("lazy"),
			key: Str::from(format!("{}@{}.{}", tool.name, tool.family, tool.rev)),
			api: 1,
			failure: sf!("fault"),
			..StaticDeclaration::default()
		})
		.collect::<Vec<_>>();
	ExtensionManifest::new_with_static(
		test_provenance(key),
		Str::from(entry),
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

fn test_config() -> ExtHostConfig {
	ExtHostConfig::new(
		PathBuf::from(env!("CARGO_BIN_EXE_omp")),
		Principal::new(sf!("test"), sf!("Test")),
		sf!("test-session"),
		1,
	)
}

fn extension_worker(module: &str, python_site: Option<PathBuf>) -> ExtHostConfig {
	let mut config = test_config();
	let key = HostKey::new("workspace", "trusted", module);
	let manifest = if module == PRELUDE_HELPER_EXTENSION_MODULE {
		ExtensionManifest::new(
			test_provenance(&key),
			Str::from(module),
			[],
			DeclarationSet::new([ToolDeclarationKey::new("helper_echo", "prelude", 1)], []),
			ServiceManifest::default(),
			[],
			[ActivationTrigger::FirstReach],
		)
	} else {
		test_manifest(&key, module, [
			ToolDeclarationKey::new("worker_block", "r", 1),
			ToolDeclarationKey::new("worker_echo", "r", 1),
			ToolDeclarationKey::new("worker_fail", "r", 1),
		])
	};
	let mut extension = ExtHostSpec::new(key, manifest);
	extension.python_site = python_site;
	config.extensions.push(extension);
	config
}

struct Harness {
	client:                  EnvClient,
	server:                  Arc<EnvServer>,
	root:                    TempDir,
	state:                   TempDir,
	server_task:             JoinHandle<()>,
	extension_data_shutdown: CancellationToken,
	extension_data_tasks:    Vec<JoinHandle<()>>,
	_eval_parent:            ParentBindingLease,
}
struct TestEvalParent {
	cwd: PathBuf,
}

#[async_trait::async_trait]
impl ParentSessionHost for TestEvalParent {
	fn eval_session_config(&self) -> Result<EvalSessionConfig, BridgeHostError> {
		Ok(EvalSessionConfig { cwd: self.cwd.clone(), local_roots_json: None })
	}

	async fn completion(
		&self,
		_args: Value,
		_progress: &dyn BridgeProgressSink,
	) -> Result<Value, BridgeHostError> {
		Err(BridgeHostError::message("bridge capability denied: __completion__"))
	}

	async fn agent(
		&self,
		_args: Value,
		_progress: &dyn BridgeProgressSink,
	) -> Result<Value, BridgeHostError> {
		Err(BridgeHostError::message("agents are unavailable in the envd contract harness"))
	}

	async fn concurrency(&self, _args: Value) -> Result<Value, BridgeHostError> {
		Err(BridgeHostError::message("concurrency is unavailable in the envd contract harness"))
	}

	async fn budget(&self, _args: Value) -> Result<Value, BridgeHostError> {
		Err(BridgeHostError::message("budget is unavailable in the envd contract harness"))
	}
}

impl Harness {
	async fn start(registry: Registry) -> Self {
		Self::start_with_worker(registry, test_config()).await
	}

	async fn start_with_worker(registry: Registry, mut worker: ExtHostConfig) -> Self {
		let root = tempfile::tempdir().expect("workspace scratch directory");
		let state = tempfile::tempdir().expect("state scratch directory");
		let mut extension_data_bindings = Vec::with_capacity(worker.extensions.len());
		for extension in &mut worker.extensions {
			let mut binding = ExtensionDataBinding::scoped(
				state.path(),
				extension.key.clone(),
				worker.session_id.as_str(),
				worker.session_generation,
				extension.data_grants.clone(),
			);
			extension.data_socket = Some(binding.path().to_path_buf());
			binding
				.prepare_endpoint()
				.expect("prepare extension DATA endpoint");
			extension_data_bindings.push(binding);
		}
		let con = Arc::new(omp_con::Ctx::new());
		let convars = Arc::new(omp_envd::exthost::ConvarControlFactory::new(Arc::clone(&con)));
		let server = Arc::new(
			EnvServer::open_local(
				root.path(),
				state.path(),
				registry,
				worker,
				&con,
				convars,
				RegistryBridges::default(),
			)
			.await
			.expect("real local environment host"),
		);
		let extension_data_shutdown = CancellationToken::new();
		let extension_data_tasks = extension_data_bindings
			.into_iter()
			.map(|binding| {
				let host = Arc::clone(&server);
				let shutdown = extension_data_shutdown.clone();
				tokio::spawn(async move {
					host
						.serve_extension_uds(binding, shutdown)
						.await
						.expect("serve extension DATA endpoint");
				})
			})
			.collect();
		let (client, transport) = EnvClient::in_process(64);
		client.set_admitter(AllowAdmission);
		let host = Arc::clone(&server);
		let server_task = tokio::spawn(async move { host.serve_in_process(transport).await });
		client
			.hello(ClientHello {
				client: "envd-contract".into(),
				schema_rev: SCHEMA_REV,
				..ClientHello::default()
			})
			.await
			.expect("environment hello");
		let eval_parent = server
			.bind_eval_sdk_parent(
				sf!("test-session"),
				Arc::new(TestEvalParent { cwd: env::current_dir().expect("test process cwd") }),
			)
			.expect("bind eval parent");
		Self {
			client,
			server,
			root,
			state,
			server_task,
			extension_data_shutdown,
			extension_data_tasks,
			_eval_parent: eval_parent,
		}
	}

	const fn client(&self) -> &EnvClient {
		&self.client
	}

	async fn connect(&self, name: &str) -> (EnvClient, JoinHandle<()>) {
		let (client, transport) = EnvClient::in_process(64);
		client.set_admitter(AllowAdmission);
		let host = Arc::clone(&self.server);
		let task = tokio::spawn(async move { host.serve_in_process(transport).await });
		client
			.hello(ClientHello {
				client: name.to_owned(),
				schema_rev: SCHEMA_REV,
				..ClientHello::default()
			})
			.await
			.expect("additional environment hello");
		(client, task)
	}
}

impl Drop for Harness {
	fn drop(&mut self) {
		self.extension_data_shutdown.cancel();
		for task in &self.extension_data_tasks {
			task.abort();
		}
		self.server_task.abort();
	}
}

#[tokio::test]
async fn presence_rpc_publishes_coexisting_leases_and_releases_them() {
	let harness = Harness::start(Registry::new()).await;
	let first = harness
		.client()
		.register_presence(RegisterPresence {
			client_id: Bytes::from_static(b"client-a"),
			pid: process::id(),
			kind: "interactive".to_owned(),
			..RegisterPresence::default()
		})
		.await
		.expect("register first presence");
	let (second_client, second_task) = harness.connect("presence-second").await;
	let second = second_client
		.register_presence(RegisterPresence {
			client_id: Bytes::from_static(b"client-b"),
			pid: process::id(),
			kind: "rpc".to_owned(),
			..RegisterPresence::default()
		})
		.await
		.expect("register second presence");
	let clients = harness.state.path().join("clients");
	assert_eq!(fs::read_dir(&clients).expect("presence directory").count(), 2);

	harness
		.client()
		.release_presence(ReleasePresence { lease_id: first.lease_id, ..ReleasePresence::default() })
		.await
		.expect("release first presence");
	assert_eq!(fs::read_dir(&clients).expect("presence directory").count(), 1);

	second_client
		.release_presence(ReleasePresence { lease_id: second.lease_id, ..ReleasePresence::default() })
		.await
		.expect("release second presence");
	assert_eq!(fs::read_dir(&clients).expect("presence directory").count(), 0);
	second_task.abort();
}

fn cwd_uri(path: &Path) -> String {
	Url::from_directory_path(path)
		.expect("directory file URI")
		.to_string()
}

fn exec_request(session: &[u8], script: impl Into<String>) -> ExecRequest {
	ExecRequest {
		session: Bytes::copy_from_slice(session),
		source: Some(Script { text: script.into(), ..Script::default() }),
		..ExecRequest::default()
	}
}

async fn collect_exec(run: &mut omp_env::ExecRun) -> (Vec<u8>, v1::ExecStatusMsg) {
	let mut output = Vec::new();
	loop {
		match time::timeout(Duration::from_secs(10), run.next_event())
			.await
			.expect("exec event timeout")
			.expect("exec event")
			.expect("exec stream closed")
		{
			ExecEvent::Started(_) => {},
			ExecEvent::Output(frame) => output.extend_from_slice(&frame.data),
			ExecEvent::Exit(exit) => return (output, exit.status.expect("terminal status")),
		}
	}
}

async fn invoke_builtin(
	client: &EnvClient,
	invocation_id: &str,
	name: &str,
	rev: &str,
	args: Value,
) -> v1::Verdict {
	invoke_builtin_as(client, "test-agent", invocation_id, name, rev, args).await
}

async fn invoke_builtin_as(
	client: &EnvClient,
	agent_id: &str,
	invocation_id: &str,
	name: &str,
	rev: &str,
	args: Value,
) -> v1::Verdict {
	let client = client
		.with_principal("test-session", agent_id)
		.expect("valid test invocation principal");
	let mut invocation = client
		.invoke(InvokeTool {
			invocation_id: invocation_id.into(),
			name: name.into(),
			rev: rev.into(),
			..InvokeTool::default()
		})
		.await
		.expect("open built-in invocation");
	assert!(matches!(
		invocation.next_event().await.expect("built-in accepted"),
		Some(InvocationEvent::Accepted(_))
	));
	invocation
		.commit_args(
			Bytes::from(serde_json::to_vec(&args).expect("encode built-in args")),
			Bytes::from_static(b"contract-test-token"),
			1000,
			None,
		)
		.await
		.expect("commit built-in arguments");
	loop {
		match invocation
			.next_event()
			.await
			.expect("built-in event")
			.expect("built-in stream closed")
		{
			InvocationEvent::Verdict(verdict) => return verdict,
			InvocationEvent::Update(_) => {},
			InvocationEvent::Accepted(_) => panic!("built-in invocation was accepted twice"),
			InvocationEvent::Admission(_) => panic!("unexpected admission in built-in test"),
		}
	}
}

fn ok_builtin_payload(verdict: v1::Verdict, operation: &str) -> Value {
	assert!(
		!verdict.is_error,
		"{operation} returned an error: {}",
		String::from_utf8_lossy(&verdict.json)
	);
	let verdict: CallOutcome<Value, Value> =
		serde_json::from_slice(&verdict.json).expect("typed built-in verdict");
	let CallOutcome::Ok(payload) = verdict else {
		panic!("{operation} did not return an ok payload");
	};
	payload
}

async fn read_builtin_text(client: &EnvClient, invocation_id: &str, path: &str) -> String {
	let verdict = invoke_builtin(client, invocation_id, "read", "2", json!({"path": path})).await;
	let payload = ok_builtin_payload(verdict, "read");
	payload["parts"][0]["text"]
		.as_str()
		.expect("read text part")
		.to_owned()
}

fn hashline_tag<'o>(output: &'o str, path: &str) -> &'o str {
	let prefix = format!("[{path}#");
	output
		.strip_prefix(&prefix)
		.and_then(|rest| rest.split_once(']'))
		.map(|(tag, _)| tag)
		.expect("read minted a hashline tag")
}

#[tokio::test]
async fn write_name_is_reserved_before_production_registry_assembly() {
	let root = tempfile::tempdir().expect("workspace scratch directory");
	let state = tempfile::tempdir().expect("state scratch directory");
	let marker = state.path().join("reserved-write-marker");
	let mut registry = Registry::new();
	registry
		.register(EffectTool::named("write", marker), Presentation::Slot, test_claims())
		.expect("register colliding caller write tool");
	let con = Arc::new(omp_con::Ctx::new());
	let convars = Arc::new(omp_envd::exthost::ConvarControlFactory::new(Arc::clone(&con)));
	let result = EnvServer::open_local(
		root.path(),
		state.path(),
		registry,
		test_config(),
		&con,
		convars,
		RegistryBridges::default(),
	)
	.await;
	let Err(error) = result else {
		panic!("production registry accepted a caller-owned write tool");
	};
	assert_eq!(error.to_string(), "duplicate production tool name: write");
}

#[tokio::test]
async fn production_registry_advertises_and_dispatches_all_native_adapters() {
	let harness = Harness::start(Registry::new()).await;
	fs::write(harness.root.path().join("note.txt"), "before\n").expect("workspace fixture");
	let registry = harness.server.registry();
	let agent_registry = harness.server.registry();
	assert!(Arc::ptr_eq(&registry, &agent_registry));
	assert_eq!(registry.slot_hash(), agent_registry.slot_hash());
	let advertised = registry
		.advertise(LoweringCaps {
			strict_schema:  true,
			grammar:        omp_catalog::GrammarBits::empty(),
			maximum_tools:  None,
			maximum_strict: None,
		})
		.expect("advertise production registry");
	let identities = advertised
		.iter()
		.map(|tool| (tool.identity.name.as_str(), tool.identity.rev.to_string()))
		.collect::<Vec<_>>();
	assert_eq!(identities, [
		("bash", "2".to_owned()),
		("edit", "hl.1".to_owned()),
		("glob", "1".to_owned()),
		("grep", "1".to_owned()),
		("read", "2".to_owned()),
	]);
	for name in ["eval", "write"] {
		assert_eq!(
			registry.presentation(name).expect("long-tail presentation"),
			Presentation::Device,
			"{name} must remain reachable through dyn without entering the wire roster",
		);
	}
	let hidden_yield = registry
		.advertise_selected(
			LoweringCaps {
				strict_schema:  true,
				grammar:        omp_catalog::GrammarBits::empty(),
				maximum_tools:  None,
				maximum_strict: None,
			},
			&[sf!("yield"), sf!("think")],
		)
		.expect("advertise hidden yield selection");
	assert_eq!(
		hidden_yield.len(),
		2,
		"yield and think must stay selectable for child/external-thinking sessions while hidden \
		 from the top-level agent"
	);
	let write_spec = registry
		.live_spec("write")
		.expect("write remains a live dyn device");
	assert!(write_spec.description.contains("`.tar.zst`"));
	assert!(write_spec.description.contains("other archive formats"));
	assert!(write_spec.description.contains("SQLite row operations"));
	assert!(serde_json::from_slice::<Value>(&write_spec.schema).is_ok());
	let definition = |name: &str| {
		advertised
			.iter()
			.find(|tool| tool.identity.name == name)
			.unwrap_or_else(|| panic!("advertised {name} definition"))
	};
	let schema = |name: &str| {
		definition(name)
			.definition
			.input
			.json_schema()
			.unwrap_or_else(|| panic!("{name} uses JSON Schema grammar"))
			.0
			.as_value()
			.clone()
	};
	assert_eq!(
		schema("grep"),
		json!({
			"type": "object",
			"additionalProperties": false,
			"required": ["i", "pattern"],
			"properties": {
				"pattern": {"type": "string", "description": "regex pattern"},
				"i": {"type": "string", "description": "Short present-participle intent for this call."},
				"notrunc": {"type": "boolean", "description": "Prefer complete output inline up to the host security ceiling; overflow or transport backpressure remains available through its artifact."},
				"path": {"type": "string", "description": "file, directory, glob, internal URL, or \"<file>:<lines>\" selector to search; pass several as a semicolon-delimited list (\"src; tests\"). Omitted -> searches the workspace root (\".\")"},
				"case": {"type": "boolean", "description": "case-sensitive search"},
				"gitignore": {"type": "boolean", "description": "respect gitignore"},
				"skip": {"type": ["number", "null"], "description": "files to skip before collecting results — use to paginate when the prior call hit the file limit"}
			}
		})
	);
	assert_eq!(
		schema("glob"),
		json!({
			"type": "object",
			"additionalProperties": false,
			"required": ["i"],
			"properties": {
				"path": {"type": "string", "description": "glob, file, or directory to search — a single path or a semicolon-delimited list (\"src/**/*.ts; test/**/*.ts\"). Omitted -> searches the workspace root (\".\")"},
				"i": {"type": "string", "description": "Short present-participle intent for this call."},
				"notrunc": {"type": "boolean", "description": "Prefer complete output inline up to the host security ceiling; overflow or transport backpressure remains available through its artifact."},
				"hidden": {"type": "boolean", "description": "include hidden files"},
				"gitignore": {"type": "boolean", "description": "respect gitignore"},
				"limit": {"type": "number", "description": "max results"}
			}
		})
	);
	assert_eq!(
		schema("read"),
		json!({
			"type": "object",
			"additionalProperties": false,
			"required": ["i", "path"],
			"properties": {
				"path": {"type": "string", "description": "Local path, internal URI (e.g. skill://), or URL. Inline selectors are supported."},
				"question": {"type": "string", "description": "Optional question about one image. The active model vision route receives the question and materialized image together."},
				"i": {"type": "string", "description": "Short present-participle intent for this call."},
				"notrunc": {"type": "boolean", "description": "Prefer complete output inline up to the host security ceiling; overflow or transport backpressure remains available through its artifact."}
			}
		})
	);
	assert_eq!(
		schema("edit"),
		json!({
			"type": "object",
			"additionalProperties": false,
			"required": ["i", "input"],
			"properties": {
				"input": {"type": "string"},
				"i": {"type": "string", "description": "Short present-participle intent for this call."},
				"notrunc": {"type": "boolean", "description": "Prefer complete output inline up to the host security ceiling; overflow or transport backpressure remains available through its artifact."}
			}
		})
	);
	let eval_spec = registry
		.live_spec("eval")
		.expect("eval remains a live dyn device");
	let eval_schema: Value = serde_json::from_slice(&eval_spec.schema).expect("eval schema");
	assert_eq!(eval_schema["required"], json!(["i", "language", "code"]));
	let bash_schema = schema("bash");
	assert_eq!(bash_schema["required"], json!(["i", "command"]));
	assert_eq!(bash_schema["properties"]["timeout"]["type"], "number");
	assert_eq!(bash_schema["properties"]["async"]["default"], false);
	assert!(bash_schema["properties"].get("name").is_none());
	let edit_description = definition("edit")
		.definition
		.description
		.as_deref()
		.expect("edit description");
	assert!(edit_description.starts_with("Line-anchored patch language:"));
	assert!(edit_description.contains("RE-GROUND AFTER EVERY EDIT"));
	assert!(edit_description.ends_with("</critical>\n"));
	let read_description = definition("read")
		.definition
		.description
		.as_deref()
		.expect("read description");
	assert!(read_description.contains("Summary footer names elided ranges?"));
	assert!(read_description.contains("NEVER guess `..`/`…` content."));
	assert_eq!(
		definition("grep").definition.description.as_deref(),
		Some(
			"Searches files/internal URLs: Rust regex, PCRE2 fallback.\n\n<instruction>\n- `path`: \
			 known files, directories, globs, internal URLs; roots `;`-separated.\n- Broad searches \
			 may time out → narrow scope or use `glob` first.\n- One-file line selector: \
			 `src/foo.ts:50-100`; never selects search root.\n- Literal `\\n` or `\\\\n` enables \
			 cross-line patterns.\n</instruction>\n\n<critical>\n- MUST use instead of shell \
			 `grep`/`rg`.\n</critical>"
		)
	);
	assert_eq!(
		definition("glob").definition.description.as_deref(),
		Some(
			"Globs files and directories with fast pattern matching.\n\n<instruction>\n- `path`: \
			 glob, file, or directory; separate targets with `;` (`src/**/*.ts; test/**/*.ts`).\n- \
			 `gitignore` defaults `true`. Set `false` for ignored files such as `.env*`, logs, or \
			 build output.\n- `hidden` defaults `true`; pair it with `gitignore: false` for ignored \
			 dotfiles.\n</instruction>\n\n<output>\nMatches are newest-first and grouped by \
			 directory; directories end in `/`.\n</output>"
		)
	);

	let read =
		invoke_builtin(harness.client(), "builtin-read", "read", "2", json!({"path":"note.txt"}))
			.await;
	assert!(
		!read.is_error,
		"read adapter returned an error: {}",
		String::from_utf8_lossy(&read.json)
	);
	let read_verdict: CallOutcome<Value, Value> =
		serde_json::from_slice(&read.json).expect("typed read verdict");
	let CallOutcome::Ok(read_payload) = read_verdict else {
		panic!("read did not return an ok payload");
	};
	let read_text = read_payload["parts"][0]["text"]
		.as_str()
		.expect("read text part");
	assert!(
		read_text.starts_with("[note.txt#"),
		"read must mint the edit anchor used by the shared document adapter: {read_text}"
	);
	let tag = omp_edit::store::file_hash("before\n");
	let patch = format!("[note.txt#{tag}]\nPUT 1.=1:\n+after");
	let edit =
		invoke_builtin(harness.client(), "builtin-edit", "edit", "hl.1", json!({"input":patch}))
			.await;
	assert!(
		!edit.is_error,
		"edit adapter returned an error: {}",
		String::from_utf8_lossy(&edit.json)
	);
	assert_eq!(
		fs::read_to_string(harness.root.path().join("note.txt")).expect("edited fixture"),
		"after\n"
	);

	let write = invoke_builtin(
		harness.client(),
		"builtin-write",
		"write",
		"2",
		json!({"path":"nested/written.txt","content":"written through adapter\n"}),
	)
	.await;
	assert!(
		!write.is_error,
		"write adapter returned an error: {}",
		String::from_utf8_lossy(&write.json)
	);
	let write_verdict: CallOutcome<Value, Value> =
		serde_json::from_slice(&write.json).expect("typed write verdict");
	let CallOutcome::Ok(write_payload) = write_verdict else {
		panic!("write did not return an ok payload");
	};
	assert_eq!(write_payload["display_path"], "nested/written.txt");
	assert_eq!(write_payload["operation"], json!({"kind":"plain"}));
	assert_eq!(write_payload["byte_len"], 24);
	assert_eq!(write_payload["reported_len"], 24);
	let write_tag = write_payload["snapshot_tag"]
		.as_str()
		.expect("plain write records a shared hashline snapshot");
	let write_edit = invoke_builtin(
		harness.client(),
		"builtin-edit-written",
		"edit",
		"hl.1",
		json!({"input":format!(
			"[nested/written.txt#{write_tag}]\nPUT 1.=1:\n+changed through shared snapshot"
		)}),
	)
	.await;
	assert!(
		!write_edit.is_error,
		"write snapshot was not consumable by edit: {}",
		String::from_utf8_lossy(&write_edit.json)
	);
	assert_eq!(
		fs::read_to_string(harness.root.path().join("nested/written.txt"))
			.expect("write/edit fixture"),
		"changed through shared snapshot\n"
	);
	let written = invoke_builtin(
		harness.client(),
		"builtin-read-written",
		"read",
		"2",
		json!({"path":"nested/written.txt:raw"}),
	)
	.await;
	assert!(!written.is_error, "write/read round trip returned an error");
	let written_verdict: CallOutcome<Value, Value> =
		serde_json::from_slice(&written.json).expect("typed read-after-write verdict");
	assert!(matches!(written_verdict, CallOutcome::Ok(_)));

	let shell = invoke_builtin(
		harness.client(),
		"builtin-shell",
		"bash",
		"2",
		json!({"command":"printf shell-ok"}),
	)
	.await;
	assert!(!shell.is_error, "shell adapter returned an error");
	let grep = invoke_builtin(
		harness.client(),
		"builtin-grep",
		"grep",
		"1",
		json!({"pattern":"after","path":"note.txt"}),
	)
	.await;
	assert!(!grep.is_error, "grep adapter returned an error");
	let glob = invoke_builtin(
		harness.client(),
		"builtin-glob",
		"glob",
		"1",
		json!({"path":"*.txt","limit":10}),
	)
	.await;
	assert!(!glob.is_error, "glob adapter returned an error");
}

#[tokio::test]
async fn special_writes_round_trip_through_production_read_backends() {
	let harness = Harness::start(Registry::new()).await;
	fs::write(
		harness.root.path().join("bundle.zip"),
		include_bytes!("../../../tools/tests/fixtures/special-sources/archives/bundle.zip"),
	)
	.expect("copy archive fixture");
	let archive = invoke_builtin(
		harness.client(),
		"write-archive-member",
		"write",
		"2",
		json!({
			"path": "bundle.zip:dir/member.txt",
			"content": "changed through write\n"
		}),
	)
	.await;
	assert_eq!(
		ok_builtin_payload(archive, "archive write")["operation"],
		json!({"kind":"archive_member"})
	);
	assert_eq!(
		read_builtin_text(
			harness.client(),
			"read-written-archive-member",
			"bundle.zip:dir/member.txt:raw"
		)
		.await,
		"changed through write\n"
	);

	fs::write(
		harness.root.path().join("catalog.sqlite"),
		include_bytes!("../../../tools/tests/fixtures/special-sources/database/catalog.sqlite"),
	)
	.expect("copy SQLite fixture");
	let insert = invoke_builtin(
		harness.client(),
		"write-sqlite-insert",
		"write",
		"2",
		json!({
			"path": "catalog.sqlite:people",
			"content": r#"{"id":4,"name":"Linus","score":40}"#
		}),
	)
	.await;
	assert_eq!(
		ok_builtin_payload(insert, "SQLite insert")["operation"],
		json!({"kind":"sqlite_insert","table":"people"})
	);
	assert_eq!(
		read_builtin_text(harness.client(), "read-sqlite-insert", "catalog.sqlite:people:4").await,
		"id: 4\nname: Linus\nscore: 40"
	);

	let update = invoke_builtin(
		harness.client(),
		"write-sqlite-update",
		"write",
		"2",
		json!({
			"path": "catalog.sqlite:people:4",
			"content": r#"{"name":"Linus Torvalds","score":41}"#
		}),
	)
	.await;
	assert_eq!(
		ok_builtin_payload(update, "SQLite update")["operation"],
		json!({"kind":"sqlite_update","table":"people","key":"4","changed":true})
	);
	assert_eq!(
		read_builtin_text(harness.client(), "read-sqlite-update", "catalog.sqlite:people:4").await,
		"id: 4\nname: Linus Torvalds\nscore: 41"
	);

	let delete = invoke_builtin(
		harness.client(),
		"write-sqlite-delete",
		"write",
		"2",
		json!({"path":"catalog.sqlite:people:4","content":""}),
	)
	.await;
	assert_eq!(
		ok_builtin_payload(delete, "SQLite delete")["operation"],
		json!({"kind":"sqlite_delete","table":"people","key":"4","changed":true})
	);
	let after_delete =
		read_builtin_text(harness.client(), "read-sqlite-delete", "catalog.sqlite:people").await;
	assert_eq!(
		after_delete,
		concat!(
			"CREATE TABLE people(id INTEGER PRIMARY KEY, name TEXT, score INTEGER)\n\n",
			"Sample rows:\n",
			"| id  | name  | score |\n",
			"| --- | ----- | ----- |\n",
			"| 1   | Ada   | 10    |\n",
			"| 2   | Grace | 20    |\n",
			"| 3   | Linus | 30    |"
		)
	);
}

#[tokio::test]
async fn edit_rejects_a_stale_tag_after_an_external_file_change() {
	let harness = Harness::start(Registry::new()).await;
	let path = harness.root.path().join("stale.txt");
	fs::write(&path, "before\n").expect("seed stale edit fixture");
	let first = read_builtin_text(harness.client(), "read-stale-base", "stale.txt").await;
	let tag = hashline_tag(&first, "stale.txt").to_owned();

	fs::write(&path, "changed outside\n").expect("modify fixture outside document host");
	let current = read_builtin_text(harness.client(), "read-stale-current", "stale.txt").await;
	assert!(current.contains("1:changed outside"));
	let edit = invoke_builtin(
		harness.client(),
		"edit-stale-base",
		"edit",
		"hl.1",
		json!({
			"input": format!("[stale.txt#{tag}]\nPUT 1.=1:\n+after")
		}),
	)
	.await;
	assert!(edit.is_error, "stale edit unexpectedly committed");
	let verdict: CallOutcome<Value, Value> =
		serde_json::from_slice(&edit.json).expect("typed stale edit verdict");
	let CallOutcome::Faulted(fault) = verdict else {
		panic!("stale edit did not return a typed fault");
	};
	assert_eq!(fault["reason"]["kind"], "stale_unrecoverable");
	let message = fault["reason"]["message"]
		.as_str()
		.expect("stale mismatch message");
	assert!(message.contains(&tag), "stale message omitted authored tag: {message}");
	assert_eq!(fs::read_to_string(path).expect("unchanged stale fixture"), "changed outside\n");
}

#[tokio::test]
async fn edit_named_register_spans_sections_and_persists_after_commit() {
	let harness = Harness::start(Registry::new()).await;
	for (path, content) in
		[("source.txt", "carry\nstay\n"), ("destination.txt", "before\n"), ("later.txt", "again\n")]
	{
		fs::write(harness.root.path().join(path), content).expect("seed clipboard fixture");
	}
	let source = read_builtin_text(harness.client(), "read-clipboard-source", "source.txt").await;
	let destination =
		read_builtin_text(harness.client(), "read-clipboard-destination", "destination.txt").await;
	let later = read_builtin_text(harness.client(), "read-clipboard-later", "later.txt").await;
	let source_tag = hashline_tag(&source, "source.txt");
	let destination_tag = hashline_tag(&destination, "destination.txt");
	let later_tag = hashline_tag(&later, "later.txt");

	let batch = invoke_builtin(
		harness.client(),
		"edit-clipboard-batch",
		"edit",
		"hl.1",
		json!({
			"input": format!(
				"[source.txt#{source_tag}]\nCUT 1.=1 @carry\n[destination.txt#{destination_tag}]\nPUT >1 @carry"
			)
		}),
	)
	.await;
	let _ = ok_builtin_payload(batch, "edit clipboard batch");
	assert_eq!(
		fs::read_to_string(harness.root.path().join("source.txt")).expect("read cut source"),
		"stay\n"
	);
	assert_eq!(
		fs::read_to_string(harness.root.path().join("destination.txt"))
			.expect("read paste destination"),
		"before\ncarry\n"
	);

	let persisted = invoke_builtin(
		harness.client(),
		"edit-clipboard-persisted",
		"edit",
		"hl.1",
		json!({
			"input": format!("[later.txt#{later_tag}]\nPUT >1 @carry")
		}),
	)
	.await;
	let _ = ok_builtin_payload(persisted, "edit persisted clipboard");
	assert_eq!(
		fs::read_to_string(harness.root.path().join("later.txt")).expect("read persisted paste"),
		"again\ncarry\n"
	);
}

#[tokio::test]
async fn production_eval_covers_bridge_persistence_reset_timeout_cancellation_and_recovery() {
	let harness = Harness::start(Registry::new()).await;
	fs::write(harness.root.path().join("bridge-note.txt"), "bridge\n").expect("eval bridge fixture");
	let changed_cwd = harness.root.path().join("eval-mutated-cwd");
	fs::create_dir(&changed_cwd).expect("eval cwd mutation fixture");
	let changed_cwd_literal =
		serde_json::to_string(&changed_cwd.to_string_lossy()).expect("encode eval cwd fixture");
	let expected_cwd = env::current_dir().expect("current test directory");
	let expected_cwd_literal =
		serde_json::to_string(&expected_cwd.to_string_lossy()).expect("encode expected cwd");

	let seed = invoke_builtin(
		harness.client(),
		"eval-seed",
		"eval",
		"1",
		json!({
			"language":"py",
			"code":format!(
				"import builtins, math, os, sys, threading\nstate = 40\nbuiltins.OMP_EVAL_LEAK = \
				 'owner-a'\nmath.OMP_EVAL_LEAK = 'owner-a'\nsys.modules['omp_eval_leak'] = \
				 object()\nos.environ['OMP_EVAL_LEAK'] = 'owner-a'\nos.chdir({changed_cwd_literal})\ndef \
				 _leaked_thread():\n    while True:\n        pass\nthreading.Thread(target=_leaked_thread, \
				 daemon=False).start()\nprint('seeded')"
			),
			"title":"seed"
		}),
	)
	.await;
	assert!(!seed.is_error, "embedded Python seed cell failed");
	let seed: CallOutcome<eval::Payload, eval::Fault> =
		serde_json::from_slice(&seed.json).expect("typed eval seed verdict");
	let CallOutcome::Ok(seed) = seed else {
		panic!("embedded Python seed cell returned a fault");
	};
	assert!(seed.had_output);
	assert_eq!(seed.status.outcome, omp_tools::eval::CellOutcome::Complete);

	let rich = invoke_builtin(
		harness.client(),
		"eval-await-display",
		"eval",
		"1",
		json!({
			"language":"py",
			"code":"import asyncio\nclass Bundle:\n    def _repr_mimebundle_(self):\n        return {'application/json': {'bundle': True}, 'text/plain': 'bundle'}\ndisplay(Bundle())\nawait asyncio.sleep(0, result=state + 2)"
		}),
	)
	.await;
	assert!(!rich.is_error, "top-level await or MIME bundle display failed");
	let rich: CallOutcome<eval::Payload, eval::Fault> =
		serde_json::from_slice(&rich.json).expect("typed rich eval verdict");
	let CallOutcome::Ok(rich) = rich else {
		panic!("rich Python eval returned a fault");
	};
	assert_eq!(
		rich.result.and_then(|result| result.json),
		Some(json!(42)),
		"top-level await did not preserve the persistent namespace"
	);
	assert_eq!(rich.display_outputs, vec![omp_tools::eval::DisplayOutput::Json {
		data: json!({"bundle": true}),
	}]);

	let (unrelated, unrelated_task) = harness.connect("eval-unrelated-owner").await;
	let isolated = invoke_builtin_as(
		&unrelated,
		"other-agent",
		"eval-owner-isolation",
		"eval",
		"1",
		json!({
			"language":"py",
			"code":format!(
				"import builtins, math, os, sys\n(hasattr(builtins, 'OMP_EVAL_LEAK'), \
				 hasattr(math, 'OMP_EVAL_LEAK'), 'omp_eval_leak' in sys.modules, \
				 os.environ.get('OMP_EVAL_LEAK'), os.getcwd() == {expected_cwd_literal})"
			)
		}),
	)
	.await;
	assert!(!isolated.is_error, "unrelated eval owner failed");
	let isolated: CallOutcome<eval::Payload, eval::Fault> =
		serde_json::from_slice(&isolated.json).expect("typed owner-isolation verdict");
	let CallOutcome::Ok(isolated) = isolated else {
		panic!("unrelated eval owner returned a fault");
	};
	assert_eq!(
		isolated.result.and_then(|result| result.json),
		Some(json!([false, false, false, null, true])),
		"Python process globals leaked between authenticated owners"
	);
	let left_ready = harness.root.path().join("eval-left-ready");
	let right_ready = harness.root.path().join("eval-right-ready");
	let left_ready_literal =
		serde_json::to_string(&left_ready.to_string_lossy()).expect("encode left ready path");
	let right_ready_literal =
		serde_json::to_string(&right_ready.to_string_lossy()).expect("encode right ready path");
	let left_code = format!(
		"import time\nfrom pathlib import \
		 Path\nPath({left_ready_literal}).write_text('ready')\nwhile not \
		 Path({right_ready_literal}).exists():\n    time.sleep(0.01)\nshared_name = \
		 'left'\nshared_name"
	);
	let right_code = format!(
		"import time\nfrom pathlib import \
		 Path\nPath({right_ready_literal}).write_text('ready')\nwhile not \
		 Path({left_ready_literal}).exists():\n    time.sleep(0.01)\nshared_name = \
		 'right'\npeer_state = 73\nshared_name"
	);
	let (left, right) = time::timeout(Duration::from_secs(5), async {
		tokio::join!(
			invoke_builtin(
				harness.client(),
				"eval-parallel-left",
				"eval",
				"1",
				json!({"language":"py","code":left_code})
			),
			invoke_builtin_as(
				&unrelated,
				"other-agent",
				"eval-parallel-right",
				"eval",
				"1",
				json!({"language":"py","code":right_code})
			)
		)
	})
	.await
	.expect("independent Python kernels serialized behind one another");
	assert!(!left.is_error, "left independent Python kernel failed");
	assert!(!right.is_error, "right independent Python kernel failed");
	let left: CallOutcome<eval::Payload, eval::Fault> =
		serde_json::from_slice(&left.json).expect("typed left parallel eval verdict");
	let right: CallOutcome<eval::Payload, eval::Fault> =
		serde_json::from_slice(&right.json).expect("typed right parallel eval verdict");
	let (CallOutcome::Ok(left), CallOutcome::Ok(right)) = (left, right) else {
		panic!("independent Python kernels returned a resource fault");
	};
	assert_eq!(left.result.and_then(|result| result.json), Some(json!("left")));
	assert_eq!(right.result.and_then(|result| result.json), Some(json!("right")));

	let bridged_glob = invoke_builtin(
		harness.client(),
		"eval-tool-bridge",
		"eval",
		"1",
		json!({"language":"py","code":"parallel([lambda: tool.glob({'path': 'bridge-note.txt'}), lambda: tool.glob({'path': 'bridge-note.txt'})])[0]"}),
	)
	.await;
	assert!(!bridged_glob.is_error, "eval tool bridge call failed");
	let bridged_glob: CallOutcome<eval::Payload, eval::Fault> =
		serde_json::from_slice(&bridged_glob.json).expect("typed eval bridge verdict");
	let CallOutcome::Ok(bridged_glob) = bridged_glob else {
		panic!("eval tool bridge returned a fault");
	};
	assert_eq!(bridged_glob.status.outcome, omp_tools::eval::CellOutcome::Complete);
	assert!(
		bridged_glob
			.result
			.as_ref()
			.and_then(|result| result.json.as_ref())
			.and_then(Value::as_str)
			.is_some_and(|output| output.contains("bridge-note.txt")),
		"glob bridge result did not contain the fixture path"
	);

	let denied_completion = invoke_builtin(
		harness.client(),
		"eval-completion-denied",
		"eval",
		"1",
		json!({
			"language":"py",
			"code":"try:\n    completion('no parent')\nexcept RuntimeError as error:\n    print(str(error))"
		}),
	)
	.await;
	assert!(!denied_completion.is_error, "completion denial cell failed");
	let denied_completion: CallOutcome<eval::Payload, eval::Fault> =
		serde_json::from_slice(&denied_completion.json).expect("typed completion denial verdict");
	let CallOutcome::Ok(denied_completion) = denied_completion else {
		panic!("completion denial returned a resource fault");
	};
	assert!(denied_completion.had_output);

	let continued = invoke_builtin(
		harness.client(),
		"eval-continued",
		"eval",
		"1",
		json!({"language":"py","code":"state += 2\nprint(f'cell={state}')\nstate"}),
	)
	.await;
	assert!(!continued.is_error, "embedded Python continuation cell failed");
	let continued: CallOutcome<eval::Payload, eval::Fault> =
		serde_json::from_slice(&continued.json).expect("typed eval continuation verdict");
	let CallOutcome::Ok(continued) = continued else {
		panic!("embedded Python continuation cell returned a fault");
	};
	assert_eq!(continued.session_id, seed.session_id);
	assert!(continued.had_output);
	assert_eq!(
		continued.result,
		Some(omp_tools::eval::CellValue { text: sf!("42"), json: Some(json!(42)) })
	);

	let reset = invoke_builtin(
		harness.client(),
		"eval-reset",
		"eval",
		"1",
		json!({
			"language":"py",
			"code":format!(
				"import builtins, math, os, sys\n('state' in globals(), \
				 hasattr(builtins, 'OMP_EVAL_LEAK'), hasattr(math, 'OMP_EVAL_LEAK'), \
				 'omp_eval_leak' in sys.modules, os.environ.get('OMP_EVAL_LEAK'), \
				 os.getcwd() == {expected_cwd_literal})"
			),
			"reset":true
		}),
	)
	.await;
	assert!(!reset.is_error, "embedded Python reset cell failed");
	let reset: CallOutcome<eval::Payload, eval::Fault> =
		serde_json::from_slice(&reset.json).expect("typed eval reset verdict");
	let CallOutcome::Ok(reset) = reset else {
		panic!("embedded Python reset cell returned a fault");
	};
	assert_eq!(reset.session_id, seed.session_id);
	assert!(reset.reset);
	assert_eq!(
		reset.result.and_then(|result| result.json),
		Some(json!([false, false, false, false, null, true])),
		"reset did not replace process-global Python state"
	);
	let peer_after_reset = invoke_builtin_as(
		&unrelated,
		"other-agent",
		"eval-peer-after-reset",
		"eval",
		"1",
		json!({"language":"py","code":"peer_state"}),
	)
	.await;
	assert!(!peer_after_reset.is_error, "peer kernel failed after another kernel reset");
	let peer_after_reset: CallOutcome<eval::Payload, eval::Fault> =
		serde_json::from_slice(&peer_after_reset.json).expect("typed peer post-reset verdict");
	let CallOutcome::Ok(peer_after_reset) = peer_after_reset else {
		panic!("peer kernel returned a fault after another kernel reset");
	};
	assert_eq!(
		peer_after_reset.result.and_then(|result| result.json),
		Some(json!(73)),
		"reset replaced an unrelated Python kernel"
	);
	unrelated_task.abort();

	let timeout_marker = harness.root.path().join("eval-timeout-started");
	let timeout_marker_literal =
		serde_json::to_string(&timeout_marker.to_string_lossy()).expect("encode timeout marker path");
	let timeout_code = format!(
		"import time\nfrom pathlib import \
		 Path\nPath({timeout_marker_literal}).write_text('started')\ntime.sleep(5)"
	);
	let timed_out = async {
		let started = Instant::now();
		let verdict = invoke_builtin(
			harness.client(),
			"eval-timeout",
			"eval",
			"1",
			json!({"language":"py","code":timeout_code,"timeout":0.025}),
		)
		.await;
		(verdict, started.elapsed())
	};
	let queued_after_timeout = async {
		while !timeout_marker.exists() {
			time::sleep(Duration::from_millis(1)).await;
		}
		invoke_builtin(
			harness.client(),
			"eval-after-timeout",
			"eval",
			"1",
			json!({"language":"py","code":"6 * 7"}),
		)
		.await
	};
	let ((timed_out, timeout_elapsed), recovered) = time::timeout(
		Duration::from_secs(5),
		Box::pin(async { tokio::join!(timed_out, queued_after_timeout) }),
	)
	.await
	.expect("queued cell deadlocked behind timed-out Python kernel");
	assert!(!timed_out.is_error, "timed-out Python cell did not return typed cell truth");
	let timed_out: CallOutcome<eval::Payload, eval::Fault> =
		serde_json::from_slice(&timed_out.json).expect("typed eval timeout verdict");
	let CallOutcome::Ok(timed_out) = timed_out else {
		panic!("timed-out Python cell returned a resource fault");
	};
	assert_eq!(timed_out.status.outcome, omp_tools::eval::CellOutcome::Timeout);
	assert!(
		timeout_elapsed < Duration::from_millis(500),
		"hard eval timeout exceeded 500ms: {timeout_elapsed:?}",
	);
	assert_eq!(
		timed_out
			.status
			.exception
			.as_ref()
			.map(|exception| exception.name.as_str()),
		Some("TimeoutError")
	);

	assert!(!recovered.is_error, "Python kernel did not recover after timeout");
	let recovered: CallOutcome<eval::Payload, eval::Fault> =
		serde_json::from_slice(&recovered.json).expect("typed post-timeout eval verdict");
	let CallOutcome::Ok(recovered) = recovered else {
		panic!("post-timeout Python cell returned a fault");
	};
	assert_eq!(recovered.session_id, seed.session_id);
	assert!(recovered.reset, "queued respawn after timeout was not reported as a reset");
	assert_eq!(
		recovered.result,
		Some(omp_tools::eval::CellValue { text: sf!("42"), json: Some(json!(42)) })
	);

	let started = harness.root.path().join("eval-cancel-started");
	let started_literal =
		serde_json::to_string(&started.to_string_lossy()).expect("encode cancellation marker path");
	let code = format!(
		"import threading\nfrom pathlib import Path\ndef spin_forever():\n    while True:\n        \
		 pass\nthreading.Thread(target=spin_forever, \
		 daemon=False).start()\nPath({started_literal}).write_text('started')\nwhile True:\n    pass"
	);
	let mut cancelled = harness
		.client()
		.with_principal("test-session", "test-agent")
		.expect("valid cancellable eval principal")
		.invoke(InvokeTool {
			invocation_id: "eval-cancel".into(),
			name: "eval".into(),
			rev: "1".into(),
			..InvokeTool::default()
		})
		.await
		.expect("open cancellable eval invocation");
	assert!(matches!(
		cancelled
			.next_event()
			.await
			.expect("eval cancellation accepted"),
		Some(InvocationEvent::Accepted(_))
	));
	cancelled
		.commit_args(
			Bytes::from(
				serde_json::to_vec(&json!({"language":"py","code":code}))
					.expect("encode cancellable eval arguments"),
			),
			Bytes::from_static(b"contract-test-token"),
			1000,
			None,
		)
		.await
		.expect("commit cancellable eval arguments");
	time::timeout(Duration::from_secs(2), async {
		while !started.exists() {
			task::yield_now().await;
		}
	})
	.await
	.expect("embedded Python cancellation cell never became active");
	cancelled.guard().cancel();
	let terminal = time::timeout(Duration::from_secs(2), cancelled.next_event())
		.await
		.expect("eval cancellation terminal timeout")
		.expect("eval cancellation terminal event")
		.expect("eval cancellation stream closed");
	let InvocationEvent::Verdict(terminal) = terminal else {
		panic!("eval cancellation did not produce a verdict");
	};
	let verdict: CallOutcome<Value, Value> =
		serde_json::from_slice(&terminal.json).expect("decode eval cancellation verdict");
	assert!(matches!(verdict, CallOutcome::Aborted { abort: Abort::EffectsUnknown { .. }, .. }));

	let after_cancel = invoke_builtin(
		harness.client(),
		"eval-after-cancel",
		"eval",
		"1",
		json!({"language":"py","code":"7 * 7"}),
	)
	.await;
	assert!(!after_cancel.is_error, "Python kernel did not recover after cancellation");
	let after_cancel: CallOutcome<eval::Payload, eval::Fault> =
		serde_json::from_slice(&after_cancel.json).expect("typed post-cancel eval verdict");
	let CallOutcome::Ok(after_cancel) = after_cancel else {
		panic!("post-cancel Python cell returned a fault");
	};
	assert_eq!(
		after_cancel.result,
		Some(omp_tools::eval::CellValue { text: sf!("49"), json: Some(json!(49)) })
	);

	let crashed = invoke_builtin(
		harness.client(),
		"eval-child-crash",
		"eval",
		"1",
		json!({"language":"py","code":"import os\nos._exit(17)"}),
	)
	.await;
	assert!(crashed.is_error, "eval child crash was reported as a successful cell");
	let crashed: CallOutcome<eval::Payload, eval::Fault> =
		serde_json::from_slice(&crashed.json).expect("typed eval crash verdict");
	assert!(matches!(crashed, CallOutcome::Faulted(omp_tools::eval::Fault::SessionLost { .. })));

	let after_crash = invoke_builtin(
		harness.client(),
		"eval-after-crash",
		"eval",
		"1",
		json!({"language":"py","code":"8 * 8"}),
	)
	.await;
	let after_crash: CallOutcome<eval::Payload, eval::Fault> =
		serde_json::from_slice(&after_crash.json).expect("typed post-crash eval verdict");
	let CallOutcome::Ok(after_crash) = after_crash else {
		panic!("post-crash Python cell returned a fault");
	};
	assert!(after_crash.reset, "respawn after crash was not reported as a reset");
	assert_eq!(after_crash.result.and_then(|result| result.json), Some(json!(64)));
}

#[tokio::test]
async fn uds_clients_invoke_owner_eval_and_retain_ordinary_tools() {
	let harness = Harness::start(Registry::new()).await;
	fs::write(harness.root.path().join("uds-note.txt"), "uds read\n").expect("UDS read fixture");
	let advertised = harness
		.server
		.registry()
		.advertise(LoweringCaps {
			strict_schema:  true,
			grammar:        omp_catalog::GrammarBits::empty(),
			maximum_tools:  None,
			maximum_strict: None,
		})
		.expect("advertise UDS registry");
	assert!(
		advertised.iter().all(|tool| tool.identity.name != "eval"),
		"eval must remain a dyn device rather than tax the wire roster",
	);
	assert_eq!(
		harness
			.server
			.registry()
			.presentation("eval")
			.expect("eval presentation"),
		Presentation::Device,
	);
	let local_eval = invoke_builtin(
		harness.client(),
		"local-eval-capability",
		"eval",
		"1",
		json!({"language":"py","code":"2 + 3"}),
	)
	.await;
	assert!(
		!local_eval.is_error,
		"session-local in-process eval was denied: {}",
		String::from_utf8_lossy(&local_eval.json)
	);

	let socket = harness.state.path().join("env-remote.sock");
	let shutdown = CancellationToken::new();
	let server = Arc::clone(&harness.server);
	let serve_shutdown = shutdown.clone();
	let socket_for_server = socket.clone();
	let server_task = tokio::spawn(async move {
		server
			.serve_uds(&socket_for_server, serve_shutdown, None)
			.await
	});
	time::timeout(Duration::from_secs(2), async {
		while !socket.exists() {
			task::yield_now().await;
		}
	})
	.await
	.expect("UDS environment socket did not become ready");
	let (remote, bridge_task) = EnvServer::connect_owner_uds(&socket)
		.await
		.expect("connect owner UDS client");
	remote.set_admitter(AllowAdmission);
	remote
		.hello(ClientHello {
			client: "envd-contract-uds".into(),
			schema_rev: SCHEMA_REV,
			..ClientHello::default()
		})
		.await
		.expect("UDS environment hello");

	let remote_eval = invoke_builtin(
		&remote,
		"remote-eval-allowed",
		"eval",
		"1",
		json!({"language":"py","code":"5 * 7"}),
	)
	.await;
	assert!(
		!remote_eval.is_error,
		"owner-local UDS eval was denied: {}",
		String::from_utf8_lossy(&remote_eval.json)
	);

	let read = invoke_builtin(
		&remote,
		"remote-read-allowed",
		"read",
		"2",
		json!({"path":"uds-note.txt:raw"}),
	)
	.await;
	assert!(!read.is_error, "ordinary UDS read was denied");

	shutdown.cancel();
	bridge_task.abort();
	let _ = server_task.await;
}

#[tokio::test]
async fn opt_in_py_eval_is_environment_routed_and_uses_a_fresh_namespace() {
	let root = tempfile::tempdir().expect("py_eval workspace");
	let state = tempfile::tempdir().expect("py_eval state");
	let environment = ProjectEnvironment::attach(root.path(), state.path(), AttachOptions {
		py_eval:            true,
		approval_mode:      None,
		trusted_extensions: Vec::new(),
		contributed_values: Vec::new(),
		con:                Arc::new(omp_con::Ctx::new()),
		bridges:            RegistryBridges::default(),
		spawn_idle_timeout: Some(2),
	})
	.await
	.expect("start py_eval environment");
	let eval_parent_lease = environment
		.bind_eval_sdk_parent(
			sf!("test-session"),
			Arc::new(TestEvalParent { cwd: root.path().to_owned() }),
		)
		.expect("bind py_eval parent");
	environment.client().set_admitter(AllowAdmission);
	let registry = environment.registry();

	assert_eq!(registry.locus("py_eval").expect("py_eval locus"), ToolLocus::Environment);
	assert!(
		!matches!(registry.route("py_eval").expect("py_eval route"), ToolRoute::Worker { .. }),
		"built-in py_eval used the extension or named-worker route"
	);
	assert_eq!(
		registry
			.live_identity("py_eval")
			.map(|(_, revision)| revision.to_string())
			.as_deref(),
		Some("1")
	);

	let seeded = invoke_builtin(
		environment.client(),
		"builtin-python-seed",
		"py_eval",
		"1",
		json!({"code":"globals().__setitem__('sentinel', 42) or sentinel"}),
	)
	.await;
	assert_eq!(ok_builtin_payload(seeded, "py_eval seed"), json!({"result": 42}));
	let fresh = invoke_builtin(
		environment.client(),
		"builtin-python-fresh",
		"py_eval",
		"1",
		json!({"code":"globals().get('sentinel', 'fresh')"}),
	)
	.await;
	assert_eq!(
		ok_builtin_payload(fresh, "py_eval fresh namespace"),
		json!({"result": "fresh"})
	);
	drop(eval_parent_lease);
}
#[tokio::test]
async fn extension_prelude_helper_bridges_eval_without_registering_a_tool() {
	let site = tempfile::tempdir().expect("prelude helper extension scratch");
	fs::write(
		site
			.path()
			.join(format!("{PRELUDE_HELPER_EXTENSION_MODULE}.py")),
		PRELUDE_HELPER_EXTENSION,
	)
	.expect("write prelude helper extension");
	let worker = extension_worker(PRELUDE_HELPER_EXTENSION_MODULE, Some(site.path().to_owned()));
	let harness = Harness::start_with_worker(Registry::new(), worker).await;
	let registry = harness.server.registry();

	assert!(
		registry.live_identity("helper_echo").is_none(),
		"prelude helper entered the tool registry"
	);
	let advertised = registry
		.advertise(LoweringCaps {
			strict_schema:  true,
			grammar:        omp_catalog::GrammarBits::empty(),
			maximum_tools:  None,
			maximum_strict: None,
		})
		.expect("advertise registry with prelude helper");
	assert_eq!(advertised.len(), 5);
	assert_eq!(registry.presentation("eval").expect("eval presentation"), Presentation::Device);

	let verdict = invoke_builtin(
		harness.client(),
		"eval-prelude-helper",
		"eval",
		"1",
		json!({
			"language": "py",
			"code": "helper_echo(value=7)",
		}),
	)
	.await;
	assert!(!verdict.is_error, "prelude helper eval returned an error");
	let verdict: CallOutcome<eval::Payload, eval::Fault> =
		serde_json::from_slice(&verdict.json).expect("typed prelude helper eval verdict");
	let CallOutcome::Ok(payload) = verdict else {
		panic!("prelude helper eval returned a resource fault");
	};
	assert_eq!(
		payload.status.outcome,
		omp_tools::eval::CellOutcome::Complete,
		"prelude eval payload: {payload:?}"
	);
	assert_eq!(payload.result.and_then(|result| result.json), Some(json!({"value": 7})));
}

#[tokio::test]
async fn native_streaming_prepares_before_commit_and_fuses_commit_cancel_terminals() {
	let scratch = tempfile::tempdir().expect("streaming native scratch");
	let lease = scratch.path().join("lease");
	let effect = scratch.path().join("effect");
	let mut registry = Registry::new();
	registry
		.register(
			StreamingTool::new(lease.clone(), effect.clone()),
			Presentation::Slot,
			test_claims(),
		)
		.expect("register streaming tool");
	let harness = Harness::start(registry).await;

	let mut cancelled = harness
		.client()
		.invoke(v1::InvokeTool {
			invocation_id: "stream-cancel".into(),
			name: "streaming_probe".into(),
			rev: "test.1".into(),
			..Default::default()
		})
		.await
		.expect("open cancellable streaming invocation");
	assert!(matches!(
		cancelled.next_event().await.expect("cancel accepted"),
		Some(InvocationEvent::Accepted(_))
	));
	cancelled
		.arg_text(sf!(r#"{{"pa"#))
		.await
		.expect("first cancellable argument fragment");
	cancelled
		.arg_text(sf!(r#"th":"cancel"}}"#))
		.await
		.expect("second cancellable argument fragment");
	let update = time::timeout(Duration::from_secs(1), cancelled.next_event())
		.await
		.expect("speculative update timeout")
		.expect("speculative update event")
		.expect("speculative stream closed");
	assert!(matches!(update, InvocationEvent::Update(_)));
	assert_eq!(fs::read(&lease).expect("speculative lease marker"), b"cancel");
	assert!(!effect.exists(), "streamed preparation performed an effect before commit");

	cancelled.guard().cancel();
	let terminal = cancelled
		.next_event()
		.await
		.expect("cancel terminal event")
		.expect("cancel stream closed");
	let InvocationEvent::Verdict(terminal) = terminal else {
		panic!("precommit cancel did not produce a verdict");
	};
	let verdict: CallOutcome<Value, Value> =
		serde_json::from_slice(&terminal.json).expect("decode precommit cancel verdict");
	assert!(matches!(&verdict, CallOutcome::Aborted { abort: Abort::Skipped { .. }, .. }));
	assert!(!matches!(&verdict, CallOutcome::Aborted { abort: Abort::EffectsUnknown { .. }, .. }));
	assert!(
		cancelled
			.next_event()
			.await
			.expect("closed cancelled invocation")
			.is_none(),
		"precommit cancellation emitted more than one terminal",
	);
	time::timeout(Duration::from_secs(1), async {
		while lease.exists() {
			task::yield_now().await;
		}
	})
	.await
	.expect("speculative lease was not released");
	assert!(!effect.exists(), "cancelled precommit invocation performed an effect");

	let mut committed = harness
		.client()
		.invoke(v1::InvokeTool {
			invocation_id: "stream-commit".into(),
			name: "streaming_probe".into(),
			rev: "test.1".into(),
			..Default::default()
		})
		.await
		.expect("open committed streaming invocation");
	assert!(matches!(
		committed.next_event().await.expect("commit accepted"),
		Some(InvocationEvent::Accepted(_))
	));
	committed
		.arg_text(sf!(r#"{{"path":"comm"#))
		.await
		.expect("first committed argument fragment");
	committed
		.arg_text(sf!(r#"itted"}}"#))
		.await
		.expect("second committed argument fragment");
	assert!(matches!(
		committed
			.next_event()
			.await
			.expect("committed speculative update"),
		Some(InvocationEvent::Update(_))
	));
	assert!(!effect.exists(), "effect marker appeared before ArgsCommitted");
	committed
		.commit_args(
			Bytes::from_static(br#"{"path":"committed"}"#),
			Bytes::from_static(b"contract-test-token"),
			1000,
			None,
		)
		.await
		.expect("commit streamed arguments");
	let terminal = committed
		.next_event()
		.await
		.expect("committed verdict")
		.expect("committed stream closed");
	assert!(matches!(terminal, InvocationEvent::Verdict(_)));
	assert_eq!(fs::read(&effect).expect("committed effect marker"), b"committed");
	assert!(!lease.exists(), "committed speculative lease was not released");
	fs::remove_file(&effect).expect("clear committed effect marker");

	let mut duplicate = harness
		.client()
		.invoke(v1::InvokeTool {
			invocation_id: "stream-duplicate".into(),
			name: "streaming_probe".into(),
			rev: "test.1".into(),
			..Default::default()
		})
		.await
		.expect("open duplicate-commit invocation");
	assert!(matches!(
		duplicate.next_event().await.expect("duplicate accepted"),
		Some(InvocationEvent::Accepted(_))
	));
	duplicate
		.arg_text(sf!(r#"{{"path":"duplicate"}}"#))
		.await
		.expect("duplicate argument fragment");
	assert!(matches!(
		duplicate
			.next_event()
			.await
			.expect("duplicate speculative update"),
		Some(InvocationEvent::Update(_))
	));
	duplicate
		.commit_args(
			Bytes::from_static(br#"{"path":"duplicate"}"#),
			Bytes::from_static(b"contract-test-token"),
			1000,
			None,
		)
		.await
		.expect("first duplicate commit");
	time::timeout(Duration::from_secs(1), async {
		while !fs::read(&effect).is_ok_and(|contents| contents == b"duplicate") {
			task::yield_now().await;
		}
	})
	.await
	.expect("first duplicate commit did not enter execution");
	duplicate
		.commit_args(
			Bytes::from_static(br#"{"path":"duplicate"}"#),
			Bytes::from_static(b"contract-test-token"),
			1000,
			None,
		)
		.await
		.expect("send duplicate commit");
	let error = duplicate
		.next_event()
		.await
		.expect_err("duplicate ArgsCommitted was not rejected");
	let omp_env::ClientError::Protocol(error) = error else {
		panic!("duplicate ArgsCommitted returned a non-protocol error");
	};
	assert_eq!(error.code, omp_proto::env::v1::ProtocolErrorCode::AlreadyExists as i32);
	time::sleep(Duration::from_millis(200)).await;
	assert_eq!(fs::read(&effect).expect("duplicate committed effect"), b"duplicate");
	assert!(!lease.exists(), "duplicate-commit request leaked its speculative lease");
	let mut reopened = harness
		.client()
		.invoke(v1::InvokeTool {
			invocation_id: "stream-duplicate".into(),
			name: "streaming_probe".into(),
			rev: "test.1".into(),
			..Default::default()
		})
		.await
		.expect("reopen cleaned duplicate invocation");
	assert!(matches!(
		reopened.next_event().await.expect("reopened accepted"),
		Some(InvocationEvent::Accepted(_))
	));
	reopened.guard().cancel();
}

#[tokio::test]
async fn native_cancel_emits_one_bounded_effects_unknown_verdict_and_next_request_succeeds() {
	let scratch = tempfile::tempdir().expect("native cancellation scratch");
	let started = scratch.path().join("started");
	let completed = scratch.path().join("completed");
	let mut registry = Registry::new();
	registry
		.register(BlockingTool::new(started.clone()), Presentation::Slot, test_claims())
		.expect("register blocking native tool");
	registry
		.register(EffectTool::new(completed.clone()), Presentation::Slot, test_claims())
		.expect("register follow-up native tool");
	let harness = Harness::start(registry).await;

	let mut blocked = harness
		.client()
		.invoke(v1::InvokeTool {
			invocation_id: "native-cancel".into(),
			name: "native_block".into(),
			rev: "test.1".into(),
			..Default::default()
		})
		.await
		.expect("open blocking native invocation");
	assert!(matches!(
		blocked.next_event().await.expect("native accepted"),
		Some(InvocationEvent::Accepted(_))
	));
	blocked
		.commit_args(
			Bytes::from_static(b"{}"),
			Bytes::from_static(b"contract-test-token"),
			1000,
			None,
		)
		.await
		.expect("commit blocking native invocation");
	assert!(matches!(
		blocked.next_event().await.expect("native started update"),
		Some(InvocationEvent::Update(_))
	));
	assert!(started.exists(), "native invocation did not enter its committed body");

	blocked.guard().cancel();
	let terminal = time::timeout(Duration::from_secs(2), blocked.next_event())
		.await
		.expect("native structural cancellation exceeded its bound")
		.expect("native cancellation event")
		.expect("native cancellation stream closed");
	let InvocationEvent::Verdict(terminal) = terminal else {
		panic!("native cancellation did not produce a verdict");
	};
	let verdict: CallOutcome<Value, Value> =
		serde_json::from_slice(&terminal.json).expect("decode native cancellation verdict");
	assert!(matches!(verdict, CallOutcome::Aborted { abort: Abort::EffectsUnknown { .. }, .. }));
	assert!(terminal.is_error);
	assert!(!terminal.useless);
	assert!(
		blocked
			.next_event()
			.await
			.expect("closed native cancellation stream")
			.is_none(),
		"native invocation leaked an update or terminal after its verdict",
	);

	let mut next = harness
		.client()
		.invoke(v1::InvokeTool {
			invocation_id: "native-next".into(),
			name: "effect_probe".into(),
			rev: "test.1".into(),
			..Default::default()
		})
		.await
		.expect("open native request after cancellation");
	assert!(matches!(
		next.next_event().await.expect("next native accepted"),
		Some(InvocationEvent::Accepted(_))
	));
	next
		.commit_args(
			Bytes::from_static(b"{}"),
			Bytes::from_static(b"contract-test-token"),
			1000,
			None,
		)
		.await
		.expect("commit next native request");
	assert!(matches!(
		next.next_event().await.expect("next native verdict"),
		Some(InvocationEvent::Verdict(_))
	));
	assert_eq!(fs::read(completed).expect("follow-up native effect"), b"committed");
}

#[tokio::test]
async fn native_interrupt_is_steering_only_and_preserves_cooperative_truth() {
	let mut registry = Registry::new();
	registry
		.register(CooperativeInterruptTool::new(), Presentation::Slot, test_claims())
		.expect("register cooperative interrupt tool");
	let harness = Harness::start(registry).await;
	let mut invocation = harness
		.client()
		.invoke(v1::InvokeTool {
			invocation_id: "native-interrupt".into(),
			name: "cooperative_interrupt".into(),
			rev: "test.1".into(),
			..Default::default()
		})
		.await
		.expect("open cooperative invocation");
	assert!(matches!(
		invocation.next_event().await.expect("cooperative accepted"),
		Some(InvocationEvent::Accepted(_))
	));
	invocation
		.commit_args(
			Bytes::from_static(b"{}"),
			Bytes::from_static(b"contract-test-token"),
			1000,
			None,
		)
		.await
		.expect("commit cooperative invocation");
	assert!(matches!(
		invocation
			.next_event()
			.await
			.expect("cooperative waiting update"),
		Some(InvocationEvent::Update(_))
	));
	invocation
		.interrupt(sf!("steer cooperatively"))
		.await
		.expect("send cooperative interrupt");
	let terminal = time::timeout(Duration::from_secs(1), invocation.next_event())
		.await
		.expect("cooperative interrupt terminal timeout")
		.expect("cooperative interrupt event")
		.expect("cooperative interrupt stream closed");
	let InvocationEvent::Verdict(terminal) = terminal else {
		panic!("cooperative interrupt did not produce a verdict");
	};
	let verdict: CallOutcome<Value, Value> =
		serde_json::from_slice(&terminal.json).expect("decode cooperative interrupt verdict");
	assert!(matches!(
		verdict,
		CallOutcome::Aborted { abort: Abort::Interrupted { reason }, .. }
			if reason == "steer cooperatively"
	));
}

#[tokio::test]
async fn native_deadline_interrupts_then_structurally_reports_effects_unknown() {
	let scratch = tempfile::tempdir().expect("native deadline scratch");
	let started = scratch.path().join("deadline-started");
	let mut registry = Registry::new();
	registry
		.register(BlockingTool::new(started.clone()), Presentation::Slot, test_claims())
		.expect("register deadline native tool");
	let harness = Harness::start(registry).await;
	let mut invocation = harness
		.client()
		.invoke(v1::InvokeTool {
			invocation_id: "native-deadline".into(),
			name: "native_block".into(),
			rev: "test.1".into(),
			deadline_ms: 50,
			..Default::default()
		})
		.await
		.expect("open deadline native invocation");
	assert!(matches!(
		invocation
			.next_event()
			.await
			.expect("deadline native accepted"),
		Some(InvocationEvent::Accepted(_))
	));
	invocation
		.commit_args(
			Bytes::from_static(b"{}"),
			Bytes::from_static(b"contract-test-token"),
			1000,
			None,
		)
		.await
		.expect("commit deadline native invocation");
	assert!(matches!(
		invocation
			.next_event()
			.await
			.expect("deadline native update"),
		Some(InvocationEvent::Update(_))
	));
	let terminal = time::timeout(Duration::from_secs(2), invocation.next_event())
		.await
		.expect("native deadline plus grace exceeded bound")
		.expect("native deadline event")
		.expect("native deadline stream closed");
	let InvocationEvent::Verdict(terminal) = terminal else {
		panic!("native deadline did not produce a verdict");
	};
	let verdict: CallOutcome<Value, Value> =
		serde_json::from_slice(&terminal.json).expect("decode native deadline verdict");
	assert!(matches!(verdict, CallOutcome::Aborted { abort: Abort::EffectsUnknown { .. }, .. }));
	assert!(started.exists(), "native deadline fired before committed execution began");
}

#[cfg(unix)]
#[tokio::test]
async fn python_extension_data_reads_and_writes_live_workspace_only_during_invocation() {
	let scratch = tempfile::tempdir().expect("extension DATA scratch");
	let root = scratch.path().join("workspace");
	let state = scratch.path().join("state");
	let site = scratch.path().join("site");
	fs::create_dir_all(&root).expect("workspace directory");
	fs::create_dir_all(&state).expect("state directory");
	fs::create_dir_all(&site).expect("extension site directory");
	let module = "envd_data_extension";
	let module_path = site.join(format!("{module}.py"));
	fs::write(&module_path, ENV_DATA_EXTENSION).expect("write DATA extension");
	let target = root.join("observed.txt");
	fs::write(&target, b"workspace state before invocation").expect("write workspace fixture");

	let key = HostKey::new("workspace", "trusted", module);
	let manifest =
		test_manifest(&key, module, [ToolDeclarationKey::new("env_data_probe", module, 1)]);
	let mut extension = ExtHostSpec::new(key, manifest);
	extension.python_site = Some(site);
	extension.entry_path = Some(module_path);
	extension.host_executable = Some(PathBuf::from(env!("CARGO_BIN_EXE_omp")));
	extension.data_grants =
		Grants::supported(["env.doc.read", "env.doc.write", "env.fs.read", "env.fs.write"]);
	let environment = ProjectEnvironment::attach(&root, &state, AttachOptions {
		py_eval:            false,
		approval_mode:      None,
		trusted_extensions: vec![extension],
		contributed_values: Vec::new(),
		con:                Arc::new(omp_con::Ctx::new()),
		bridges:            RegistryBridges::default(),
		spawn_idle_timeout: Some(2),
	})
	.await
	.expect("start extension DATA environment");
	environment.client().set_admitter(AllowAdmission);

	let mut invocation = environment
		.client()
		.invoke(v1::InvokeTool {
			invocation_id: "extension-data-contract".into(),
			name: "env_data_probe".into(),
			rev: format!("{module}.1"),
			..Default::default()
		})
		.await
		.expect("open extension DATA invocation");
	assert!(matches!(
		invocation
			.next_event()
			.await
			.expect("extension DATA accepted"),
		Some(InvocationEvent::Accepted(_))
	));
	let effects = Effects {
		documents: Some(DocEffects {
			read:        true,
			write_globs: [sf!("**")].into_iter().collect(),
		}),
		..Effects::default()
	};
	invocation
		.commit_args(
			Bytes::from(
				serde_json::to_vec(&json!({
					"path": Url::from_file_path(&target)
						.expect("workspace file URI")
						.to_string(),
				}))
				.expect("serialize extension DATA arguments"),
			),
			Bytes::from_static(b"extension-data-effect-token"),
			1000,
			Some(omp_proto::policy::v1::EffectEnvelope::from(&effects)),
		)
		.await
		.expect("authorize extension DATA invocation");
	let terminal = time::timeout(Duration::from_secs(10), async {
		loop {
			match invocation
				.next_event()
				.await
				.expect("extension DATA event")
				.expect("extension DATA stream closed")
			{
				InvocationEvent::Verdict(verdict) => break verdict,
				InvocationEvent::Update(_) => {},
				InvocationEvent::Accepted(_) => panic!("extension DATA invocation accepted twice"),
				InvocationEvent::Admission(_) => {
					panic!("unexpected extension DATA admission event")
				},
			}
		}
	})
	.await
	.expect("extension DATA invocation timed out");
	let verdict: CallOutcome<Value, Value> =
		serde_json::from_slice(&terminal.json).expect("decode extension DATA verdict");
	assert_eq!(
		verdict,
		CallOutcome::Ok(json!({
			"declaration_data_denied": true,
			"kind": "regular_file",
		}))
	);
	assert_eq!(
		fs::read_to_string(&target).expect("read workspace result"),
		"updated through extension DATA"
	);
}

#[tokio::test]
async fn worker_cancel_forwards_effects_unknown_once_and_respawn_serves_next_request() {
	let site = tempfile::tempdir().expect("worker extension scratch");
	fs::write(site.path().join("envd_cancel_tools.py"), WORKER_CANCEL_EXTENSION)
		.expect("write worker cancellation extension");
	let mut worker = extension_worker("envd_cancel_tools", Some(site.path().to_owned()));
	worker.interrupt_grace = omp_core::Duration::new(150, omp_core::DurationUnit::Milliseconds);
	let respawn_timeout = worker.spawn_timeout;
	let harness = Harness::start_with_worker(Registry::new(), worker).await;
	let started = site.path().join("worker-started");

	let mut blocked = harness
		.client()
		.invoke(v1::InvokeTool {
			invocation_id: "worker-cancel".into(),
			name: "worker_block".into(),
			rev: "r.1".into(),
			..Default::default()
		})
		.await
		.expect("open blocking worker invocation");
	assert!(matches!(
		blocked.next_event().await.expect("worker accepted"),
		Some(InvocationEvent::Accepted(_))
	));
	blocked
		.commit_args(
			Bytes::from(
				serde_json::to_vec(&json!({
					"started": started.to_string_lossy(),
					"seconds": 30,
				}))
				.expect("serialize worker arguments"),
			),
			Bytes::from_static(b"contract-test-token"),
			1000,
			None,
		)
		.await
		.expect("commit blocking worker invocation");
	time::timeout(Duration::from_secs(3), async {
		while !started.exists() {
			time::sleep(Duration::from_millis(10)).await;
		}
	})
	.await
	.expect("worker invocation did not enter native sleep");

	blocked.guard().cancel();
	let terminal = time::timeout(Duration::from_secs(3), blocked.next_event())
		.await
		.expect("worker cancellation terminal timeout")
		.expect("worker cancellation event")
		.expect("worker cancellation stream closed");
	let InvocationEvent::Verdict(terminal) = terminal else {
		panic!("worker cancellation did not produce a verdict");
	};
	let verdict: CallOutcome<Value, Value> =
		serde_json::from_slice(&terminal.json).expect("decode worker cancellation verdict");
	assert!(matches!(verdict, CallOutcome::Aborted { abort: Abort::EffectsUnknown { .. }, .. }));
	assert!(terminal.is_error);
	assert!(!terminal.useless);
	assert!(
		blocked
			.next_event()
			.await
			.expect("closed worker cancellation stream")
			.is_none(),
		"worker invocation leaked an update or terminal after its verdict",
	);

	let mut next = harness
		.client()
		.invoke(v1::InvokeTool {
			invocation_id: "worker-next".into(),
			name: "worker_echo".into(),
			rev: "r.1".into(),
			..Default::default()
		})
		.await
		.expect("open worker request after cancellation");
	assert!(matches!(
		next.next_event().await.expect("next worker accepted"),
		Some(InvocationEvent::Accepted(_))
	));
	next
		.commit_args(
			Bytes::from_static(br#"{"message":"after cancellation"}"#),
			Bytes::from_static(b"contract-test-token"),
			1000,
			None,
		)
		.await
		.expect("commit next worker request");
	let next_terminal = time::timeout(respawn_timeout, async {
		loop {
			match next
				.next_event()
				.await
				.expect("next worker event")
				.expect("next worker stream closed")
			{
				InvocationEvent::Verdict(verdict) => break verdict,
				InvocationEvent::Update(_) => {},
				InvocationEvent::Accepted(_) => panic!("worker request was accepted twice"),
				InvocationEvent::Admission(_) => panic!("unexpected admission in worker test"),
			}
		}
	})
	.await
	.expect("respawned worker did not serve next request");
	assert_eq!(next_terminal.invocation_id, "worker-next");
	assert!(!next_terminal.is_error);
	assert!(!next_terminal.useless);
	let expected = Bytes::from_static(br#"{"kind":"ok","value":{"message":"after cancellation"}}"#);
	assert_eq!(next_terminal.json, expected);
	let details = next_terminal
		.details_blob
		.as_ref()
		.expect("worker success retains its canonical outcome artifact");
	assert_eq!(details.mime, "application/json");
	assert!(details.inline.is_empty());
	assert_eq!(details.size, u64::try_from(expected.len()).expect("verdict length fits u64"));
	let projection = next_terminal
		.projection
		.as_ref()
		.expect("worker success reports exact projection facts");
	assert_eq!(projection.source_bytes, details.size);
	assert_eq!(projection.inline_bytes, details.size);
	assert!(!projection.omitted);
	assert_eq!(projection.artifact.as_ref(), Some(details));
	let verdict: CallOutcome<Value, Value> =
		serde_json::from_slice(&next_terminal.json).expect("decode worker success verdict");
	assert_eq!(verdict, CallOutcome::Ok(json!({"message": "after cancellation"})));

	let mut fault = harness
		.client()
		.invoke(v1::InvokeTool {
			invocation_id: "worker-fault".into(),
			name: "worker_fail".into(),
			rev: "r.1".into(),
			..Default::default()
		})
		.await
		.expect("open worker fault request");
	assert!(matches!(
		fault.next_event().await.expect("worker fault accepted"),
		Some(InvocationEvent::Accepted(_))
	));
	fault
		.commit_args(
			Bytes::from_static(br#"{"code":409}"#),
			Bytes::from_static(b"contract-test-token"),
			1000,
			None,
		)
		.await
		.expect("commit worker fault request");
	let fault_terminal = time::timeout(respawn_timeout, async {
		loop {
			match fault
				.next_event()
				.await
				.expect("worker fault event")
				.expect("worker fault stream closed")
			{
				InvocationEvent::Verdict(verdict) => break verdict,
				InvocationEvent::Update(_) => {},
				InvocationEvent::Accepted(_) => panic!("worker fault was accepted twice"),
				InvocationEvent::Admission(_) => panic!("unexpected admission in worker fault test"),
			}
		}
	})
	.await
	.expect("worker did not return its structured fault");
	assert!(fault_terminal.is_error);
	assert!(!fault_terminal.useless);
	assert_eq!(
		fault_terminal.json,
		Bytes::from_static(br#"{"kind":"faulted","value":{"code":409}}"#),
	);
	let verdict: CallOutcome<Value, Value> =
		serde_json::from_slice(&fault_terminal.json).expect("decode worker fault verdict");
	assert_eq!(verdict, CallOutcome::Faulted(json!({"code": 409})));
}

#[tokio::test]
async fn same_worker_invocation_id_on_two_connections_cancels_only_its_owner() {
	let site = tempfile::tempdir().expect("worker collision scratch");
	fs::write(site.path().join("envd_cancel_tools.py"), WORKER_CANCEL_EXTENSION)
		.expect("write worker collision extension");
	let mut worker = extension_worker("envd_cancel_tools", Some(site.path().to_owned()));
	worker.interrupt_grace = omp_core::Duration::new(100, omp_core::DurationUnit::Milliseconds);
	let respawn_timeout = worker.spawn_timeout;
	let harness = Harness::start_with_worker(Registry::new(), worker).await;
	let (client_b, client_b_task) = harness.connect("envd-contract-b").await;
	let started_a = site.path().join("worker-a-started");
	let started_b = site.path().join("worker-b-started");

	let mut invocation_a = harness
		.client()
		.invoke(v1::InvokeTool {
			invocation_id: "shared-id".into(),
			name: "worker_block".into(),
			rev: "r.1".into(),
			..Default::default()
		})
		.await
		.expect("open worker A");
	assert!(matches!(
		invocation_a.next_event().await.expect("worker A accepted"),
		Some(InvocationEvent::Accepted(_))
	));
	invocation_a
		.commit_args(
			Bytes::from(
				serde_json::to_vec(&json!({
					"started": started_a.to_string_lossy(),
					"seconds": 30,
				}))
				.expect("serialize worker A arguments"),
			),
			Bytes::from_static(b"contract-test-token"),
			1000,
			None,
		)
		.await
		.expect("commit worker A");
	time::timeout(Duration::from_secs(3), async {
		while !started_a.exists() {
			time::sleep(Duration::from_millis(10)).await;
		}
	})
	.await
	.expect("worker A did not start");

	let mut invocation_b = client_b
		.invoke(v1::InvokeTool {
			invocation_id: "shared-id".into(),
			name: "worker_block".into(),
			rev: "r.1".into(),
			..Default::default()
		})
		.await
		.expect("open worker B with colliding external id");
	assert!(matches!(
		invocation_b.next_event().await.expect("worker B accepted"),
		Some(InvocationEvent::Accepted(_))
	));
	invocation_b
		.commit_args(
			Bytes::from(
				serde_json::to_vec(&json!({
					"started": started_b.to_string_lossy(),
					"seconds": 30,
				}))
				.expect("serialize worker B arguments"),
			),
			Bytes::from_static(b"contract-test-token"),
			1000,
			None,
		)
		.await
		.expect("commit worker B");
	invocation_b.guard().cancel();

	let terminal_b = time::timeout(Duration::from_secs(2), invocation_b.next_event())
		.await
		.expect("worker B queued cancellation timeout")
		.expect("worker B cancellation event")
		.expect("worker B cancellation stream closed");
	let InvocationEvent::Verdict(terminal_b) = terminal_b else {
		panic!("worker B cancellation did not produce a verdict");
	};
	let verdict_b: CallOutcome<Value, Value> =
		serde_json::from_slice(&terminal_b.json).expect("decode worker B cancellation");
	assert!(matches!(verdict_b, CallOutcome::Aborted { abort: Abort::Skipped { .. }, .. }));
	assert!(!started_b.exists(), "cancelled worker B was dispatched");
	assert!(
		tokio::time::timeout(Duration::from_millis(100), invocation_a.next_event())
			.await
			.is_err(),
		"worker B cancellation terminated worker A",
	);

	invocation_a.guard().cancel();
	let terminal_a = time::timeout(Duration::from_secs(3), invocation_a.next_event())
		.await
		.expect("worker A cancellation timeout")
		.expect("worker A cancellation event")
		.expect("worker A cancellation stream closed");
	let InvocationEvent::Verdict(terminal_a) = terminal_a else {
		panic!("worker A cancellation did not produce a verdict");
	};
	let verdict_a: CallOutcome<Value, Value> =
		serde_json::from_slice(&terminal_a.json).expect("decode worker A cancellation");
	assert!(matches!(verdict_a, CallOutcome::Aborted { abort: Abort::EffectsUnknown { .. }, .. }));

	let mut next = client_b
		.invoke(v1::InvokeTool {
			invocation_id: "shared-id".into(),
			name: "worker_echo".into(),
			rev: "r.1".into(),
			..Default::default()
		})
		.await
		.expect("reuse external id after worker B terminal");
	assert!(matches!(
		next.next_event().await.expect("follow-up worker accepted"),
		Some(InvocationEvent::Accepted(_))
	));
	next
		.commit_args(
			Bytes::from_static(br#"{"message":"still isolated"}"#),
			Bytes::from_static(b"contract-test-token"),
			1000,
			None,
		)
		.await
		.expect("commit follow-up worker");
	assert!(matches!(
		tokio::time::timeout(respawn_timeout, next.next_event())
			.await
			.expect("follow-up worker timeout")
			.expect("follow-up worker event"),
		Some(InvocationEvent::Verdict(_))
	));
	client_b_task.abort();
}

#[tokio::test]
async fn cancelled_exec_preserves_session_cwd_and_kills_term_ignoring_tree() {
	let harness = Harness::start(Registry::new()).await;
	let client = harness.client();
	let opened = client
		.open_session(
			&omp_core::EnvPath::new(cwd_uri(harness.root.path())).expect("typed cwd"),
			OpenSessionRequest::default(),
		)
		.await
		.expect("open session");
	let child_pid = harness.root.path().join("child.pid");
	let grandchild_pid = harness.root.path().join("grandchild.pid");
	let script = format!(
		"cd sub 2>/dev/null || mkdir sub && cd sub; sh -c 'trap \"\" TERM; (trap \"\" TERM; sleep \
		 30) & echo $! > {}; echo $$ > {}; wait'",
		grandchild_pid.display(),
		child_pid.display()
	);
	let mut run = client
		.exec(exec_request(&opened.session, script))
		.await
		.expect("start cancellable run");
	assert!(matches!(run.next_event().await.expect("started"), Some(ExecEvent::Started(_))));
	for _ in 0..100 {
		if child_pid.exists() && grandchild_pid.exists() {
			break;
		}
		time::sleep(Duration::from_millis(10)).await;
	}
	assert!(child_pid.exists() && grandchild_pid.exists(), "child tree did not start");
	drop(run);
	for pid_file in [&child_pid, &grandchild_pid] {
		// The shell creates the file before the redirected write lands; poll for
		// a parseable pid instead of racing the first byte.
		let mut parsed = None;
		for _ in 0..100 {
			if let Ok(pid) = fs::read_to_string(pid_file)
				.expect("pid file")
				.trim()
				.parse::<i32>()
			{
				parsed = Some(pid);
				break;
			}
			time::sleep(Duration::from_millis(10)).await;
		}
		let pid: i32 = parsed.expect("pid");
		let mut dead = false;
		for _ in 0..100 {
			// SAFETY: `pid` is a parsed child process identifier; `kill` only reads it.
			if unsafe { libc::kill(pid, 0) } == -1 {
				dead = true;
				break;
			}
			time::sleep(Duration::from_millis(25)).await;
		}
		assert!(dead, "cancelled process {pid} is still alive");
	}
	let mut pwd = client
		.exec(exec_request(&opened.session, "pwd"))
		.await
		.expect("session survived");
	let (output, status) = collect_exec(&mut pwd).await;
	assert_eq!(status.outcome, ExecOutcome::Exited as i32);
	assert!(
		String::from_utf8_lossy(&output).contains("/sub"),
		"cwd did not persist: {}",
		String::from_utf8_lossy(&output)
	);
}

#[tokio::test]
async fn blob_and_named_process_frames_route_through_one_host() {
	let harness = Harness::start(Registry::new()).await;
	let client = harness.client();
	let payload = Bytes::from_static(b"host-routed-blob");
	let upload = client.blob_put().expect("begin blob upload");
	upload
		.send_chunk(Chunk { data: payload.clone(), ..Default::default() })
		.await
		.expect("blob chunk");
	let stored = upload.commit().await.expect("commit blob");
	let mut download = client
		.blob_get(GetRequest { hash: stored.hash.clone(), ..Default::default() })
		.await
		.expect("get blob");
	let mut received = Vec::new();
	while let BlobDownloadEvent::Chunk(chunk) = download
		.next_event()
		.await
		.expect("blob event")
		.expect("blob event present")
	{
		received.extend_from_slice(&chunk.data);
	}
	assert_eq!(received, payload);

	client
		.start_process(
			&omp_core::EnvPath::new(cwd_uri(harness.root.path())).expect("typed cwd"),
			StartProcess {
				name: "contract-process".into(),
				spec: Some(ProcessSpec {
					source: Some(Script { text: "echo ready; sleep 30".into(), ..Default::default() }),
					..Default::default()
				}),
				..Default::default()
			},
		)
		.await
		.expect("start named process");
	let listed = client
		.list_processes(ListProcesses::default())
		.await
		.expect("list processes");
	assert_eq!(
		listed
			.processes
			.iter()
			.map(|p| p.name.as_str())
			.collect::<Vec<_>>(),
		["contract-process"]
	);
	let mut attachment = client
		.attach_output(v1::AttachOutput {
			name: "contract-process".into(),
			generation: 1,
			..Default::default()
		})
		.await
		.expect("attach output");
	assert!(matches!(
		attachment.next_event().await.expect("attached"),
		Some(ProcessAttachmentEvent::Attached(_))
	));
	client
		.stop_process(StopProcess {
			name: "contract-process".into(),
			grace_ms: 50,
			generation: 1,
			..Default::default()
		})
		.await
		.expect("stop process");
	loop {
		let event = time::timeout(Duration::from_secs(10), attachment.next_event())
			.await
			.expect("named process stop timeout")
			.expect("process state");
		if let Some(ProcessAttachmentEvent::State(state)) = event
			&& state
				.process
				.as_ref()
				.and_then(|p| p.status.as_ref())
				.is_some()
		{
			break;
		}
	}
	let mut exited_attachment = client
		.attach_output(v1::AttachOutput {
			name: "contract-process".into(),
			generation: 1,
			..Default::default()
		})
		.await
		.expect("attach already-terminal process");
	assert!(matches!(
		exited_attachment.next_event().await.expect("attached"),
		Some(ProcessAttachmentEvent::Attached(_))
	));
	loop {
		let event = time::timeout(Duration::from_secs(2), exited_attachment.next_event())
			.await
			.expect("already-terminal attachment state timeout")
			.expect("already-terminal process state");
		if let Some(ProcessAttachmentEvent::State(state)) = event
			&& state
				.process
				.as_ref()
				.and_then(|process| process.status.as_ref())
				.is_some()
		{
			break;
		}
	}
}

#[tokio::test]
async fn named_process_attach_has_no_gap_between_backlog_and_future_output() {
	let harness = Harness::start(Registry::new()).await;
	let client = harness.client();
	client
		.start_process(
			&omp_core::EnvPath::new(cwd_uri(harness.root.path())).expect("typed cwd"),
			StartProcess {
				name: "attach-race".into(),
				spec: Some(ProcessSpec {
					source: Some(Script {
						text: "i=0; while [ $i -lt 50 ]; do echo output; sleep 0.01; i=$((i + 1)); done"
							.into(),
						..Default::default()
					}),
					..Default::default()
				}),
				..Default::default()
			},
		)
		.await
		.expect("start racing named process");
	let mut attachment = client
		.attach_output(v1::AttachOutput {
			name: "attach-race".into(),
			generation: 1,
			..Default::default()
		})
		.await
		.expect("attach while output is active");
	assert!(matches!(
		attachment.next_event().await.expect("attached"),
		Some(ProcessAttachmentEvent::Attached(_))
	));

	let mut sequences = Vec::new();
	loop {
		let event = time::timeout(Duration::from_secs(10), attachment.next_event())
			.await
			.expect("attach race timeout")
			.expect("attachment event")
			.expect("attachment remains open");
		match event {
			ProcessAttachmentEvent::Output(output) => {
				sequences.push((output.log_offset, output.sequence));
			},
			ProcessAttachmentEvent::State(state)
				if state
					.process
					.as_ref()
					.and_then(|process| process.status.as_ref())
					.is_some() =>
			{
				break;
			},
			_ => {},
		}
	}
	assert!(!sequences.is_empty());
	assert!(
		sequences.windows(2).all(|pair| pair[1].0 == pair[0].1),
		"attachment must not lose output at the snapshot/subscription boundary"
	);
}

#[tokio::test]
async fn timeout_cancel_and_workspace_cancel_have_distinct_truth() {
	let root = tempfile::tempdir().expect("workspace");
	fs::write(root.path().join("data"), b"needle").expect("workspace file");
	let workspace = WorkspaceHost::open(root.path()).expect("workspace host");
	let cancelled = CancellationToken::new();
	cancelled.cancel();
	assert!(matches!(
		workspace.search(&workspace.request(), &WorkspaceSearchOptions::new("needle"), &cancelled,),
		Err(WorkspaceError::Cancelled)
	));

	let exec = ExecHost::new();
	let opened = exec
		.open_session(OpenSessionRequest { cwd_uri: cwd_uri(root.path()), ..Default::default() })
		.await
		.expect("session");
	let (_, timed) = exec
		.exec(
			exec_request(&opened.session, "trap '' TERM; sleep 30"),
			Some(Duration::from_millis(50)),
		)
		.await
		.expect("timed run");
	let timeout_status = loop {
		if let Some(HostExecEvent::Exit(exit)) = timed.next_event().await {
			break exit.status.expect("timeout status");
		}
	};
	assert_eq!(timeout_status.outcome, ExecOutcome::Timeout as i32);

	let (_, cancelled) = exec
		.exec(exec_request(&opened.session, "trap '' TERM; sleep 30"), None)
		.await
		.expect("cancelled run");
	cancelled.cancel();
	let cancelled_status = loop {
		if let Some(HostExecEvent::Exit(exit)) = cancelled.next_event().await {
			break exit.status.expect("cancel status");
		}
	};
	assert_eq!(cancelled_status.outcome, ExecOutcome::Cancelled as i32);
	assert_ne!(timeout_status.outcome, cancelled_status.outcome);
}

#[tokio::test]
async fn queued_session_cancel_never_enters_execution() {
	let root = tempfile::tempdir().expect("workspace");
	let exec = ExecHost::new();
	let opened = exec
		.open_session(OpenSessionRequest { cwd_uri: cwd_uri(root.path()), ..Default::default() })
		.await
		.expect("session");
	let (_, active) = exec
		.exec(exec_request(&opened.session, "trap '' TERM; sleep 30"), None)
		.await
		.expect("active run");
	assert!(matches!(
		tokio::time::timeout(Duration::from_secs(5), active.next_event())
			.await
			.expect("active start timeout"),
		Some(HostExecEvent::Started { .. })
	));

	let (_, queued) = exec
		.exec(exec_request(&opened.session, "touch queued-marker"), None)
		.await
		.expect("queued run");
	queued.cancel();
	active.cancel();
	time::timeout(Duration::from_secs(5), async {
		while !matches!(active.next_event().await, Some(HostExecEvent::Exit(_))) {}
	})
	.await
	.expect("active cancellation timeout");

	let event = time::timeout(Duration::from_secs(5), queued.next_event())
		.await
		.expect("queued cancellation timeout")
		.expect("queued terminal event");
	let HostExecEvent::Exit(exit) = event else {
		panic!("queued command entered execution before cancellation: {event:?}")
	};
	assert_eq!(exit.status.expect("queued cancel status").outcome, ExecOutcome::Cancelled as i32);
	assert!(!root.path().join("queued-marker").exists());
}

#[tokio::test]
async fn active_cancel_allows_queued_cancel_to_propagate_before_execution() {
	let root = tempfile::tempdir().expect("workspace");
	let exec = ExecHost::new();
	let opened = exec
		.open_session(OpenSessionRequest { cwd_uri: cwd_uri(root.path()), ..Default::default() })
		.await
		.expect("session");
	let (_, active) = exec
		.exec(exec_request(&opened.session, "trap '' TERM; sleep 30"), None)
		.await
		.expect("active run");
	assert!(matches!(
		tokio::time::timeout(Duration::from_secs(5), active.next_event())
			.await
			.expect("active start timeout"),
		Some(HostExecEvent::Started { .. })
	));

	active.cancel();
	time::timeout(Duration::from_secs(5), async {
		while !matches!(active.next_event().await, Some(HostExecEvent::Exit(_))) {}
	})
	.await
	.expect("active cancellation timeout");
	let (_, queued) = exec
		.exec(exec_request(&opened.session, "touch queued-race-marker"), None)
		.await
		.expect("queued run");

	assert!(
		tokio::time::timeout(Duration::from_millis(50), queued.next_event())
			.await
			.is_err(),
		"queued command started before its batch cancellation could propagate"
	);
	queued.cancel();
	let event = time::timeout(Duration::from_secs(5), queued.next_event())
		.await
		.expect("queued cancellation timeout")
		.expect("queued terminal event");
	let HostExecEvent::Exit(exit) = event else {
		panic!("queued command entered execution before cancellation: {event:?}")
	};
	assert_eq!(exit.status.expect("queued cancel status").outcome, ExecOutcome::Cancelled as i32);
	assert!(!root.path().join("queued-race-marker").exists());
}

#[tokio::test]
async fn uds_retire_unlinks_listener_and_drains_existing_clients() {
	use std::os::unix::fs::PermissionsExt as _;
	let harness = Harness::start(Registry::new()).await;
	let socket = harness.state.path().join("env-retire.sock");
	let shutdown = CancellationToken::new();
	let server = Arc::clone(&harness.server);
	let serve_shutdown = shutdown.clone();
	let socket_for_server = socket.clone();
	let mut server_task = tokio::spawn(async move {
		server
			.serve_uds(&socket_for_server, serve_shutdown, None)
			.await
	});
	time::timeout(Duration::from_secs(2), async {
		loop {
			if socket.exists()
				&& fs::metadata(&socket)
					.expect("socket metadata")
					.permissions()
					.mode() & 0o077
					== 0
			{
				break;
			}
			task::yield_now().await;
		}
	})
	.await
	.expect("UDS environment socket did not become ready");

	let (retiring, retiring_bridge) = EnvServer::connect_owner_uds(&socket)
		.await
		.expect("connect retiring client");
	let retiring_hello = retiring
		.hello(ClientHello {
			client: "envd-retiring".into(),
			schema_rev: SCHEMA_REV,
			..ClientHello::default()
		})
		.await
		.expect("retiring client hello");
	let (remaining, remaining_bridge) = EnvServer::connect_owner_uds(&socket)
		.await
		.expect("connect remaining client");
	let remaining_hello = remaining
		.hello(ClientHello {
			client: "envd-remaining".into(),
			schema_rev: SCHEMA_REV,
			..ClientHello::default()
		})
		.await
		.expect("remaining client hello");
	assert_ne!(retiring_hello.server_build, "");
	assert_eq!(retiring_hello.server_build, remaining_hello.server_build);

	retiring.retire().await.expect("retire acknowledgement");
	time::timeout(Duration::from_secs(2), async {
		loop {
			match UnixStream::connect(&socket).await {
				Err(error)
					if matches!(
						error.kind(),
						io::ErrorKind::NotFound | io::ErrorKind::ConnectionRefused
					) =>
				{
					break;
				},
				_ => task::yield_now().await,
			}
		}
	})
	.await
	.expect("retired UDS listener remained reachable");
	remaining
		.list_processes(ListProcesses::default())
		.await
		.expect("existing client request after retire");

	drop(retiring);
	retiring_bridge.abort();
	assert!(
		tokio::time::timeout(Duration::from_millis(50), &mut server_task)
			.await
			.is_err(),
		"server exited while an existing client remained connected"
	);
	drop(remaining);
	remaining_bridge.abort();
	time::timeout(Duration::from_secs(2), server_task)
		.await
		.expect("retired server did not finish draining")
		.expect("retired server task panicked")
		.expect("retired server failed");
}

#[tokio::test]
async fn in_process_retire_is_rejected_as_unsupported() {
	let harness = Harness::start(Registry::new()).await;
	let error = harness
		.client()
		.retire()
		.await
		.expect_err("in-process retire succeeded");
	let omp_env::ClientError::Protocol(error) = error else {
		panic!("in-process retire did not return a protocol error");
	};
	assert_eq!(error.code, omp_proto::env::v1::ProtocolErrorCode::Unsupported as i32);
	assert_eq!(error.message, "retire is not available on this transport");
}
#[cfg(unix)]
#[tokio::test]
async fn owner_client_lsp_status_reports_discovered_workspace_roster() {
	use std::os::unix::fs::PermissionsExt as _;
	let scratch = TempDir::new().expect("scratch");
	let root = scratch.path().join("workspace");
	let state = scratch.path().join("state");
	fs::create_dir_all(&root).expect("workspace directory");
	fs::create_dir_all(&state).expect("state directory");
	let server = root.join("fake-lsp.sh");
	fs::write(&server, "#!/bin/sh\nexit 0\n").expect("fake server");
	fs::set_permissions(&server, fs::Permissions::from_mode(0o700)).expect("chmod fake server");
	fs::write(root.join("foo.marker"), b"").expect("marker");
	fs::write(
		root.join(".lsp.json"),
		serde_json::to_vec(&json!({
			"servers": {
				"fake": {
					"command": server,
					"args": [],
					"fileTypes": [".foo"],
					"rootMarkers": ["foo.marker"],
				}
			}
		}))
		.expect("encode config"),
	)
	.expect("write config");

	let environment = ProjectEnvironment::attach(&root, &state, AttachOptions {
		py_eval:            false,
		approval_mode:      None,
		trusted_extensions: Vec::new(),
		contributed_values: Vec::new(),
		con:                Arc::new(omp_con::Ctx::new()),
		bridges:            RegistryBridges::default(),
		spawn_idle_timeout: Some(2),
	})
	.await
	.expect("start project environment");

	let response = environment
		.client()
		.lsp_status(false)
		.await
		.expect("owner client lsp status");
	let fake = response
		.servers
		.iter()
		.find(|server| server.name == "fake")
		.expect("discovered declaration in owner roster");
	assert_eq!(fake.stage, omp_proto::document::v1::LspServerStage::Available as i32);
}
