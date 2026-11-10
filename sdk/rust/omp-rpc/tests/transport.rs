//! Transport tests against a scripted server on in-memory pipes.

use std::{
	io::{BufRead, BufReader, PipeReader, PipeWriter, Write},
	sync::{
		Arc, Mutex,
		atomic::{AtomicUsize, Ordering},
		mpsc::{self, Receiver},
	},
	thread,
	time::Duration,
};

use omp_rpc::*;
use serde_json::{Map, Value, json};

const CHUNK: usize = 256 * 1024;

struct Server {
	out:   PipeWriter,
	input: BufReader<PipeReader>,
}

impl Server {
	fn send(&mut self, frame: &Value) {
		let mut line = serde_json::to_vec(frame).unwrap();
		line.push(b'\n');
		// The client may already have closed after a fatal frame.
		let _ = self.out.write_all(&line);
	}

	fn recv(&mut self) -> Value {
		let mut line = String::new();
		assert!(self.input.read_line(&mut line).unwrap() > 0, "client closed its stdin");
		serde_json::from_str(&line).unwrap()
	}

	fn respond(&mut self, request: &Value, data: Value) {
		self.send(&json!({"type": "response", "id": request["id"], "command": request["type"], "success": true, "data": data}));
	}

	fn fail(&mut self, request: &Value, error: &str, code: &str) {
		self.send(&json!({"type": "response", "id": request["id"], "command": request["type"], "success": false, "error": error, "code": code}));
	}

	fn expect(&mut self, command: &str) -> Value {
		let frame = self.recv();
		assert_eq!(frame["type"], command, "{frame}");
		frame
	}
}

fn ready_v2() -> Value {
	json!({"type": "ready", "protocolVersion": 1, "supportedProtocolVersions": [1, 2], "maxFrameBytes": 1_048_576, "maxReassembledFrameBytes": 67_108_864})
}

fn ready_v1() -> Value {
	json!({"type": "ready"})
}

fn connect(ready: Value, tools: Vec<HostTool>) -> (Client, Receiver<Event>, Server) {
	connect_with(ready, tools, Vec::new())
}

fn connect_with(
	ready: Value,
	tools: Vec<HostTool>,
	uris: Vec<HostUri>,
) -> (Client, Receiver<Event>, Server) {
	let (client_read, server_write) = std::io::pipe().unwrap();
	let (server_read, client_write) = std::io::pipe().unwrap();
	let mut server = Server { out: server_write, input: BufReader::new(server_read) };
	let names: Vec<String> = tools
		.iter()
		.map(|tool| tool.definition().name.clone())
		.collect();
	let schemes: Vec<String> = uris.iter().map(|uri| uri.scheme().to_owned()).collect();
	let options = ClientOptions {
		tools,
		uris,
		ready_timeout: Duration::from_secs(5),
		default_timeout: Duration::from_secs(5),
	};
	let handle = thread::spawn(move || Client::from_io(client_read, client_write, options));
	let negotiates = ready == ready_v2();
	server.send(&ready);
	if negotiates {
		let frame = server.expect("negotiate_protocol");
		assert_eq!(frame["protocolVersion"], 2);
		server.respond(&frame, json!({"protocolVersion": 2}));
	}
	if !names.is_empty() {
		let frame = server.expect("set_host_tools");
		server.respond(&frame, json!({"toolNames": names}));
	}
	if !schemes.is_empty() {
		let frame = server.expect("set_host_uri_schemes");
		server.respond(&frame, json!({"schemes": schemes}));
	}
	let (client, events) = handle.join().unwrap().unwrap();
	(client, events, server)
}

fn encode_base64(bytes: &[u8]) -> String {
	const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
	let mut out = String::new();
	for group in bytes.chunks(3) {
		let bits = group
			.iter()
			.enumerate()
			.fold(0u32, |bits, (index, &byte)| bits | u32::from(byte) << (16 - 8 * index));
		for index in 0..4 {
			out.push(if index <= group.len() {
				ALPHABET[(bits >> (18 - 6 * index) & 0x3f) as usize] as char
			} else {
				'='
			});
		}
	}
	out
}

/// An unknown-type notification whose JSON encoding is exactly `size` bytes.
fn big_frame(size: usize) -> Vec<u8> {
	let empty = br#"{"type":"big","pad":""}"#.len();
	let frame = json!({"type": "big", "pad": "x".repeat(size - empty)});
	let bytes = serde_json::to_vec(&frame).unwrap();
	assert_eq!(bytes.len(), size);
	bytes
}

fn chunks(id: &str, bytes: &[u8]) -> Vec<Value> {
	let count = bytes.len().div_ceil(CHUNK);
	bytes
        .chunks(CHUNK)
        .enumerate()
        .map(|(index, part)| {
            json!({"type": "rpc_chunk", "chunkId": id, "index": index, "count": count, "byteLength": bytes.len(), "data": encode_base64(part)})
        })
        .collect()
}

/// Next event that is not `ready`.
fn next_event(events: &Receiver<Event>) -> Event {
	loop {
		match events.recv_timeout(Duration::from_secs(5)).expect("event") {
			Event::Notification(RpcNotification::Ready(_)) => {},
			event => return event,
		}
	}
}

/// Waits until the reader stops, then returns the error a call reports.
fn fatal_error(client: &Client, events: &Receiver<Event>) -> String {
	while events.recv_timeout(Duration::from_secs(5)).is_ok() {}
	match client.call(&GetStateCommand {}) {
		Err(Error::Protocol(message)) => message,
		other => panic!("expected a protocol error, got {other:?}"),
	}
}

// ---- chunk decoder ----

