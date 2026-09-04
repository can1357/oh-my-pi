//! Executable P9 proof that Environment-placed workers inherit an isolated
//! worktree root rather than the parent repository root.

#![cfg(unix)]

use std::{fs, future, path::PathBuf, process, sync::Arc};

use bytes::Bytes;
use omp_core::{ArtifactDigest, Principal, Provenance, Str, sf};
use omp_e2e::{
	Context as _, Result, error,
	support::{DEFAULT_TIMEOUT, EnvHarness, Scratch, omp_binary, within},
};
use omp_env::{Admitter, EnvClient, InvocationEvent};
use omp_envd::{
	EnvServer, ExtensionDataBinding, RegistryBridges,
	exthost::{
		ActivationTrigger, DeclarationSet, ExtensionManifest, ServiceManifest, ToolDeclarationKey,
	},
	worker::{ExtHostConfig, ExtHostSpec, HostKey},
};
use omp_ext::config::{StaticDeclaration, StaticDeclarations};
use omp_proto::{
	SCHEMA_REV,
	env::v1::{Admission, AdmitInvocation, ClientHello, CreateWorktree, InvokeTool},
};
use omp_tool::{CallOutcome, Registry};
use serde_json::{Value, json};
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;
use url::Url;

const MODULE: &str = "p9_isolated_extension";
const MARKER: &str = "extension-proof.txt";
const CONTROL_EXTENSION: &str = r#"
import os
import omp


@omp.tool("prove_isolated_root", rev=1)
def prove_root(path: str):
    with open(path, "w", encoding="utf-8") as marker:
        marker.write("isolated-extension\n")
    with open(path, "r", encoding="utf-8") as marker:
        contents = marker.read()
    return {
        "parts": [],
        "details": {
            "cwd": os.getcwd(),
            "contents": contents,
            "pid": os.getpid(),
        },
    }
"#;

struct AllowAdmission;

impl Admitter for AllowAdmission {
	type Future<'client> = future::Ready<Admission>;

	fn admit<'client>(&'client self, query: AdmitInvocation) -> Self::Future<'client> {
		future::ready(Admission {
			invocation_id: query.invocation_id,
			allow: true,
			..Admission::default()
		})
	}
}

struct ChildEnvironment {
	client:     EnvClient,
	serve_task: JoinHandle<()>,
	data_task:  JoinHandle<()>,
	shutdown:   CancellationToken,
	_server:    Arc<EnvServer>,
	_state:     tempfile::TempDir,
}

impl ChildEnvironment {
	async fn spawn(root: PathBuf) -> Result<Self> {
		let state = tempfile::tempdir().context("create isolated environment state")?;
		let session_id = sf!("p9-isolated-session");
		let session_generation = 1;
		let mut config = ExtHostConfig::new(
			omp_binary().context("resolve extension-host-capable executable")?,
			Principal::new(sf!("p9-e2e"), sf!("P9 E2E")),
			session_id.clone(),
			session_generation,
		);
		let key = HostKey::new("workspace", "trusted", MODULE);
		let provenance = Provenance::new(
			sf!("omp-e2e"),
			key.extension().clone(),
			sf!("1.0.0"),
			ArtifactDigest::new([9; 32]),
			key.layer().clone(),
			key.tier().clone(),
			1,
		);
		let tool = ToolDeclarationKey::new("prove_isolated_root", MODULE, 1);
		let declaration_id = Str::from(format!("{}@{}.{}", tool.name, tool.family, tool.rev));
		let declaration = StaticDeclaration {
			id: declaration_id.clone(),
			kind: sf!("soft"),
			module: sf!(MODULE),
			trigger: sf!("lazy"),
			key: declaration_id,
			api: 1,
			failure: sf!("fault"),
			..StaticDeclaration::default()
		};
		let manifest = ExtensionManifest::new_with_static(
			provenance,
			sf!(MODULE),
			[],
			DeclarationSet::new([tool], []),
			ServiceManifest::default(),
			StaticDeclarations {
				ordered: vec![declaration.clone()].into_boxed_slice(),
				tools: vec![declaration].into_boxed_slice(),
				..StaticDeclarations::default()
			},
			[],
			[ActivationTrigger::FirstReach],
		);
		let mut extension = ExtHostSpec::new(key.clone(), manifest);
		extension.python_site = Some(root.clone());
		extension.entry_path = Some(root.join(format!("{MODULE}.py")));
		let mut data_binding = ExtensionDataBinding::scoped(
			state.path(),
			key,
			session_id.as_str(),
			session_generation,
			extension.data_grants.clone(),
		);
		data_binding
			.prepare_endpoint()
			.context("prepare scoped extension DATA socket")?;
		extension.data_socket = Some(data_binding.path().to_owned());
		config.extensions.push(extension);

		let con = Arc::new(omp_con::Ctx::new());
		let convars = Arc::new(omp_envd::exthost::ConvarControlFactory::new(Arc::clone(&con)));
		let server = Arc::new(
			EnvServer::open_local(
				&root,
				state.path(),
				Registry::new(),
				config,
				&con,
				convars,
				RegistryBridges::default(),
			)
			.await
			.context("open isolated environment")?,
		);
		let identities = server.extension_control_identities();
		let [identity] = identities.as_slice() else {
			return Err(error(format!(
				"expected one authenticated CONTROL child, got {}",
				identities.len()
			)));
		};
		if identity.extension.as_str() != MODULE {
			return Err(error(format!(
				"CONTROL child authenticated as unexpected extension {:?}",
				identity.extension
			)));
		}
		let evidence = server
			.extension_registry_evidence(identity)
			.context("CONTROL child omitted frozen registry evidence")?;
		let registered = evidence.tools.iter().any(|declaration| {
			declaration
				.definition
				.as_ref()
				.is_some_and(|definition| definition.name == "prove_isolated_root")
		});
		if !registered {
			return Err(error(format!("CONTROL child did not register prove_isolated_root")));
		}

		let shutdown = CancellationToken::new();
		let data_server = Arc::clone(&server);
		let data_shutdown = shutdown.clone();
		let data_task = tokio::spawn(async move {
			let _ = data_server
				.serve_extension_uds(data_binding, data_shutdown)
				.await;
		});
		let (client, transport) = EnvClient::in_process(64);
		client.set_admitter(AllowAdmission);
		let host = Arc::clone(&server);
		let serve_task = tokio::spawn(async move { host.serve_in_process(transport).await });
		within(
			"isolated environment hello",
			DEFAULT_TIMEOUT,
			client.hello(ClientHello {
				client: "p9-e2e".to_owned(),
				schema_rev: SCHEMA_REV,
				..ClientHello::default()
			}),
		)
		.await??;
		Ok(Self { client, serve_task, data_task, shutdown, _server: server, _state: state })
	}
}

