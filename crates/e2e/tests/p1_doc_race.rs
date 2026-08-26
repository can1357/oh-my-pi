//! Executable P1 proof for document races, stale rebases, and pinned reads.

#![cfg(unix)]

use std::{
	collections::BTreeSet,
	fmt::Write as _,
	fs, io,
	os::unix::fs::PermissionsExt as _,
	path::{Path, PathBuf},
	sync::{
		Arc,
		atomic::{AtomicUsize, Ordering},
	},
	time::Duration,
};

use bytes::Bytes;
use omp_agent::{
	Agent, AgentEvent, AgentSnapshot, AgentState, EventSubscription, Journal, TurnId,
	testing::{ScriptedStep, ScriptedTurn, ScriptedTurnClient},
};
use omp_core::{Str, sf};
use omp_e2e::{
	Context as _, Error, Result, error,
	support::{
		DocServerTask, EnvHarness, Gate, Scratch, accepted_event, outcome_event, tool_call_item,
		turn_event, user_item, within,
	},
};
use omp_env::{EnvClient, InvocationEvent};
use omp_envd::docs::{DocumentHost, DocumentLease};
use omp_hashline::compute_snapshot_tag;
use omp_proto::{
	document::v1::{
		self as document, commit_transaction_response, read_document_response, read_selection,
		text_mutation,
	},
	env::v1::InvokeTool,
	inference::v1::{self as inference, part_start, turn_event, value},
	thread::v1::item,
};
use omp_storage::transcript::{Header, SessionId};
use omp_tool::{
	CallOutcome, CapsBase, Claims, ModelClass, Precedence, Presentation, Registry, Rev, ToolIdentity,
};
use omp_tools::edit::{self, FormatPolicy};
use serde::Deserialize;
use tokio::{sync::Barrier, task, time};
use tokio_util::sync::CancellationToken;
use url::Url;

macro_rules! ensure {
	($condition:expr, $($message:tt)*) => {
		if !$condition {
			return Err(error(format!($($message)*)));
		}
	};
}

const TEST_TIMEOUT: Duration = Duration::from_secs(40);
const STORM_COUNT: usize = 100;
const PINNED_READERS: usize = 4;
const PINNED_READS: usize = 25;
const REVISION_TWO: &[u8] = b"fn main() {\n    let VALUE = 2;\n}\n";

#[derive(Debug, Deserialize)]
struct LspRecord {
	kind:    String,
	#[serde(default)]
	uri:     String,
	#[serde(default)]
	version: Option<i64>,
	#[serde(default)]
	text:    String,
}

#[derive(Debug)]
struct CommitRecord {
	sequence: u64,
	start:    usize,
	end:      usize,
	bytes:    Bytes,
	rebased:  bool,
}

