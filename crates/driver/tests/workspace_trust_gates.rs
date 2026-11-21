//! The workspace trust gates on the production composition path: a real
//! `compose_kernel` over a project daemon served in this process and a
//! scripted inference gateway, with the trust decision evaluated against a
//! grant file in a scratch data directory, as a launch evaluates it.
//!
//! An untrusted workspace's native extensions and `.omp/SYSTEM.md` are
//! withheld, its `AGENTS.md` still loads, the session journals the decision
//! once, and the operator is told once what was withheld. A grant bound to the
//! inputs' digest admits them; editing a gated input afterwards withholds them
//! again (`digest_changed`).

mod support;

use std::{
	env, fs,
	path::{Path, PathBuf},
	sync::Arc,
};

use flume::Receiver;
use omp_agent::{Kernel, RunControl, TurnInput};
use omp_ai::{
	BlockKind, ChatEvent, Completion, ExecutionReceipt, FinishReason, Registry, ToolCall,
	ToolCallId, Usage,
	event::WorkflowResponse,
	layer::{LayerCall, stack::RouteProviderService},
	provider::fake::{FakeProvider, FakeScript},
	receipt::ReasonId,
	registry::RouteUnavailable,
	session::ConversationSessionPlanner,
};
use omp_catalog::{
	ManagementCapabilities, OperationBits, OperationKind,
	snapshot::{Catalog, SnapshotProvenance},
};
use omp_core::{Str, sf};
use omp_driver::{
	headless::kernel::{ComposedInference, KernelOptions, PromptOverrides, compose_kernel},
	prompt_input::resolve_system_inputs,
	workspace_trust::{
		WITHHELD_NOTICE, WithheldInputs, WorkspaceTrustSource, evaluate_workspace, journaled_decision,
	},
};
use omp_envd::exec_settings::{ExecSandboxMode, SV_SANDBOX_MODE};
use omp_ext::{
	trust::{GrantDuration, GrantsFile, grants_path},
	workspace_trust::{
		CanonicalHome, TrustChannel, TrustDecision, TrustDecisionKind, WorkspaceTrust,
		WorkspaceTrustGrant,
		inventory::{InventoryBudget, inventory},
	},
};
use omp_proto::inference::v1::inference_server::InferenceServer;
use omp_serve::inference::InferenceRpc;
use omp_session::Session;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use tonic::transport::{Channel, Server};

/// The project's own system prompt; it reaches the session only when trusted.
const PROJECT_SYSTEM: &str = "Project system prompt from .omp/SYSTEM.md";
/// The project's `AGENTS.md`; it loads whatever the trust.
const PROJECT_AGENTS: &str = "Project context from AGENTS.md";
/// The skill the workspace extension's manifest seals.
const EXTENSION_SKILL: &str = "trusted-review";

/// One hermetic workspace: an operator home, data directory, and project
/// holding a native extension, a system prompt, and an `AGENTS.md`.
struct Workspace {
	_scratch: tempfile::TempDir,
	home:     PathBuf,
	data:     PathBuf,
	project:  PathBuf,
	session:  PathBuf,
	con:      Arc<omp_con::Ctx>,
}

impl Workspace {
	fn new() -> Self {
		let scratch = tempfile::tempdir().expect("scratch");
		let root = fs::canonicalize(scratch.path()).expect("canonical scratch");
		let home = root.join("home");
		let data = root.join("data");
		let project = root.join("project");
		fs::create_dir_all(&home).expect("home");
		fs::create_dir_all(&data).expect("data");
		fs::create_dir_all(&project).expect("project");
		// SAFETY: nextest runs each test in its own process, and nothing else in
		// this one reads the environment concurrently.
		unsafe {
			env::set_var("HOME", &home);
			env::set_var("OMP_CONFIG_DIR", home.join(omp_core::dirs::CONFIG_DIR_NAME));
			env::set_var("OMP_DATA_DIR", &data);
			env::set_var("OMP_STATE_DIR", root.join("state"));
			env::set_var("OMP_CACHE_DIR", root.join("cache"));
			for name in ["OMP_PROFILE", "PI_PROFILE", "OMP_CONFIG_FILES"] {
				env::remove_var(name);
			}
		}
		write(&project.join("AGENTS.md"), PROJECT_AGENTS);
		write(&project.join(".omp/SYSTEM.md"), PROJECT_SYSTEM);
		let extension = project.join(".omp/extensions/review");
		write(&extension.join("src/demo/__init__.py"), "# inert test extension\n");
		write(
			&extension.join("src/demo/.omp-generated/skills/review/SKILL.md"),
			&format!(
				"---\nname: {EXTENSION_SKILL}\ndescription: Review changes\n---\n\nReview the \
				 change.\n"
			),
		);
		write(
			&extension.join("omp.toml"),
			r#"id = "test.trusted"
entry = "demo"

[[declarations]]
kind = "skills"
path = "demo/.omp-generated/skills/review/SKILL.md"
"#,
		);
		let con = omp_con::Ctx::new();
		SV_SANDBOX_MODE
			.set(&con, ExecSandboxMode::Off)
			.expect("sandbox off");
		let session = root.join("sessions/trust.oms");
		Self { _scratch: scratch, home, data, project, session, con: Arc::new(con) }
	}

