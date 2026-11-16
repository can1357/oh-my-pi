mod support;

use std::{future::ready, sync::Arc, time::Duration};

use futures::stream;
use omp_agent::{DispatchPolicy, Inference, Kernel, RunControl, StaticPrompt, TurnInput};
use omp_ai::{
	BlockKind, ChatEvent, ChatRequest, ChatStream, Completion, ExecutionReceipt, FinishReason,
	RequestId, ResponseMeta, Usage,
};
use omp_catalog::{ProviderId, RouteId};
use omp_core::{ArtifactDigest, Provenance, Str};
use omp_envd::{
	AttachOptions, ProjectEnvironment, RegistryBridges,
	exthost::{ActivationTrigger, DeclarationSet, ExtensionManifest, ServiceManifest},
	worker::{ExtHostSpec, HostKey},
};
use omp_ext::{config::StaticDeclarations, workspace_trust::WorkspaceTrust};
use omp_session::{ComponentRegistry, Session};
use parking_lot::Mutex;

const MODULE: &str = "settled_ext";

const SOURCE: &str = r#"import omp

_calls = 0


@omp.hook("agent_settled")
async def settled(event, ctx):
    global _calls
    _calls += 1
    if _calls == 1:
        return omp.agents.Continue(prompt="one more")
    return omp.agents.Settle()
"#;

struct Texts {
	requests: Arc<Mutex<Vec<String>>>,
}

impl Inference for Texts {
	fn chat(
		&mut self,
		request: ChatRequest,
	) -> impl Future<Output = Result<ChatStream, omp_ai::Error>> + Send {
		self.requests.lock().push(format!("{:?}", request.messages));
		let meta = ResponseMeta {
			request_id:          RequestId::from("agent-settled"),
			provider:            ProviderId::from("test"),
			route:               RouteId::from("test/route"),
			model:               None,
			provider_request_id: None,
			created_at:          std::time::SystemTime::UNIX_EPOCH,
		};
		let events = vec![
			ChatEvent::Started(meta),
			ChatEvent::BlockStarted { index: 0, kind: BlockKind::Text },
			ChatEvent::TextDelta { index: 0, text: Str::new_static("done") },
			ChatEvent::Completed(Completion {
				reason:  FinishReason::Stop,
				blocks:  1,
				usage:   Usage::default(),
				receipt: ExecutionReceipt::default().into(),
			}),
		];
		ready(Ok(ChatStream::ordinary(Box::pin(stream::iter(events.into_iter().map(Ok))))))
	}
}

fn extension(root: &std::path::Path) -> ExtHostSpec {
	let entry = root.join(format!("{MODULE}.py"));
	std::fs::write(&entry, SOURCE).expect("extension module");
	let key = HostKey::new("workspace", "trusted", MODULE);
	let provenance = Provenance::new(
		Str::new_static("omp-driver-test"),
		key.extension().clone(),
		Str::new_static("1.0.0"),
		ArtifactDigest::new([9; 32]),
		key.layer().clone(),
		key.tier().clone(),
		1,
	);
	let mut manifest = ExtensionManifest::new_with_static(
		provenance,
		Str::new_static(MODULE),
		[],
		DeclarationSet::default(),
		ServiceManifest::default(),
		StaticDeclarations::default(),
		[],
		[ActivationTrigger::BeforeFirstPrompt],
	);
	manifest.trust_runtime_declarations();
	let mut spec = ExtHostSpec::new(key, manifest);
	spec.python_site = Some(root.to_path_buf());
	spec.entry_path = Some(entry);
	spec
}

#[tokio::test]
async fn python_agent_settled_continue_runs_one_more_turn() {
	let scratch = tempfile::tempdir().expect("scratch");
	let root = scratch.path().join("project");
	let state = scratch.path().join("state");
	std::fs::create_dir_all(&root).expect("root");
	std::fs::create_dir_all(&state).expect("state");
	let con = Arc::new(omp_con::Ctx::new());
	let environment = ProjectEnvironment::attach(&root, &state, AttachOptions {
		py_eval:            false,
		approval_mode:      None,
		trusted_extensions: vec![extension(&root)],
		contributed_values: Vec::new(),
		con:                Arc::clone(&con),
		bridges:            RegistryBridges::default(),
		spawn_idle_timeout: Some(2),
		spawn_policy:       None,
	})
	.await
	.expect("environment");
	let spill = omp_journal::blob::BlobStore::open(scratch.path().join("artifacts")).expect("spill");
	let journal = scratch.path().join("settled.oms");
	let mut session =
		Session::create_with_blob_store(&journal, ComponentRegistry::standard(), spill.clone())
			.expect("session");
	let requests = Arc::new(Mutex::new(Vec::new()));
	let kernel = Kernel::new(
		Texts { requests: Arc::clone(&requests) },
		environment.registry(),
		DispatchPolicy::new(spill),
		StaticPrompt(Str::new_static("test")),
	)
	.with_hook_gate(environment.admission_gate());
	let mut kernel = support::install_authority(
		kernel,
		&environment,
		&session,
		&con,
		None,
		WorkspaceTrust::Untrusted,
		&root,
	);
	tokio::time::timeout(
		Duration::from_secs(90),
		kernel.run_turn(
			&mut session,
			TurnInput { text: Str::new_static("start"), attachments: Vec::new() },
			RunControl::default(),
		),
	)
	.await
	.expect("turn settles")
	.expect("turn");

	let requests = requests.lock().clone();
	assert_eq!(requests.len(), 2, "one extra turn ran: {requests:?}");
	assert!(!requests[0].contains("one more"), "{:?}", requests[0]);
	assert!(
		requests[1].contains("one more"),
		"the continuation reached the model: {:?}",
		requests[1]
	);
	drop(environment);
}
