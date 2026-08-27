//! Executable P5 proof for delta-only context and provider-request prefix
//! stability.

use std::{
	collections::BTreeMap, fs, future::Future, num::NonZeroUsize, path::Path, sync::Arc,
	time::Duration,
};

use bytes::Bytes;
use futures::{FutureExt as _, Stream};
use omp_agent::{
	Agent, AgentSnapshot, AgentState, ContextFile, InProcTurnClient, Journal, PromptFacts,
	TurnClient, TurnId, TurnInput, TurnOptions,
};
use omp_catalog::{
	CompiledCatalog,
	snapshot::{Catalog, SnapshotProvenance},
};
use omp_core::{Ulid, sf};
use omp_e2e::support::{Scratch, user_item, within};
use omp_inference::{
	AccountSummary, Error, ErrorKind, ErrorPhase, ExecutionReceipt, Registry, RetryAction,
	account::AccountPool,
	answer::AuthSession,
	auth::{
		AuthLoginEngine, AuthManager, AuthRefreshEngine, CredentialBroker, CredentialBrokerEngines,
		CredentialShaperRegistry, CredentialStore, HeadlessKeySource, KeyId,
	},
	call::{AuthMethod, LoginRequest},
	codec::{
		google_cca::{AntigravityFingerprint, AntigravityPolicy, CcaHeaders},
		openai_chat::OpenAiChatCodec,
	},
	layer::{admission::AdmissionController, stack::BuiltinConfig},
	provider::builtin::{
		AuthApplicationConfig, GoogleCcaConfig, LocalRouteBackend, ProductionDependencies,
	},
	session::{ConversationSessionPlanner, InMemoryConversationStore},
	transport::{
		Frame, SseEvent,
		cassette::{CassetteAttempt, CassetteBodyAction, CassetteTerminal, CassetteTransport},
		http::HttpTransport,
		websocket_transport::WebSocketTransport,
	},
};
use omp_proto::{
	inference::v1::{self as pb, tool_def},
	prost::Message as _,
	thread::v1::{self as thread, item, part},
};
use omp_serve::inference::InferenceRpc;
use omp_storage::transcript::{Header, SessionId};
use omp_tool::{
	CapsBase, Claims, Constraint, Effects, Ev, IncomingParams, ModelClass, Part, Precedence,
	Presentation, PromptCaps, Rev, Tool, ToolSpec,
};
use parking_lot::Mutex;

const MODEL: &str = "apple-intelligence/apple-intelligence";
const ROUTE: &str = "apple-intelligence/primary";
const BODY_LIMIT: usize = 1024 * 1024;

fn canonical_turn_id() -> TurnId {
	TurnId::new(Ulid::generate().to_string())
}

/// Exists because scripting cannot express request capture wrapping an
/// arbitrary inner turn client.
#[derive(Clone)]
struct Instrumented<C> {
	inner: C,
	turns: Arc<Mutex<Vec<CapturedInput>>>,
}

#[derive(Clone, Debug)]
struct CapturedInput {
	input:   TurnInput,
	options: TurnOptions,
}

impl<C> Instrumented<C> {
	fn new(inner: C) -> Self {
		Self { inner, turns: Arc::new(Mutex::new(Vec::new())) }
	}

	fn captures(&self) -> Vec<CapturedInput> {
		self.turns.lock().clone()
	}
}

impl<C: TurnClient> TurnClient for Instrumented<C> {
	type Session<'client>
		= C::Session<'client>
	where
		C: 'client;

	fn turn<'client>(
		&'client self,
		turn_id: TurnId,
		input: TurnInput,
		options: &'client TurnOptions,
	) -> impl Future<Output = Result<Self::Session<'client>, omp_agent::Error>> + Send + 'client {
		self
			.turns
			.lock()
			.push(CapturedInput { input: input.clone(), options: options.clone() });
		self.inner.turn(turn_id, input, options)
	}
}

struct RevisionTool {
	spec: ToolSpec,
}

impl Tool for RevisionTool {
	type Fault = serde_json::Value;
	type Params = serde_json::Value;
	type Payload = serde_json::Value;
	type Update = serde_json::Value;

	fn spec(&self) -> &ToolSpec {
		&self.spec
	}

