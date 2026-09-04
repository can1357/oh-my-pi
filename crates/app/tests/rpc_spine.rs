//! RPC transport proof over a scripted journal-first kernel.

use std::{
	collections::VecDeque,
	future::ready,
	sync::{Arc, Mutex},
	time::SystemTime,
};

use omp_agent::{DispatchPolicy, Inference, Kernel, StaticPrompt};
use omp_ai::{
	BlockKind, ChatEvent, ChatRequest, ChatStream, Completion, ExecutionReceipt, FinishReason,
	ProviderId, RequestId, ResponseMeta, RouteId, Usage,
};
use omp_app::rpc_mode::RpcUiBridge;
use omp_core::Str;
use omp_driver::{headless::kernel::SessionHome, sessions::SessionRegistry};
use omp_journal::blob::BlobStore;
use omp_rpc::framing::{MAX_FRAME_BYTES, RpcFrameDecoder, encode_json_v2};
use omp_session::{ComponentRegistry, Session};
use omp_tool::Registry;
use omp_tools::ask::{AskPresenter as _, OptionItem, Question};
use serde_json::{Value, json};
use tokio::io::{AsyncBufReadExt as _, AsyncWriteExt as _, BufReader};

enum Script {
	Events(Vec<ChatEvent>),
	Pending,
}

struct ScriptedInference {
	scripts: Mutex<VecDeque<Script>>,
}

impl Inference for ScriptedInference {
	fn chat(
		&mut self,
		_request: ChatRequest,
	) -> impl Future<Output = Result<ChatStream, omp_ai::Error>> + Send {
		let stream = match self
			.scripts
			.get_mut()
			.expect("script mutex poisoned")
			.pop_front()
			.expect("one scripted turn")
		{
			Script::Events(events) => streaming(events),
			Script::Pending => ChatStream::ordinary(Box::pin(futures::stream::pending())),
		};
		ready(Ok(stream))
	}
}

fn streaming(events: Vec<ChatEvent>) -> ChatStream {
	let events = std::iter::once(ChatEvent::Started(ResponseMeta {
		request_id:          RequestId::from("rpc-script"),
		provider:            ProviderId::from("scripted"),
		route:               RouteId::from("scripted/test"),
		model:               None,
		provider_request_id: None,
		created_at:          SystemTime::UNIX_EPOCH,
	}))
	.chain(events)
	.map(Ok);
	ChatStream::ordinary(Box::pin(futures::stream::iter(events)))
}

fn scripted_kernel(
	temp: &tempfile::TempDir,
	scripts: VecDeque<Script>,
) -> Kernel<ScriptedInference> {
	let spill = BlobStore::open(temp.path().join("blobs")).expect("blob store");
	Kernel::new(
		ScriptedInference { scripts: Mutex::new(scripts) },
		Arc::new(Registry::new()),
		DispatchPolicy::new(spill),
		StaticPrompt(Str::new_static("system")),
	)
}

fn session_home(temp: &tempfile::TempDir, kernel: &Kernel<ScriptedInference>) -> SessionHome {
	SessionHome {
		sessions_dir:  temp.path().join("sessions"),
		project_root:  temp.path().to_path_buf(),
		model:         Str::new_static("scripted/test"),
		prompt:        Default::default(),
		facts:         Default::default(),
		live:          Arc::new(SessionRegistry::new()),
		tools_enabled: true,
		up:            kernel.mailbox(),
	}
}

fn completed_script(text: &'static str) -> Script {
	Script::Events(vec![
		ChatEvent::BlockStarted { index: 0, kind: BlockKind::Text },
		ChatEvent::TextDelta { index: 0, text: Str::new_static(text) },
		ChatEvent::Completed(Completion {
			reason:  FinishReason::Stop,
			blocks:  1,
			usage:   Usage::default(),
			receipt: ExecutionReceipt::default().into(),
		}),
	])
}