#[test]
fn chunked_frame_of_exactly_one_mib_is_reassembled() {
	let (_client, events, mut server) = connect(ready_v2(), Vec::new());
	let bytes = big_frame(1_048_576);
	for chunk in chunks("c1", &bytes) {
		server.send(&chunk);
	}
	let Event::Notification(RpcNotification::Unknown(raw)) = next_event(&events) else {
		panic!("no frame")
	};
	assert_eq!(serde_json::to_vec(&raw).unwrap(), bytes);
}

#[test]
fn larger_chunked_frame_is_reassembled() {
	let (_client, events, mut server) = connect(ready_v2(), Vec::new());
	let bytes = big_frame(1_500_001);
	let sequence = chunks("c2", &bytes);
	assert_eq!(sequence.len(), 6);
	for chunk in sequence {
		server.send(&chunk);
	}
	let Event::Notification(RpcNotification::Unknown(raw)) = next_event(&events) else {
		panic!("no frame")
	};
	assert_eq!(raw["pad"].as_str().unwrap().len(), 1_500_001 - 23);
}

#[test]
fn interleaved_chunk_sequence_is_fatal() {
	let (client, events, mut server) = connect(ready_v2(), Vec::new());
	let sequence = chunks("c1", &big_frame(1_048_576));
	server.send(&sequence[0]);
	server.send(&json!({"type": "agent_start"}));
	assert_eq!(fatal_error(&client, &events), "RPC chunk sequence was interrupted");
}

#[test]
fn other_chunk_id_inside_a_sequence_is_fatal() {
	let (client, events, mut server) = connect(ready_v2(), Vec::new());
	let bytes = big_frame(1_048_576);
	server.send(&chunks("c1", &bytes)[0]);
	server.send(&chunks("c2", &bytes)[1]);
	assert_eq!(fatal_error(&client, &events), "RPC chunk sequence mismatch");
}

#[test]
fn out_of_order_chunk_is_fatal() {
	let (client, events, mut server) = connect(ready_v2(), Vec::new());
	let sequence = chunks("c1", &big_frame(1_048_576));
	server.send(&sequence[0]);
	server.send(&sequence[2]);
	assert_eq!(fatal_error(&client, &events), "RPC chunk sequence mismatch");
}

#[test]
fn sequence_not_starting_at_zero_is_fatal() {
	let (client, events, mut server) = connect(ready_v2(), Vec::new());
	server.send(&chunks("c1", &big_frame(1_048_576))[1]);
	assert_eq!(fatal_error(&client, &events), "RPC chunk sequence must start at index 0");
}

#[test]
fn non_canonical_base64_is_fatal() {
	let (client, events, mut server) = connect(ready_v2(), Vec::new());
	let mut chunk = chunks("c1", &big_frame(1_048_576))[0].clone();
	// "Zm9=" decodes to "fo" but its canonical encoding is "Zm8=".
	chunk["data"] = json!("Zm9=");
	server.send(&chunk);
	assert_eq!(fatal_error(&client, &events), "Invalid RPC chunk data");
}

#[test]
fn oversized_chunk_payload_is_fatal() {
	let (client, events, mut server) = connect(ready_v2(), Vec::new());
	let bytes = big_frame(1_048_576);
	let chunk = json!({"type": "rpc_chunk", "chunkId": "c1", "index": 0, "count": 4, "byteLength": bytes.len(), "data": encode_base64(&bytes[..CHUNK + 1])});
	server.send(&chunk);
	assert_eq!(fatal_error(&client, &events), "RPC chunk payload exceeds the transport limit");
}

#[test]
fn invalid_chunk_metadata_is_fatal() {
	for (key, value) in [
		("index", json!(true)),
		("count", json!(1)),
		("byteLength", json!(1_048_575)),
		("count", json!(257)),
		("index", json!(0.0)),
	] {
		let (client, events, mut server) = connect(ready_v2(), Vec::new());
		let mut chunk = chunks("c1", &big_frame(1_048_576))[0].clone();
		chunk[key] = value;
		server.send(&chunk);
		assert_eq!(fatal_error(&client, &events), "Invalid RPC chunk metadata", "{key}");
	}
}

#[test]
fn chunk_before_negotiation_is_fatal() {
	let (client, events, mut server) = connect(ready_v1(), Vec::new());
	assert_eq!(client.protocol_version(), 1);
	server.send(&chunks("c1", &big_frame(1_048_576))[0]);
	assert_eq!(fatal_error(&client, &events), "RPC chunk received before protocol negotiation");
}

#[test]
fn fatal_error_fails_a_pending_call() {
	let (client, _events, mut server) = connect(ready_v2(), Vec::new());
	let probe = thread::spawn(move || {
		server.expect("get_state");
		server.send(&json!({"type": "rpc_chunk"}));
		server
	});
	let error = client.call(&GetStateCommand {}).unwrap_err();
	assert!(
		matches!(&error, Error::Protocol(message) if message == "Invalid RPC chunk metadata"),
		"{error:?}"
	);
	drop(probe.join().unwrap());
}

// ---- negotiation ----

#[test]
fn negotiates_v2_with_the_advertised_limits() {
	let (client, _events, _server) = connect(ready_v2(), Vec::new());
	assert_eq!(client.protocol_version(), 2);
}

#[test]
fn stays_on_v1_unless_limits_match_exactly() {
	for ready in [
		json!({"type": "ready", "supportedProtocolVersions": [1, 2], "maxFrameBytes": 2_097_152, "maxReassembledFrameBytes": 67_108_864}),
		json!({"type": "ready", "supportedProtocolVersions": [1, 2], "maxFrameBytes": 1_048_576}),
		json!({"type": "ready", "supportedProtocolVersions": [1], "maxFrameBytes": 1_048_576, "maxReassembledFrameBytes": 67_108_864}),
		ready_v1(),
	] {
		let (client, _events, mut server) = connect(ready, Vec::new());
		assert_eq!(client.protocol_version(), 1);
		let probe = thread::spawn(move || {
			// The first frame after ready is the caller's command, not negotiate_protocol.
			let frame = server.expect("get_last_assistant_text");
			server.respond(&frame, json!({"text": null}));
		});
		assert_eq!(client.call(&GetLastAssistantTextCommand {}).unwrap(), None);
		probe.join().unwrap();
	}
}

