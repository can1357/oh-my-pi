//! Pure transcript-to-thread projection and canonical tool-result lowering.
use std::{collections::BTreeMap, str, sync::LazyLock};

use bytes::Bytes;
use omp_core::{SparseMap, SparseSet, Str, encoding::hex};
use omp_proto::{
	inference::v1::{self as pb, value},
	thread::v1::{self as thread_pb, blob, item, part},
};
use omp_scribe::{Props, Template};
use omp_storage::transcript::{
	AmendPatch, Entry, Kind, LiveLog, LiveSet, Log, truncate_persisted_text,
};
use omp_tool::{
	Abort, CallOutcome, CapsBase, Part as ToolPart, ProjectedCall, PromptCaps, RecordedCallOwned,
	Registry as ToolRegistry, Rev, TOOL_REV_PROP, ToolIdentity,
};
use serde::Deserialize;
use thiserror::Error;

use crate::{journal_kinds, prompt_engine, prompt_keys};

const COMPACTION_SUMMARY_CONTEXT: &str = "Prior model work/tool state available.\nMUST build on \
                                          prior work; NEVER duplicate prior \
                                          work.\n\n<summary>\n{{ summary }}\n</summary>\n";
const HANDOFF_SUMMARY_CONTEXT: &str =
	include_str!("../prompts/compaction/handoff-summary-context.md");

/// Renders the compaction framing captured by the prompt golden suite.
#[doc(hidden)]

pub fn render_compaction_summary(summary: &str, method: Option<&str>) -> String {
	static COMPACTION: LazyLock<Template> = LazyLock::new(|| {
		prompt_engine::engine()
			.compile("compaction/summary-context", COMPACTION_SUMMARY_CONTEXT)
			.expect("embedded compaction summary template")
	});
	static HANDOFF: LazyLock<Template> = LazyLock::new(|| {
		prompt_engine::engine()
			.compile("compaction/handoff-summary-context", HANDOFF_SUMMARY_CONTEXT)
			.expect("embedded handoff summary template")
	});
	let template = if method == Some("handoff") {
		&*HANDOFF
	} else {
		&*COMPACTION
	};
	let mut props = Props::new();
	props.set(prompt_keys::SUMMARY, summary.to_owned());
	let mut rendered = template
		.render_str(prompt_engine::engine(), &props)
		.expect("typed summary props satisfy compaction template")
		.to_string();
	if !rendered.ends_with('\n') {
		rendered.push('\n');
	}
	rendered
}