#[tokio::test]
async fn rpc_prompt_is_acknowledged_then_emits_one_terminal_agent_end() {
	let temp = tempfile::tempdir().expect("tempdir");
	let kernel = scripted_kernel(&temp, VecDeque::from([completed_script("pong")]));
	let home = session_home(&temp, &kernel);
	let session =
		Session::create(temp.path().join("rpc.oms"), ComponentRegistry::standard()).expect("session");
	let (client_io, server_io) = tokio::io::duplex(64 * 1024);
	let (server_read, server_write) = tokio::io::split(server_io);
	let server =
		omp_app::rpc_mode::serve_rpc(kernel, session, home, None, server_read, server_write);
	let client = async move {
		let (client_read, mut client_write) = tokio::io::split(client_io);
		client_write
			.write_all(b"{\"id\":\"1\",\"type\":\"prompt\",\"message\":\"ping\"}\n")
			.await
			.expect("prompt");
		let mut lines = BufReader::new(client_read).lines();
		let mut frames = Vec::<Value>::new();
		while let Some(line) = lines.next_line().await.expect("response") {
			let frame: Value = serde_json::from_str(&line).expect("json response");
			let terminal = frame["type"] == "agent_end";
			frames.push(frame);
			if terminal {
				client_write
					.write_all(b"{\"id\":\"2\",\"type\":\"quit\"}\n")
					.await
					.expect("quit");
				client_write.shutdown().await.expect("shutdown");
			}
		}
		frames
	};
	let (server, frames) = tokio::join!(server, client);
	server.expect("server");
	assert!(
		frames.iter().any(|frame| frame["type"] == "message_start"),
		"RPC projects session mutations into public message events, not private DOM patches",
	);
	assert!(
		!frames.iter().any(|frame| frame["event"] == "patch@1"),
		"private journal patches are not part of the public RPC event stream",
	);
	let prompt = frames
		.iter()
		.find(|frame| frame["type"] == "response" && frame["id"] == "1")
		.expect("prompt acceptance");
	assert_eq!(prompt["data"]["accepted"], true);
	let terminal = frames
		.iter()
		.filter(|frame| frame["type"] == "agent_end")
		.collect::<Vec<_>>();
	assert_eq!(terminal.len(), 1, "one canonical terminal frame");
	assert_eq!(terminal[0]["text"], "pong");
}

#[tokio::test]
async fn rpc_reader_dispatches_cancel_while_turn_is_pending() {
	let temp = tempfile::tempdir().expect("tempdir");
	let kernel = scripted_kernel(&temp, VecDeque::from([Script::Pending]));
	let home = session_home(&temp, &kernel);
	let session =
		Session::create(temp.path().join("rpc.oms"), ComponentRegistry::standard()).expect("session");
	let (client_io, server_io) = tokio::io::duplex(64 * 1024);
	let (server_read, server_write) = tokio::io::split(server_io);
	let server =
		omp_app::rpc_mode::serve_rpc(kernel, session, home, None, server_read, server_write);
	let client = async move {
		let (client_read, mut client_write) = tokio::io::split(client_io);
		client_write
			.write_all(
				b"{\"id\":\"prompt\",\"type\":\"prompt\",\"message\":\"wait\"}\n{\"id\":\"cancel\",\"type\":\"cancel\"}\n",
			)
			.await
			.expect("live requests");
		let mut lines = BufReader::new(client_read).lines();
		let mut frames = Vec::<Value>::new();
		while let Some(line) = lines.next_line().await.expect("response") {
			let frame: Value = serde_json::from_str(&line).expect("json response");
			let terminal = frame["type"] == "agent_end";
			frames.push(frame);
			if terminal {
				client_write
					.write_all(b"{\"id\":\"quit\",\"type\":\"quit\"}\n")
					.await
					.expect("quit");
				client_write.shutdown().await.expect("shutdown");
			}
		}
		frames
	};
	let (server, frames) = tokio::time::timeout(std::time::Duration::from_secs(2), async {
		tokio::join!(server, client)
	})
	.await
	.expect("live cancel must not wait for inference");
	server.expect("server");
	assert!(frames.iter().any(|frame| {
		frame["type"] == "response" && frame["id"] == "cancel" && frame["success"] == true
	}));
	let terminal = frames
		.iter()
		.filter(|frame| frame["type"] == "agent_end")
		.collect::<Vec<_>>();
	assert_eq!(terminal.len(), 1);
	assert_eq!(terminal[0]["cancelled"], true);
}