#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn p1_real_docserver_rebases_two_agent_loops_and_survives_the_storm() -> Result<()> {
	Box::pin(within("complete P1 race proof", Duration::from_secs(90), async {
		let scratch = Scratch::new().context("create scratch project")?;
		fs::set_permissions(scratch.state(), fs::Permissions::from_mode(0o700))
			.context("secure scratch daemon state")?;
		let race_initial = b"fn main() {\n    let value = 1;\n}\n";
		scratch.write("f.rs", race_initial)?;

		let lsp_log = scratch.state().join("lsp.jsonl");
		let lsp_config = install_lsp_fixture(&scratch, &lsp_log)?;
		let docserver =
			DocServerTask::spawn(scratch.project(), scratch.socket("docserver.sock"), vec![
				lsp_config,
			])
			.await?;
		let direct_a = docserver.connect().await?;
		let uri = file_uri(&scratch, "f.rs")?;
		let env = EnvHarness::spawn_attached(&scratch, docserver.socket()).await?;
		let env_a_connection = env.connect_client("p1-agent-a").await?;
		let env_b_connection = env.connect_client("p1-agent-b").await?;
		let env_a = env_a_connection.client_clone();
		let env_b = env_b_connection.client_clone();
		let initial_tag = read_snapshot_tag(&env_a, "f.rs").await?;
		let revision_two_tag = compute_snapshot_tag(REVISION_TWO);
		let lsp_observer = within(
			"open persistent LSP observer",
			TEST_TIMEOUT,
			direct_a.open(Str::new(&uri), None, &CancellationToken::new()),
		)
		.await??;

		let identity = ToolIdentity { name: sf!("edit"), rev: Rev { family: sf!("hl"), n: 1 } };
		let mut registry = Registry::new();
		registry.register(
			edit::tool(direct_a.clone(), FormatPolicy::BestEffort),
			Presentation::Slot,
			Claims { precedence: Precedence::CORE, claimant: sf!("omp/core"), replaces: None },
		)?;
		let registry = Arc::new(registry);

		let a1_args = edit_args("f.rs", initial_tag.as_str(), "PUT 2.=2:\n+    let value = 2;")?;
		let a2_args = edit_args("f.rs", revision_two_tag.as_str(), "PUT 2.=2:\n+    let value = 3;")?;
		let b_args =
			edit_args("f.rs", revision_two_tag.as_str(), "PUT 1.=1:\n+fn main() { // agent B")?;
		let a_client = ScriptedTurnClient::new([
			tool_turn(&identity, "a-rev2", a1_args, None),
			end_turn(),
			tool_turn(&identity, "a-stale-rev2", a2_args, None),
			end_turn(),
		]);
		let b_client =
			ScriptedTurnClient::new([tool_turn(&identity, "b-rev3", b_args, None), end_turn()]);
		let (mut agent_a, events_a) =
			agent(a_client.clone(), env_a, Arc::clone(&registry), &scratch, "agent-a")?;
		let (mut agent_b, events_b) =
			agent(b_client.clone(), env_b, Arc::clone(&registry), &scratch, "agent-b")?;

		let a1_turn = TurnId::new(omp_core::Ulid::generate().to_string());
		agent_a
			.submit([user_item("A: publish revision two")], a1_turn)
			.await?;
		let a1 = next_edit_payload(&events_a, "a-rev2").await?;
		let a1_bytes = REVISION_TWO;
		ensure!(scratch.read("f.rs")? == a1_bytes, "A revision two was not durable");

		let b1_turn = TurnId::new(omp_core::Ulid::generate().to_string());
		agent_b
			.submit([user_item("B: publish revision three")], b1_turn)
			.await?;
		let b = next_edit_payload(&events_b, "b-rev3").await?;
		let b_bytes = b"fn main() { // agent B\n    let VALUE = 2;\n}\n";
		ensure!(scratch.read("f.rs")? == b_bytes, "B revision three was not durable");

		let a2_turn = TurnId::new(omp_core::Ulid::generate().to_string());
		agent_a
			.submit([user_item("A: edit again from my revision-two view")], a2_turn)
			.await?;
		let a2 = next_edit_payload(&events_a, "a-stale-rev2").await?;
		let race_final = b"fn main() { // agent B\n    let VALUE = 3;\n}\n";
		ensure!(scratch.read("f.rs")? == race_final, "stale A overwrote B or lost its own edit");

		ensure!(
			!a1.rebased && !b.rebased && !a2.rebased,
			"tools prepared against the live revision were incorrectly reported as commit-time \
			 rebases"
		);
		let a1_old = revision_sequence(&a1.old_revision)?;
		let a1_new = revision_sequence(committed_revision(&a1)?)?;
		let b_old = revision_sequence(&b.old_revision)?;
		let b_new = revision_sequence(committed_revision(&b)?)?;
		let a2_old = revision_sequence(&a2.old_revision)?;
		let a2_new = revision_sequence(committed_revision(&a2)?)?;
		ensure!(a1_old < a1_new && a1_new < b_new && b_new < a2_new, "race revisions regressed");
		ensure!(
			b_old == a1_new && a2_old == b_new,
			"stale authored edit was not prepared against B's live revision"
		);
		ensure!(
			a_client.remaining() == 0 && b_client.remaining() == 0,
			"agent loop left scripted turns unconsumed"
		);

		let race_records = lsp_records(&lsp_log)?;
		let published_race: BTreeSet<_> = [a1_bytes, b_bytes.as_slice(), race_final.as_slice()]
			.into_iter()
			.map(|bytes| String::from_utf8(bytes.to_vec()).expect("UTF-8 race fixture"))
			.collect();
		assert_lsp_publication(&race_records, &uri, &published_race, race_final)?;
		let public_lsp_uri = Url::parse(&uri)?;
		ensure!(
			race_records.iter().any(|record| {
				let Ok(shadow_uri) = Url::parse(&record.uri) else {
					return false;
				};
				record.kind == "format"
					&& shadow_uri != public_lsp_uri
					&& shadow_uri.scheme() == public_lsp_uri.scheme()
					&& shadow_uri.path() == public_lsp_uri.path()
					&& shadow_uri.query().is_some()
					&& record.text.as_bytes() == race_final
			}),
			"the stale A candidate was not formatted on a selector-preserving shadow URI: \
			 {race_records:?}"
		);
		storm(&scratch, &docserver, &lsp_log).await?;

		direct_a
			.close(lsp_observer, &CancellationToken::new())
			.await?;
		drop(agent_a);
		drop(agent_b);
		drop(env_b_connection);
		drop(env_a_connection);
		env.shutdown().await?;
		drop(direct_a);
		docserver.shutdown().await?;
		Ok(())
	}))
	.await?
}