impl Drop for ChildEnvironment {
	fn drop(&mut self) {
		self.shutdown.cancel();
		self.serve_task.abort();
		self.data_task.abort();
	}
}

async fn invoke_extension(client: &EnvClient) -> Result<Value> {
	let mut invocation = within(
		"open isolated extension invocation",
		DEFAULT_TIMEOUT,
		client.invoke(InvokeTool {
			invocation_id: "p9-extension-call".to_owned(),
			name: "prove_isolated_root".to_owned(),
			rev: format!("{MODULE}.1"),
			..InvokeTool::default()
		}),
	)
	.await??;
	match within("extension acceptance", DEFAULT_TIMEOUT, invocation.next_event()).await?? {
		Some(InvocationEvent::Accepted(_)) => {},
		other => return Err(error(format!("expected extension acceptance, got {other:?}"))),
	}
	within(
		"commit extension arguments",
		DEFAULT_TIMEOUT,
		invocation.commit_args(
			Bytes::from(serde_json::to_vec(&json!({"path": MARKER}))?),
			Bytes::from_static(b"p9-e2e-token"),
			1000,
			None,
		),
	)
	.await??;
	loop {
		match within("isolated extension verdict", DEFAULT_TIMEOUT, invocation.next_event()).await?? {
			Some(InvocationEvent::Verdict(verdict)) => {
				let outcome: CallOutcome<Value, Value> = serde_json::from_slice(&verdict.json)?;
				return match outcome {
					CallOutcome::Ok(value) => Ok(value),
					other => return Err(error(format!("isolated extension returned {other:?}"))),
				};
			},
			Some(InvocationEvent::Update(_)) => {},
			Some(other) => return Err(error(format!("unexpected extension event {other:?}"))),
			None => return Err(error(format!("isolated extension closed before verdict"))),
		}
	}
}

#[tokio::test]
async fn p9_control_extension_is_rooted_in_the_isolated_worktree() -> Result<()> {
	let parent = Scratch::new().context("create parent project")?;
	parent.write("parent-only.txt", b"parent\n")?;
	let parent_env = EnvHarness::spawn(&parent, Registry::new()).await?;
	let created = within(
		"create isolated worktree",
		DEFAULT_TIMEOUT,
		parent_env.client().create_worktree(CreateWorktree {
			name: "p9-extension-sandbox".to_owned(),
			owner_pid: process::id(),
			..CreateWorktree::default()
		}),
	)
	.await??;
	let worktree = created
		.worktree
		.context("environment omitted worktree identity")?;
	let root = Url::parse(&worktree.root_uri)
		.context("parse worktree root URI")?
		.to_file_path()
		.map_err(|()| error(format!("worktree root was not a file URI")))?;
	fs::write(root.join(format!("{MODULE}.py")), CONTROL_EXTENSION)
		.context("install isolated CONTROL extension")?;

	let child = ChildEnvironment::spawn(root.clone()).await?;
	let proof = invoke_extension(&child.client).await?;
	assert_eq!(proof["contents"], "isolated-extension\n");
	assert_ne!(
		proof["pid"].as_u64().context("extension omitted pid")?,
		u64::from(process::id()),
		"extension ran inside the environment process instead of its CONTROL child",
	);
	assert_eq!(
		fs::canonicalize(proof["cwd"].as_str().context("extension omitted cwd")?)?,
		fs::canonicalize(&root)?,
		"placed extension inherited a root other than its isolated Environment",
	);
	assert_eq!(fs::read(root.join(MARKER))?, b"isolated-extension\n");
	assert!(
		!parent.project().join(MARKER).exists(),
		"extension write escaped into the parent repository",
	);

	drop(child);
	parent_env.shutdown().await?;
	Ok(())
}