/// Canonical thread projection failure.
#[derive(Debug, Error)]
pub enum ProjectionError {
	/// A committed tool revision property had the wrong shape.
	#[error("omp/tool-rev must be a string")]
	RevisionType,
	/// A committed tool revision string was malformed.
	#[error("omp/tool-rev contains an invalid revision")]
	InvalidRevision,
	/// Structured tool call-outcome JSON was invalid.
	#[error("invalid tool call-outcome JSON: {0}")]
	OutcomeJson(#[from] serde_json::Error),
	/// A model-facing JSON part was not UTF-8.
	#[error("tool JSON part is not UTF-8: {0}")]
	PartUtf8(#[from] str::Utf8Error),
	/// A model-facing blob hash was not hexadecimal.
	#[error("tool blob hash is not valid hexadecimal")]
	BlobHash,
	/// The live tool could not deterministically render a lifted verdict.
	#[error("tool projection failed: {0}")]
	Tool(#[from] omp_tool::RegistryError),
	/// A recovery target was not a canonical tool call.
	#[error("tool recovery target is not a tool call")]
	ExpectedToolCall,
	/// A committed tool call lacked its durable revision identity.
	#[error("committed tool call is missing omp/tool-rev")]
	MissingRevision,
}

/// Applies the one-time durable string bound to a canonical thread item.
///
/// Provider-signed thinking/tool blocks remain exact. Calling this on a
/// replayed persisted item is byte-stable because the visible notice fits under
/// the cap.
pub fn truncate_item_for_persistence(item: &mut thread_pb::Item) {
	let Some(kind) = &mut item.kind else {
		return;
	};
	match kind {
		item::Kind::Message(message) => {
			truncate_parts_for_persistence(&mut message.parts);
		},
		item::Kind::ToolCall(call) => {
			if call.thought_signature.is_empty()
				&& let Ok(arguments) = str::from_utf8(&call.args_json)
			{
				let bounded = truncate_persisted_text(arguments);
				if bounded.as_str() != arguments {
					call.args_json = bounded.as_bytes().to_vec().into();
				}
			}
		},
		item::Kind::ToolResult(result) => {
			truncate_parts_for_persistence(&mut result.parts);
		},
	}
}

fn truncate_parts_for_persistence(parts: &mut [thread_pb::Part]) {
	for part in parts {
		let Some(kind) = &mut part.kind else {
			continue;
		};
		match kind {
			part::Kind::Text(text) => {
				let bounded = truncate_persisted_text(text);
				if bounded.as_str() != text {
					*text = bounded.as_str().to_owned();
				}
			},
			part::Kind::Thinking(thinking) if thinking.signature.is_empty() => {
				let bounded = truncate_persisted_text(&thinking.text);
				if bounded.as_str() != thinking.text {
					thinking.text = bounded.as_str().to_owned();
				}
			},
			part::Kind::Fallback(fallback) => {
				let from = truncate_persisted_text(&fallback.from_model);
				let to = truncate_persisted_text(&fallback.to_model);
				if from.as_str() != fallback.from_model {
					fallback.from_model = from.as_str().to_owned();
				}
				if to.as_str() != fallback.to_model {
					fallback.to_model = to.as_str().to_owned();
				}
			},
			part::Kind::Thinking(_) | part::Kind::Blob(_) | part::Kind::ServerTool(_) => {},
		}
	}
}
fn is_terminal_error_item(item: &thread_pb::Item) -> bool {
	item
		.props
		.as_ref()
		.and_then(|props| props.fields.get(journal_kinds::TERMINAL_ERROR_PROP))
		.and_then(|value| value.kind.as_ref())
		.is_some_and(|kind| matches!(kind, value::Kind::Bool(true)))
}
fn is_silent_abort_item(item: &thread_pb::Item) -> bool {
	matches!(
		item.kind.as_ref(),
		Some(item::Kind::Message(message))
			if message.role == thread_pb::Role::Assistant as i32
	) && item
		.props
		.as_ref()
		.and_then(|props| props.fields.get(journal_kinds::SILENT_ABORT_PROP))
		.and_then(|value| value.kind.as_ref())
		.is_some_and(|kind| matches!(kind, value::Kind::Bool(true)))
}
///
/// Rewinds are already resolved in `live`. Sequence amendments update only the
/// working copy; original item events remain untouched.
pub fn project_journal(
	view: &LiveLog,
	tool_registry: &ToolRegistry,
	caps: &CapsBase,
) -> Result<thread_pb::Thread, ProjectionError> {
	let items = project_journal_items(view.log(), view.live())?;
	project_thread_history(&thread_pb::Thread { items }, tool_registry, caps)
}

/// Lowers the canonical live journal chain to persisted thread items.
///
/// This is the single event-semantic projection used both by provider history
/// and by child materialization. Tool revision lifting remains a final
/// provider-capability-specific step in [`project_journal`].
pub(crate) fn project_journal_items(
	log: &Log,
	live: &LiveSet,
) -> Result<Vec<thread_pb::Item>, ProjectionError> {
	let mut items = Vec::new();
	let mut positions = SparseMap::new();
	let mut amended = SparseSet::new();
	let mut amendments = SparseMap::new();
	for index in live.iter() {
		let Some(Entry::Ok(event)) = log.get(index) else {
			continue;
		};
		match &event.kind {
			Kind::Item(record) => {
				if is_terminal_error_item(&record.item) || is_silent_abort_item(&record.item) {
					continue;
				}
				let position = items.len();
				let mut item = record.item.clone();
				if amended.contains(index)
					&& let Some(amendment) = amendments.get(index)
				{
					apply_amendment(&mut item, amendment);
				}
				positions.insert(index, position);
				items.push(item);
			},
			Kind::TurnInput(input) => {
				let position = items.len();
				let mut item = input.item.clone();
				if amended.contains(index)
					&& let Some(amendment) = amendments.get(index)
				{
					apply_amendment(&mut item, amendment);
				}
				positions.insert(index, position);
				items.push(item);
			},
			Kind::PromptRewriteStage(stage) => {
				let position = items.len();
				let mut item = stage.item.clone();
				if amended.contains(index)
					&& let Some(amendment) = amendments.get(index)
				{
					apply_amendment(&mut item, amendment);
				}
				positions.insert(index, position);
				items.push(item);
			},
			Kind::JobSettled(settled) => {
				let position = items.len();
				let mut item = settled.settlement.clone();
				if amended.contains(index)
					&& let Some(amendment) = amendments.get(index)
				{
					apply_amendment(&mut item, amendment);
				}
				positions.insert(index, position);
				items.push(item);
			},
			Kind::Compact { summary, method, snapcompact, .. } => {
				let mut parts = vec![thread_pb::Part {
					kind: Some(omp_proto::thread::v1::part::Kind::Text(render_compaction_summary(
						summary,
						method.as_deref(),
					))),
				}];
				if let Some(archive) = snapcompact {
					parts.extend(archive.frames.iter().map(|reference| thread_pb::Part {
						kind: Some(part::Kind::Blob(thread_pb::Blob {
							hash:   Bytes::copy_from_slice(reference.hash.as_bytes()),
							mime:   "image/png".to_owned(),
							size:   reference.size,
							inline: Bytes::new(),
							detail: blob::Detail::Auto as i32,
						})),
					}));
				}
				positions.insert(index, items.len());
				items.push(thread_pb::Item {
					created_at_ms: event.ts,
					kind: Some(item::Kind::Message(thread_pb::Message {
						role: thread_pb::Role::User as i32,
						parts,
					})),
					..Default::default()
				});
			},
			Kind::Custom(custom) if custom.kind() == journal_kinds::REWIND_REPORT_KIND => {
				#[derive(Deserialize)]
				struct RewindReport<'a> {
					#[serde(borrow)]
					report: &'a str,
				}
				let Some(data) = custom.data() else {
					continue;
				};
				let report: RewindReport<'_> = serde_json::from_str(data.get())?;
				items.push(thread_pb::Item {
					created_at_ms: event.ts,
					kind: Some(item::Kind::Message(thread_pb::Message {
						role:  thread_pb::Role::User as i32,
						parts: vec![thread_pb::Part {
							kind: Some(omp_proto::thread::v1::part::Kind::Text(format!(
								"Checkpoint called and rewound. Report retained below. Need explore again \
								 → new `checkpoint`.\n\nReport:\n{}",
								report.report
							))),
						}],
					})),
					..Default::default()
				});
			},
			Kind::Amend { target, patch } => {
				let amendment = amendments.get_or_insert(*target, ItemAmendment::default());
				if !amendment.record(patch) {
					continue;
				}
				amended.insert(*target);
				if let Some(position) = positions.get(*target).copied() {
					apply_amendment(&mut items[position], amendment);
				}
			},
			_ => {},
		}
	}
	Ok(items)
}

/// The effective item-affecting portion of an append-only amendment chain.
#[derive(Default)]
struct ItemAmendment {
	seq:        Option<u64>,
	drop_parts: bool,
}

impl ItemAmendment {
	/// Records one amendment, returning whether it changes canonical projection.
	const fn record(&mut self, patch: &AmendPatch) -> bool {
		match patch {
			AmendPatch::DropParts => {
				self.drop_parts = true;
				true
			},
			AmendPatch::Seq { seq } => {
				self.seq = Some(*seq);
				true
			},
			AmendPatch::Prune { .. } | AmendPatch::RetryRecovery { .. } | AmendPatch::Unknown(_) => {
				false
			},
		}
	}
}

/// Applies compacted projection state without mutating durable transcript
/// bytes.
fn apply_amendment(item: &mut thread_pb::Item, amendment: &ItemAmendment) {
	if let Some(seq) = amendment.seq {
		item.seq = seq;
	}
	if amendment.drop_parts
		&& let Some(item::Kind::ToolResult(result)) = item.kind.as_mut()
	{
		result.parts.clear();
	}
}

/// Re-expresses historical tool calls through complete live revision lifts.
///
/// Calls without a complete lift path are retained exactly. Calls already at
/// the live revision are not decoded or rewritten, preserving their bytes and
/// field presence exactly.
pub fn project_thread_history(
	thread: &thread_pb::Thread,
	tool_registry: &ToolRegistry,
	caps: &CapsBase,
) -> Result<thread_pb::Thread, ProjectionError> {
	let mut projected = thread.clone();
	for call_index in 0..projected.items.len() {
		let Some(item::Kind::ToolCall(call)) = projected.items[call_index].kind.as_ref() else {
			continue;
		};
		let Some(rev) = tool_revision(&projected.items[call_index])? else {
			continue;
		};
		let call_id = call.id.clone();
		let name = call.name.clone();
		let Some(live_identity) = tool_registry.resolved_identity(&name) else {
			continue;
		};
		if live_identity.rev == rev {
			continue;
		}
		let raw_args = call.args_json.clone();
		let Some(result_index) = projected
			.items
			.iter()
			.enumerate()
			.skip(call_index + 1)
			.find_map(|(index, item)| {
				matches!(
					item.kind.as_ref(),
					Some(omp_proto::thread::v1::item::Kind::ToolResult(result))
						if result.call_id == call_id && result.details.is_some()
				)
				.then_some(index)
			})
		else {
			continue;
		};
		let Some(item::Kind::ToolResult(result)) = projected.items[result_index].kind.as_ref() else {
			unreachable!("result index came from ToolResult items")
		};
		let recorded_useless = result.useless.unwrap_or(false);
		let Some(verdict) = proto_json_bytes(
			result
				.details
				.as_ref()
				.expect("selected result has structured details"),
		) else {
			continue;
		};
		let original = RecordedCallOwned {
			identity: ToolIdentity { name: Str::new(name.as_str()), rev: rev.clone() },
			raw_args: Bytes::copy_from_slice(&raw_args),
			verdict,
		};
		let ProjectedCall::Live(live) = tool_registry.project(original) else {
			continue;
		};
		let caps = PromptCaps::for_tool(*caps, &live.identity.rev);
		let rendered =
			tool_registry.project_verdict(&live.identity, &live.verdict, recorded_useless, &caps)?;
		let lifted_verdict: serde_json::Value = serde_json::from_slice(&live.verdict)?;
		let lifted_details = json_proto_value(lifted_verdict);
		let lifted_parts = tool_parts(&rendered.parts)?;

		let Some(item::Kind::ToolCall(call)) = projected.items[call_index].kind.as_mut() else {
			unreachable!("call index came from ToolCall items")
		};
		call.args_json = live.raw_args.clone();
		let props = projected.items[call_index].props.get_or_insert_default();
		props.fields.insert(TOOL_REV_PROP.to_owned(), pb::Value {
			kind: Some(value::Kind::String(live.identity.rev.to_string())),
		});
		let result_props = projected.items[result_index].props.get_or_insert_default();
		result_props
			.fields
			.insert(TOOL_REV_PROP.to_owned(), pb::Value {
				kind: Some(value::Kind::String(live.identity.rev.to_string())),
			});

		let Some(item::Kind::ToolResult(result)) = projected.items[result_index].kind.as_mut() else {
			unreachable!("result index came from ToolResult items")
		};
		result.details = Some(lifted_details);
		result.parts = lifted_parts;
		result.is_error = rendered.is_error;
		result.useless = Some(rendered.useless);
	}
	Ok(projected)
}

pub fn recovery_tool_result_item(
	created_at_ms: u64,
	call_item: &thread_pb::Item,
	abort: Abort,
) -> Result<thread_pb::Item, ProjectionError> {
	let Some(item::Kind::ToolCall(call)) = call_item.kind.as_ref() else {
		return Err(ProjectionError::ExpectedToolCall);
	};
	let rev = tool_revision(call_item)?.ok_or(ProjectionError::MissingRevision)?;
	let identity = ToolIdentity { name: Str::new(call.name.as_str()), rev };
	let text = match &abort {
		Abort::Skipped { reason } => format!("skipped: {reason}"),
		Abort::Interrupted { reason } => format!("interrupted: {reason}"),
		Abort::EffectsUnknown { reason } => format!("aborted with effects unknown: {reason}"),
		Abort::InputDropped => "aborted: invocation input dropped before commit".to_owned(),
		Abort::MissingOutcome => "aborted: executor ended without a terminal outcome".to_owned(),
	};
	let outcome = CallOutcome::<serde_json::Value, serde_json::Value>::aborted(abort);
	let raw = serde_json::to_vec(&outcome)?;
	tool_result_item(created_at_ms, &call.id, &identity, &raw, true, false, &[ToolPart::Text {
		text: Str::new(text),
	}])
}

/// Builds one canonical optimistic tool-result item from durable tool truth.
pub fn tool_result_item(
	created_at_ms: u64,
	call_id: &str,
	identity: &ToolIdentity,
	verdict: &[u8],
	is_error: bool,
	useless: bool,
	parts: &[ToolPart],
) -> Result<thread_pb::Item, ProjectionError> {
	build_tool_result_item(
		created_at_ms,
		call_id,
		identity,
		verdict,
		is_error,
		useless,
		tool_parts(parts)?,
	)
}

/// Builds a canonical optimistic tool result while preserving wire-provided
/// canonical parts as an authoritative fallback.
pub fn tool_result_item_canonical_parts(
	created_at_ms: u64,
	call_id: &str,
	identity: &ToolIdentity,
	verdict: &[u8],
	is_error: bool,
	useless: bool,
	parts: Vec<thread_pb::Part>,
) -> Result<thread_pb::Item, ProjectionError> {
	build_tool_result_item(created_at_ms, call_id, identity, verdict, is_error, useless, parts)
}

fn build_tool_result_item(
	created_at_ms: u64,
	call_id: &str,
	identity: &ToolIdentity,
	verdict: &[u8],
	is_error: bool,
	useless: bool,
	parts: Vec<thread_pb::Part>,
) -> Result<thread_pb::Item, ProjectionError> {
	let details = json_proto_value(serde_json::from_slice(verdict)?);
	let props = pb::ValueMap {
		fields: BTreeMap::from([(TOOL_REV_PROP.to_owned(), pb::Value {
			kind: Some(value::Kind::String(identity.rev.to_string())),
		})]),
	};
	Ok(thread_pb::Item {
		seq: 0,
		created_at_ms,
		kind: Some(item::Kind::ToolResult(thread_pb::ToolResult {
			call_id: call_id.to_owned(),
			parts,
			is_error,
			name: identity.name.as_str().to_owned(),
			details: Some(details),
			useless: Some(useless),
			..Default::default()
		})),
		props: Some(props),
	})
}

fn tool_revision(item: &thread_pb::Item) -> Result<Option<Rev>, ProjectionError> {
	let Some(value) = item
		.props
		.as_ref()
		.and_then(|props| props.fields.get(TOOL_REV_PROP))
	else {
		return Ok(None);
	};
	let Some(value::Kind::String(value)) = value.kind.as_ref() else {
		return Err(ProjectionError::RevisionType);
	};
	Ok(Some(
		value
			.parse::<Rev>()
			.map_err(|_| ProjectionError::InvalidRevision)?,
	))
}

fn proto_json_bytes(value: &pb::Value) -> Option<Bytes> {
	serde_json::to_vec(&proto_json_value(value)?)
		.ok()
		.map(Bytes::from)
}

fn proto_json_value(value: &pb::Value) -> Option<serde_json::Value> {
	let value = match value.kind.as_ref()? {
		value::Kind::Null(_) => serde_json::Value::Null,
		value::Kind::Int(value) => serde_json::Value::from(*value),
		value::Kind::Double(value) => {
			serde_json::Value::Number(serde_json::Number::from_f64(*value)?)
		},
		value::Kind::Bool(value) => serde_json::Value::Bool(*value),
		value::Kind::String(value) => serde_json::Value::String(value.clone()),
		value::Kind::List(list) => serde_json::Value::Array(
			list
				.values
				.iter()
				.map(proto_json_value)
				.collect::<Option<Vec<_>>>()?,
		),
		value::Kind::Map(map) => serde_json::Value::Object(
			map.fields
				.iter()
				.map(|(key, value)| Some((key.clone(), proto_json_value(value)?)))
				.collect::<Option<serde_json::Map<_, _>>>()?,
		),
		value::Kind::Uint(value) => serde_json::Value::from(*value),
	};
	Some(value)
}

fn json_proto_value(value: serde_json::Value) -> pb::Value {
	let kind = match value {
		serde_json::Value::Null => value::Kind::Null(true),
		serde_json::Value::Bool(value) => value::Kind::Bool(value),
		serde_json::Value::Number(value) => {
			if let Some(value) = value.as_i64() {
				value::Kind::Int(value)
			} else if let Some(value) = value.as_u64() {
				value::Kind::Uint(value)
			} else {
				value::Kind::Double(value.as_f64().expect("JSON numbers are finite"))
			}
		},
		serde_json::Value::String(value) => value::Kind::String(value),
		serde_json::Value::Array(values) => value::Kind::List(pb::ValueList {
			values: values.into_iter().map(json_proto_value).collect(),
		}),
		serde_json::Value::Object(fields) => value::Kind::Map(pb::ValueMap {
			fields: fields
				.into_iter()
				.map(|(key, value)| (key, json_proto_value(value)))
				.collect(),
		}),
	};
	pb::Value { kind: Some(kind) }
}

fn tool_parts(parts: &[ToolPart]) -> Result<Vec<thread_pb::Part>, ProjectionError> {
	let mut projected = Vec::with_capacity(parts.len());
	for part in parts {
		match part {
			ToolPart::Text { text } => projected
				.push(thread_pb::Part { kind: Some(part::Kind::Text(text.as_str().to_owned())) }),
			ToolPart::Json { json } => projected.push(thread_pb::Part {
				kind: Some(part::Kind::Text(str::from_utf8(json)?.to_owned())),
			}),
			ToolPart::Blob { blob, alt } => {
				if let Some(alt) = alt {
					projected
						.push(thread_pb::Part { kind: Some(part::Kind::Text(alt.as_str().to_owned())) });
				}
				let hash = hex::decode(blob.hash.as_str())
					.into_vec()
					.map_err(|_| ProjectionError::BlobHash)?;
				if hash.len() != 32 {
					return Err(ProjectionError::BlobHash);
				}
				projected.push(thread_pb::Part {
					kind: Some(part::Kind::Blob(thread_pb::Blob {
						hash: hash.into(),
						mime: blob.media_type.as_str().to_owned(),
						size: blob.byte_len,
						..Default::default()
					})),
				});
			},
		}
	}
	Ok(projected)
}

#[cfg(test)]
mod tests {
	use std::{
		collections::BTreeMap,
		env, fs,
		sync::atomic::{AtomicU64, Ordering},
	};

	use bytes::Bytes;
	use omp_proto::{
		inference::v1::{self as pb, value},
		thread::v1::{self as thread_pb, blob, item},
	};
	use omp_storage::transcript::{
		AmendPatch, Event, Header, ItemRecord, Kind, SessionId, Writer, load, load_live,
	};
	use omp_tool::{CapsBase, ModelClass, TOOL_REV_PROP};

	use super::{project_journal, render_compaction_summary};

	static NEXT_PATH: AtomicU64 = AtomicU64::new(0);

	#[test]
	fn handoff_compaction_uses_successor_memory_framing() {
		let rendered =
			render_compaction_summary("## Next Steps\nRun the focused test.", Some("handoff"));
		assert!(rendered.contains("<handoff>"));
		assert!(rendered.contains("prior instance"));
		assert!(rendered.contains("NEVER write another handoff document"));
		assert!(!rendered.contains("<summary>"));
	}

	#[test]
	fn ordinary_compaction_keeps_summary_framing() {
		let rendered = render_compaction_summary("portable state", Some("remote"));
		assert!(rendered.contains("<summary>"));
		assert!(rendered.contains("portable state"));
		assert!(!rendered.contains("<handoff>"));
	}
	#[test]
	fn silent_abort_marker_is_durable_but_absent_from_replay_projection() {
		let path = env::temp_dir().join(format!(
			"omp-agent-project-silent-abort-{}-{}.jsonl",
			std::process::id(),
			NEXT_PATH.fetch_add(1, Ordering::Relaxed)
		));
		let mut writer = Writer::create(&path, &Header {
			v:       4,
			id:      SessionId(sf!("silent-abort")),
			created: 1,
			cwd:     env::temp_dir(),
		})
		.expect("create transcript");
		let item = thread_pb::Item {
			kind: Some(item::Kind::Message(thread_pb::Message {
				role:  thread_pb::Role::Assistant as i32,
				parts: Vec::new(),
			})),
			props: Some(pb::ValueMap {
				fields: BTreeMap::from([
					(crate::journal_kinds::SILENT_ABORT_PROP.to_owned(), pb::Value {
						kind: Some(value::Kind::Bool(true)),
					}),
					(crate::journal_kinds::ABORT_REASON_PROP.to_owned(), pb::Value {
						kind: Some(value::Kind::String("TTSR matched rule: no-unwrap".to_owned())),
					}),
				]),
			}),
			..Default::default()
		};
		writer
			.append(&Event {
				ts:   2,
				kind: Kind::Item(ItemRecord {
					item:        item.clone(),
					turn_id:     None,
					prompt_hash: None,
				}),
			})
			.expect("append aborted assistant");
		drop(writer);

		let log = load(&path).expect("load transcript");
		let Some(omp_storage::transcript::Entry::Ok(event)) = log.get(0) else {
			panic!("durable entry is an assistant item");
		};
		let Event { kind: Kind::Item(record), .. } = event.as_ref() else {
			panic!("durable entry is an assistant item");
		};
		assert_eq!(record.item, item);
		let view = load_live(&path).expect("load live transcript");
		let projected = project_journal(&view, &omp_tool::Registry::new(), &CapsBase {
			maximum_parts:      1,
			maximum_text_bytes: 1,
			media:              false,
			model_class:        ModelClass::Standard,
		})
		.expect("project transcript");
		assert!(projected.items.is_empty());
		fs::remove_file(path).expect("remove transcript");
	}

	#[test]
	fn user_blob_survives_projection_when_tool_media_is_disabled() {
		let path = env::temp_dir().join(format!(
			"omp-agent-project-user-blob-{}-{}.jsonl",
			std::process::id(),
			NEXT_PATH.fetch_add(1, Ordering::Relaxed)
		));
		let mut writer = Writer::create(&path, &Header {
			v:       4,
			id:      SessionId(sf!("user-blob")),
			created: 1,
			cwd:     env::temp_dir(),
		})
		.expect("create transcript");
		let blob = thread_pb::Blob {
			hash:   Bytes::from_static(&[7; 32]),
			mime:   "image/png".to_owned(),
			size:   4,
			inline: Bytes::from_static(b"data"),
			detail: blob::Detail::Auto as i32,
		};
		let item = thread_pb::Item {
			kind: Some(item::Kind::Message(thread_pb::Message {
				role:  thread_pb::Role::User as i32,
				parts: vec![thread_pb::Part {
					kind: Some(omp_proto::thread::v1::part::Kind::Blob(blob)),
				}],
			})),
			..Default::default()
		};
		writer
			.append(&Event {
				ts:   2,
				kind: Kind::Item(ItemRecord {
					item:        item.clone(),
					turn_id:     None,
					prompt_hash: None,
				}),
			})
			.expect("append user item");
		drop(writer);

		let view = load_live(&path).expect("load transcript");
		let projected = project_journal(&view, &omp_tool::Registry::new(), &CapsBase {
			maximum_parts:      1,
			maximum_text_bytes: 1024,
			media:              false,
			model_class:        ModelClass::Standard,
		})
		.expect("project transcript");
		assert_eq!(projected.items, vec![item]);
		fs::remove_file(path).expect("remove transcript");
	}

	#[test]
	fn drop_parts_preserves_tool_result_details_and_revision() {
		let path = env::temp_dir().join(format!(
			"omp-agent-project-drop-parts-{}-{}.jsonl",
			std::process::id(),
			NEXT_PATH.fetch_add(1, Ordering::Relaxed)
		));
		let mut writer = Writer::create(&path, &Header {
			v:       4,
			id:      SessionId(sf!("drop-parts")),
			created: 1,
			cwd:     env::temp_dir(),
		})
		.expect("create transcript");
		let details = pb::Value { kind: Some(value::Kind::String("recorded".to_owned())) };
		let item = thread_pb::Item {
			kind: Some(item::Kind::ToolResult(thread_pb::ToolResult {
				call_id: "call-1".to_owned(),
				name: "read".to_owned(),
				parts: vec![thread_pb::Part {
					kind: Some(omp_proto::thread::v1::part::Kind::Text("large result".to_owned())),
				}],
				details: Some(details.clone()),
				is_error: true,
				useless: Some(true),
				..Default::default()
			})),
			props: Some(pb::ValueMap {
				fields: BTreeMap::from([(TOOL_REV_PROP.to_owned(), pb::Value {
					kind: Some(value::Kind::String("read.1".to_owned())),
				})]),
			}),
			..Default::default()
		};
		let target = writer
			.append(&Event {
				ts:   2,
				kind: Kind::Item(ItemRecord { item, turn_id: None, prompt_hash: None }),
			})
			.expect("append tool result");
		writer
			.append(&Event { ts: 3, kind: Kind::Amend { target, patch: AmendPatch::DropParts } })
			.expect("append content drop");
		drop(writer);

		let view = load_live(&path).expect("load transcript");
		let projected = project_journal(&view, &omp_tool::Registry::new(), &CapsBase {
			maximum_parts:      8,
			maximum_text_bytes: 4_096,
			media:              true,
			model_class:        ModelClass::Standard,
		})
		.expect("project transcript");
		let Some(item::Kind::ToolResult(result)) = projected.items[0].kind.as_ref() else {
			panic!("projected item is a tool result");
		};
		assert!(result.parts.is_empty());
		assert_eq!(result.details.as_ref(), Some(&details));
		assert!(result.is_error);
		assert_eq!(result.useless, Some(true));
		assert_eq!(
			projected.items[0]
				.props
				.as_ref()
				.and_then(|props| props.fields.get(TOOL_REV_PROP)),
			Some(&pb::Value {
				kind: Some(omp_proto::inference::v1::value::Kind::String("read.1".to_owned())),
			})
		);
		fs::remove_file(path).expect("remove transcript");
	}
}