#[test]
fn failed_negotiation_fails_startup() {
	let (client_read, server_write) = std::io::pipe().unwrap();
	let (server_read, client_write) = std::io::pipe().unwrap();
	let mut server = Server { out: server_write, input: BufReader::new(server_read) };
	let handle =
		thread::spawn(move || Client::from_io(client_read, client_write, ClientOptions::default()));
	server.send(&ready_v2());
	let frame = server.expect("negotiate_protocol");
	server.respond(&frame, json!({"protocolVersion": 1}));
	assert!(matches!(handle.join().unwrap(), Err(Error::Protocol(_))));
}

// ---- prompt_and_wait ----

fn prompt(message: &str) -> PromptCommand {
	PromptCommand {
		message:            message.to_owned(),
		images:             None,
		streaming_behavior: None,
		client_message_id:  None,
	}
}

fn user(text: &str) -> Value {
	json!({"role": "user", "content": text, "timestamp": 1})
}

fn assistant(text: &str) -> Value {
	json!({"role": "assistant", "content": [{"type": "thinking", "thinking": "hmm"}, {"type": "text", "text": text}], "api": "x", "provider": "p", "model": "m", "usage": {}, "stopReason": "stop", "timestamp": 2})
}

#[test]
fn prompt_wait_ends_on_its_own_result_only() {
	let (client, events, mut server) = connect(ready_v2(), Vec::new());
	let script = thread::spawn(move || {
		let frame = server.expect("prompt");
		assert_eq!(frame["message"], "hi");
		let id = frame["id"].clone();
		// The result may precede the acknowledgement; stale frames precede both.
		server.send(&json!({"type": "agent_end", "messages": [assistant("stale")]}));
		server.send(&json!({"type": "prompt_result", "id": "other", "agentInvoked": true, "status": "completed", "sessionSettled": false}));
		server.respond(&frame, json!({"agentInvoked": true}));
		server.send(&json!({"type": "agent_start"}));
		server.send(&json!({"type": "message_end", "message": user("hi")}));
		server.send(&json!({"type": "message_end", "message": assistant("hello")}));
		server.send(&json!({"type": "agent_end", "messages": [user("hi"), assistant("hello")]}));
		server.send(&json!({"type": "prompt_result", "id": id, "agentInvoked": true, "status": "completed", "sessionSettled": true}));
		server
	});
	let turn = client
		.prompt_and_wait(&prompt("hi"), Duration::from_secs(5))
		.unwrap();
	let _server = script.join().unwrap();
	assert_eq!(turn.events.len(), 5);
	assert!(matches!(turn.events[0], RpcAgentEvent::AgentEnd(_)));
	assert_eq!(turn.messages.len(), 2);
	assert_eq!(turn.assistant_text.as_deref(), Some("hello"));
	let result = turn.result.unwrap();
	assert_eq!(result.status, PromptStatus::Completed);
	assert!(result.session_settled);
	// Events still reach the event stream.
	let delivered = events
		.try_iter()
		.filter(|event| matches!(event, Event::Notification(RpcNotification::RpcAgentEvent(_))))
		.count();
	assert_eq!(delivered, 5);
}

#[test]
fn prompt_wait_returns_immediately_without_the_agent() {
	let (client, _events, mut server) = connect(ready_v2(), Vec::new());
	let script = thread::spawn(move || {
		let frame = server.expect("prompt");
		server.respond(&frame, json!({"agentInvoked": false}));
		server
	});
	let turn = client
		.prompt_and_wait(&prompt("/help"), Duration::from_secs(5))
		.unwrap();
	let _server = script.join().unwrap();
	assert_eq!(turn.result, None);
	assert!(turn.events.is_empty());
	assert_eq!(turn.assistant_text, None);
}

#[test]
fn prompt_wait_fails_on_a_late_error_response() {
	let (client, _events, mut server) = connect(ready_v2(), Vec::new());
	let script = thread::spawn(move || {
		let frame = server.expect("prompt");
		server.respond(&frame, json!({"agentInvoked": true}));
		server.fail(&frame, "model exploded", "prompt_failed");
		server
	});
	let error = client
		.prompt_and_wait(&prompt("hi"), Duration::from_secs(5))
		.unwrap_err();
	let _server = script.join().unwrap();
	assert!(
		matches!(&error, Error::Command { command, error, code } if command == "prompt" && error == "model exploded" && code.as_deref() == Some("prompt_failed")),
		"{error:?}"
	);
}

#[test]
fn prompt_wait_times_out_and_reports_closure() {
	let (client, _events, mut server) = connect(ready_v2(), Vec::new());
	let script = thread::spawn(move || {
		let frame = server.expect("prompt");
		server.respond(&frame, json!({"agentInvoked": true}));
		server
	});
	let error = client
		.prompt_and_wait(&prompt("hi"), Duration::from_millis(200))
		.unwrap_err();
	assert!(matches!(error, Error::Timeout { .. }), "{error:?}");
	let server = script.join().unwrap();
	let script = thread::spawn(move || {
		let mut server = server;
		let frame = server.expect("prompt");
		server.respond(&frame, json!({"agentInvoked": true}));
		drop(server);
	});
	let error = client
		.prompt_and_wait(&prompt("hi"), Duration::from_secs(5))
		.unwrap_err();
	script.join().unwrap();
	assert!(matches!(error, Error::Closed), "{error:?}");
}