fn agent(
	client: ScriptedTurnClient,
	env: EnvClient,
	registry: Arc<Registry>,
	scratch: &Scratch,
	name: &str,
) -> Result<(Agent<ScriptedTurnClient>, EventSubscription)> {
	let journal = Journal::create(&scratch.state().join(format!("{name}.jsonl")), &Header {
		v:       4,
		id:      SessionId(Str::from(name)),
		created: 1,
		cwd:     scratch.project().to_owned(),
	})?;
	let mut snapshot = AgentSnapshot::new(Default::default(), Default::default(), registry);
	snapshot.enabled_tools = Arc::from([sf!("edit")]);
	let agent = Agent::new(client, env, AgentState::new(snapshot), journal, CapsBase {
		maximum_parts:      16,
		maximum_text_bytes: 128 * 1024,
		media:              false,
		model_class:        ModelClass::Standard,
	});
	let events = agent.events().subscribe_lossless();
	Ok((agent, events))
}

async fn read_snapshot_tag(client: &EnvClient, path: &str) -> Result<Str> {
	let mut invocation = within(
		"opening snapshot read",
		TEST_TIMEOUT,
		client.invoke(InvokeTool {
			invocation_id: "p1-seed-read".to_owned(),
			name: "read".to_owned(),
			rev: "1".to_owned(),
			..InvokeTool::default()
		}),
	)
	.await??;
	match within("accepting snapshot read", TEST_TIMEOUT, invocation.next_event()).await?? {
		Some(InvocationEvent::Accepted(_)) => {},
		other => return Err(error(format!("snapshot read was not accepted: {other:?}"))),
	}
	within(
		"committing snapshot read",
		TEST_TIMEOUT,
		invocation.commit_args(
			Bytes::from(serde_json::to_vec(&serde_json::json!({"path": path}))?),
			Bytes::from_static(b"doc-race-test-token"),
			1000,
			None,
		),
	)
	.await??;
	loop {
		match within("receiving snapshot read", TEST_TIMEOUT, invocation.next_event()).await?? {
			Some(InvocationEvent::Verdict(verdict)) => {
				ensure!(
					!verdict.is_error,
					"snapshot read failed: {}",
					String::from_utf8_lossy(&verdict.json)
				);
				let outcome: CallOutcome<serde_json::Value, serde_json::Value> =
					serde_json::from_slice(&verdict.json)?;
				let CallOutcome::Ok(payload) = outcome else {
					return Err(error(format!("snapshot read returned a non-success outcome")));
				};
				let header = payload["parts"][0]["text"]
					.as_str()
					.and_then(|text| text.lines().next())
					.ok_or_else(|| error(format!("snapshot read omitted its hashline header")))?;
				let body = header
					.strip_prefix('[')
					.and_then(|header| header.strip_suffix(']'))
					.ok_or_else(|| {
						error(format!("snapshot read returned malformed header {header:?}"))
					})?;
				let (_, tag) = body.rsplit_once('#').ok_or_else(|| {
					error(format!("snapshot read returned untagged header {header:?}"))
				})?;
				ensure!(
					tag.len() == 4 && tag.bytes().all(|byte| byte.is_ascii_hexdigit()),
					"snapshot read returned invalid tag {tag:?}"
				);
				return Ok(Str::from(tag));
			},
			Some(InvocationEvent::Update(_)) => {},
			Some(InvocationEvent::Accepted(_)) => {
				return Err(error(format!("snapshot read was accepted twice")));
			},
			Some(InvocationEvent::Admission(_)) => {
				return Err(error(format!("unexpected admission query during snapshot read")));
			},
			None => return Err(error(format!("snapshot read closed before its verdict"))),
		}
	}
}