	/// Records the operator's trust in the workspace's current inputs, the way
	/// an operator answers an untrusted workspace.
	fn grant(&self) {
		let digest = *inventory(&self.project, &self.data, &InventoryBudget::default())
			.expect("inventory")
			.digest();
		let grant = WorkspaceTrustGrant::exact(
			&self.project,
			digest,
			TrustChannel::Cli,
			GrantDuration::Persistent,
		)
		.expect("grant");
		GrantsFile::persist_workspace_trust(
			&grants_path(&self.data),
			grant,
			&TrustDecision::Untrusted,
			&CanonicalHome::resolve(Some(&self.home)),
		)
		.expect("grant file")
		.expect("the answer is current");
	}

	/// Composes the launch kernel as a launch does: the decision evaluated
	/// once, the prompt slots resolved under it, and both handed to
	/// composition.
	async fn compose(&self, gateway: &Gateway) -> (Kernel<ComposedInference>, Session) {
		self.compose_with_tools(gateway, false).await
	}

	async fn compose_with_tools(
		&self,
		gateway: &Gateway,
		tools_enabled: bool,
	) -> (Kernel<ComposedInference>, Session) {
		let decision = evaluate_workspace(&self.data, &self.project);
		let (custom_prompt, append_prompt) =
			resolve_system_inputs(&self.project, &self.home, None, None, decision.trust())
				.expect("prompt inputs");
		let options = KernelOptions {
			session: Some(self.session.clone()),
			sessions_dir: self.session.parent().map(Path::to_path_buf),
			no_tools: !tools_enabled,
			tools: tools_enabled.then(|| vec![Str::new_static("remote_build")]),
			gateway: Some(gateway.channel.clone()),
			prompt: PromptOverrides { custom_prompt, append_prompt, ..PromptOverrides::default() },
			workspace_trust: WorkspaceTrustSource::Fixed(decision),
			..KernelOptions::default()
		};
		let (kernel, session, _) = Box::pin(compose_kernel(
			&self.data,
			&self.project,
			gateway.model.as_str(),
			Arc::clone(&self.con),
			options,
		))
		.await
		.expect("composition");
		(kernel, session)
	}

	/// The project daemon of this workspace for a session of `trust`, served
	/// in this process.
	async fn daemon(&self, trust: WorkspaceTrust) -> support::InProcessDaemon {
		let state = omp_env::project_state::directory(&self.data, &self.project).expect("state");
		fs::create_dir_all(&state).expect("state directory");
		support::InProcessDaemon::serve(&self.project, &state, Arc::clone(&self.con), trust).await
	}

	/// Waits until this workspace's document authority stops answering.
	async fn released_document_authority(&self) {
		let state = omp_env::project_state::directory(&self.data, &self.project).expect("state");
		support::released_document_authority(&state).await;
	}
}

fn write(path: &Path, contents: &str) {
	fs::create_dir_all(path.parent().expect("parent")).expect("parent dir");
	fs::write(path, contents).expect("write");
}

/// An inference gateway served in this process whose one chat route answers
/// from `fake`'s scripts.
struct Gateway {
	channel:    Channel,
	model:      Str,
	fake:       FakeProvider,
	_responses: Receiver<WorkflowResponse>,
	_serving:   JoinHandle<()>,
}

impl Gateway {
	async fn start(scratch: &Path) -> Self {
		Self::start_with_registry(scratch, Arc::new(omp_tool::Registry::new())).await
	}

	async fn start_with_registry(scratch: &Path, tools: Arc<omp_tool::Registry>) -> Self {
		Self::start_with_tool_support(scratch, tools, false).await
	}