	fn call<'c>(
		&'c self,
		_params: IncomingParams<'c>,
	) -> impl Stream<Item = Ev<Self::Update, Self::Payload, Self::Fault>> + Send + 'c {
		futures::stream::empty()
	}

	fn prompt(&self, _view: Result<&Self::Payload, &Self::Fault>, _caps: &PromptCaps) -> Vec<Part> {
		Vec::new()
	}
}

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
		_spec: omp_catalog::AuthSpecId,
	) -> futures::future::BoxFuture<'_, Result<AuthSession, Error>> {
		async { Err(unused_auth_error()) }.boxed()
	}
}

struct UnusedRefresh;

impl AuthRefreshEngine for UnusedRefresh {
	fn refresh(
		&self,
		_account: omp_inference::AccountId,
	) -> futures::future::BoxFuture<'_, Result<AccountSummary, Error>> {
		async { Err(unused_auth_error()) }.boxed()
	}
}

fn unused_auth_error() -> Error {
	Error::new(
		ErrorKind::InternalInvariant,
		ErrorPhase::Authentication,
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
}

fn tool_schema(revision: u16) -> Bytes {
	serde_json::to_vec(&serde_json::json!({
		"type": "object",
		"properties": { "revision": { "const": revision } }
	}))
	.expect("serialize revision tool schema")
	.into()
}

fn tool_registry(revision: u16) -> Arc<omp_tool::Registry> {
	let mut registry = omp_tool::Registry::new();
	registry
		.register(
			RevisionTool {
				spec: ToolSpec {
					name:            "probe".into(),
					rev:             Rev { family: "json".into(), n: revision },
					description:     format!("prefix probe revision {revision}").into(),
					schema:          tool_schema(revision),
					constraint:      Constraint::None,
					effects:         Effects::empty(),
					projection_code: [0; 32],
				},
			},
			Presentation::Slot,
			Claims { precedence: Precedence::CORE, claimant: "omp/core".into(), replaces: None },
		)
		.expect("register revision tool");
	Arc::new(registry)
}

fn tool_def(revision: u16) -> pb::ToolDef {
	pb::ToolDef {
		name:        "probe".to_owned(),
		description: format!("prefix probe revision {revision}"),
		input:       Some(tool_def::Input::JsonSchema(tool_def::JsonSchema {
			schema_json: tool_schema(revision),
			strict:      None,
		})),
	}
}

fn catalog() -> Arc<Catalog> {
	let mut value =
		serde_json::to_value(Catalog::embedded().compiled()).expect("normalized catalog JSON");
	let models = value["models"].as_array_mut().expect("models array");
	let mut model = models.first().cloned().expect("catalog model fixture");
	model["key"] = serde_json::json!(MODEL);
	model["display_name"] = serde_json::json!("Offline Apple Intelligence");
	model["routes"] = serde_json::json!([ROUTE]);
	model["wire_ids"] = serde_json::json!([[ROUTE, "apple-intelligence"]]);
	model["capabilities"]["chat"]["tools"] = serde_json::json!({
		"native": { "features": 0, "maximum_tools": null }
	});
	models.push(model);
	let compiled: CompiledCatalog = serde_json::from_value(value).expect("modified test catalog");
	let artifacts = Catalog::encode(compiled, SnapshotProvenance { source_digest: [0; 32] })
		.expect("encode test catalog");
	Arc::new(Catalog::decode(&artifacts.postcard).expect("decode test catalog"))
}

fn cassette_attempt() -> CassetteAttempt {
	CassetteAttempt {
		status: Some(200),
		headers: Box::new([]),
		provider_request_id: Some(sf!("p5-cassette")),
		body: CassetteBodyAction::Drain,
		frames: vec![
			Frame::Sse(SseEvent {
				name: None,
				data: Bytes::from_static(
					br#"{"id":"chatcmpl-p5","object":"chat.completion.chunk","created":1,"model":"apple-intelligence","choices":[{"index":0,"delta":{"role":"assistant","content":"ok"},"finish_reason":null}]}"#,
				),
			}),
			Frame::Sse(SseEvent {
				name: None,
				data: Bytes::from_static(
					br#"{"id":"chatcmpl-p5","object":"chat.completion.chunk","created":1,"model":"apple-intelligence","choices":[{"index":0,"delta":{},"finish_reason":"stop"}]}"#,
				),
			}),
			Frame::Sse(SseEvent { name: None, data: Bytes::from_static(b"[DONE]") }),
		]
		.into_boxed_slice(),
		terminal: CassetteTerminal::Complete,
	}
}

fn auth_manager(
	catalog: Arc<Catalog>,
	path: &Path,
	broker: CredentialBroker,
	accounts: AccountPool,
) -> AuthManager {
	let store = Arc::new(
		CredentialStore::open(path, Arc::new(HeadlessKeySource::new(KeyId::new("p5-e2e"), [7; 32])))
			.expect("credential store"),
	);
	let login = [
		AuthMethod::ApiKey,
		AuthMethod::OAuthPkce,
		AuthMethod::OAuthDevice,
		AuthMethod::ApplicationDefault,
		AuthMethod::AwsCredentialChain,
		AuthMethod::SessionToken,
	]
	.into_iter()
	.map(|method| Arc::new(UnusedLogin(method)) as Arc<dyn AuthLoginEngine>)
	.collect();
	AuthManager::new(catalog, store, broker, accounts, login, Arc::new(UnusedRefresh))
		.expect("test auth manager")
}

async fn gateway(
	scratch: &Scratch,
	cassette: CassetteTransport,
	tools: Arc<omp_tool::Registry>,
) -> InProcTurnClient {
	let catalog = catalog();
	let broker = CredentialBroker::system(&catalog, CredentialBrokerEngines::default())
		.expect("credential broker");
	let accounts = AccountPool::new();
	let auth = auth_manager(
		Arc::clone(&catalog),
		&scratch.state().join("credentials.sqlite"),
		broker.clone(),
		accounts.clone(),
	);
	let sessions = ConversationSessionPlanner::with_in_memory(
		Arc::new(InMemoryConversationStore::new()),
		Arc::clone(&catalog),
	);
	let dependencies = ProductionDependencies::new(
		broker,
		auth,
		accounts,
		sessions.clone(),
		WebSocketTransport::new(),
		GoogleCcaConfig {
			gemini_cli_platform: "test".into(),
			gemini_cli_arch:     "test".into(),
			antigravity_headers: CcaHeaders::antigravity(
				&AntigravityFingerprint::default(),
				false,
				None,
			),
			antigravity_policy:  AntigravityPolicy::default(),
		},
		HttpTransport::new(),
		AuthApplicationConfig { signing_regions: Arc::new(BTreeMap::new()) },
		AdmissionController::new(8, 8),
		Duration::from_secs(2),
		Arc::new(BTreeMap::new()),
		Arc::new(CredentialShaperRegistry::new()),
	)
	.with_local_routes([(
		ROUTE.into(),
		LocalRouteBackend::new(
			Arc::new(OpenAiChatCodec::default()),
			cassette,
			Duration::from_secs(2),
		),
	)]);
	let registry = Registry::builder(catalog)
		.with_builtins(BuiltinConfig::production(dependencies))
		.expect("compose production route stack")
		.build()
		.expect("build inference registry");
	let service = InferenceRpc::new(registry, sessions, tools);
	InProcTurnClient::new(service)
		.await
		.expect("start in-process gateway")
}

fn journal(scratch: &Scratch) -> Journal {
	Journal::create(&scratch.state().join("p5.jsonl"), &Header {
		v:       4,
		id:      SessionId(sf!("p5-prefix-stability")),
		created: 0,
		cwd:     scratch.project().to_owned(),
	})
	.expect("create agent journal")
}

fn context_file(path: &Path) -> ContextFile {
	ContextFile::new("AGENTS.md", fs::read(path).expect("read context file"))
}

fn array_contents<'a>(body: &'a [u8], field: &[u8]) -> &'a [u8] {
	let mut needle = Vec::with_capacity(field.len() + 4);
	needle.push(b'"');
	needle.extend_from_slice(field);
	needle.extend_from_slice(b"\":[");
	let start = body
		.windows(needle.len())
		.position(|window| window == needle)
		.map(|index| index + needle.len())
		.expect("captured request contains expected array");
	let mut depth = 1_u32;
	let mut quoted = false;
	let mut escaped = false;
	for (offset, byte) in body[start..].iter().copied().enumerate() {
		if quoted {
			if escaped {
				escaped = false;
			} else if byte == b'\\' {
				escaped = true;
			} else if byte == b'"' {
				quoted = false;
			}
			continue;
		}
		match byte {
			b'"' => quoted = true,
			b'[' => depth += 1,
			b']' => {
				depth -= 1;
				if depth == 0 {
					return &body[start..start + offset];
				}
			},
			_ => {},
		}
	}
	panic!("captured request array is unterminated")
}