/// Runs one scripted RPC conversation: `initial` is written up front; every
/// `agent_end` frame is answered by the next request in `after_turns` (the
/// last one should quit). Returns every frame the server emitted.
async fn converse(
	temp: &tempfile::TempDir,
	scripts: VecDeque<Script>,
	initial: &'static str,
	after_turns: &'static [&'static str],
) -> Vec<Value> {
	let kernel = scripted_kernel(temp, scripts);
	let home = session_home(temp, &kernel);
	let session =
		Session::create(temp.path().join("rpc.oms"), ComponentRegistry::standard()).expect("session");
	let (client_io, server_io) = tokio::io::duplex(64 * 1024);
	let (server_read, server_write) = tokio::io::split(server_io);
	let server =
		omp_app::rpc_mode::serve_rpc(kernel, session, home, None, server_read, server_write);
	let client = async move {
		let (client_read, mut client_write) = tokio::io::split(client_io);
		client_write
			.write_all(initial.as_bytes())
			.await
			.expect("initial requests");
		let mut lines = BufReader::new(client_read).lines();
		let mut frames = Vec::<Value>::new();
		let mut pending = after_turns.iter();
		while let Some(line) = lines.next_line().await.expect("response") {
			let frame: Value = serde_json::from_str(&line).expect("json response");
			let terminal = frame["type"] == "agent_end";
			frames.push(frame);
			if terminal && let Some(request) = pending.next() {
				client_write
					.write_all(request.as_bytes())
					.await
					.expect("follow-on request");
				if pending.as_slice().is_empty() {
					client_write.shutdown().await.expect("shutdown");
				}
			}
		}
		frames
	};
	let (server, frames) = tokio::time::timeout(std::time::Duration::from_secs(5), async {
		tokio::join!(server, client)
	})
	.await
	.expect("RPC conversation must settle");
	server.expect("server");
	frames
}

fn agent_ends(frames: &[Value]) -> Vec<&Value> {
	frames
		.iter()
		.filter(|frame| frame["type"] == "agent_end")
		.collect()
}

fn response<'a>(frames: &'a [Value], id: &str) -> &'a Value {
	frames
		.iter()
		.find(|frame| frame["type"] == "response" && frame["id"] == id)
		.unwrap_or_else(|| panic!("missing response {id}: {frames:#?}"))
}