fn edit_args(path: &str, tag: &str, patch: &str) -> Result<Bytes> {
	let input = format!("[{path}#{tag}]\n{patch}");
	Ok(Bytes::from(serde_json::to_vec(&serde_json::json!({ "input": input }))?))
}

fn tool_turn(
	identity: &ToolIdentity,
	call_id: &str,
	args: Bytes,
	gate: Option<Gate>,
) -> ScriptedTurn {
	let start = turn_event(turn_event::Event::PartStart(inference::PartStart {
		index:        0,
		kind:         part_start::Kind::ToolCall as i32,
		tool_call_id: call_id.to_owned(),
		tool_name:    identity.name.to_string(),
	}));
	let delta = turn_event(turn_event::Event::PartDelta(inference::PartDelta {
		index: 0,
		chunk: args.clone(),
	}));
	let end = turn_event(turn_event::Event::PartEnd(inference::PartEnd {
		index:     0,
		signature: Bytes::new(),
	}));
	let outcome = outcome_event(inference::Outcome {
		output: vec![tool_call_item(1, call_id, identity, args)],
		stop: inference::StopReason::StopToolUse as i32,
		..Default::default()
	});
	let mut steps = vec![
		ScriptedStep::from(accepted_event(false)),
		ScriptedStep::from(start),
		ScriptedStep::from(delta),
	];
	if let Some(gate) = gate {
		steps.push(ScriptedStep::Wait(gate));
	}
	steps.extend([ScriptedStep::from(end), ScriptedStep::from(outcome)]);
	ScriptedTurn::steps(steps)
}

fn end_turn() -> ScriptedTurn {
	ScriptedTurn::events([
		accepted_event(false),
		outcome_event(inference::Outcome {
			stop: inference::StopReason::StopEndTurn as i32,
			..Default::default()
		}),
	])
}

async fn next_edit_payload(
	events: &EventSubscription,
	call_id: &str,
) -> Result<edit::SectionPayload> {
	within("successful edit tool result", TEST_TIMEOUT, async {
		loop {
			let event = events.recv().await?;
			let AgentEvent::ToolFinished { call_id: completed, item, .. } = event.as_ref() else {
				continue;
			};
			if completed.as_str() != call_id {
				continue;
			}
			let Some(item::Kind::ToolResult(result)) = item.kind.as_ref() else {
				return Err(error(format!("ToolFinished did not carry ToolResult")));
			};
			let details = result
				.details
				.as_ref()
				.ok_or_else(|| error(format!("missing edit outcome")))?;
			let outcome: CallOutcome<edit::Payload, edit::Fault> = serde_json::from_value(
				proto_json(details).ok_or_else(|| error(format!("invalid edit outcome")))?,
			)?;
			match outcome {
				CallOutcome::Ok(mut payload) => {
					ensure!(
						payload.sections.len() == 1,
						"edit transaction should contain exactly one section"
					);
					return Ok(payload
						.sections
						.pop()
						.expect("verified single edit section"));
				},
				other => return Err(error(format!("edit did not commit: {other:?}"))),
			}
		}
	})
	.await?
}