#[test]
fn prompt_wait_completes_a_compacted_agent_end() {
	let (client, _events, mut server) = connect(ready_v2(), Vec::new());
	let script = thread::spawn(move || {
		let frame = server.expect("prompt");
		server.respond(&frame, json!({"agentInvoked": true}));
		server.send(&json!({"type": "message_end", "message": assistant("before the run")}));
		server.send(&json!({"type": "agent_start"}));
		server.send(&json!({"type": "message_end", "message": user("big")}));
		server.send(&json!({"type": "message_end", "message": assistant("first")}));
		server.send(&json!({"type": "message_end", "message": assistant("final")}));
		server
			.send(&json!({"type": "agent_end", "messages": [assistant("final")], "messageCount": 3}));
		server.send(&json!({"type": "prompt_result", "id": frame["id"], "agentInvoked": true, "status": "completed", "sessionSettled": true}));
		server
	});
	let turn = client
		.prompt_and_wait(&prompt("big"), Duration::from_secs(5))
		.unwrap();
	let _server = script.join().unwrap();
	let texts: Vec<Value> = turn
		.messages
		.iter()
		.map(|message| serde_json::to_value(message).unwrap())
		.collect();
	assert_eq!(texts.len(), 3);
	assert_eq!(texts[0]["content"], "big");
	assert_eq!(texts[1]["content"][1]["text"], "first");
	assert_eq!(turn.assistant_text.as_deref(), Some("final"));
}

#[test]
fn prompt_wait_rejects_an_unrecoverable_compaction() {
	let (client, _events, mut server) = connect(ready_v2(), Vec::new());
	let script = thread::spawn(move || {
		let frame = server.expect("prompt");
		server.respond(&frame, json!({"agentInvoked": true}));
		server.send(&json!({"type": "agent_start"}));
		server.send(&json!({"type": "agent_end", "messages": [], "messageCount": 2}));
		server.send(&json!({"type": "prompt_result", "id": frame["id"], "agentInvoked": true, "status": "completed", "sessionSettled": true}));
		server
	});
	let error = client
		.prompt_and_wait(&prompt("x"), Duration::from_secs(5))
		.unwrap_err();
	let _server = script.join().unwrap();
	assert!(matches!(error, Error::Protocol(_)), "{error:?}");
}

// ---- host tools ----

fn schema() -> Map<String, Value> {
	let Value::Object(map) =
		json!({"type": "object", "properties": {"message": {"type": "string"}}})
	else {
		unreachable!()
	};
	map
}

fn echo_tool(calls: Arc<AtomicUsize>) -> HostTool {
	HostTool::new("echo", "Echo a message", schema(), move |arguments, context| {
		calls.fetch_add(1, Ordering::SeqCst);
		context.send_update("working")?;
		let message = arguments
			.get("message")
			.and_then(Value::as_str)
			.unwrap_or_default();
		Ok(format!("host:{message}").into())
	})
	.load_mode(ToolLoadMode::Essential)
}

#[test]
fn host_tool_success_with_an_update() {
	let calls = Arc::new(AtomicUsize::new(0));
	let (_client, events, mut server) = connect(ready_v2(), vec![echo_tool(Arc::clone(&calls))]);
	server.send(&json!({"type": "host_tool_call", "id": "h1", "toolCallId": "c1", "toolName": "echo", "arguments": {"message": "hi"}}));
	assert_eq!(
		server.recv(),
		json!({"type": "host_tool_update", "id": "h1", "partialResult": {"content": [{"type": "text", "text": "working"}]}})
	);
	assert_eq!(
		server.recv(),
		json!({"type": "host_tool_result", "id": "h1", "result": {"content": [{"type": "text", "text": "host:hi"}]}})
	);
	assert_eq!(calls.load(Ordering::SeqCst), 1);
	// Host tool frames are consumed by the client.
	assert!(
		events
			.try_iter()
			.all(|event| matches!(event, Event::Notification(RpcNotification::Ready(_))))
	);
}

#[test]
fn host_tool_definitions_are_registered() {
	let (client, _events, mut server) = connect(ready_v2(), Vec::new());
	let script = thread::spawn(move || {
		let frame = server.expect("set_host_tools");
		server.respond(&frame, json!({"toolNames": ["echo"]}));
		frame
	});
	let names = client
		.set_custom_tools(vec![echo_tool(Arc::default()).label("Echo")])
		.unwrap();
	let frame = script.join().unwrap();
	assert_eq!(names, ["echo"]);
	assert_eq!(
		frame["tools"],
		json!([{"name": "echo", "description": "Echo a message", "parameters": schema(), "label": "Echo", "hidden": false, "loadMode": "essential", "readsSkillUris": false}])
	);
}

#[test]
fn unknown_host_tool_and_non_object_arguments_are_errors() {
	let (_client, _events, mut server) = connect(ready_v2(), vec![echo_tool(Arc::default())]);
	server.send(&json!({"type": "host_tool_call", "id": "h1", "toolCallId": "c1", "toolName": "nope", "arguments": {}}));
	assert_eq!(
		server.recv(),
		json!({"type": "host_tool_result", "id": "h1", "isError": true, "result": {"content": [{"type": "text", "text": "Host tool \"nope\" is not registered"}], "details": {}}})
	);
	server.send(&json!({"type": "host_tool_call", "id": "h2", "toolCallId": "c2", "toolName": "echo", "arguments": [1]}));
	assert_eq!(
		server.recv(),
		json!({"type": "host_tool_result", "id": "h2", "isError": true, "result": {"content": [{"type": "text", "text": "Host tool arguments must be an object"}], "details": {}}})
	);
}

#[test]
fn host_tool_handler_error_is_an_error_result() {
	let tool = HostTool::new("fail", "Always fails", schema(), |_, _| Err("disk on fire".into()));
	let (_client, _events, mut server) = connect(ready_v2(), vec![tool]);
	server.send(&json!({"type": "host_tool_call", "id": "h1", "toolCallId": "c1", "toolName": "fail", "arguments": {}}));
	assert_eq!(
		server.recv(),
		json!({"type": "host_tool_result", "id": "h1", "isError": true, "result": {"content": [{"type": "text", "text": "disk on fire"}], "details": {}}})
	);
}

