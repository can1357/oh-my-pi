//! ACP controller proofs over a scripted journal-first kernel.

use std::{
	collections::VecDeque,
	future::{Future, ready},
	sync::{Arc, Mutex},
	time::SystemTime,
};

use futures::StreamExt as _;
use omp_agent::{DispatchPolicy, Inference, Kernel, StaticPrompt};
use omp_ai::{
	Artifact, ArtifactBody, BlockKind, ChatEvent, ChatRequest, ChatStream, Completion,
	ExecutionReceipt, FinishReason, ProviderId, RequestId, ResponseMeta, RouteId, Usage,
};
use omp_core::Str;
use omp_driver::{
	headless::kernel::{KernelOptions, SessionHome},
	sessions::SessionRegistry,
};
use omp_journal::blob::BlobStore;
use omp_session::{ComponentRegistry, Session};
use omp_tool::Registry;
use serde_json::Value;
use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader};

#[derive(Clone, Copy)]
enum Script {
	Pending,
	Text(&'static str),
	TextAndImage(&'static str, &'static [u8]),
}

struct ScriptedInference {
	scripts: Mutex<VecDeque<Script>>,
}

impl Inference for ScriptedInference {
	fn chat(
		&mut self,
		_request: ChatRequest,
	) -> impl Future<Output = Result<ChatStream, omp_ai::Error>> + Send {
		let script = self
			.scripts
			.get_mut()
			.expect("script mutex poisoned")
			.pop_front()
			.expect("one scripted turn");
		ready(Ok(match script {
			Script::Pending => {
				let events = futures::stream::once(ready(Ok(started())))
					.chain(futures::stream::pending::<Result<ChatEvent, omp_ai::Error>>());
				ChatStream::ordinary(Box::pin(events))
			},
			Script::Text(text) => {
				let events = vec![
					started(),
					ChatEvent::BlockStarted { index: 0, kind: BlockKind::Text },
					ChatEvent::TextDelta { index: 0, text: Str::new(text) },
					ChatEvent::Completed(Completion {
						reason:  FinishReason::Stop,
						blocks:  1,
						usage:   Usage::default(),
						receipt: ExecutionReceipt::default().into(),
					}),
				]
				.into_iter()
				.map(Ok);
				ChatStream::ordinary(Box::pin(futures::stream::iter(events)))
			},
			Script::TextAndImage(text, image) => {
				let events = vec![
					started(),
					ChatEvent::BlockStarted { index: 0, kind: BlockKind::Text },
					ChatEvent::TextDelta { index: 0, text: Str::new(text) },
					ChatEvent::BlockStarted { index: 1, kind: BlockKind::Artifact },
					ChatEvent::Artifact {
						index:    1,
						artifact: Artifact {
							media_type: Str::new_static("image/png"),
							size:       None,
							digest:     None,
							body:       ArtifactBody::Bytes(bytes::Bytes::from_static(image)),
						},
					},
					ChatEvent::Completed(Completion {
						reason:  FinishReason::Stop,
						blocks:  2,
						usage:   Usage::default(),
						receipt: ExecutionReceipt::default().into(),
					}),
				]
				.into_iter()
				.map(Ok);
				ChatStream::ordinary(Box::pin(futures::stream::iter(events)))
			},
		}))
	}
}

fn started() -> ChatEvent {
	ChatEvent::Started(ResponseMeta {
		request_id:          RequestId::from("acp-script"),
		provider:            ProviderId::from("scripted"),
		route:               RouteId::from("scripted/test"),
		model:               None,
		provider_request_id: None,
		created_at:          SystemTime::UNIX_EPOCH,
	})
}

fn harness(
	directory: &tempfile::TempDir,
	scripts: impl IntoIterator<Item = Script>,
) -> (Kernel<ScriptedInference>, Session, SessionHome) {
	let sessions_dir = directory.path().join("sessions");
	std::fs::create_dir_all(&sessions_dir).expect("sessions directory");
	let spill = BlobStore::open(directory.path().join("blobs")).expect("blob store");
	let kernel = Kernel::new(
		ScriptedInference { scripts: Mutex::new(scripts.into_iter().collect()) },
		Arc::new(Registry::new()),
		DispatchPolicy::new(spill),
		StaticPrompt(Str::new_static("system")),
	);
	let live = Arc::new(SessionRegistry::new());
	let options = KernelOptions {
		sessions_dir: Some(sessions_dir.clone()),
		sessions: Some(live),
		..KernelOptions::default()
	};
	let home = SessionHome::new(
		directory.path(),
		directory.path(),
		&options,
		Str::new_static("scripted/test"),
		kernel.mailbox(),
	)
	.expect("session home");
	let session = Session::create(sessions_dir.join("startup.oms"), ComponentRegistry::standard())
		.expect("startup session");
	(kernel, session, home)
}

async fn exchange(
	kernel: Kernel<ScriptedInference>,
	session: Session,
	home: SessionHome,
	requests: &'static [u8],
) -> Vec<Value> {
	let (client_io, server_io) = tokio::io::duplex(64 * 1024);
	let (server_read, server_write) = tokio::io::split(server_io);
	let server = omp_app::acp_mode::serve_acp(kernel, session, home, server_read, server_write);
	let client = async move {
		let (client_read, mut client_write) = tokio::io::split(client_io);
		client_write.write_all(requests).await.expect("requests");
		client_write.shutdown().await.expect("request shutdown");
		let mut lines = BufReader::new(client_read).lines();
		let mut frames = Vec::new();
		while let Some(line) = lines.next_line().await.expect("response") {
			frames.push(serde_json::from_str(&line).expect("JSON response"));
		}
		frames
	};
	let (server, frames) = tokio::time::timeout(std::time::Duration::from_secs(2), async {
		tokio::join!(server, client)
	})
	.await
	.expect("ACP exchange must not deadlock");
	server.expect("ACP server");
	frames
}

fn response<'a>(frames: &'a [Value], id: &str) -> &'a Value {
	frames
		.iter()
		.find(|frame| frame.get("id").and_then(Value::as_str) == Some(id))
		.unwrap_or_else(|| panic!("missing response {id}: {frames:#?}"))
}