fn proto_json(value: &inference::Value) -> Option<serde_json::Value> {
	Some(match value.kind.as_ref()? {
		value::Kind::Null(_) => serde_json::Value::Null,
		value::Kind::Bool(value) => (*value).into(),
		value::Kind::Int(value) => (*value).into(),
		value::Kind::Uint(value) => (*value).into(),
		value::Kind::Double(value) => serde_json::Number::from_f64(*value)?.into(),
		value::Kind::String(value) => value.clone().into(),
		value::Kind::List(values) => serde_json::Value::Array(
			values
				.values
				.iter()
				.map(proto_json)
				.collect::<Option<Vec<_>>>()?,
		),
		value::Kind::Map(values) => serde_json::Value::Object(
			values
				.fields
				.iter()
				.map(|(key, value)| Some((key.clone(), proto_json(value)?)))
				.collect::<Option<serde_json::Map<_, _>>>()?,
		),
	})
}

fn revision_sequence(revision: &Str) -> Result<u64> {
	revision
		.as_str()
		.split_once(':')
		.ok_or_else(|| error(format!("revision identity omitted sequence")))?
		.0
		.parse()
		.context("parse revision sequence")
}

fn committed_revision(section: &edit::SectionPayload) -> Result<&Str> {
	section
		.new_revision
		.as_ref()
		.ok_or_else(|| error(format!("race edit unexpectedly deleted its document")))
}