#[test]
fn cancelled_host_tool_sends_nothing_more() {
	let (started_tx, started_rx) = mpsc::channel();
	let (finished_tx, finished_rx) = mpsc::channel();
	let started_tx = Mutex::new(started_tx);
	let finished_tx = Mutex::new(finished_tx);
	let tool = HostTool::new("slow", "Waits for cancellation", schema(), move |_, context| {
		started_tx.lock().unwrap().send(()).unwrap();
		while !context.is_cancelled() {
			thread::sleep(Duration::from_millis(5));
		}
		context.send_update("too late")?;
		finished_tx.lock().unwrap().send(()).unwrap();
		Ok("ignored".into())
	});
	let (client, _events, mut server) = connect(ready_v2(), vec![tool]);
	server.send(&json!({"type": "host_tool_call", "id": "h1", "toolCallId": "c1", "toolName": "slow", "arguments": {}}));
	started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
	server.send(&json!({"type": "host_tool_cancel", "id": "x1", "targetId": "h1"}));
	finished_rx.recv_timeout(Duration::from_secs(5)).unwrap();
	thread::sleep(Duration::from_millis(50));
	let script = thread::spawn(move || {
		// The next frame is the probe, not an update or result for the cancelled call.
		let frame = server.expect("get_last_assistant_text");
		server.respond(&frame, json!({"text": "probe"}));
	});
	assert_eq!(
		client
			.call(&GetLastAssistantTextCommand {})
			.unwrap()
			.as_deref(),
		Some("probe")
	);
	script.join().unwrap();
}

#[test]
fn tool_events_of_host_calls_are_renamed() {
	let (_client, events, mut server) = connect(ready_v2(), vec![echo_tool(Arc::default())]);
	server.send(&json!({"type": "tool_execution_start", "toolCallId": "c1", "toolName": "write"}));
	server.send(&json!({"type": "host_tool_call", "id": "h1", "toolCallId": "c1", "toolName": "echo", "arguments": {"message": "hi"}}));
	server.recv();
	server.recv();
	server.send(&json!({"type": "tool_execution_update", "toolCallId": "c1", "toolName": "write"}));
	server.send(&json!({"type": "tool_execution_end", "toolCallId": "c1", "toolName": "write"}));
	// The mapping ends with the call.
	server.send(&json!({"type": "tool_execution_end", "toolCallId": "c1", "toolName": "write"}));
	let mut names = Vec::new();
	for _ in 0..4 {
		let Event::Notification(RpcNotification::RpcAgentEvent(event)) = next_event(&events) else {
			panic!("not an event")
		};
		names.push(match event {
			RpcAgentEvent::ToolExecutionStart(event) => event.tool_name,
			RpcAgentEvent::ToolExecutionUpdate(event) => event.tool_name,
			RpcAgentEvent::ToolExecutionEnd(event) => event.tool_name,
			other => panic!("unexpected {other:?}"),
		});
	}
	assert_eq!(names, ["write", "echo", "echo", "write"]);
}

#[test]
fn dropping_the_client_cancels_host_calls() {
	let (started_tx, started_rx) = mpsc::channel();
	let (cancelled_tx, cancelled_rx) = mpsc::channel();
	let (started_tx, cancelled_tx) = (Mutex::new(started_tx), Mutex::new(cancelled_tx));
	let tool = HostTool::new("slow", "Waits", schema(), move |_, context| {
		started_tx.lock().unwrap().send(()).unwrap();
		while !context.is_cancelled() {
			thread::sleep(Duration::from_millis(5));
		}
		cancelled_tx.lock().unwrap().send(()).unwrap();
		Ok("ignored".into())
	});
	let (client, _events, mut server) = connect(ready_v2(), vec![tool]);
	server.send(&json!({"type": "host_tool_call", "id": "h1", "toolCallId": "c1", "toolName": "slow", "arguments": {}}));
	started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
	drop(client);
	cancelled_rx.recv_timeout(Duration::from_secs(5)).unwrap();
}

// ---- get_messages ----

#[test]
fn get_messages_drains_pages_with_v2() {
	let (client, _events, mut server) = connect(ready_v2(), Vec::new());
	let script = thread::spawn(move || {
		let first = server.expect("get_messages_page");
		assert_eq!(first.get("cursor"), None);
		assert_eq!(first["limit"], 256);
		server.respond(
			&first,
			json!({"messages": [user("one")], "totalMessages": 2, "nextCursor": "k1"}),
		);
		let second = server.expect("get_messages_page");
		assert_eq!(second["cursor"], "k1");
		server.respond(&second, json!({"messages": [user("two")], "totalMessages": 2}));
	});
	assert_eq!(client.get_messages().unwrap().len(), 2);
	script.join().unwrap();
}

#[test]
fn get_messages_falls_back_on_a_stale_cursor() {
	let (client, _events, mut server) = connect(ready_v2(), Vec::new());
	let script = thread::spawn(move || {
		let first = server.expect("get_messages_page");
		server.respond(
			&first,
			json!({"messages": [user("one")], "totalMessages": 3, "nextCursor": "k1"}),
		);
		let second = server.expect("get_messages_page");
		server.fail(&second, "RPC message cursor is stale", "stale_cursor");
		let whole = server.expect("get_messages");
		server.respond(&whole, json!({"messages": [user("one"), user("two"), user("three")]}));
	});
	assert_eq!(client.get_messages().unwrap().len(), 3);
	script.join().unwrap();
}