/// `follow_up`: behind a running turn the message is queued (not
/// steering) and runs as its own turn once the agent yields; idle, it runs
/// immediately. Each follow-up produces a `turn_start` and one `agent_end`.
#[tokio::test]
async fn rpc_follow_up_runs_after_the_turn_yields_and_immediately_when_idle() {
	let temp = tempfile::tempdir().expect("tempdir");
	let frames = converse(
		&temp,
		VecDeque::from([Script::Pending, completed_script("second"), completed_script("third")]),
		"{\"id\":\"prompt\",\"type\":\"prompt\",\"message\":\"wait\"}\n{\"id\":\"queue\",\"type\":\"\
		 follow_up\",\"message\":\"later\"}\n{\"id\":\"abort\",\"type\":\"abort\"}\n",
		&[
			"",
			"{\"id\":\"idle\",\"type\":\"follow_up\",\"message\":\"now\"}\n",
			"{\"id\":\"quit\",\"type\":\"quit\"}\n",
		],
	)
	.await;
	let queued = response(&frames, "queue");
	assert_eq!(queued["success"], true);
	assert_eq!(queued["data"]["queued"], true, "behind a turn the follow-up is queued");
	let idle = response(&frames, "idle");
	assert_eq!(idle["success"], true);
	assert_eq!(idle["data"]["queued"], false, "idle, the follow-up runs at once");
	let ends = agent_ends(&frames);
	assert_eq!(ends.len(), 3, "aborted prompt, queued follow-up, idle follow-up: {frames:#?}");
	assert_eq!(ends[0]["cancelled"], true);
	assert_eq!(ends[1]["text"], "second");
	assert_eq!(ends[2]["text"], "third");
	assert_eq!(
		frames
			.iter()
			.filter(|frame| frame["type"] == "turn_start")
			.count(),
		3,
		"every started turn announces itself"
	);
	// The queued follow-up was journaled as `<prompt kind=queued>` and popped
	// (`sent`) rather than injected as steering.
	let session = Session::open(temp.path().join("rpc.oms"), ComponentRegistry::standard())
		.expect("journal reopens");
	let dom = session.dom();
	let prompts = omp_session::components::prompts::prompts_handle(dom).expect("prompt queue");
	let statuses: Vec<_> = dom
		.children(prompts)
		.iter()
		.filter_map(|handle| dom.get(*handle))
		.filter_map(|node| {
			node
				.prop(&omp_dom::PropKey::from(omp_dom::PropId::Status))
				.and_then(omp_dom::Value::as_str)
				.map(str::to_owned)
		})
		.collect();
	assert_eq!(statuses, ["sent"]);
}

/// `abort_and_prompt`: the running turn is interrupted and the new prompt
/// starts as soon as the session comes back, ahead of anything queued.
#[tokio::test]
async fn rpc_abort_and_prompt_interrupts_then_starts_the_new_turn() {
	let temp = tempfile::tempdir().expect("tempdir");
	let frames = converse(
		&temp,
		VecDeque::from([Script::Pending, completed_script("replacement")]),
		"{\"id\":\"prompt\",\"type\":\"prompt\",\"message\":\"wait\"}\n{\"id\":\"swap\",\"type\":\"\
		 abort_and_prompt\",\"message\":\"instead\"}\n",
		&["", "{\"id\":\"quit\",\"type\":\"quit\"}\n"],
	)
	.await;
	assert_eq!(response(&frames, "swap")["success"], true);
	let ends = agent_ends(&frames);
	assert_eq!(ends.len(), 2, "{frames:#?}");
	assert_eq!(ends[0]["cancelled"], true);
	assert_eq!(ends[1]["text"], "replacement");
	assert_eq!(ends[1]["cancelled"], false);
}

/// `get_state` works while streaming; the actor's replica serves the
/// tree even though the running turn owns the session.
#[tokio::test]
async fn rpc_get_state_answers_while_a_turn_is_running() {
	let temp = tempfile::tempdir().expect("tempdir");
	let frames = converse(
		&temp,
		VecDeque::from([Script::Pending]),
		"{\"id\":\"prompt\",\"type\":\"prompt\",\"message\":\"wait\"}\n{\"id\":\"state\",\"type\":\"\
		 get_state\"}\n{\"id\":\"abort\",\"type\":\"abort\"}\n",
		&["{\"id\":\"quit\",\"type\":\"quit\"}\n"],
	)
	.await;
	let state = response(&frames, "state");
	assert_eq!(state["success"], true, "get_state must not report SESSION_BUSY: {state}");
	assert!(state["data"].is_object(), "state carries the session snapshot: {state}");
	let position = |id: &str| {
		frames
			.iter()
			.position(|frame| frame["type"] == "response" && frame["id"] == id)
			.expect("response order")
	};
	assert!(
		position("state") < position("abort"),
		"the state answer arrives while the turn is still running"
	);
}