async fn storm(scratch: &Scratch, docserver: &DocServerTask, lsp_log: &Path) -> Result<()> {
	let mut initial = String::with_capacity(STORM_COUNT * 8);
	for index in 0..STORM_COUNT {
		let _ = writeln!(initial, "old-{index:03}");
	}
	let initial = initial.into_bytes();
	scratch.write("storm.rs", &initial)?;

	let uri = file_uri(scratch, "storm.rs")?;
	let host_a = docserver.connect().await?;
	let host_b = docserver.connect().await?;
	let readers = docserver.connect().await?;
	let cancel = CancellationToken::new();

	let mut leases = Vec::with_capacity(STORM_COUNT);
	for index in 0..STORM_COUNT {
		let host = if index % 2 == 0 { &host_a } else { &host_b };
		leases.push(open(host, &uri, &cancel).await?);
	}
	let base_sequence = leases[0]
		.head()
		.revision
		.as_ref()
		.ok_or_else(|| error(format!("storm base omitted revision")))?
		.sequence;
	ensure!(
		leases.iter().all(|lease| lease
			.head()
			.revision
			.as_ref()
			.is_some_and(|revision| revision.sequence == base_sequence)),
		"storm writers were not pinned to one base"
	);

	let mut pinned = Vec::with_capacity(PINNED_READERS);
	for _ in 0..PINNED_READERS {
		pinned.push(open(&readers, &uri, &cancel).await?);
	}
	let format_count = lsp_records(lsp_log)?
		.iter()
		.filter(|record| record.kind == "format")
		.count();
	let format_done_count = lsp_records(lsp_log)?
		.iter()
		.filter(|record| record.kind == "format_done")
		.count();
	let barrier = Arc::new(Barrier::new(STORM_COUNT + 1));
	let reader_gate = Gate::default();
	let first_reads = Arc::new(AtomicUsize::new(0));
	let mut reader_tasks = Vec::new();
	for lease in pinned {
		let host = readers.clone();
		let expected = initial.clone();
		let reader_gate = reader_gate.clone();
		let first_reads = Arc::clone(&first_reads);
		reader_tasks.push(tokio::spawn(async move {
			reader_gate.arrive_and_wait(TEST_TIMEOUT).await?;
			for index in 0..PINNED_READS {
				let bytes = read_whole(&host, &lease).await?;
				ensure!(
					bytes.as_ref() == expected.as_slice(),
					"pinned reader observed a torn or newer head"
				);
				if index == 0 {
					first_reads.fetch_add(1, Ordering::Release);
				}
				task::yield_now().await;
			}
			Ok::<_, Error>(lease)
		}));
	}

	let mut commits = Vec::with_capacity(STORM_COUNT);
	for (index, lease) in leases.into_iter().enumerate() {
		let host = if index % 2 == 0 {
			host_a.clone()
		} else {
			host_b.clone()
		};
		let barrier = Arc::clone(&barrier);
		let start = index * 8;
		let end = start + 7;
		let replacement = Bytes::from(format!("new-{index:03}"));
		commits.push(tokio::spawn(async move {
			barrier.wait().await;
			let mut lease = lease;
			let response = host
				.commit(
					&mut lease,
					Bytes::copy_from_slice(&(10_000_u128 + index as u128).to_be_bytes()),
					document::TextMutation {
						base_revision: None,
						change:        Some(text_mutation::Change::Edits(document::ByteEdits {
							edits: vec![document::ByteEdit {
								start:       start as u64,
								end:         end as u64,
								replacement: replacement.clone(),
							}],
						})),
						stale_policy:  document::StalePolicy::RebaseNonOverlapping as i32,
						format_policy: if index == 0 {
							document::FormatPolicy::Required as i32
						} else {
							document::FormatPolicy::Disabled as i32
						},
					},
					&CancellationToken::new(),
				)
				.await?;
			match response.outcome {
				Some(commit_transaction_response::Outcome::Committed(committed)) => {
					let operation = committed
						.operations
						.into_iter()
						.next()
						.ok_or_else(|| error(format!("committed storm op omitted result")))?;
					let rebased = operation.rebased;
					let sequence = operation
						.head
						.and_then(|head| head.revision)
						.ok_or_else(|| error(format!("committed storm op omitted revision")))?
						.sequence;
					Ok::<_, Error>(Some(CommitRecord {
						sequence,
						start,
						end,
						bytes: replacement,
						rebased,
					}))
				},
				Some(commit_transaction_response::Outcome::Rejected(rejected)) => {
					ensure!(
						matches!(
							document::TransactionRejectReason::try_from(rejected.reason),
							Ok(document::TransactionRejectReason::StaleBase
								| document::TransactionRejectReason::OverlappingChange
								| document::TransactionRejectReason::RevisionExpired)
						),
						"storm rejection was not a typed conflict: {rejected:?}"
					);
					Ok(None)
				},
				Some(commit_transaction_response::Outcome::PartiallyCommitted(partial)) => {
					Err(error(format!("single-operation storm partially committed: {partial:?}")))
				},
				None => Err(error(format!("storm transaction omitted outcome"))),
			}
		}));
	}
	barrier.wait().await;
	wait_lsp_kind(lsp_log, "", "format", format_count + 1).await?;
	reader_gate.wait_arrived(TEST_TIMEOUT).await?;
	reader_gate.release();
	within("pinned readers during formatter", TEST_TIMEOUT, async {
		while first_reads.load(Ordering::Acquire) < PINNED_READERS {
			task::yield_now().await;
		}
	})
	.await?;
	ensure!(
		lsp_records(lsp_log)?
			.iter()
			.filter(|record| record.kind == "format_done")
			.count()
			== format_done_count,
		"formatter completed before every pinned reader observed its immutable head"
	);
	for task in reader_tasks {
		let lease = within("pinned reader", TEST_TIMEOUT, task).await???;
		readers.close(lease, &CancellationToken::new()).await?;
	}

	let mut committed = Vec::new();
	for task in commits {
		if let Some(record) = within("storm commit", TEST_TIMEOUT, task).await??? {
			committed.push(record);
		}
	}
	ensure!(committed.len() >= 2, "storm committed fewer than two operations");
	ensure!(
		committed.iter().any(|record| record.rebased),
		"storm committed no stale operation through daemon rebase"
	);
	committed.sort_by_key(|record| record.sequence);
	ensure!(
		committed
			.windows(2)
			.all(|pair| pair[0].sequence < pair[1].sequence),
		"storm revisions were not strictly monotone"
	);
	let mut folded = initial.clone();
	let mut published = BTreeSet::new();
	for record in &committed {
		ensure!(
			record.end - record.start == record.bytes.len(),
			"storm replacement changed line width"
		);
		folded.splice(record.start..record.end, record.bytes.iter().copied());
		published.insert(String::from_utf8(folded.clone())?);
	}
	let final_bytes = scratch.read("storm.rs")?;
	ensure!(
		final_bytes == folded,
		"final storm bytes differ from the revision-ordered fold of commits"
	);
	let final_lease = open(&host_a, &uri, &CancellationToken::new()).await?;
	let final_head = final_lease
		.head()
		.revision
		.as_ref()
		.ok_or_else(|| error(format!("final storm head omitted revision")))?
		.sequence;
	ensure!(
		final_head == committed.last().expect("nonempty commits").sequence,
		"final head regressed behind last commit"
	);
	ensure!(
		read_whole(&host_a, &final_lease).await?.as_ref() == folded.as_slice(),
		"final pinned read disagreed with disk"
	);
	host_a.close(final_lease, &CancellationToken::new()).await?;

	let records = lsp_records(lsp_log)?;
	assert_lsp_publication(&records, &uri, &published, &folded)?;
	let changed = records
		.iter()
		.filter(|record| record.kind == "change" && record.uri == uri)
		.count();
	ensure!(changed >= committed.len(), "LSP missed published storm heads");
	Ok(())
}