#[test]
fn get_messages_rejects_an_inconsistent_total() {
	let (client, _events, mut server) = connect(ready_v2(), Vec::new());
	let script = thread::spawn(move || {
		let first = server.expect("get_messages_page");
		server.respond(
			&first,
			json!({"messages": [user("one")], "totalMessages": 2, "nextCursor": "k1"}),
		);
		let second = server.expect("get_messages_page");
		server.respond(&second, json!({"messages": [user("two")], "totalMessages": 5}));
	});
	assert!(matches!(client.get_messages(), Err(Error::Protocol(_))));
	script.join().unwrap();
}

#[test]
fn get_messages_uses_the_monolithic_command_on_v1() {
	let (client, _events, mut server) = connect(ready_v1(), Vec::new());
	let script = thread::spawn(move || {
		let frame = server.expect("get_messages");
		server.respond(&frame, json!({"messages": [user("one")]}));
	});
	assert_eq!(client.get_messages().unwrap().len(), 1);
	script.join().unwrap();
}

// ---- host URIs ----

type Writes = Arc<Mutex<Vec<(String, String)>>>;

fn notes_uri(writes: Writes) -> HostUri {
	HostUri::new(" Notes ", |url, context| {
		assert_eq!(context.url(), url);
		assert_eq!(context.operation(), HostUriOperation::Read);
		Ok(match url {
			"notes://rich" => HostUriRead {
				content:      "{}".to_owned(),
				content_type: Some(HostUriResultContentType::ApplicationJson),
				notes:        Some(vec!["cached".to_owned()]),
				immutable:    Some(true),
			},
			"notes://broken" => return Err("no such note".into()),
			_ => "note body".into(),
		})
	})
	.unwrap()
	.description("Scratch notes")
	.write(move |url, content, context| {
		assert_eq!(context.operation(), HostUriOperation::Write);
		writes
			.lock()
			.unwrap()
			.push((url.to_owned(), content.to_owned()));
		Ok(())
	})
}

fn uri_request(server: &mut Server, id: &str, operation: &str, url: &str) -> Value {
	server.send(&json!({"type": "host_uri_request", "id": id, "operation": operation, "url": url}));
	server.recv()
}

#[test]
fn host_uri_scheme_must_not_be_empty() {
	assert!(matches!(HostUri::new("  ", |_, _| Ok("x".into())), Err(Error::InvalidArgument(_))));
}

#[test]
fn host_uri_registration_payload() {
	let (client, _events, mut server) = connect(ready_v2(), Vec::new());
	let read_only = HostUri::new("docs", |_, _| Ok("x".into()))
		.unwrap()
		.immutable(true);
	let script = thread::spawn(move || {
		let frame = server.expect("set_host_uri_schemes");
		server.respond(&frame, json!({"schemes": ["notes", "docs"]}));
		frame
	});
	let schemes = client
		.set_host_uris(vec![notes_uri(Writes::default()), read_only])
		.unwrap();
	let frame = script.join().unwrap();
	assert_eq!(schemes, ["notes", "docs"]);
	assert_eq!(
		frame["schemes"],
		json!([
			{"scheme": "notes", "description": "Scratch notes", "writable": true, "immutable": false},
			{"scheme": "docs", "writable": false, "immutable": true},
		])
	);
}

#[test]
fn host_uri_reads() {
	let (_client, events, mut server) =
		connect_with(ready_v2(), Vec::new(), vec![notes_uri(Writes::default())]);
	assert_eq!(
		uri_request(&mut server, "u1", "read", "NOTES://today"),
		json!({"type": "host_uri_result", "id": "u1", "content": "note body"})
	);
	assert_eq!(
		uri_request(&mut server, "u2", "read", "notes://rich"),
		json!({"type": "host_uri_result", "id": "u2", "content": "{}", "contentType": "application/json", "notes": ["cached"], "immutable": true})
	);
	assert_eq!(
		uri_request(&mut server, "u3", "read", "notes://broken"),
		json!({"type": "host_uri_result", "id": "u3", "error": "no such note", "isError": true})
	);
	// Host URI frames are consumed by the client.
	assert!(
		events
			.try_iter()
			.all(|event| matches!(event, Event::Notification(RpcNotification::Ready(_))))
	);
}

#[test]
fn host_uri_write_passes_the_content_through() {
	let writes = Writes::default();
	let (_client, _events, mut server) =
		connect_with(ready_v2(), Vec::new(), vec![notes_uri(Arc::clone(&writes))]);
	server.send(&json!({"type": "host_uri_request", "id": "u1", "operation": "write", "url": "notes://today", "content": "hello"}));
	assert_eq!(server.recv(), json!({"type": "host_uri_result", "id": "u1"}));
	assert_eq!(
		uri_request(&mut server, "u2", "write", "notes://empty"),
		json!({"type": "host_uri_result", "id": "u2"})
	);
	assert_eq!(*writes.lock().unwrap(), [
		("notes://today".to_owned(), "hello".to_owned()),
		("notes://empty".to_owned(), String::new())
	]);
}

#[test]
fn host_uri_request_errors() {
	let read_only = HostUri::new("docs", |_, _| Ok("x".into())).unwrap();
	let (_client, _events, mut server) = connect_with(ready_v2(), Vec::new(), vec![read_only]);
	assert_eq!(
		uri_request(&mut server, "u1", "read", "other://x"),
		json!({"type": "host_uri_result", "id": "u1", "isError": true, "error": "Host URI scheme \"other://\" is not registered"})
	);
	assert_eq!(
		uri_request(&mut server, "u2", "read", "no scheme here"),
		json!({"type": "host_uri_result", "id": "u2", "isError": true, "error": "Host URI scheme \"://\" is not registered"})
	);
	assert_eq!(
		uri_request(&mut server, "u3", "write", "docs://x"),
		json!({"type": "host_uri_result", "id": "u3", "isError": true, "error": "Host URI scheme \"docs://\" was not registered with a write handler"})
	);
	assert_eq!(
		uri_request(&mut server, "u4", "delete", "docs://x"),
		json!({"type": "host_uri_result", "id": "u4", "isError": true, "error": "Unsupported host URI operation: delete"})
	);
	// Malformed requests are ignored: the next frame answers the following request.
	server
		.send(&json!({"type": "host_uri_request", "id": 5, "operation": "read", "url": "docs://x"}));
	assert_eq!(
		uri_request(&mut server, "u6", "read", "docs://x"),
		json!({"type": "host_uri_result", "id": "u6", "content": "x"})
	);
}

