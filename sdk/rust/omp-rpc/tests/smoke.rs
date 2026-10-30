//! Real-server smoke runs: `cargo test -- --ignored --nocapture` from this
//! crate. Spawn the repository's `omp --mode rpc` with an isolated agent dir:
//! `smoke_real_server` never calls a model; `smoke_scripted_model` talks to the
//! scripted OpenAI-compatible server in `test/rpc-wire/fake-openai-server.ts`.

use std::{
	io::{BufRead, BufReader},
	path::{Path, PathBuf},
	process::{Command as Process, Stdio},
	sync::{Arc, Mutex, mpsc::Receiver},
	time::{Duration, Instant},
};

use omp_rpc::*;
use serde_json::{Map, Value, json};

fn group_alive(pgid: libc::pid_t) -> bool {
	// SAFETY: signal 0 only probes for a live member.
	unsafe { libc::kill(-pgid, 0) == 0 }
}

fn group_members(pgid: libc::pid_t) -> Vec<String> {
	let output = Process::new("pgrep")
		.args(["-g", &pgid.to_string()])
		.output()
		.unwrap();
	String::from_utf8_lossy(&output.stdout)
		.split_whitespace()
		.map(str::to_owned)
		.collect()
}

fn repo_root() -> PathBuf {
	Path::new(env!("CARGO_MANIFEST_DIR"))
		.join("../../..")
		.canonicalize()
		.unwrap()
}

fn assert_clean(seen: &[Event]) {
	let bad: Vec<&Event> = seen
		.iter()
		.filter(|event| {
			matches!(
				event,
				Event::Undecodable { .. }
					| Event::UnmatchedResponse(_)
					| Event::Notification(RpcNotification::Unknown(_))
			)
		})
		.collect();
	assert!(bad.is_empty(), "unknown/undecodable frames: {bad:?}");
}

fn drain(events: &Receiver<Event>, seen: &mut Vec<Event>, wait: Duration) {
	let deadline = Instant::now() + wait;
	while let Some(left) = deadline.checked_duration_since(Instant::now()) {
		match events.recv_timeout(left) {
			Ok(event) => seen.push(event),
			Err(_) => break,
		}
	}
}

fn notification_type(event: &Event) -> String {
	match event {
		Event::Notification(notification) => serde_json::to_value(notification).unwrap()["type"]
			.as_str()
			.unwrap_or("?")
			.to_owned(),
		other => format!("{other:?}"),
	}
}

#[test]
#[ignore = "spawns the real omp server; run with --ignored"]
fn smoke_real_server() {
	let repo = repo_root();
	let agent_dir = std::env::temp_dir().join(format!("omp-rpc-rust-smoke-{}", std::process::id()));
	std::fs::create_dir_all(&agent_dir).unwrap();
	let mut process = Process::new("bun");
	process
		.args(["packages/coding-agent/src/cli.ts", "--mode", "rpc", "--no-session"])
		.current_dir(&repo)
		.env("PI_CODING_AGENT_DIR", &agent_dir);
	let (client, events) = Client::spawn(process, ClientOptions::default()).expect("spawn + ready");
	println!("ready: {:?}", client.ready());
	println!("protocol version: {}", client.protocol_version());
	assert_eq!(client.protocol_version(), 2);
	let mut seen = Vec::new();

	let state = client.call(&GetStateCommand {}).unwrap();
	println!(
		"get_state: session {} steering {:?} streaming {}",
		state.session_id, state.steering_mode, state.is_streaming
	);

	let commands = client.call(&GetAvailableCommandsCommand {}).unwrap();
	println!("get_available_commands: {} commands", commands.len());
	drain(&events, &mut seen, Duration::from_millis(500));

	let created = client
		.call(&GoalCommand {
			op:           GoalOp::Create,
			objective:    Some("smoke objective".into()),
			token_budget: Some(5000),
		})
		.unwrap();
	println!(
		"goal create: {:?}",
		created
			.goal
			.as_ref()
			.map(|goal| (&goal.objective, goal.status))
	);
	let paused = client
		.call(&GoalCommand { op: GoalOp::Pause, objective: None, token_budget: None })
		.unwrap();
	println!("goal pause: {:?}", paused.goal.as_ref().map(|goal| goal.status));
	let dropped = client
		.call(&GoalCommand { op: GoalOp::Drop, objective: None, token_budget: None })
		.unwrap();
	println!("goal drop: {:?}", dropped.goal.as_ref().map(|goal| goal.status));

	let phases = client
		.call(&SetTodosCommand {
			phases: vec![TodoPhase {
				name:  "Smoke".into(),
				tasks: vec![TodoItem {
					content: "blocked task".into(),
					status:  TodoStatus::Blocked,
					blocker: Some("waiting".into()),
					details: None,
					notes:   None,
				}],
			}],
		})
		.unwrap();
	println!(
		"set_todos: {:?}",
		phases
			.iter()
			.map(|phase| phase
				.tasks
				.iter()
				.map(|task| task.status)
				.collect::<Vec<_>>())
			.collect::<Vec<_>>()
	);
	assert_eq!(phases[0].tasks[0].status, TodoStatus::Blocked);

	let filter = client
		.call(&SetEventFilterCommand { events: None })
		.unwrap();
	println!("set_event_filter null: {filter:?}");
	assert_eq!(filter, None);

	match client.call(&GetEntriesCommand { since: Some("no-such-entry".into()) }) {
		Err(Error::Command { command, error, code }) => {
			println!("get_entries unknown since: {command} {code:?} {error}");
			assert_eq!(code.as_deref(), Some("unknown_since"));
		},
		other => panic!("expected unknown_since, got {other:?}"),
	}

	let cancelled = client
		.call(&CancelSubagentCommand { subagent_id: "nope".into() })
		.unwrap();
	println!("cancel_subagent unknown: {cancelled}");
	assert!(!cancelled);

	let suffix = client
		.call(&PredictWordCommand { text: "hello wor".into(), cursor: 9 })
		.unwrap();
	println!("predict_word: {suffix:?}");

	let bash = client
		.call(&BashCommand { command: "echo hi".into() })
		.unwrap();
	println!("bash: exit {:?} output {:?}", bash.exit_code, bash.output);
	assert_eq!(bash.output.trim(), "hi");

	// The server leads its own process group; dropping the client must empty it.
	let pgid = libc::pid_t::try_from(client.pid().unwrap()).unwrap();
	println!("server pgid {pgid}, members {:?}", group_members(pgid));

	drain(&events, &mut seen, Duration::from_secs(1));
	let types: Vec<String> = seen.iter().map(notification_type).collect();
	println!("notifications: {types:?}");
	assert_clean(&seen);
	assert!(types.iter().any(|kind| kind == "available_commands_update"));
	assert!(types.iter().filter(|kind| *kind == "goal_updated").count() >= 3);
	let dropped = Instant::now();
	drop(client);
	while group_alive(pgid) {
		assert!(dropped.elapsed() < Duration::from_secs(3), "server group {pgid} survived the drop");
		std::thread::sleep(Duration::from_millis(20));
	}
	println!("server group gone {:?} after drop", dropped.elapsed());
	let _ = std::fs::remove_dir_all(&agent_dir);
}