async fn open(host: &DocumentHost, uri: &str, cancel: &CancellationToken) -> Result<DocumentLease> {
	within("open pinned document", TEST_TIMEOUT, host.open(Str::new(uri), Some(sf!("rust")), cancel))
		.await?
		.context("open pinned document")
}

async fn read_whole(host: &DocumentHost, lease: &DocumentLease) -> Result<Bytes> {
	let response = host
		.read(
			lease,
			document::ReadSelection {
				selection: Some(read_selection::Selection::Whole(document::WholeDocument {})),
			},
			&CancellationToken::new(),
		)
		.await?;
	match response.body {
		Some(read_document_response::Body::Content(bytes)) => Ok(bytes),
		_ => Err(error(format!("whole read returned slices or no body"))),
	}
}

fn file_uri(scratch: &Scratch, relative: &str) -> Result<String> {
	let path =
		fs::canonicalize(scratch.project().join(relative)).context("canonicalize fixture path")?;
	Url::from_file_path(path)
		.map(String::from)
		.map_err(|()| error(format!("fixture path is not an absolute file URI")))
}

fn install_lsp_fixture(scratch: &Scratch, log: &Path) -> Result<PathBuf> {
	let executable = scratch.state().join("lsp_fixture.py");
	fs::write(&executable, LSP_FIXTURE)?;
	fs::set_permissions(&executable, fs::Permissions::from_mode(0o700))?;
	let config = scratch.state().join("lsp.json");
	fs::write(
		&config,
		serde_json::to_vec(&serde_json::json!({
			"name": "p1-fixture",
			"priority": 100,
			"selector": { "schemes": ["file"], "path_patterns": ["**/*.rs"] },
			"executable": executable,
			"env": { "OMP_LSP_LOG": log },
			"transport": { "initialize_timeout_ms": 5000, "shutdown_timeout_ms": 1000 }
		}))?,
	)?;
	Ok(config)
}

fn lsp_records(path: &Path) -> Result<Vec<LspRecord>> {
	match fs::read_to_string(path) {
		Ok(text) => text
			.lines()
			.filter(|line| !line.is_empty())
			.map(|line| serde_json::from_str(line).context("decode LSP fixture record"))
			.collect(),
		Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(Vec::new()),
		Err(error) => Err(error.into()),
	}
}

async fn wait_lsp_kind(path: &Path, uri: &str, kind: &str, minimum: usize) -> Result<()> {
	within("LSP lifecycle attribution", TEST_TIMEOUT, async {
		loop {
			if lsp_records(path)?
				.iter()
				.filter(|record| record.kind == kind && (uri.is_empty() || record.uri == uri))
				.count() >= minimum
			{
				return Ok::<_, Error>(());
			}
			time::sleep(Duration::from_millis(10)).await;
		}
	})
	.await?
}