#[test]
fn cancelled_host_uri_request_sends_nothing() {
	let (started_tx, started_rx) = mpsc::channel();
	let (finished_tx, finished_rx) = mpsc::channel();
	let (started_tx, finished_tx) = (Mutex::new(started_tx), Mutex::new(finished_tx));
	let slow = HostUri::new("slow", move |_, context| {
		started_tx.lock().unwrap().send(()).unwrap();
		while !context.is_cancelled() {
			thread::sleep(Duration::from_millis(5));
		}
		finished_tx.lock().unwrap().send(()).unwrap();
		Ok("ignored".into())
	})
	.unwrap();
	let (client, _events, mut server) = connect_with(ready_v2(), Vec::new(), vec![slow]);
	server.send(
		&json!({"type": "host_uri_request", "id": "u1", "operation": "read", "url": "slow://x"}),
	);
	started_rx.recv_timeout(Duration::from_secs(5)).unwrap();
	server.send(&json!({"type": "host_uri_cancel", "id": "x1", "targetId": "u1"}));
	finished_rx.recv_timeout(Duration::from_secs(5)).unwrap();
	thread::sleep(Duration::from_millis(50));
	let script = thread::spawn(move || {
		let frame = server.expect("get_last_assistant_text");
		server.respond(&frame, json!({"text": "probe"}));
	});
	assert_eq!(
		client
			.call(&GetLastAssistantTextCommand {})
			.unwrap()
			.as_deref(),
		Some("probe")
	);
	script.join().unwrap();
}

// ---- writer thread, closing, and teardown ----

const BIG: usize = 1024 * 1024;

/// A 1 MiB host frame: a peer that does not read blocks the writer on it.
fn big_ui_response() -> RpcInbound {
	RpcInbound::ExtensionUiResponse(ExtensionUiResponse::ValueUiResponse(ValueUiResponse {
		id:    "ui".to_owned(),
		value: "v".repeat(BIG),
	}))
}

/// Runs `body` on a thread; fails the test when it does not finish in time.
fn within<T: Send + 'static>(limit: Duration, body: impl FnOnce() -> T + Send + 'static) -> T {
	let (done_tx, done_rx) = mpsc::channel();
	thread::spawn(move || {
		let _ = done_tx.send(body());
	});
	done_rx.recv_timeout(limit).expect("did not finish in time")
}

fn write_line(out: &mut PipeWriter, frame: &Value) {
	let mut line = serde_json::to_vec(frame).unwrap();
	line.push(b'\n');
	out.write_all(&line).unwrap();
}

/// Forwards every line the client writes to a channel.
fn forward(input: BufReader<PipeReader>) -> Receiver<Value> {
	let (tx, rx) = mpsc::channel();
	thread::spawn(move || {
		for line in input.lines() {
			let Ok(line) = line else { return };
			if tx.send(serde_json::from_str(&line).unwrap()).is_err() {
				return;
			}
		}
	});
	rx
}

#[test]
fn drop_does_not_wait_for_a_blocked_write() {
	// The server never reads its stdin, so the writer blocks on the first frame.
	let (client, _events, _server) = connect(ready_v2(), Vec::new());
	within(Duration::from_secs(5), move || {
		client.send(&big_ui_response()).unwrap();
		client.send(&big_ui_response()).unwrap();
		thread::sleep(Duration::from_millis(50));
		drop(client);
	});
}

#[test]
fn call_deadline_covers_a_blocked_write() {
	let (mut client, _events, _server) = connect(ready_v2(), Vec::new());
	client.set_default_timeout(Duration::from_millis(300));
	let error = within(Duration::from_secs(5), move || {
		client.send(&big_ui_response()).unwrap();
		client.call(&GetStateCommand {}).unwrap_err()
	});
	assert!(matches!(&error, Error::Timeout { command } if command == "get_state"), "{error:?}");
}

#[test]
fn cancel_suppresses_a_queued_reply() {
	let (handled_tx, handled_rx) = mpsc::channel();
	let handled_tx = Mutex::new(handled_tx);
	let quick = HostTool::new("quick", "Answers at once", schema(), move |_, _| {
		handled_tx.lock().unwrap().send(()).unwrap();
		Ok("too late".into())
	});
	let (client, _events, mut server) = connect(ready_v2(), vec![quick]);
	// Block the writer so the reply waits in the queue.
	client.send(&big_ui_response()).unwrap();
	server.send(&json!({"type": "host_tool_call", "id": "h1", "toolCallId": "c1", "toolName": "quick", "arguments": {}}));
	handled_rx.recv_timeout(Duration::from_secs(5)).unwrap();
	thread::sleep(Duration::from_millis(50));
	server.send(&json!({"type": "host_tool_cancel", "id": "x1", "targetId": "h1"}));
	thread::sleep(Duration::from_millis(50));
	let script = thread::spawn(move || {
		assert_eq!(server.recv()["type"], "extension_ui_response");
		// The queued result was dropped: the next frame is the probe.
		let frame = server.expect("get_last_assistant_text");
		server.respond(&frame, json!({"text": "probe"}));
	});
	assert_eq!(
		client
			.call(&GetLastAssistantTextCommand {})
			.unwrap()
			.as_deref(),
		Some("probe")
	);
	script.join().unwrap();
}