#[tokio::test]
async fn rpc_v2_reassembles_large_requests_and_chunks_large_responses() {
	let temp = tempfile::tempdir().expect("tempdir");
	let kernel = scripted_kernel(&temp, VecDeque::new());
	let home = session_home(&temp, &kernel);
	let mut session =
		Session::create(temp.path().join("rpc.oms"), ComponentRegistry::standard()).expect("session");
	// The logical snapshot exceeds one physical RPC frame while each journal
	// entry remains below the journal's independently bounded frame size.
	for _ in 0..20 {
		session.begin_turn().expect("turn");
		session
			.user(Str::new("x".repeat(64 * 1024)), Vec::new())
			.expect("bounded durable message");
	}
	let (client_io, server_io) = tokio::io::duplex(64 * 1024);
	let (server_read, server_write) = tokio::io::split(server_io);
	let server =
		omp_app::rpc_mode::serve_rpc(kernel, session, home, None, server_read, server_write);
	let client = async move {
		let (client_read, mut client_write) = tokio::io::split(client_io);
		let writer = async move {
			client_write
				.write_all(
					b"{\"id\":\"negotiate\",\"type\":\"negotiate_protocol\",\"protocolVersion\":2}\n",
				)
				.await
				.expect("negotiate");
			let request = json!({
				"id": "large",
				"type": "get_messages",
				"padding": "y".repeat(MAX_FRAME_BYTES + 16 * 1024),
			});
			for frame in encode_json_v2(&request, "request").expect("chunk request") {
				client_write.write_all(&frame).await.expect("request chunk");
			}
			client_write
				.write_all(b"{\"id\":\"quit\",\"type\":\"quit\"}\n")
				.await
				.expect("quit");
			client_write.shutdown().await.expect("shutdown");
		};
		let reader = async move {
			let mut lines = BufReader::new(client_read).lines();
			let mut logical = RpcFrameDecoder::new();
			let mut values = Vec::new();
			let mut chunks = 0;
			while let Some(line) = lines.next_line().await.expect("response") {
				let physical: Value = serde_json::from_str(&line).expect("physical JSON");
				chunks += usize::from(physical["type"] == "rpc_chunk");
				if let Some(value) = logical.push_frame(line.as_bytes()).expect("logical frame") {
					values.push(value);
				}
			}
			(values, chunks)
		};
		let ((), result) = tokio::join!(writer, reader);
		result
	};
	let (server, (frames, chunks)) = tokio::join!(server, client);
	server.expect("server");
	assert!(chunks > 1, "large response must use physical v2 chunks");
	let response = frames
		.iter()
		.find(|frame| frame["type"] == "response" && frame["id"] == "large")
		.expect("reassembled get_messages response");
	assert_eq!(response["success"], true);
	assert!(
		serde_json::to_vec(&response["data"])
			.expect("snapshot JSON")
			.len() > MAX_FRAME_BYTES
	);
}