fn tool_names(turn: &PromptTurn) -> Vec<(&'static str, String)> {
	turn
		.events
		.iter()
		.filter_map(|event| match event {
			RpcAgentEvent::ToolExecutionStart(event) => Some(("start", event.tool_name.clone())),
			RpcAgentEvent::ToolExecutionUpdate(event) => Some(("update", event.tool_name.clone())),
			RpcAgentEvent::ToolExecutionEnd(event) => Some(("end", event.tool_name.clone())),
			_ => None,
		})
		.collect()
}

#[test]
#[ignore = "spawns the real omp server and a scripted model; run with --ignored"]
fn smoke_scripted_model() {
	let repo = repo_root();
	let agent_dir = std::env::temp_dir().join(format!("omp-rpc-rust-model-{}", std::process::id()));
	std::fs::create_dir_all(&agent_dir).unwrap();
	let mut model = Process::new("bun")
		.arg("packages/coding-agent/test/rpc-wire/fake-openai-server.ts")
		.arg(&agent_dir)
		.current_dir(&repo)
		.stdin(Stdio::piped())
		.stdout(Stdio::piped())
		.spawn()
		.unwrap();
	let mut first = String::new();
	BufReader::new(model.stdout.take().unwrap())
		.read_line(&mut first)
		.unwrap();
	println!("fake model: {}", first.trim());
	assert!(first.starts_with("READY "), "{first}");

	let calls: Arc<Mutex<Vec<Map<String, Value>>>> = Arc::default();
	let recorded = Arc::clone(&calls);
	let Value::Object(parameters) = json!({"type": "object", "properties": {"message": {"type": "string"}}, "required": ["message"]})
	else {
		unreachable!()
	};
	let echo = HostTool::new(
		"echo_host",
		"Echo a message back from the host",
		parameters,
		move |arguments, context| {
			recorded.lock().unwrap().push(arguments.clone());
			context.send_update("echoing")?;
			let message = arguments
				.get("message")
				.and_then(Value::as_str)
				.unwrap_or_default();
			Ok(format!("host:{message}").into())
		},
	)
	.load_mode(ToolLoadMode::Essential);

	let mut process = Process::new("bun");
	process
		.args([
			"packages/coding-agent/src/cli.ts",
			"--mode",
			"rpc",
			"--no-session",
			"--model",
			"fake/fake-model",
		])
		.current_dir(&repo)
		.env("PI_CODING_AGENT_DIR", &agent_dir);
	let reads: Arc<Mutex<Vec<String>>> = Arc::default();
	let writes: Arc<Mutex<Vec<(String, String)>>> = Arc::default();
	let (seen_reads, seen_writes) = (Arc::clone(&reads), Arc::clone(&writes));
	let notes = HostUri::new("notes", move |url, _| {
		seen_reads.lock().unwrap().push(url.to_owned());
		Ok(HostUriRead {
			content: "note body".to_owned(),
			content_type: Some(HostUriResultContentType::TextPlain),
			..HostUriRead::default()
		})
	})
	.unwrap()
	.description("Scratch notes")
	.write(move |url, content, _| {
		seen_writes
			.lock()
			.unwrap()
			.push((url.to_owned(), content.to_owned()));
		Ok(())
	});
	let options = ClientOptions { tools: vec![echo], uris: vec![notes], ..ClientOptions::default() };
	let (client, events) = Client::spawn(process, options).expect("spawn + ready");
	println!("protocol version: {}", client.protocol_version());
	assert_eq!(client.protocol_version(), 2);

	let turn = client
		.prompt_and_wait(&prompt("say hi"), DEFAULT_PROMPT_TIMEOUT)
		.unwrap();
	let status = turn.result.as_ref().map(|result| result.status);
	println!("say hi: {:?} status {status:?} ({} events)", turn.assistant_text, turn.events.len());
	assert_eq!(turn.assistant_text.as_deref(), Some("pong"));
	assert_eq!(status, Some(PromptStatus::Completed));

	let turn = client
		.prompt_and_wait(&prompt("please use echo_host"), DEFAULT_PROMPT_TIMEOUT)
		.unwrap();
	let tools = tool_names(&turn);
	println!(
		"echo_host: {:?} calls {:?} tool events {tools:?}",
		turn.assistant_text,
		calls.lock().unwrap()
	);
	assert_eq!(turn.assistant_text.as_deref(), Some("tool said: host:hello"));
	assert_eq!(*calls.lock().unwrap(), [json!({"message": "hello"}).as_object().unwrap().clone()]);
	for phase in ["start", "update", "end"] {
		assert!(tools.contains(&(phase, "echo_host".to_owned())), "{phase}: {tools:?}");
	}

	let turn = client
		.prompt_and_wait(&prompt("please read_uri notes://today"), DEFAULT_PROMPT_TIMEOUT)
		.unwrap();
	println!("read_uri: {:?} reads {:?}", turn.assistant_text, reads.lock().unwrap());
	assert_eq!(turn.assistant_text.as_deref(), Some("tool said: 1:note body"));
	assert_eq!(*reads.lock().unwrap(), ["notes://today"]);

	let turn = client
		.prompt_and_wait(&prompt("please write_uri notes://today"), DEFAULT_PROMPT_TIMEOUT)
		.unwrap();
	println!("write_uri: {:?} writes {:?}", turn.assistant_text, writes.lock().unwrap());
	assert_eq!(
		turn.assistant_text.as_deref(),
		Some("tool said: Successfully wrote 16 bytes to notes://today")
	);
	assert_eq!(*writes.lock().unwrap(), [(
		"notes://today".to_owned(),
		"written by model".to_owned()
	)]);
	let big = format!("{} say hi", "x".repeat(1_200_000));
	let turn = client
		.prompt_and_wait(&prompt(&big), DEFAULT_PROMPT_TIMEOUT)
		.unwrap();
	let echoed = turn.events.iter().any(|event| match event {
		RpcAgentEvent::MessageEnd(MessageEndEvent {
			message: AgentMessage::User(message), ..
		}) => {
			let text = match &message.content {
				Some(MessageContent::String(text)) => text.clone(),
				Some(MessageContent::UserContentList(blocks)) => blocks
					.iter()
					.filter_map(|block| match block {
						UserContent::Text(block) => block.text.clone(),
						UserContent::Image(_) => None,
					})
					.collect(),
				None => String::new(),
			};
			text == big
		},
		_ => false,
	});
	println!(
		"1.2 MiB prompt: {:?} status {:?}, user message_end carries the full text: {echoed}, turn \
		 messages {}",
		turn.assistant_text,
		turn.result.as_ref().map(|result| result.status),
		turn.messages.len()
	);
	assert_eq!(turn.result.as_ref().map(|result| result.status), Some(PromptStatus::Completed));
	assert!(echoed);

	let messages = client.get_messages().unwrap();
	let state = client.call(&GetStateCommand {}).unwrap();
	println!(
		"get_messages: {} messages, get_state messageCount {}",
		messages.len(),
		state.message_count
	);
	assert_eq!(messages.len() as i64, state.message_count);

	let mut seen = Vec::new();
	drain(&events, &mut seen, Duration::from_millis(500));
	println!("events delivered: {}", seen.len());
	assert_clean(&seen);
	drop(client);
	drop(model.stdin.take());
	let _ = model.wait();
	let _ = std::fs::remove_dir_all(&agent_dir);
}

fn prompt(message: &str) -> PromptCommand {
	PromptCommand {
		message:            message.to_owned(),
		images:             None,
		streaming_behavior: None,
	}
}