#[test]
fn dropped_client_ignores_host_requests() {
	let calls = Arc::new(AtomicUsize::new(0));
	let (client, _events, mut server) = connect(ready_v2(), vec![echo_tool(Arc::clone(&calls))]);
	drop(client);
	server.send(&json!({"type": "host_tool_call", "id": "h1", "toolCallId": "c1", "toolName": "echo", "arguments": {"message": "hi"}}));
	// The client closed its side: the server sees EOF, not a result.
	let mut line = String::new();
	assert_eq!(server.input.read_line(&mut line).unwrap(), 0, "{line}");
	thread::sleep(Duration::from_millis(100));
	assert_eq!(calls.load(Ordering::SeqCst), 0);
}

#[test]
fn fatal_error_closes_the_write_side() {
	let (client, events, mut server) = connect(ready_v2(), Vec::new());
	server.out.write_all(b"not json\n").unwrap();
	while events.recv_timeout(Duration::from_secs(5)).is_ok() {}
	let error = client.send(&big_ui_response()).unwrap_err();
	assert!(
		matches!(&error, Error::Protocol(message) if message.starts_with("Failed to decode RPC output")),
		"{error:?}"
	);
	assert!(matches!(client.call(&GetStateCommand {}), Err(Error::Protocol(_))));
	let mut line = String::new();
	assert_eq!(server.input.read_line(&mut line).unwrap(), 0, "{line}");
}

#[test]
fn host_registrations_are_serialized() {
	let (client, _events, server) = connect(ready_v2(), Vec::new());
	let Server { mut out, input } = server;
	let lines = forward(input);
	let client = Arc::new(client);
	let tool = |name: &str| HostTool::new(name, "A tool", schema(), |_, _| Ok("ok".into()));
	let first = {
		let client = Arc::clone(&client);
		let tools = vec![tool("a")];
		thread::spawn(move || client.set_custom_tools(tools))
	};
	let request_a = lines.recv_timeout(Duration::from_secs(5)).unwrap();
	assert_eq!(request_a["tools"][0]["name"], "a");
	let second = {
		let client = Arc::clone(&client);
		let tools = vec![tool("b")];
		thread::spawn(move || client.set_custom_tools(tools))
	};
	// The second replacement waits until the first registration completes.
	assert!(lines.recv_timeout(Duration::from_millis(200)).is_err());
	let respond = |out: &mut PipeWriter, request: &Value, names: Value| {
		write_line(
			out,
			&json!({"type": "response", "id": request["id"], "command": "set_host_tools", "success": true, "data": {"toolNames": names}}),
		);
	};
	respond(&mut out, &request_a, json!(["a"]));
	let request_b = lines.recv_timeout(Duration::from_secs(5)).unwrap();
	assert_eq!(request_b["tools"][0]["name"], "b");
	respond(&mut out, &request_b, json!(["b"]));
	assert_eq!(first.join().unwrap().unwrap(), ["a"]);
	assert_eq!(second.join().unwrap().unwrap(), ["b"]);
	// The client dispatches to what the server registered last.
	write_line(
		&mut out,
		&json!({"type": "host_tool_call", "id": "h1", "toolCallId": "c1", "toolName": "b", "arguments": {}}),
	);
	let result = lines.recv_timeout(Duration::from_secs(5)).unwrap();
	assert_eq!(
		result,
		json!({"type": "host_tool_result", "id": "h1", "result": {"content": [{"type": "text", "text": "ok"}]}})
	);
}

#[cfg(unix)]
fn process_alive(pid: libc::pid_t) -> bool {
	// SAFETY: signal 0 only probes for the process.
	unsafe { libc::kill(pid, 0) == 0 }
}

/// Spawns a server whose leader and background child both ignore SIGTERM;
/// returns the client and the two pids.
#[cfg(unix)]
fn spawn_stubborn_group(name: &str) -> (Client, libc::pid_t, libc::pid_t) {
	let pid_file = std::env::temp_dir().join(format!("omp-rpc-{name}-{}", std::process::id()));
	let _ = std::fs::remove_file(&pid_file);
	// The leader neither reads stdin nor obeys SIGTERM, so teardown must escalate.
	let script = r#"trap "" TERM; sleep 30 >/dev/null 2>&1 & echo $! > "$0"; printf '{"type":"ready"}\n'; exec sleep 60"#;
	let mut process = std::process::Command::new("sh");
	process.arg("-c").arg(script).arg(&pid_file);
	let (client, _events) = Client::spawn(process, ClientOptions::default()).unwrap();
	let background = std::fs::read_to_string(&pid_file)
		.unwrap()
		.trim()
		.parse()
		.unwrap();
	let _ = std::fs::remove_file(&pid_file);
	let leader = libc::pid_t::try_from(client.pid().unwrap()).unwrap();
	assert!(process_alive(leader) && process_alive(background));
	(client, leader, background)
}

#[cfg(unix)]
fn assert_gone(pids: [libc::pid_t; 2]) {
	let deadline = std::time::Instant::now() + Duration::from_secs(3);
	for pid in pids {
		while process_alive(pid) {
			assert!(std::time::Instant::now() < deadline, "process {pid} survived teardown");
			thread::sleep(Duration::from_millis(20));
		}
	}
}

#[cfg(unix)]
#[test]
fn close_kills_the_process_group() {
	let (client, leader, background) = spawn_stubborn_group("close");
	within(Duration::from_secs(5), move || client.close()).unwrap();
	assert_gone([leader, background]);
}

#[cfg(unix)]
#[test]
fn drop_kills_the_process_group() {
	let (client, leader, background) = spawn_stubborn_group("drop");
	within(Duration::from_secs(5), move || drop(client));
	assert_gone([leader, background]);
}