#[tokio::test]
async fn rpc_session_commands_publish_reset_snapshots() {
	let temp = tempfile::tempdir().expect("tempdir");
	let kernel = scripted_kernel(&temp, VecDeque::new());
	let home = session_home(&temp, &kernel);
	std::fs::create_dir_all(&home.sessions_dir).expect("sessions directory");
	let source_path = home.sessions_dir.join("source.oms");
	let mut session = Session::create(&source_path, ComponentRegistry::standard()).expect("session");
	session.begin_turn().expect("turn");
	let branch_at = session
		.user("branch point", Vec::new())
		.expect("user entry");
	let (client_io, server_io) = tokio::io::duplex(64 * 1024);
	let (server_read, server_write) = tokio::io::split(server_io);
	let server =
		omp_app::rpc_mode::serve_rpc(kernel, session, home, None, server_read, server_write);
	let client = async move {
		let (client_read, mut client_write) = tokio::io::split(client_io);
		let requests = format!(
			"{{\"id\":\"new\",\"type\":\"new_session\"}}\n{{\"id\":\"switch\",\"type\":\"\
			 switch_session\",\"sessionPath\":{}}}\n{{\"id\":\"branch\",\"type\":\"branch\",\"\
			 entryId\":\"{}\"}}\n{{\"id\":\"quit\",\"type\":\"quit\"}}\n",
			serde_json::to_string(&source_path).expect("path JSON"),
			branch_at,
		);
		client_write
			.write_all(requests.as_bytes())
			.await
			.expect("session commands");
		client_write.shutdown().await.expect("shutdown");
		let mut lines = BufReader::new(client_read).lines();
		let mut frames = Vec::<Value>::new();
		while let Some(line) = lines.next_line().await.expect("response") {
			frames.push(serde_json::from_str(&line).expect("json response"));
		}
		frames
	};
	let (server, frames) = tokio::join!(server, client);
	server.expect("server");
	for id in ["new", "switch", "branch"] {
		assert!(
			frames.iter().any(|frame| {
				frame["type"] == "response" && frame["id"] == id && frame["success"] == true
			}),
			"missing successful {id} response"
		);
	}
	assert_eq!(
		frames
			.iter()
			.filter(|frame| frame["type"] == "session_start")
			.count(),
		3,
		"one public lifecycle event per transition",
	);
	assert!(
		!frames.iter().any(|frame| frame["type"] == "snapshot"),
		"the controller's private DOM snapshot is not an RPC event",
	);
}

#[tokio::test]
async fn rpc_ui_routes_retained_select_dialogs_and_responses() {
	let temp = tempfile::tempdir().expect("tempdir");
	let kernel = scripted_kernel(&temp, VecDeque::new());
	let home = session_home(&temp, &kernel);
	let session =
		Session::create(temp.path().join("rpc.oms"), ComponentRegistry::standard()).expect("session");
	let ui = RpcUiBridge::new();
	let presenter = {
		let ui = ui.clone();
		tokio::spawn(async move {
			ui.present(
				&[Question {
					id:          Str::new_static("choice"),
					question:    Str::new_static("Choose"),
					header:      None,
					options:     vec![OptionItem {
						label:       Str::new_static("A"),
						description: Some(Str::new_static("first")),
						preview:     None,
					}],
					multi:       false,
					recommended: Some(0),
				}],
				Some("call-ui"),
			)
			.await
		})
	};
	let (client_io, server_io) = tokio::io::duplex(64 * 1024);
	let (server_read, server_write) = tokio::io::split(server_io);
	let server =
		omp_app::rpc_mode::serve_rpc(kernel, session, home, Some(ui), server_read, server_write);
	let client = async move {
		let (client_read, mut client_write) = tokio::io::split(client_io);
		let mut lines = BufReader::new(client_read).lines();
		let mut request = None;
		while let Some(line) = lines.next_line().await.expect("UI request") {
			let frame: Value = serde_json::from_str(&line).expect("json response");
			if frame["type"] == "extension_ui_request" {
				request = Some(frame.clone());
				let response = json!({
					"id": frame["id"],
					"type": "extension_ui_response",
					"value": "A",
				});
				client_write
					.write_all(format!("{response}\n").as_bytes())
					.await
					.expect("UI response");
				client_write
					.write_all(b"{\"id\":\"quit\",\"type\":\"quit\"}\n")
					.await
					.expect("quit");
				client_write.shutdown().await.expect("shutdown");
			}
		}
		request.expect("retained UI request")
	};
	let (server, request, presentation) = tokio::join!(server, client, presenter);
	server.expect("server");
	assert_eq!(request["method"], "select");
	assert_eq!(request["allowOther"], true);
	assert_eq!(request["recommended"], 0);
	let presentation = presentation
		.expect("presenter task")
		.expect("dialog answer");
	assert_eq!(presentation.selections[0].selected, [Str::new_static("A")]);
}