#[tokio::test]
async fn control_requests_remain_live_during_a_prompt() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let (kernel, session, home) = harness(&directory, [Script::Pending]);
	let frames = exchange(
		kernel,
		session,
		home,
		br#"{"jsonrpc":"2.0","id":"init","method":"initialize","params":{"protocolVersion":1}}
{"jsonrpc":"2.0","id":"prompt","method":"session/prompt","params":{"prompt":"wait"}}
{"jsonrpc":"2.0","id":"approval","method":"session/approve","params":{"promptId":"approval-1","approved":true}}
{"jsonrpc":"2.0","id":"cancel","method":"session/cancel","params":{}}
{"jsonrpc":"2.0","id":"shutdown","method":"shutdown","params":{}}
"#,
	)
	.await;

	assert_eq!(response(&frames, "approval")["result"], serde_json::json!({}));
	assert_eq!(response(&frames, "cancel")["result"], serde_json::json!({}));
	assert_eq!(response(&frames, "prompt")["result"]["stopReason"], "cancelled");
	let approval = frames
		.iter()
		.position(|frame| frame.get("id").and_then(Value::as_str) == Some("approval"))
		.expect("approval response");
	let prompt = frames
		.iter()
		.position(|frame| frame.get("id").and_then(Value::as_str) == Some("prompt"))
		.expect("prompt response");
	assert!(approval < prompt, "approval must dispatch before the active prompt completes");
}

#[tokio::test]
async fn standard_acp_cancel_interrupts_the_active_prompt() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let (kernel, session, home) = harness(&directory, [Script::Pending]);
	let frames = exchange(
		kernel,
		session,
		home,
		br#"{"jsonrpc":"2.0","id":"init","method":"initialize","params":{"protocolVersion":1}}
{"jsonrpc":"2.0","id":"prompt","method":"session/prompt","params":{"sessionId":"startup","prompt":[{"type":"text","text":"wait"}]}}
{"jsonrpc":"2.0","id":"cancel","method":"cancel","params":{"sessionId":"startup"}}
{"jsonrpc":"2.0","id":"shutdown","method":"shutdown","params":{}}
"#,
	)
	.await;

	assert_eq!(
		response(&frames, "cancel")["result"],
		serde_json::json!({}),
		"the ACP `cancel` method must be accepted, not rejected as unknown: {frames:#?}"
	);
	assert_eq!(response(&frames, "prompt")["result"]["stopReason"], "cancelled");
}