	async fn start_with_tools(scratch: &Path) -> Self {
		let mut registry = omp_tool::Registry::new();
		for spec in [
			omp_tools::read::spec(omp_tools::read::ReadPolicy::default()),
			omp_tools::grep::spec(omp_tools::grep::SearchPolicy::default()),
			omp_tools::glob::spec(omp_tools::grep::SearchPolicy::default()),
		] {
			registry
				.declare_remote(
					spec,
					omp_tool::Presentation::Slot,
					omp_tool::Claims {
						precedence: omp_tool::Precedence::CORE,
						claimant:   omp_core::Str::new_static("omp/core"),
						replaces:   None,
					},
					omp_tool::ExecutionMode::Parallel,
				)
				.expect("declare consult tool for gateway projection");
		}
		Self::start_with_tool_support(scratch, Arc::new(registry), true).await
	}

	async fn start_with_tool_support(
		scratch: &Path,
		tools: Arc<omp_tool::Registry>,
		require_tools: bool,
	) -> Self {
		let mut compiled = Catalog::embedded().compiled().clone();
		for provider in &mut compiled.providers {
			provider.management = ManagementCapabilities {
				operations:        OperationBits::empty(),
				multiple_accounts: false,
				refresh:           false,
				principal_quota:   false,
			};
		}
		let artifacts = Catalog::encode(compiled, SnapshotProvenance { source_digest: [0; 32] })
			.expect("catalog snapshot");
		let catalog = Arc::new(Catalog::decode(&artifacts.postcard).expect("catalog decode"));
		let model = catalog
			.models()
			.iter()
			.find(|model| {
				model.routes.len() == 1
					&& model
						.capabilities
						.operations
						.contains_kind(OperationKind::Chat)
					&& (!require_tools
						|| model.capabilities.chat.as_ref().is_some_and(|chat| {
							chat
								.tools
								.constraints()
								.is_some_and(|tools| tools.maximum_tools.is_none_or(|maximum| maximum >= 3))
						}))
			})
			.expect("chat model");
		let route_id = model.routes.first().expect("chat route").clone();
		let model_key = Str::new(model.key.as_str());
		let route = catalog.route(&route_id).expect("route");
		let fake = FakeProvider::new(route.provider.clone(), route_id.clone());
		let service = {
			let fake = fake.clone();
			RouteProviderService::new(tower::service_fn(move |call: LayerCall<omp_ai::Call>| {
				tower::ServiceExt::oneshot(fake.clone(), call.payload)
			}))
		};
		let mut builder = Registry::builder(Arc::clone(&catalog));
		for candidate in catalog.routes() {
			builder = if candidate.id == route_id {
				builder.register_route(candidate.id.clone(), service.clone())
			} else {
				builder.register_unavailable(RouteUnavailable::new(
					candidate.id.clone(),
					ReasonId(sf!("trust-gates-scripted-route-only")),
					None,
				))
			}
			.expect("route registers");
		}
		let sessions = ConversationSessionPlanner::open(
			scratch.join("gateway-sessions.db"),
			Arc::clone(&catalog),
		)
		.expect("conversation store");
		let (responses, incoming) = flume::bounded(32);
		let rpc =
			InferenceRpc::new_for_test(builder.build().expect("registry"), sessions, tools, responses);
		let socket = scratch.join("gateway.sock");
		let listener = omp_rpc::uds::listen(&socket).await.expect("gateway socket");
		let serving = tokio::spawn(async move {
			let _ = Server::builder()
				.add_service(InferenceServer::new(rpc))
				.serve_with_incoming(listener)
				.await;
		});
		let channel = omp_rpc::uds::connect(&socket)
			.await
			.expect("gateway channel");
		Self { channel, model: model_key, fake, _responses: incoming, _serving: serving }
	}

	/// Scripts one plain text answer.
	fn answer(&self, text: &'static str) {
		self.fake.push(FakeScript::chat(vec![
			Ok(ChatEvent::BlockStarted { index: 0, kind: BlockKind::Text }),
			Ok(ChatEvent::TextDelta { index: 0, text: Str::new_static(text) }),
			Ok(ChatEvent::Completed(Completion {
				reason:  FinishReason::Stop,
				blocks:  1,
				usage:   Usage::default(),
				receipt: ExecutionReceipt::default().into(),
			})),
		]));
	}
}