fn assert_lsp_publication(
	records: &[LspRecord],
	uri: &str,
	published: &BTreeSet<String>,
	final_bytes: &[u8],
) -> Result<()> {
	let changes: Vec<_> = records
		.iter()
		.filter(|record| record.kind == "change" && record.uri == uri)
		.collect();
	ensure!(!changes.is_empty(), "LSP received no didChange for {uri}");
	ensure!(
		changes
			.iter()
			.all(|record| published.contains(&record.text)),
		"LSP didChange was attributed to bytes that never became a published head: \
		 changes={changes:?}, published={published:?}"
	);
	ensure!(
		changes.windows(2).all(|pair| pair[0]
			.version
			.zip(pair[1].version)
			.is_some_and(|(left, right)| left < right)),
		"LSP versions regressed or were omitted"
	);
	ensure!(
		changes
			.last()
			.is_some_and(|record| record.text.as_bytes() == final_bytes),
		"LSP final text desynchronized from published head"
	);
	Ok(())
}

const LSP_FIXTURE: &[u8] = br#"#!/usr/bin/env python3
import json, os, sys, time

log_path = os.environ["OMP_LSP_LOG"]
documents = {}

def record(kind, uri="", version=None, text=""):
    with open(log_path, "a", encoding="utf-8") as handle:
        handle.write(json.dumps({"kind":kind,"uri":uri,"version":version,"text":text}, separators=(",", ":")) + "\n")

def send(identifier, result):
    payload = json.dumps({"jsonrpc":"2.0","id":identifier,"result":result}, separators=(",", ":")).encode()
    sys.stdout.buffer.write(b"Content-Length: " + str(len(payload)).encode() + b"\r\n\r\n" + payload)
    sys.stdout.buffer.flush()

def formatted_text(uri):
    return documents.get(uri, "").replace("value", "VALUE")

def format_edits(uri):
    text = documents.get(uri, "")
    for line_index, line in enumerate(text.splitlines()):
        start = line.find("value")
        if start >= 0:
            return [{"range":{"start":{"line":line_index,"character":start},"end":{"line":line_index,"character":start + 5}},"newText":"VALUE"}]
    return []

def read_message():
    length = None
    while True:
        line = sys.stdin.buffer.readline()
        if not line:
            return None
        if line in (b"\r\n", b"\n"):
            break
        name, value = line.decode("ascii").split(":", 1)
        if name.lower() == "content-length":
            length = int(value.strip())
    if length is None:
        return None
    body = sys.stdin.buffer.read(length)
    return json.loads(body)

while True:
    message = read_message()
    if message is None:
        break
    method = message.get("method")
    params = message.get("params") or {}
    if method == "initialize":
        send(message["id"], {"capabilities":{"positionEncoding":"utf-8","textDocumentSync":{"openClose":True,"change":1,"willSave":True,"willSaveWaitUntil":True},"documentFormattingProvider":True}})
    elif method == "textDocument/didOpen":
        document = params["textDocument"]
        documents[document["uri"]] = document["text"]
        record("open", document["uri"], document.get("version"), document["text"])
    elif method == "textDocument/didChange":
        document = params["textDocument"]
        changes = params.get("contentChanges") or []
        if changes:
            documents[document["uri"]] = changes[-1]["text"]
        record("change", document["uri"], document.get("version"), documents.get(document["uri"], ""))
    elif method == "textDocument/willSave":
        uri = params["textDocument"]["uri"]
        record("will_save", uri, None, documents.get(uri, ""))
    elif method == "textDocument/willSaveWaitUntil":
        uri = params["textDocument"]["uri"]
        record("format", uri, None, formatted_text(uri))
        time.sleep(0.25)
        record("format_done", uri, None, formatted_text(uri))
        send(message["id"], format_edits(uri))
    elif method == "textDocument/formatting":
        uri = params["textDocument"]["uri"]
        record("format", uri, None, formatted_text(uri))
        time.sleep(0.25)
        record("format_done", uri, None, formatted_text(uri))
        send(message["id"], format_edits(uri))
    elif method == "textDocument/didClose":
        document = params["textDocument"]
        record("close", document["uri"])
        documents.pop(document["uri"], None)
    elif method == "shutdown":
        send(message["id"], None)
    elif method == "exit":
        break
    elif "id" in message:
        send(message["id"], None)
"#;