#[tokio::test]
async fn content_block_prompts_journal_text_and_image_attachments() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let (kernel, session, home) =
		harness(&directory, [Script::TextAndImage("seen", b"provider image")]);
	let journal_path = session.journal_path().to_path_buf();
	let frames = exchange(
		kernel,
		session,
		home,
		br#"{"jsonrpc":"2.0","id":"init","method":"initialize","params":{"protocolVersion":1}}
{"jsonrpc":"2.0","id":"prompt","method":"session/prompt","params":{"sessionId":"startup","prompt":[{"type":"text","text":"describe this"},{"type":"resource","resource":{"uri":"file:///notes.md","mimeType":"text/markdown","text":"embedded notes"}},{"type":"resource_link","uri":"file:///spec.md","name":"spec.md"},{"type":"image","data":"iVBORw0KGgo=","mimeType":"image/png"}]}}
{"jsonrpc":"2.0","id":"shutdown","method":"shutdown","params":{}}
"#,
	)
	.await;

	let init = response(&frames, "init");
	assert_eq!(init["result"]["agentCapabilities"]["promptCapabilities"]["image"], true);
	let prompt = response(&frames, "prompt");
	assert_ne!(
		prompt["error"]["code"],
		serde_json::json!(-32602),
		"content-block prompts must be accepted as valid params: {prompt:#?}"
	);
	assert!(prompt["result"].get("text").is_none(), "ACP PromptResponse carries chunks, not text");
	assert!(
		frames.iter().any(|frame| {
			frame["method"] == "session/update"
				&& frame["params"]["sessionId"] == "startup"
				&& frame["params"]["update"]["sessionUpdate"] == "agent_message_chunk"
				&& frame["params"]["update"]["content"]["text"] == "seen"
				&& frame["params"]["update"]["messageId"].is_string()
		}),
		"assistant text must use the ACP chunk event with a stable message id: {frames:#?}",
	);
	assert!(
		frames.iter().all(|frame| {
			!matches!(
				frame
					.pointer("/params/update/sessionUpdate")
					.and_then(Value::as_str),
				Some("patch" | "snapshot")
			)
		}),
		"private DOM patch vocabulary must never leak onto ACP: {frames:#?}",
	);
	assert!(
		frames.iter().any(|frame| {
			frame["method"] == "session/update"
				&& frame["params"]["sessionId"] == "startup"
				&& frame["params"]["update"]["sessionUpdate"] == "agent_message_chunk"
				&& frame["params"]["update"]["content"]["type"] == "image"
				&& frame["params"]["update"]["content"]["data"]
					== omp_core::base64::encode(b"provider image").into_string()
		}),
		"provider media must resolve from the same session CAS as the prompt: {frames:#?}",
	);

	let reopened = Session::open(&journal_path, ComponentRegistry::standard()).expect("reopen");
	let dom = reopened.dom();
	let turn = *dom.children(dom.body()).last().expect("journaled turn");
	let user = dom
		.children(turn)
		.iter()
		.filter_map(|handle| dom.get(*handle))
		.find(|node| node.tag == omp_dom::Tag::Known(omp_dom::KnownTag::User))
		.expect("journaled user message");
	assert_eq!(
		user.content.as_deref(),
		Some("describe this\n\nembedded notes\n\nspec.md"),
		"text, embedded text resources, and resource links join in order"
	);
	let attachments = match user.prop(&omp_dom::PropKey::Known(omp_dom::PropId::Data)) {
		Some(omp_dom::Value::Json(raw)) => {
			serde_json::from_str::<Vec<omp_journal::blob::BlobRef>>(raw.get()).expect("blob refs")
		},
		other => panic!("user message must carry its image attachments, got {other:?}"),
	};
	assert_eq!(attachments.len(), 1);
	let stored = reopened
		.blobs()
		.get(&attachments[0])
		.expect("image blob is content-addressed in the session store");
	assert_eq!(stored.as_ref(), b"\x89PNG\r\n\x1a\n");

	let provider_blob = omp_journal::blob::BlobRef {
		hash: omp_core::Hash32::sum(b"provider image"),
		size: u64::try_from(b"provider image".len()).expect("fixture length"),
	};
	assert_eq!(
		reopened
			.blobs()
			.get(&provider_blob)
			.expect("provider image in session CAS")
			.as_ref(),
		b"provider image"
	);
	let assistant = dom
		.children(turn)
		.iter()
		.copied()
		.find(|handle| {
			dom.get(*handle)
				.is_some_and(|node| node.tag == omp_dom::Tag::Known(omp_dom::KnownTag::Assistant))
		})
		.expect("journaled assistant");
	let artifact = dom
		.children(assistant)
		.iter()
		.filter_map(|handle| dom.get(*handle))
		.find(|node| matches!(&node.tag, omp_dom::Tag::Custom(tag) if tag.as_str() == "artifact"))
		.expect("journaled provider artifact");
	let provider_uri = format!("artifact://sha256/{}", provider_blob.to_hex());
	assert_eq!(
		artifact
			.prop(&omp_dom::PropKey::Known(omp_dom::PropId::Blob))
			.and_then(omp_dom::Value::as_str),
		Some(provider_uri.as_str())
	);
	assert_eq!(
		artifact.prop(&omp_dom::PropKey::Custom(Str::new_static("size"))),
		Some(&omp_dom::Value::Int(i64::try_from(provider_blob.size).expect("fixture size"))),
		"the actual CAS size is journaled even when the provider omitted it"
	);
}