/// Runs one scripted turn, which journals what the kernel was told.
async fn turn(gateway: &Gateway, kernel: &mut Kernel<ComposedInference>, session: &mut Session) {
	gateway.answer("Done.");
	kernel
		.run_turn(
			session,
			TurnInput { text: Str::new_static("hello"), attachments: Vec::new() },
			RunControl::new(CancellationToken::new(), None),
		)
		.await
		.expect("turn");
}

/// The typed payload of every withheld-inputs notice the session journaled.
fn withheld_notices(session: &Session) -> Vec<WithheldInputs> {
	let dom = session.dom();
	dom.select("body turn notice")
		.expect("selector")
		.filter_map(|handle| dom.get(handle))
		.filter(|node| {
			node
				.prop(&omp_dom::PropKey::Custom(Str::new_static("name")))
				.and_then(omp_dom::Value::as_str)
				== Some(WITHHELD_NOTICE)
		})
		.map(|node| match node.prop(&omp_dom::PropId::Data.into()) {
			Some(omp_dom::Value::Json(data)) => serde_json::from_str(data.get()).expect("payload"),
			_ => panic!("the notice carries its typed payload"),
		})
		.collect()
}

/// How many times the session journaled a trust decision.
fn decisions_journaled(session: &Session) -> usize {
	session
		.entries()
		.filter(|entry| entry.label.as_deref() == Some("session.workspace-trust"))
		.count()
}

/// The prompt facts composition journaled on the session's `<meta>`.
fn prompt_facts(session: &Session) -> serde_json::Value {
	let dom = session.dom();
	match dom
		.get(dom.meta())
		.and_then(|meta| meta.prop(&omp_dom::PropKey::Custom(Str::new_static("prompt-facts"))))
	{
		Some(omp_dom::Value::Json(raw)) => serde_json::from_str(raw.get()).expect("prompt facts"),
		_ => panic!("composition journals prompt facts"),
	}
}

/// Whether the workspace extension's sealed skill reached the session: it
/// does only when the extension was admitted.
fn extension_admitted(session: &Session) -> bool {
	prompt_facts(session)["skills"]
		.as_array()
		.expect("skills")
		.iter()
		.any(|skill| skill["name"] == EXTENSION_SKILL)
}