fn assert_prefix(left: &[u8], right: &[u8], label: &str) {
	assert!(right.starts_with(left), "{label} was not byte-prefix stable");
}

#[tokio::test]
async fn delta_context_prompt_rewind_preserves_exact_provider_prefixes() {
	let scratch = Scratch::new().expect("scratch workspace");
	let prompt_path = scratch
		.write("AGENTS.md", b"stable prompt v1\n")
		.expect("initial prompt");
	let tools_v1 = tool_registry(1);

	let cassette = CassetteTransport::new(Arc::<[CassetteAttempt]>::from(
		(0..7).map(|_| cassette_attempt()).collect::<Vec<_>>(),
	))
	.with_request_body_capture(NonZeroUsize::new(BODY_LIMIT).expect("nonzero body limit"));
	let cassette_probe = cassette.clone();
	let client = Instrumented::new(gateway(&scratch, cassette, Arc::clone(&tools_v1)).await);
	let probe = client.clone();
	let options = TurnOptions {
		context_id:      Some(sf!("p5-context")),
		params:          pb::ChatParams {
			model: MODEL.to_owned(),
			tools: vec![tool_def(1)],
			..Default::default()
		},
		executor:        None,
		props:           None,
		provider_reset:  false,
		stream_watchdog: omp_agent::StreamWatchdog::default(),
	};
	let props =
		PromptFacts::new(scratch.project(), Arc::<[ContextFile]>::from([context_file(&prompt_path)]))
			.props()
			.expect("prefix-stability prompt facts");
	let state = AgentState::new(AgentSnapshot::new(options, props, Arc::clone(&tools_v1)));
	let (env, _env_transport) = omp_env::EnvClient::in_process(4);
	let mut agent = Agent::new(client, env, state.clone(), journal(&scratch), CapsBase {
		maximum_parts:      4,
		maximum_text_bytes: 4096,
		media:              false,
		model_class:        ModelClass::Standard,
	});

	let mut revisions = Vec::new();
	let mut diagnostic_codes = Vec::new();
	for text in ["steady one", "steady two", "steady tri"] {
		let summary = within(
			"p5 steady turn",
			Duration::from_secs(5),
			Box::pin(agent.submit([user_item(text)], canonical_turn_id())),
		)
		.await
		.expect("steady turn stays within deadline")
		.unwrap_or_else(|error| {
			panic!("steady turn succeeds: {error:?}; cassette={:?}", cassette_probe.captures())
		});
		let outcome = summary.outcome.expect("committed outcome");
		diagnostic_codes.push(
			outcome
				.diagnostics
				.iter()
				.map(|value| value.code.clone())
				.collect::<Vec<_>>(),
		);
		revisions.push(outcome.revision.expect("stateful revision"));
	}

	scratch
		.write("AGENTS.md", b"stable prompt v2\n")
		.expect("mutate real context file");
	state.update(|snapshot| {
		snapshot.props = PromptFacts::new(
			scratch.project(),
			Arc::<[ContextFile]>::from([context_file(&prompt_path)]),
		)
		.props()
		.expect("updated prefix-stability prompt facts");
	});
	let fourth = within(
		"p5 prompt rewind",
		Duration::from_secs(5),
		Box::pin(agent.submit([user_item("after prompt")], canonical_turn_id())),
	)
	.await
	.expect("prompt rewind stays within deadline")
	.expect("prompt rewind succeeds without conflict");
	let outcome = fourth.outcome.expect("committed outcome");
	assert_eq!(
		outcome
			.diagnostics
			.iter()
			.filter(|value| value.code == "session_reseed")
			.map(|value| value.detail.as_str())
			.collect::<Vec<_>>(),
		vec!["Fork"],
		"prompt truncation must causally fork and reseed provider history"
	);
	diagnostic_codes.push(
		outcome
			.diagnostics
			.iter()
			.map(|value| value.code.clone())
			.collect::<Vec<_>>(),
	);
	revisions.push(outcome.revision.expect("prompt rewind revision"));

	let fifth = within(
		"p5 unchanged registry",
		Duration::from_secs(5),
		Box::pin(agent.submit([user_item("same tools")], canonical_turn_id())),
	)
	.await
	.expect("unchanged registry stays within deadline")
	.expect("unchanged registry turn succeeds");
	let outcome = fifth.outcome.expect("committed outcome");
	diagnostic_codes.push(
		outcome
			.diagnostics
			.iter()
			.map(|value| value.code.clone())
			.collect::<Vec<_>>(),
	);
	revisions.push(outcome.revision.expect("unchanged registry revision"));

	let sixth = within(
		"p5 continued stable registry",
		Duration::from_secs(5),
		Box::pin(agent.submit([user_item("same tools again")], canonical_turn_id())),
	)
	.await
	.expect("continued stable registry stays within deadline")
	.expect("continued stable registry turn succeeds");
	let outcome = sixth.outcome.expect("committed outcome");
	diagnostic_codes.push(
		outcome
			.diagnostics
			.iter()
			.map(|value| value.code.clone())
			.collect::<Vec<_>>(),
	);
	revisions.push(
		outcome
			.revision
			.expect("continued stable registry revision"),
	);
	let seventh = within(
		"p5 final stable registry",
		Duration::from_secs(5),
		Box::pin(agent.submit([user_item("tools stay")], canonical_turn_id())),
	)
	.await
	.expect("final stable registry stays within deadline")
	.expect("final stable registry turn succeeds");
	let outcome = seventh.outcome.expect("committed outcome");
	diagnostic_codes.push(
		outcome
			.diagnostics
			.iter()
			.map(|value| value.code.clone())
			.collect::<Vec<_>>(),
	);
	revisions.push(outcome.revision.expect("final stable registry revision"));

	for pair in revisions.windows(2) {
		assert!(pair[0].head < pair[1].head, "gateway revisions must be strictly monotone");
	}
	let reseed_turns = diagnostic_codes
		.iter()
		.enumerate()
		.flat_map(|(turn, codes)| {
			codes
				.iter()
				.filter(|code| code.as_str() == "session_reseed")
				.map(move |_| turn)
		})
		.collect::<Vec<_>>();
	assert_eq!(
		reseed_turns,
		vec![3],
		"only prompt replacement reseeds provider history, exactly once"
	);
	let turns = probe.captures();
	assert_eq!(turns.len(), 7, "no implicit reseed submission or retry");
	assert!(matches!(turns[0].input, TurnInput::Full(_)), "only turn one seeds");
	let (second_context, second_delta) = match &turns[1].input {
		TurnInput::Delta(context, delta) => (context, delta),
		TurnInput::Full(_) => panic!("turn two must be Delta-only"),
	};
	let (third_context, third_delta) = match &turns[2].input {
		TurnInput::Delta(context, delta) => (context, delta),
		TurnInput::Full(_) => panic!("turn three must be Delta-only"),
	};
	assert_eq!(second_context.context_id, "p5-context");
	assert_eq!(third_context.context_id, second_context.context_id);
	assert_eq!(second_delta.truncate_to, None);
	assert_eq!(third_delta.truncate_to, None);
	assert_eq!(
		second_delta.encoded_len(),
		third_delta.encoded_len(),
		"equal-size new items have history-independent delta bytes"
	);
	assert_eq!(second_delta.append.len(), 1);
	assert_eq!(third_delta.append.len(), 1);

	let (fourth_context, fourth_delta) = match &turns[3].input {
		TurnInput::Delta(context, delta) => (context, delta),
		TurnInput::Full(_) => panic!("prompt replacement must not reseed the gateway context"),
	};
	assert_eq!(fourth_context.context_id, second_context.context_id);
	assert_eq!(fourth_delta.truncate_to, Some(0));
	let rewind_messages = fourth_delta
		.append
		.iter()
		.map(|item| {
			let Some(item::Kind::Message(message)) = item.kind.as_ref() else {
				panic!("prompt rewind append must contain only canonical messages")
			};
			let text = message
				.parts
				.iter()
				.map(|part| match part.kind.as_ref() {
					Some(part::Kind::Text(text)) => text.as_str(),
					_ => panic!("P5 prompt history is text-only"),
				})
				.collect::<String>();
			(message.role, text)
		})
		.collect::<Vec<_>>();
	assert_eq!(
		rewind_messages[0].0,
		thread::Role::System as i32,
		"prompt rewind must begin with the rebuilt system head"
	);
	assert!(
		rewind_messages[0].1.contains("<system-conventions>"),
		"prompt rewind omitted the canonical system contract"
	);
	assert_eq!(rewind_messages[1].0, thread::Role::System as i32);
	assert!(
		rewind_messages[1].1.contains("stable prompt v2"),
		"prompt rewind omitted the refreshed repository context"
	);
	assert_eq!(
		&rewind_messages[2..],
		vec![
			(thread::Role::User as i32, "steady one".to_owned()),
			(thread::Role::Assistant as i32, "ok".to_owned()),
			(thread::Role::User as i32, "steady two".to_owned()),
			(thread::Role::Assistant as i32, "ok".to_owned()),
			(thread::Role::User as i32, "steady tri".to_owned()),
			(thread::Role::Assistant as i32, "ok".to_owned()),
			(thread::Role::User as i32, "after prompt".to_owned()),
		]
		.as_slice(),
		"prompt rewind replaces only the head and preserves the exact prior user/assistant tail"
	);
	let fourth_json = serde_json::to_vec(&fourth_delta.append).expect("serialize rewind append");
	assert!(
		fourth_json
			.windows(b"stable prompt v2".len())
			.any(|w| w == b"stable prompt v2")
	);
	for tail in [b"steady one".as_slice(), b"steady two", b"steady tri", b"after prompt"] {
		assert!(
			fourth_json.windows(tail.len()).any(|window| window == tail),
			"rewind preserves tail"
		);
	}
	let truncations = turns
		.iter()
		.filter(|turn| {
			matches!(&turn.input, TurnInput::Delta(_, pb::ThreadDelta { truncate_to: Some(0), .. }))
		})
		.count();
	assert_eq!(truncations, 1, "only the prompt replacement invalidates the prefix");
	for turn in &turns[4..] {
		assert!(matches!(
			&turn.input,
			TurnInput::Delta(_, pb::ThreadDelta { truncate_to: None, .. })
		));
		assert_eq!(turn.options.params.tools, vec![tool_def(1)]);
	}

	let captures = cassette_probe.captures();
	assert_eq!(captures.len(), 7, "one provider attempt per logical turn and no hidden retry");
	let bodies: Vec<Bytes> = captures
		.into_iter()
		.map(|capture| {
			let body = capture
				.request_body
				.expect("sanctioned cassette body capture enabled");
			assert!(!body.truncated, "request capture bound must retain exact bytes");
			assert_eq!(body.observed_bytes, body.bytes.len() as u64);
			body.bytes
		})
		.collect();

	let messages: Vec<&[u8]> = bodies
		.iter()
		.map(|body| array_contents(body, b"messages"))
		.collect();
	assert_prefix(messages[0], messages[1], "turn 1→2 dialect messages");
	assert_prefix(messages[1], messages[2], "turn 2→3 dialect messages");
	assert!(
		messages[3]
			.windows(b"stable prompt v2".len())
			.any(|w| w == b"stable prompt v2")
	);
	assert!(
		!messages[3]
			.windows(b"stable prompt v1".len())
			.any(|w| w == b"stable prompt v1")
	);
	for tail in [b"steady one".as_slice(), b"steady two", b"steady tri"] {
		assert!(
			messages[3].windows(tail.len()).any(|window| window == tail),
			"provider replay preserves canonical tail"
		);
	}
	assert_prefix(messages[3], messages[4], "post-prompt turn 4→5 dialect messages");
	assert_prefix(messages[4], messages[5], "stable turn 5→6 dialect messages");
	assert_prefix(messages[5], messages[6], "stable turn 6→7 dialect messages");

	let tool_bytes: Vec<&[u8]> = bodies
		.iter()
		.map(|body| array_contents(body, b"tools"))
		.collect();
	for pair in tool_bytes.windows(2) {
		assert_eq!(pair[0], pair[1], "unchanged registry keeps provider tool bytes stable");
	}
}