#[tokio::test]
async fn new_load_and_resume_switch_the_authoritative_durable_session() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let target_path = directory.path().join("sessions").join("target.oms");
	let resumed_path = directory.path().join("sessions").join("resumed.oms");
	std::fs::create_dir_all(target_path.parent().expect("session parent"))
		.expect("sessions directory");
	let mut target =
		Session::create(&target_path, ComponentRegistry::standard()).expect("durable load target");
	let image = target
		.store_attachment("image/png", b"switched image")
		.expect("target image");
	target.begin_turn().expect("target turn");
	target
		.user("loaded [Image #1]", vec![image])
		.expect("target image prompt");
	drop(target);
	drop(
		Session::create(&resumed_path, ComponentRegistry::standard()).expect("durable resume target"),
	);
	let (kernel, session, home) = harness(&directory, [Script::Text("written")]);
	let frames = exchange(
		kernel,
		session,
		home,
		br#"{"jsonrpc":"2.0","id":"init","method":"initialize","params":{"protocolVersion":1}}
{"jsonrpc":"2.0","id":"new","method":"session/new","params":{}}
{"jsonrpc":"2.0","id":"load","method":"session/load","params":{"sessionId":"target"}}
{"jsonrpc":"2.0","id":"resume","method":"session/resume","params":{"sessionId":"resumed"}}
{"jsonrpc":"2.0","id":"prompt","method":"session/prompt","params":{"prompt":"durable marker"}}
{"jsonrpc":"2.0","id":"shutdown","method":"shutdown","params":{}}
"#,
	)
	.await;

	let new_id = response(&frames, "new")["result"]["sessionId"]
		.as_str()
		.expect("new session id");
	assert_ne!(new_id, "startup");
	assert_ne!(new_id, "target");
	assert!(
		directory
			.path()
			.join("sessions")
			.join(format!("{new_id}.oms"))
			.exists()
	);
	assert!(
		response(&frames, "load")["result"]
			.get("sessionId")
			.is_none(),
		"ACP load response identifies the already-requested session implicitly",
	);
	assert!(
		response(&frames, "resume")["result"]
			.get("sessionId")
			.is_none(),
		"ACP resume response identifies the already-requested session implicitly",
	);
	assert_eq!(response(&frames, "load")["result"]["modes"]["currentModeId"], "default",);
	assert_eq!(response(&frames, "resume")["result"]["modes"]["currentModeId"], "default",);
	assert!(
		frames.iter().any(|frame| {
			frame["method"] == "session/update"
				&& frame["params"]["sessionId"] == "target"
				&& frame["params"]["update"]["sessionUpdate"] == "user_message_chunk"
				&& frame["params"]["update"]["content"]["type"] == "image"
				&& frame["params"]["update"]["content"]["data"]
					== omp_core::base64::encode(b"switched image").into_string()
		}),
		"loading a session resolves its image from that session's CAS: {frames:#?}"
	);

	let target =
		Session::open(&target_path, ComponentRegistry::standard()).expect("load target reopens");
	let target_snapshot = target.dom().snapshot();
	assert!(
		!String::from_utf8_lossy(target_snapshot.as_bytes()).contains("durable marker"),
		"resuming another session must switch authority away from the prior load target"
	);
	let resumed =
		Session::open(&resumed_path, ComponentRegistry::standard()).expect("resume target reopens");
	let resumed_snapshot = resumed.dom().snapshot();
	assert!(
		String::from_utf8_lossy(resumed_snapshot.as_bytes()).contains("durable marker"),
		"prompt must be journaled in the requested resumed session"
	);
}