/// Whether the project `AGENTS.md` reached the session.
fn agents_loaded(session: &Session) -> bool {
	prompt_facts(session)["context_files"]
		.as_array()
		.expect("context files")
		.iter()
		.any(|file| file["content"] == PROJECT_AGENTS)
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn production_composition_routes_remote_build_to_the_session_tool() {
	let workspace = Workspace::new();
	omp_driver::remote_build::SV_EXEC_AGENT_RUNS
		.set(&workspace.con, true)
		.expect("enable remote builds");
	let registry = omp_driver::remote_build::enabled(&workspace.con)
		.expect("remote builds enabled")
		.declare(&omp_tool::Registry::new())
		.expect("remote build declaration");
	let gateway =
		Gateway::start_with_registry(workspace.home.parent().expect("scratch"), Arc::new(registry))
			.await;
	let _daemon = workspace.daemon(WorkspaceTrust::Untrusted).await;
	let (mut kernel, mut session) = workspace.compose_with_tools(&gateway, true).await;
	assert!(kernel.tool_registry().live_spec("remote_build").is_ok());

	let args = serde_json::json!({ "recipe": "test-pkg", "i": "Test" });
	let call = ToolCall {
		id:        ToolCallId::from("remote-build-call"),
		name:      Str::new_static("remote_build"),
		arguments: omp_ai::OpaqueJson::new(args.clone()),
	};
	gateway.fake.push(FakeScript::chat(vec![
		Ok(ChatEvent::ToolCallStarted { index: 0, id: call.id.clone(), name: call.name.clone() }),
		Ok(ChatEvent::ToolArgumentsDelta {
			index: 0,
			bytes: bytes::Bytes::from(serde_json::to_vec(&args).expect("arguments")),
		}),
		Ok(ChatEvent::ToolCallReady { index: 0, call }),
		Ok(ChatEvent::Completed(Completion {
			reason:  FinishReason::ToolCalls,
			blocks:  1,
			usage:   Usage::default(),
			receipt: ExecutionReceipt::default().into(),
		})),
	]));
	gateway.answer("Done.");
	kernel
		.run_turn(
			&mut session,
			TurnInput { text: Str::new_static("run the build"), attachments: Vec::new() },
			RunControl::new(CancellationToken::new(), None),
		)
		.await
		.expect("turn");
	assert!(
		session.entries().any(|entry| {
			serde_json::from_str::<serde_json::Value>(entry.data.as_str()).is_ok_and(|value| {
				value["fault"]["kind"] == "faulted"
					&& value["fault"]["value"]["kind"] == "invalid_arity"
			})
		}),
		"the production session tool must validate the request"
	);
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn an_untrusted_workspace_withholds_its_inputs_and_says_so_once() {
	let workspace = Workspace::new();
	let gateway = Gateway::start(workspace.home.parent().expect("scratch")).await;
	let _daemon = workspace.daemon(WorkspaceTrust::Untrusted).await;

	let (mut kernel, mut session) = workspace.compose(&gateway).await;
	assert_eq!(journaled_decision(&session), Some(TrustDecision::Untrusted));
	assert!(!extension_admitted(&session), "the workspace extension is withheld");
	assert!(
		prompt_facts(&session).get("custom_prompt").is_none(),
		"the project SYSTEM.md is withheld: {}",
		prompt_facts(&session)
	);
	assert!(agents_loaded(&session), "AGENTS.md loads while untrusted");
	turn(&gateway, &mut kernel, &mut session).await;
	let notices = withheld_notices(&session);
	let [withheld] = notices.as_slice() else {
		panic!("one withheld notice, {} journaled", notices.len());
	};
	assert_eq!(withheld.decision, TrustDecisionKind::Untrusted);
	assert!(withheld.named.iter().any(|path| path == ".omp/SYSTEM.md"), "{withheld:?}");
	assert!(
		withheld
			.named
			.iter()
			.any(|path| path.starts_with(".omp/extensions/")),
		"{withheld:?}"
	);
	assert!(withheld.body().contains("until this workspace is trusted"), "{}", withheld.body());
	drop(kernel);
	drop(session);

	// Resumed: the decision is recorded once and the operator not told again.
	let (mut kernel, mut session) = workspace.compose(&gateway).await;
	turn(&gateway, &mut kernel, &mut session).await;
	assert_eq!(decisions_journaled(&session), 1, "the decision is journaled once");
	assert_eq!(withheld_notices(&session).len(), 1, "the operator is told once");
	assert_eq!(journaled_decision(&session), Some(TrustDecision::Untrusted));
}

#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn a_digest_bound_grant_admits_the_inputs_until_one_changes() {
	let workspace = Workspace::new();
	let gateway = Gateway::start(workspace.home.parent().expect("scratch")).await;
	let daemon = workspace.daemon(WorkspaceTrust::Trusted).await;
	workspace.grant();

	let (mut kernel, mut session) = workspace.compose(&gateway).await;
	assert!(matches!(journaled_decision(&session), Some(TrustDecision::Trusted { .. })));
	assert!(extension_admitted(&session), "the trusted workspace extension loads");
	assert_eq!(prompt_facts(&session)["custom_prompt"], PROJECT_SYSTEM);
	assert!(agents_loaded(&session));
	turn(&gateway, &mut kernel, &mut session).await;
	assert_eq!(withheld_notices(&session), [], "nothing is withheld");
	drop(kernel);
	drop(session);
	// The trusted daemon holds the project's one document authority, which
	// an untrusted session may not join, so it is stopped first.
	drop(daemon);
	workspace.released_document_authority().await;

	// An edit to a gated input after the grant: the grant no longer matches.
	write(&workspace.project.join(".omp/mcp.json"), r#"{"mcpServers":{}}"#);
	fs::remove_file(&workspace.session).expect("fresh session");
	let _daemon = workspace.daemon(WorkspaceTrust::Untrusted).await;
	let (mut kernel, mut session) = workspace.compose(&gateway).await;
	assert!(
		matches!(journaled_decision(&session), Some(TrustDecision::DigestChanged { .. })),
		"{:?}",
		journaled_decision(&session)
	);
	assert!(!extension_admitted(&session), "a changed workspace's extension is withheld");
	assert!(prompt_facts(&session).get("custom_prompt").is_none());
	turn(&gateway, &mut kernel, &mut session).await;
	let notices = withheld_notices(&session);
	let [withheld] = notices.as_slice() else {
		panic!("one withheld notice, {} journaled", notices.len());
	};
	assert_eq!(withheld.decision, TrustDecisionKind::DigestChanged);
	assert!(withheld.named.iter().any(|path| path == ".omp/mcp.json"), "{withheld:?}");
}
#[tokio::test(flavor = "multi_thread", worker_threads = 2)]
async fn consult_child_is_read_only_and_never_opens_the_source_for_write() {
	use omp_driver::consult::{ConsultSource, child_options, prepare_root};
	let workspace = Workspace::new();
	let _daemon = workspace.daemon(WorkspaceTrust::Untrusted).await;
	let gateway = Gateway::start_with_tools(workspace.home.parent().expect("scratch")).await;
	let source_gateway_scratch = tempfile::tempdir().expect("source gateway scratch");
	let source_gateway = Gateway::start_with_tools(source_gateway_scratch.path()).await;

	// Build a completed, production-composed session as the consult source.
	let (mut source_kernel, mut source_session) = workspace.compose(&source_gateway).await;
	turn(&source_gateway, &mut source_kernel, &mut source_session).await;
	drop(source_kernel);
	drop(source_session);
	let source_path = workspace.session.clone();
	let before = fs::read(&source_path).expect("source bytes before");
	let source_dir = tempfile::tempdir().expect("consult temp");
	let root = prepare_root(source_dir.path(), &ConsultSource {
		id:    Str::new_static("fixture"),
		path:  source_path.clone(),
		model: gateway.model.clone(),
	})
	.expect("private root");
	let mut options = child_options(&root);
	options.gateway = Some(gateway.channel.clone());
	let (mut kernel, mut session, _) = compose_kernel(
		&workspace.data,
		&workspace.project,
		gateway.model.as_str(),
		Arc::clone(&workspace.con),
		options,
	)
	.await
	.expect("consult child composition");

	for name in omp_driver::consult::CONSULT_TOOLS {
		assert_eq!(
			kernel.tool_registry().presentation(name).expect(name),
			omp_tool::Presentation::Slot
		);
	}
	assert_eq!(
		kernel
			.tool_registry()
			.presentation("goal")
			.expect("hidden goal"),
		omp_tool::Presentation::Hidden
	);
	assert!(kernel.tool_registry().live_spec("write").is_err(), "write is not registered");

	// A full consult turn completes normally with exactly three declared tools.
	gateway.answer("The saved session records the earlier work.");
	kernel
		.run_turn(
			&mut session,
			TurnInput {
				text:        Str::new_static("Summarize the saved session."),
				attachments: Vec::new(),
			},
			RunControl::new(CancellationToken::new(), None),
		)
		.await
		.expect("full consult turn");
	drop(kernel);
	drop(session);
	let _ = gateway.fake.take_calls();

	// A deliberately invalid model response tries to call a tool not in the wire
	// roster.
	let mut options = child_options(&root);
	options.gateway = Some(gateway.channel.clone());
	let (mut kernel, mut session, _) = compose_kernel(
		&workspace.data,
		&workspace.project,
		gateway.model.as_str(),
		Arc::clone(&workspace.con),
		options,
	)
	.await
	.expect("second consult child composition");
	let args = serde_json::json!({});
	let call = ToolCall {
		id:        ToolCallId::from("forbidden-write"),
		name:      Str::new_static("write"),
		arguments: omp_ai::OpaqueJson::new(args.clone()),
	};
	gateway.fake.push(FakeScript::chat(vec![
		Ok(ChatEvent::ToolCallStarted { index: 0, id: call.id.clone(), name: call.name.clone() }),
		Ok(ChatEvent::ToolArgumentsDelta {
			index: 0,
			bytes: bytes::Bytes::from(serde_json::to_vec(&args).expect("arguments")),
		}),
		Ok(ChatEvent::ToolCallReady { index: 0, call }),
		Ok(ChatEvent::Completed(Completion {
			reason:  FinishReason::ToolCalls,
			blocks:  1,
			usage:   Usage::default(),
			receipt: ExecutionReceipt::default().into(),
		})),
	]));
	let rejected = kernel
		.run_turn(
			&mut session,
			TurnInput {
				text:        Str::new_static("Try to write to the saved session."),
				attachments: Vec::new(),
			},
			RunControl::new(CancellationToken::new(), None),
		)
		.await;
	assert!(rejected.is_err(), "an undeclared write call must be refused");
	let captured = gateway.fake.calls();
	assert!(!captured.is_empty(), "the child reached the gateway");
	assert!(
		captured.iter().all(|call| matches!(
			call.shape,
			omp_ai::provider::fake::CapturedOperation::Chat { tools: 3, .. }
		)),
		"only the three read tools reach the wire: {captured:?}"
	);

	assert_eq!(
		fs::read(&source_path).expect("source bytes after"),
		before,
		"source journal unchanged after full turn"
	);
}