/// `session/list` pages stored journals (newest first, offset cursor,
/// `cwd` scoping) and
/// `session/fork` copies a stored session into a fresh one that becomes the
/// authority, with both capabilities advertised by `initialize`.
#[tokio::test]
async fn list_and_fork_expose_stored_sessions() {
	let directory = tempfile::tempdir().expect("temporary directory");
	let sessions = directory.path().join("sessions");
	std::fs::create_dir_all(&sessions).expect("sessions directory");
	let source_path = sessions.join("source.oms");
	{
		let mut source =
			Session::create(&source_path, ComponentRegistry::standard()).expect("stored source");
		source.begin_turn().expect("turn");
		source
			.user("remember the fixture", Vec::new())
			.expect("stored prompt");
	}
	let (kernel, session, home) = harness(&directory, [Script::Text("forked reply")]);
	let frames = exchange(
		kernel,
		session,
		home,
		br#"{"jsonrpc":"2.0","id":"init","method":"initialize","params":{"protocolVersion":1}}
{"jsonrpc":"2.0","id":"list","method":"session/list","params":{}}
{"jsonrpc":"2.0","id":"page","method":"session/list","params":{"cursor":"1"}}
{"jsonrpc":"2.0","id":"elsewhere","method":"session/list","params":{"cwd":"/nonexistent/elsewhere"}}
{"jsonrpc":"2.0","id":"badcursor","method":"session/list","params":{"cursor":"later"}}
{"jsonrpc":"2.0","id":"fork","method":"session/fork","params":{"sessionId":"source"}}
{"jsonrpc":"2.0","id":"prompt","method":"session/prompt","params":{"prompt":"in the fork"}}
{"jsonrpc":"2.0","id":"after","method":"session/list","params":{}}
{"jsonrpc":"2.0","id":"shutdown","method":"shutdown","params":{}}
"#,
	)
	.await;

	let capabilities =
		&response(&frames, "init")["result"]["agentCapabilities"]["sessionCapabilities"];
	assert!(capabilities.get("list").is_some() && capabilities.get("fork").is_some());

	let listed = response(&frames, "list")["result"].clone();
	let ids = |page: &Value| {
		page["sessions"]
			.as_array()
			.expect("sessions array")
			.iter()
			.map(|row| row["sessionId"].as_str().expect("id").to_owned())
			.collect::<Vec<_>>()
	};
	let mut all = ids(&listed);
	all.sort();
	assert_eq!(all, ["source", "startup"]);
	assert!(listed.get("nextCursor").is_none(), "two rows fit one page");
	let source_row = listed["sessions"]
		.as_array()
		.expect("sessions")
		.iter()
		.find(|row| row["sessionId"] == "source")
		.expect("source row");
	assert_eq!(source_row["title"], "remember the fixture");
	assert_eq!(source_row["_meta"]["messageCount"], 1);
	assert!(
		source_row["_meta"]["size"]
			.as_u64()
			.is_some_and(|size| size > 0)
	);
	assert!(
		source_row["updatedAt"]
			.as_str()
			.is_some_and(|stamp| stamp.ends_with('Z') && stamp.contains('T'))
	);

	assert_eq!(ids(&response(&frames, "page")["result"]).len(), 1, "cursor skips one row");
	assert!(ids(&response(&frames, "elsewhere")["result"]).is_empty(), "cwd scoping");
	assert_eq!(response(&frames, "badcursor")["error"]["code"], -32602);

	let fork_id = response(&frames, "fork")["result"]["sessionId"]
		.as_str()
		.expect("fork id")
		.to_owned();
	assert_ne!(fork_id, "source");
	let fork_path = sessions.join(format!("{fork_id}.oms"));
	assert!(fork_path.exists());
	let mut after = ids(&response(&frames, "after")["result"]);
	after.sort();
	let mut expected = vec!["source".to_owned(), "startup".to_owned(), fork_id.clone()];
	expected.sort();
	assert_eq!(after, expected);

	let fork = Session::open(&fork_path, ComponentRegistry::standard()).expect("fork reopens");
	let fork_snapshot = String::from_utf8_lossy(fork.dom().snapshot().as_bytes()).into_owned();
	assert!(fork_snapshot.contains("remember the fixture"), "the fork carries its source's history");
	assert!(fork_snapshot.contains("in the fork"), "the fork is the authority for new prompts");
	let source = Session::open(&source_path, ComponentRegistry::standard()).expect("source reopens");
	assert!(
		!String::from_utf8_lossy(source.dom().snapshot().as_bytes()).contains("in the fork"),
		"the source is untouched by prompts in the fork"
	);
}
