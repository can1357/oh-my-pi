//! Second-model watchdog: a Director whose engagement pairs the session with
//! the `@advisor` role model, which reads the primary transcript as
//! incremental *Session update*s and speaks only through the `advise` tool.
//!
//! Where the TS implementation runs the advisor as a concurrent agent that
//! steers the primary from the outside, this Director reviews at the two
//! points the kernel already exposes cold hooks for: every candidate yield
//! ([`Director::before_yield`]) and, when `ai_advisor_sync_backlog` names a
//! turn count, mid-turn once that many primary turns are unreviewed
//! ([`Director::before_inference`]). The review is one isolated inference on
//! the advisor route; the kernel drops it on interrupt.
//!
//! Delivery routes a `nit` as an aside and a `concern`/`blocker` as steering,
//! except that a `concern` never wakes an idle primary that just gave a
//! terminal answer with no queued work, never interrupts inside the
//! post-interrupt immune window (`ai_advisor_immune_turns`), and never
//! triggers a turn under plan mode. Every accepted note is journaled twice in
//! the turn: the model-facing `<developer>` aside carrying exact
//! `<advisory>` bytes and the transcript's `<notice kind=advisor>` card. A
//! steered note makes the Director consume the candidate yield
//! (`Verdict::Continue`) and start another turn.
//!
//! Everything durable is element state under `<meta><directors>`: roster
//! health (`status`), whether the yielded turn is reviewed (`yielded`, the
//! status-band eye), the delivered projection cursor, the failure ladder, the
//! primary-turn counter and immune fence. Earlier advice and the dedupe set
//! derive from the `<notice kind=advisor>` elements already in `<body>`.

use std::{fmt::Write as _, sync::Arc};

use futures::StreamExt;
use omp_ai::{
	ChatEvent, ChatRequest, Completion, ContentPart, ErrorKind, Message, OpaqueJson, Role, Setting,
	ToolChoice, ToolDefinition, ToolInputConstraint, ToolResultContent,
	settings::{AI_ADVISOR_ENABLED, AI_ADVISOR_IMMUNE_TURNS, AI_ADVISOR_SYNC_BACKLOG},
};
use omp_con::Ctx;
use omp_core::{FastHashMap, FastHashSet, Str, sf};
use omp_dom::{Dom, Handle, KnownTag, Node, NodeSpec, Op, PropId, PropKey, Tag, Value};
use omp_journal::data::{AdvisorMessage, ReceiptIdentity, ReceiptRole, TurnReceipt};
pub use omp_journal::data::{AdvisorNote as Note, AdvisorSeverity as Severity};
use omp_session::{Session, projection::project_thread};
use strum::{Display, EnumString};

use crate::director::{
	BindValue, BoxFut, Director, DirectorCx, DirectorEffect, DirectorError, DirectorRegistry,
	DirectorStack, MutDirectorCx, Prepared, StateUpdate, TurnView, Verdict, find_director, patch,
	state_bool, state_int, state_str, update_ops,
};

/// Director family and registry id.
pub const FAMILY: &str = "advisor";
/// Model selector the review runs on, defaulting to the `slow` chain through
/// the catalog's known roles.
pub const MODEL_SELECTOR: &str = "@advisor";
/// The primary's only cue for how to treat advice.
pub const GUIDANCE: &str = "weigh, don't blindly obey";
const SYSTEM_PROMPT: &str = include_str!("../../prompts/modes/advisor.md");
const ADVISE_DESCRIPTION: &str = include_str!("../../prompts/advisor/advise-tool.md");
/// Appended to the system prompt: this Director grants no tools, so the
/// prompt's "verify with session-granted tools" clause has nothing to grant.
const TOOL_GRANT: &str = "Session-granted tools: none. Advise from the rendered transcript alone.";
const HEADING: &str = "### Session update";
const WIP_TRAILER: &str = "[in progress — more steps follow]";
/// Transient failures tolerated before the backlog is dropped and the roster
/// reports `error`.
const MAX_FAILURES: i64 = 3;
/// Per-tool budget for expanded input and output.
const TOOL_IO_MAX_BYTES: usize = 8 * 1024;
const TOOL_IO_MAX_LINES: usize = 80;
/// One-line argument preview length.
const PRIMARY_ARG_MAX: usize = 120;
/// Whole-update bound; the head is elided when the backlog exceeds it.
const UPDATE_MAX_BYTES: usize = 192 * 1024;
const ELIDED_MARKER: &str = "[…content elided to fit advisor context…]";
/// Per-tool preference order for the most informative scalar argument.
const PRIMARY_ARG_KEYS: &[&str] = &[
	"path",
	"file_path",
	"filePath",
	"command",
	"cmd",
	"pattern",
	"url",
	"query",
	"prompt",
	"assignment",
	"note",
	"message",
	"op",
	"name",
	"id",
];
/// Content-free filler the emission guard drops.
const CONTENT_FREE: &[&str] = &[
	"stop",
	"stop here",
	"stop now",
	"halt",
	"abort",
	"done",
	"task done",
	"task complete",
	"complete",
	"finished",
	"ok",
	"okay",
	"ok done",
	"no issue",
	"no issues",
	"no issue continue",
	"no concerns",
	"no concern",
	"nothing to add",
	"nothing to flag",
	"nothing to report",
	"no notes",
	"no further input",
	"no further input needed",
	"no further input required",
	"no further watcher input",
	"no further watcher input needed",
	"no further advice",
	"no further advice needed",
	"lgtm",
	"looks good",
	"all good",
	"agent is on track",
	"agent on track",
	"on track",
	"continue",
	"carry on",
];

/// Runtime health of the advisor.
#[derive(Clone, Copy, Debug, Default, Display, EnumString, Eq, PartialEq)]
#[strum(serialize_all = "snake_case")]
pub enum Status {
	/// Actively reviewing primary turns.
	#[default]
	Running,
	/// User-toggled off; the roster keeps the entry.
	Paused,
	/// The provider refused on quota; cleared by toggling the advisor.
	QuotaExhausted,
	/// Repeated transient failures; the backlog was dropped.
	Error,
	/// No model resolves for the `@advisor` role.
	NoModel,
}

/// How one accepted note reaches the primary.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Channel {
	/// Non-interrupting: lands at the next step boundary.
	Aside,
	/// Interrupting: consumes the candidate yield so the primary acts now.
	Steer,
	/// Visible card only; never wakes an idle primary.
	Preserve,
}

/// Facts the channel decision reads.
#[derive(Clone, Copy, Debug, Default)]
pub struct DeliveryFacts {
	/// The primary loop is mid-turn (a sync-backlog review).
	pub streaming: bool,
	/// The primary's tail is a terminal text answer with no queued prompts.
	pub terminal_answer_no_queued_work: bool,
	/// Inside the post-interrupt immune window.
	pub immune_active: bool,
	/// The plan Director is engaged: only user-driven turns converge.
	pub plan_mode: bool,
}

/// Resolves the delivery channel, including the plan-mode preserve rule for
/// steering.
#[must_use]
pub fn delivery_channel(severity: Severity, facts: DeliveryFacts) -> Channel {
	if !severity.interrupting() {
		return Channel::Aside;
	}
	if facts.terminal_answer_no_queued_work && severity != Severity::Blocker && !facts.streaming {
		return Channel::Preserve;
	}
	if facts.immune_active && severity != Severity::Blocker {
		return Channel::Aside;
	}
	if facts.plan_mode {
		return Channel::Preserve;
	}
	Channel::Steer
}

/// Lowercases, collapses non-alphanumerics to one space, and trims the dedupe
/// key.
#[must_use]
pub fn normalize_note(note: &str) -> Str {
	let mut normalized = String::with_capacity(note.len());
	let mut separator = false;
	for character in note.chars().flat_map(char::to_lowercase) {
		if character.is_alphanumeric() {
			if separator && !normalized.is_empty() {
				normalized.push(' ');
			}
			separator = false;
			normalized.push(character);
		} else {
			separator = true;
		}
	}
	Str::new(normalized)
}

/// Formats one note as agent-facing bytes.
#[must_use]
pub fn advisory_text(note: &Note) -> Str {
	let advisor = if note.advisor == "default" {
		Str::default()
	} else {
		sf!(" advisor=\"{}\"", escape_xml_attribute(note.advisor.as_str()))
	};
	Str::new(format!(
		"<advisory{advisor} severity=\"{}\" guidance=\"{GUIDANCE}\">\n{}\n</advisory>",
		note.severity,
		escape_xml_text(note.note.as_str())
	))
}

/// The advisor watchdog engagement.
pub struct Advisor {
	status:          Status,
	yielded:         bool,
	/// Projected thread items already delivered to the advisor.
	delivered:       i64,
	/// Compaction markers seen when `delivered` was taken; a change re-primes
	/// the advisor from the rewritten history.
	compactions:     i64,
	failures:        i64,
	/// Primary turns completed since engagement.
	completed_turns: i64,
	/// `completed_turns` when the last interrupting note was delivered; `-1`
	/// when none.
	immune_start:    i64,
	/// A steered note awaits the candidate-yield verdict.
	pending_steer:   bool,
}

impl Default for Advisor {
	fn default() -> Self {
		Self::new()
	}
}

impl Advisor {
	/// Creates a running advisor whose first update delivers the whole primary
	/// transcript.
	#[must_use]
	pub const fn new() -> Self {
		Self {
			status:          Status::Running,
			yielded:         false,
			delivered:       0,
			compactions:     0,
			failures:        0,
			completed_turns: 0,
			immune_start:    -1,
			pending_steer:   false,
		}
	}

	/// Reconstructs the engagement from its element.
	#[must_use]
	pub fn from_node(node: &Node) -> Self {
		Self {
			status:          state_str(node, "status")
				.and_then(|status| status.parse().ok())
				.unwrap_or_default(),
			yielded:         state_bool(node, "yielded").unwrap_or(false),
			delivered:       state_int(node, "delivered").unwrap_or(0),
			compactions:     state_int(node, "compactions").unwrap_or(0),
			failures:        state_int(node, "failures").unwrap_or(0),
			completed_turns: state_int(node, "completed_turns").unwrap_or(0),
			immune_start:    state_int(node, "immune_start").unwrap_or(-1),
			pending_steer:   state_bool(node, "pending_steer").unwrap_or(false),
		}
	}

	/// Roster health.
	#[must_use]
	pub const fn status(&self) -> Status {
		self.status
	}

	/// Whether the advisor finished reviewing the yielded turn.
	#[must_use]
	pub const fn yielded(&self) -> bool {
		self.yielded
	}

	/// Whether the post-interrupt immune window remains active.
	fn immune_active(&self, con: Option<&Ctx>) -> bool {
		let immune_turns = con.map_or(3, |con| AI_ADVISOR_IMMUNE_TURNS.get(con));
		self.immune_start >= 0
			&& immune_turns > 0
			&& self.completed_turns < self.immune_start.saturating_add(immune_turns)
	}

	/// One review of everything delivered since the cursor. `wip` marks a
	/// mid-turn (sync-backlog) update. Returns whether the projection changed.
	async fn review(
		&self,
		cx: &mut MutDirectorCx<'_>,
		wip: bool,
		terminal_answer_no_queued_work: bool,
	) -> Result<bool, DirectorError> {
		if matches!(self.status, Status::Paused | Status::QuotaExhausted | Status::NoModel) {
			return Ok(false);
		}
		let Some(handle) = cx.director else {
			return Ok(false);
		};
		let dom = cx.session.dom();
		let items = project_thread(dom);
		let compactions = compaction_count(dom);
		let mut delivered = usize::try_from(self.delivered).unwrap_or(0);
		if compactions != self.compactions || items.len() < delivered {
			delivered = 0;
		}
		if delivered >= items.len() {
			if !wip && !self.yielded {
				patch(
					cx.session,
					"advisor.review",
					update_ops(handle, vec![StateUpdate::new("yielded", BindValue::Bool(true))]),
				)?;
			}
			return Ok(false);
		}
		let delta = Message::from_thread_items(&items[delivered..])?;
		let update = render_update(&delta, wip);
		let earlier = earlier_notes(dom);
		let request = advisor_request(update, &earlier);
		let outcome = match cx.inference.execute_on(MODEL_SELECTOR, request).await {
			Ok(stream) => collect_notes(stream).await,
			Err(error) => Err(error),
		};
		let mut updates = Vec::with_capacity(8);
		let mut ops = Vec::new();
		let mut receipt = None;
		let mut seen = earlier
			.iter()
			.map(|note| normalize_note(note.note.as_str()))
			.collect::<FastHashSet<Str>>();
		match outcome {
			Ok(review) => {
				receipt = review.receipt;
				updates.push(StateUpdate::new("status", BindValue::Str(Str::new_static("running"))));
				updates.push(StateUpdate::new("failures", BindValue::Int(0)));
				updates.push(StateUpdate::new("delivered", BindValue::Int(items.len() as i64)));
				updates.push(StateUpdate::new("compactions", BindValue::Int(compactions)));
				// Reject noise, session duplicates, and all but one note per
				// update; a suppressed note never burns the slot.
				let accepted = review.notes.into_iter().find(|note| {
					let key = normalize_note(note.note.as_str());
					!key.is_empty() && !CONTENT_FREE.contains(&key.as_str()) && seen.insert(key)
				});
				if let Some(note) = accepted {
					let facts = DeliveryFacts {
						streaming: wip,
						terminal_answer_no_queued_work,
						immune_active: self.immune_active(cx.con),
						plan_mode: plan_engaged(dom),
					};
					let channel = delivery_channel(note.severity, facts);
					ops.push(notice_op(dom, cx.turn, std::slice::from_ref(&note))?);
					ops.push(developer_op(dom, cx.turn, advisory_text(&note)));
					if channel == Channel::Steer {
						// Arm the immune window only when a turn is actually
						// steered.
						updates.push(StateUpdate::new(
							"immune_start",
							BindValue::Int(self.completed_turns.saturating_add(1)),
						));
						updates.push(StateUpdate::new("pending_steer", BindValue::Bool(!wip)));
					}
				}
			},
			Err(error) => match error.kind {
				ErrorKind::QuotaExhausted | ErrorKind::RateLimited | ErrorKind::PaymentRequired => {
					updates.push(StateUpdate::new(
						"status",
						BindValue::Str(Str::new_static("quota_exhausted")),
					));
				},
				ErrorKind::TargetNotFound | ErrorKind::RouteUnavailable => {
					updates
						.push(StateUpdate::new("status", BindValue::Str(Str::new_static("no_model"))));
				},
				ErrorKind::Cancelled => return Ok(false),
				_ => {
					let failures = self.failures.saturating_add(1);
					if failures >= MAX_FAILURES {
						updates
							.push(StateUpdate::new("status", BindValue::Str(Str::new_static("error"))));
						updates.push(StateUpdate::new("failures", BindValue::Int(0)));
						updates.push(StateUpdate::new("delivered", BindValue::Int(items.len() as i64)));
						updates.push(StateUpdate::new("compactions", BindValue::Int(compactions)));
					} else {
						updates.push(StateUpdate::new("failures", BindValue::Int(failures)));
					}
				},
			},
		}
		if !wip {
			updates.push(StateUpdate::new("yielded", BindValue::Bool(true)));
		}
		let changed = !ops.is_empty();
		ops.extend(update_ops(handle, updates));
		if let Some(receipt) = receipt {
			cx.session.receipt(receipt)?;
		}
		patch(cx.session, "advisor.review", ops)?;
		Ok(changed)
	}
}

impl Director for Advisor {
	fn id(&self) -> &'static str {
		FAMILY
	}

	fn state(&self) -> Vec<(Str, BindValue)> {
		vec![
			(Str::new_static("status"), BindValue::Str(Str::new(self.status.to_string()))),
			(Str::new_static("yielded"), BindValue::Bool(self.yielded)),
			(Str::new_static("delivered"), BindValue::Int(self.delivered)),
			(Str::new_static("compactions"), BindValue::Int(self.compactions)),
			(Str::new_static("failures"), BindValue::Int(self.failures)),
			(Str::new_static("completed_turns"), BindValue::Int(self.completed_turns)),
			(Str::new_static("immune_start"), BindValue::Int(self.immune_start)),
			(Str::new_static("pending_steer"), BindValue::Bool(self.pending_steer)),
		]
	}

	fn before_inference<'a>(
		&'a self,
		cx: &'a mut MutDirectorCx<'_>,
		_req: &'a ChatRequest,
	) -> BoxFut<'a, Result<Prepared, DirectorError>> {
		Box::pin(async move {
			// `off`, or the number of primary turns the advisor may fall behind
			// before the primary waits for it.
			let Some(threshold) = cx
				.con
				.and_then(|con| AI_ADVISOR_SYNC_BACKLOG.get(con).parse::<usize>().ok())
				.filter(|threshold| *threshold > 0)
			else {
				return Ok(Prepared::Unchanged);
			};
			let unreviewed = unreviewed_assistant_turns(cx.session.dom(), self.delivered);
			if unreviewed < threshold {
				return Ok(Prepared::Unchanged);
			}
			Ok(if self.review(cx, true, false).await? {
				Prepared::Rebuild
			} else {
				Prepared::Unchanged
			})
		})
	}

	fn before_yield<'a>(
		&'a self,
		cx: &'a mut MutDirectorCx<'_>,
		turn: &'a TurnView,
	) -> BoxFut<'a, Result<(), DirectorError>> {
		Box::pin(async move {
			let terminal_answer_no_queued_work =
				!turn.assistant_text.trim().is_empty() && !queued_prompts(cx.session.dom());
			self
				.review(cx, false, terminal_answer_no_queued_work)
				.await
				.map(drop)
		})
	}

	fn observe_turn(&self, _dom: &Dom, _cx: &DirectorCx<'_>, _turn: &TurnView) -> Vec<StateUpdate> {
		// A completed primary turn re-opens the eye until the yield review
		// catches up and advances the immune fence.
		let mut updates = vec![StateUpdate::new(
			"completed_turns",
			BindValue::Int(self.completed_turns.saturating_add(1)),
		)];
		if self.yielded {
			updates.push(StateUpdate::new("yielded", BindValue::Bool(false)));
		}
		updates
	}

	fn evaluate(&self, _dom: &Dom, _cx: &DirectorCx<'_>, _turn: &TurnView) -> DirectorEffect {
		if self.pending_steer {
			// The advisory is already in the turn; consume the yield to start
			// another turn.
			DirectorEffect::new(Verdict::Continue { reminder: None })
				.with_update("pending_steer", BindValue::Bool(false))
		} else {
			DirectorEffect::new(Verdict::Pass)
		}
	}
}

/// Engages the advisor at launch when `ai_advisor_enabled` is set (`--advisor`
/// or the archived `advisor.enabled`); idempotent.
pub fn apply_launch(session: &mut Session, con: &Ctx) -> Result<(), DirectorError> {
	if !AI_ADVISOR_ENABLED.get(con) {
		return Ok(());
	}
	engage(session)
}

/// Engages a fresh advisor unless one is already active; returns whether the
/// call engaged it.
pub fn engage(session: &mut Session) -> Result<(), DirectorError> {
	let registry = DirectorRegistry::standard();
	let mut stack = DirectorStack::from_dom(session.dom(), &registry);
	if stack.active_ids().contains(&FAMILY) {
		return Ok(());
	}
	stack.engage(session, Box::new(Advisor::new())).map(drop)
}

/// Number of `<meta>` compaction markers.
fn compaction_count(dom: &Dom) -> i64 {
	dom.children(dom.meta())
		.iter()
		.filter(|handle| {
			dom.get(**handle)
				.is_some_and(|node| node.tag.as_str() == "compaction")
		})
		.count() as i64
}

/// Completed assistant messages in the projection past the delivered cursor.
fn unreviewed_assistant_turns(dom: &Dom, delivered: i64) -> usize {
	let items = project_thread(dom);
	let delivered = usize::try_from(delivered).unwrap_or(0).min(items.len());
	items[delivered..]
		.iter()
		.filter(|item| {
			matches!(
				item.kind.as_ref(),
				Some(omp_proto::thread::v1::item::Kind::Message(message))
					if message.role == omp_proto::thread::v1::Role::Assistant as i32
			)
		})
		.count()
}

/// Whether a queued follow-up prompt awaits the yield.
fn queued_prompts(dom: &Dom) -> bool {
	dom.children(dom.queues()).iter().any(|queue| {
		dom.get(*queue)
			.is_some_and(|node| node.tag == Tag::Known(KnownTag::Prompts))
			&& dom.children(*queue).iter().any(|prompt| {
				dom.get(*prompt).is_some_and(|node| {
					node.tag == Tag::Known(KnownTag::Prompt)
						&& prop_str(node, PropId::Kind) == Some("queued")
						&& prop_str(node, PropId::Status) == Some("pending")
				})
			})
	})
}

fn plan_engaged(dom: &Dom) -> bool {
	find_director(dom, "plan").is_some_and(|(_, node)| {
		node
			.prop(&PropKey::Custom(Str::new_static("status")))
			.and_then(Value::as_str)
			== Some("active")
	})
}

/// Advice already delivered in this session, oldest first, read back from
/// the transcript's `<notice kind=advisor>` cards (rewind and `/new` forget
/// them with the rest of the tree).
fn earlier_notes(dom: &Dom) -> Vec<Note> {
	let mut notes = Vec::new();
	for turn in dom.children(dom.body()) {
		for handle in dom.children(*turn) {
			let Some(node) = dom.get(*handle) else {
				continue;
			};
			if node.tag != Tag::Known(KnownTag::Notice) || prop_str(node, PropId::Kind) != Some(FAMILY)
			{
				continue;
			}
			if let Some(Value::Json(data)) = node.prop(&PropKey::from(PropId::Data))
				&& let Ok(message) = serde_json::from_str::<AdvisorMessage>(data.get())
			{
				notes.extend(message.notes);
				continue;
			}
			let Some(note) = node.content.clone() else {
				continue;
			};
			let severity = prop_str(node, PropId::Severity)
				.and_then(|severity| severity.parse().ok())
				.unwrap_or_default();
			notes.push(Note { advisor: Str::new_static("default"), note, severity });
		}
	}
	notes
}

fn prop_str(node: &Node, prop: PropId) -> Option<&str> {
	node.prop(&PropKey::from(prop)).and_then(Value::as_str)
}

fn notice_op(dom: &Dom, turn: Handle, notes: &[Note]) -> Result<Op, serde_json::Error> {
	let data = serde_json::value::to_raw_value(&AdvisorMessage { notes: notes.to_vec() })?;
	let mut content = String::new();
	for note in notes {
		if !content.is_empty() {
			content.push('\n');
		}
		content.push_str(note.note.as_str());
	}
	Ok(Op::Ins {
		parent: turn,
		after:  dom.children(turn).last().copied(),
		node:   NodeSpec::new(KnownTag::Notice)
			.with_prop(PropId::Kind, Value::Str(Str::new_static(FAMILY)))
			.with_prop(PropId::Data, Value::Json(data))
			.with_content(Str::new(content)),
	})
}

/// The model-facing aside; anchored on the turn tail *after* the notice
/// inserted in the same transaction lands there (both anchor on the
/// pre-transaction tail, so the later insert sits before the earlier one —
/// the developer aside therefore anchors on nothing and is appended last).
fn developer_op(dom: &Dom, turn: Handle, text: Str) -> Op {
	Op::Ins {
		parent: turn,
		after:  dom.children(turn).last().copied(),
		node:   NodeSpec::new(KnownTag::Developer).with_content(text),
	}
}

/// The advisor request: the system prompt, the `advise` tool, the advisor's
/// own earlier notes as append-only context, then the session update.
fn advisor_request(update: Str, earlier: &[Note]) -> ChatRequest {
	let mut system = String::with_capacity(SYSTEM_PROMPT.len() + TOOL_GRANT.len() + 2);
	system.push_str(SYSTEM_PROMPT);
	system.push_str("\n\n");
	system.push_str(TOOL_GRANT);
	let mut messages = Vec::with_capacity(3);
	messages.push(text_message(Role::System, Str::new(system)));
	if !earlier.is_empty() {
		let mut recap = String::from("### Your earlier advice (never repeat it)\n");
		for note in earlier
			.iter()
			.rev()
			.take(8)
			.collect::<Vec<_>>()
			.into_iter()
			.rev()
		{
			let _ = writeln!(recap, "- [{}] {}", note.severity, one_line(note.note.as_str(), 200));
		}
		messages.push(text_message(Role::User, Str::new(recap)));
	}
	messages.push(text_message(Role::User, update));
	let parameters = serde_json::json!({
		"type": "object",
		"properties": {
			"note": {"type": "string", "description": "One concrete, terse advice for the watched agent."},
			"severity": {"type": "string", "enum": ["nit", "concern", "blocker"]}
		},
		"required": ["note"],
		"additionalProperties": false
	});
	ChatRequest {
		messages:          messages.into(),
		tools:             Arc::from([ToolDefinition {
			name:        Str::new_static("advise"),
			description: Some(Str::new_static(ADVISE_DESCRIPTION)),
			input:       ToolInputConstraint::JsonSchema {
				parameters: OpaqueJson::new(parameters),
				strict:     false,
			},
		}]),
		hosted_tools:      Arc::from([]),
		tool_choice:       Setting::Prefer(ToolChoice::Auto),
		output:            Setting::Unset,
		reasoning:         Setting::Unset,
		verbosity:         Setting::Unset,
		cache_retention:   Setting::Unset,
		service_tier:      Setting::Unset,
		sampling:          omp_ai::Sampling::default(),
		max_output_tokens: None,
		top_logprobs:      None,
		safety:            Arc::from([]),
		negotiation:       omp_ai::NegotiationPolicy::default(),
		forced_call:       None,
	}
}

fn text_message(role: Role, text: Str) -> Message {
	Message { role, content: Arc::from([ContentPart::Text { text, proof: None }]), name: None }
}

/// One completed advisor review: accepted tool notes plus its independent
/// billing receipt.
struct Review {
	notes:   Vec<Note>,
	receipt: Option<TurnReceipt>,
}

/// Drains the advisor stream into its `advise` calls and authoritative
/// completion receipt.
async fn collect_notes(mut stream: omp_ai::ChatStream) -> Result<Review, omp_ai::Error> {
	let mut notes = Vec::new();
	let mut receipt = None;
	while let Some(event) = stream.next().await {
		match event? {
			ChatEvent::ToolCallReady { call, .. } => {
				if call.name.as_str() != "advise" {
					continue;
				}
				let Some(args) = call.arguments.0.as_object() else {
					continue;
				};
				let Some(note) = args.get("note").and_then(serde_json::Value::as_str) else {
					continue;
				};
				let note = note.trim();
				if note.is_empty() {
					continue;
				}
				let severity = args
					.get("severity")
					.and_then(serde_json::Value::as_str)
					.and_then(|severity| severity.parse().ok())
					.unwrap_or_default();
				notes.push(Note {
					advisor: Str::new_static("default"),
					note: Str::new(note),
					severity,
				});
			},
			ChatEvent::Completed(completion) => receipt = advisor_receipt(&completion),
			_ => {},
		}
	}
	Ok(Review { notes, receipt })
}

/// Projects a successful auxiliary completion into the separate advisor
/// `turn.receipt@1`. Successful production completions carry serving
/// attribution; the selected plan is the credential-free fallback.
fn advisor_receipt(completion: &Completion) -> Option<TurnReceipt> {
	let provider = completion
		.receipt
		.serving_model
		.as_ref()
		.map(|serving| serving.provider.as_str())
		.or_else(|| {
			completion
				.receipt
				.plan
				.provider
				.as_ref()
				.map(|provider| provider.as_str())
		})?;
	let model = completion
		.receipt
		.serving_model
		.as_ref()
		.map(|serving| serving.model.as_str())
		.or_else(|| {
			completion
				.receipt
				.plan
				.model
				.as_ref()
				.map(|model| model.as_str())
		})?;
	let millis =
		|duration: std::time::Duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX);
	let usage = completion.usage;
	Some(TurnReceipt {
		tokens_in:                   usage.input_tokens,
		tokens_out:                  usage.output_tokens,
		cost_nano_usd:               completion
			.receipt
			.cost
			.micro_usd
			.max(0)
			.saturating_mul(1_000)
			.try_into()
			.unwrap_or(u64::MAX),
		cache_read:                  usage.cache_read_tokens,
		cache_write:                 usage.cache_write_tokens,
		ttft_ms:                     completion.receipt.timings.first_frame.map(millis),
		duration_ms:                 Some(millis(completion.receipt.timings.total)),
		premium_requests_millionths: usage.premium_requests_millionths,
		identity:                    Some(ReceiptIdentity {
			role:     ReceiptRole::Advisor,
			provider: Str::new(provider),
			model:    Str::new(model),
		}),
		recoveries:                  completion
			.receipt
			.recoveries
			.iter()
			.map(crate::loop_::journal_recovery)
			.collect(),
	})
}

/// Renders a watched update with role labels (consecutive same-role messages
/// collapse), included thinking, one-line tool calls with intent, and expanded
/// bounded results.
#[must_use]
pub fn render_update(messages: &[Message], wip: bool) -> Str {
	let mut results: FastHashMap<&str, (&[ToolResultContent], bool)> = FastHashMap::default();
	for message in messages {
		for part in message.content.iter() {
			if let ContentPart::ToolResult { call, content, is_error, .. } = part {
				results.insert(call.as_str(), (content, *is_error));
			}
		}
	}
	let mut consumed: FastHashSet<&str> = FastHashSet::default();
	let mut body = String::new();
	let mut last_label: Option<&'static str> = None;
	for message in messages {
		match message.role {
			Role::User | Role::Developer | Role::System => {
				let text = content_text(&message.content);
				if text.trim().is_empty() {
					continue;
				}
				let label = if message.role == Role::User {
					"**user**:"
				} else {
					"**developer**:"
				};
				push_labeled(&mut body, &mut last_label, label, &[text]);
			},
			Role::Assistant => {
				let mut lines = Vec::new();
				for part in message.content.iter() {
					match part {
						ContentPart::Text { text, .. } => {
							if !text.trim().is_empty() {
								lines.push(text.to_string());
							}
						},
						ContentPart::Reasoning { text, .. } => {
							if !text.trim().is_empty() {
								lines.push(format!("_thinking:_ {text}"));
							}
						},
						ContentPart::ToolCall { call, name, arguments, .. } => {
							let result = results.get(call.as_str()).copied();
							if result.is_some() {
								consumed.insert(call.as_str());
							}
							lines.push(tool_call_line(name.as_str(), Some(&arguments.0), result));
						},
						_ => {},
					}
				}
				if lines.is_empty() {
					continue;
				}
				push_labeled(&mut body, &mut last_label, "**agent**:", &lines);
			},
			Role::Tool => {
				// Orphans (the delta starts after their call) get their own line.
				for part in message.content.iter() {
					if let ContentPart::ToolResult { call, name, content, is_error } = part
						&& !consumed.contains(call.as_str())
					{
						let line = tool_call_line(
							name.as_deref().unwrap_or("tool"),
							None,
							Some((content, *is_error)),
						);
						body.push_str(&line);
						body.push_str("\n\n");
						last_label = None;
					}
				}
			},
		}
	}
	let body = if body.len() > UPDATE_MAX_BYTES {
		let mut cut = body.len() - UPDATE_MAX_BYTES;
		while !body.is_char_boundary(cut) {
			cut += 1;
		}
		format!("{ELIDED_MARKER}\n{}", &body[cut..])
	} else {
		body
	};
	let mut update = String::with_capacity(HEADING.len() + body.len() + WIP_TRAILER.len() + 12);
	update.push_str(HEADING);
	update.push_str("\n\n");
	update.push_str(body.trim_end());
	if wip {
		update.push_str("\n\n---\n\n");
		update.push_str(WIP_TRAILER);
	}
	Str::new(update)
}

/// Watched-mode role label: consecutive same-role messages collapse under
/// one label.
fn push_labeled(
	body: &mut String,
	last_label: &mut Option<&'static str>,
	label: &'static str,
	lines: &[String],
) {
	if *last_label != Some(label) {
		body.push_str(label);
		body.push('\n');
		*last_label = Some(label);
	}
	for line in lines {
		body.push_str(line);
		body.push('\n');
	}
	body.push('\n');
}

/// Joins text parts and renders media as `[image]`.
fn content_text(content: &[ContentPart]) -> String {
	let mut text = String::new();
	for part in content {
		match part {
			ContentPart::Text { text: piece, .. } | ContentPart::Reasoning { text: piece, .. } => {
				if !text.is_empty() {
					text.push('\n');
				}
				text.push_str(piece);
			},
			ContentPart::Image(_) | ContentPart::Audio(_) | ContentPart::Document(_) => {
				if !text.is_empty() {
					text.push('\n');
				}
				text.push_str("[image]");
			},
			_ => {},
		}
	}
	text
}

fn result_text(content: &[ToolResultContent]) -> String {
	let mut text = String::new();
	for part in content {
		let piece = match part {
			ToolResultContent::Text(text) => text.to_string(),
			ToolResultContent::Json(json) => json.0.to_string(),
			_ => "[image]".to_owned(),
		};
		if !text.is_empty() {
			text.push('\n');
		}
		text.push_str(&piece);
	}
	text
}

/// Renders a tool call with its intent and expanded I/O.
fn tool_call_line(
	name: &str,
	args: Option<&serde_json::Value>,
	result: Option<(&[ToolResultContent], bool)>,
) -> String {
	let head = format!("→ {name}({})", args.map_or(String::new(), |args| primary_arg(name, args)));
	let mut line = match result {
		None => format!("{head} ⇒ pending"),
		Some((content, is_error)) => {
			let text = result_text(content);
			let lines = if text.is_empty() {
				0
			} else {
				text.lines().count().max(1)
			};
			let count = format!("{lines} {}", if lines == 1 { "line" } else { "lines" });
			let mut base = if is_error {
				let first = one_line(text.lines().next().unwrap_or_default(), PRIMARY_ARG_MAX);
				if first.is_empty() {
					format!("{head} ⇒ error · {count}")
				} else {
					format!("{head} ⇒ error · {count} — {first}")
				}
			} else {
				format!("{head} ⇒ ok · {count}")
			};
			if !text.trim().is_empty() {
				base.push_str("\nTool result:\n");
				base.push_str(&bounded_fenced(&text, "text"));
			}
			base
		},
	};
	if let Some(intent) = args
		.and_then(|args| args.get("i"))
		.and_then(serde_json::Value::as_str)
		.filter(|intent| !intent.trim().is_empty())
	{
		line = format!("// {}\n{line}", one_line(intent, 80));
	}
	line
}

fn primary_arg_value(value: &serde_json::Value) -> Option<String> {
	match value {
		serde_json::Value::String(text) if !text.is_empty() => Some(text.clone()),
		serde_json::Value::Array(items)
			if !items.is_empty() && items.iter().all(serde_json::Value::is_string) =>
		{
			Some(
				items
					.iter()
					.filter_map(serde_json::Value::as_str)
					.collect::<Vec<_>>()
					.join(", "),
			)
		},
		_ => None,
	}
}

/// Selects and formats a tool call's primary argument.
fn primary_arg(name: &str, args: &serde_json::Value) -> String {
	let Some(object) = args.as_object() else {
		return String::new();
	};
	let field = |key: &str| object.get(key).and_then(primary_arg_value);
	match name {
		"advise" => {
			let note = field("note");
			let severity = field("severity");
			match (note, severity) {
				(Some(note), Some(severity)) => {
					return one_line(&format!("{severity}: {note}"), PRIMARY_ARG_MAX);
				},
				(Some(text), None) | (None, Some(text)) => return one_line(&text, PRIMARY_ARG_MAX),
				(None, None) => {},
			}
		},
		"grep" => {
			let pattern = field("pattern");
			let paths = field("path").or_else(|| field("paths"));
			match (pattern, paths) {
				(Some(pattern), Some(paths)) => {
					return one_line(&format!("{pattern} @ {paths}"), PRIMARY_ARG_MAX);
				},
				(Some(text), None) | (None, Some(text)) => return one_line(&text, PRIMARY_ARG_MAX),
				(None, None) => {},
			}
		},
		"glob" => {
			if let Some(paths) = field("path").or_else(|| field("paths")) {
				return one_line(&paths, PRIMARY_ARG_MAX);
			}
		},
		"ast_grep" => {
			if let Some(pattern) = field("pat") {
				return one_line(&pattern, PRIMARY_ARG_MAX);
			}
		},
		_ => {},
	}
	for key in PRIMARY_ARG_KEYS {
		if let Some(summary) = field(key) {
			return one_line(&summary, PRIMARY_ARG_MAX);
		}
	}
	let mut rest = serde_json::Map::new();
	for (key, value) in object {
		if key == "i" {
			continue;
		}
		if let serde_json::Value::String(text) = value
			&& !text.is_empty()
		{
			return one_line(text, PRIMARY_ARG_MAX);
		}
		rest.insert(key.clone(), value.clone());
	}
	if rest.is_empty() {
		return "{}".to_owned();
	}
	one_line(&serde_json::Value::Object(rest).to_string(), PRIMARY_ARG_MAX)
}

/// Collapses whitespace runs and truncates to `max` chars.
fn one_line(text: &str, max: usize) -> String {
	let flat = text.split_whitespace().collect::<Vec<_>>().join(" ");
	if flat.chars().count() > max {
		let mut cut = flat.chars().take(max.saturating_sub(1)).collect::<String>();
		cut.push('…');
		cut
	} else {
		flat
	}
}

/// Truncates the middle under both a byte and a line budget.
fn truncate_middle(text: &str, max_bytes: usize, max_lines: usize) -> (String, bool) {
	let lines = text.lines().count();
	if text.len() <= max_bytes && lines <= max_lines {
		return (text.to_owned(), false);
	}
	let head_lines = max_lines / 2;
	let tail_lines = max_lines.saturating_sub(head_lines).max(1);
	let all = text.lines().collect::<Vec<_>>();
	let (head, tail) = if lines > max_lines {
		(all[..head_lines].join("\n"), all[lines - tail_lines..].join("\n"))
	} else {
		(text.to_owned(), String::new())
	};
	let budget = max_bytes.saturating_sub(ELIDED_MARKER.len() + 2);
	let half = budget / 2;
	let head = clip_end(&head, half);
	let tail = clip_start(&tail, budget.saturating_sub(head.len()));
	let mut out = String::with_capacity(head.len() + tail.len() + ELIDED_MARKER.len() + 2);
	out.push_str(head);
	out.push('\n');
	out.push_str(ELIDED_MARKER);
	if !tail.is_empty() {
		out.push('\n');
		out.push_str(tail);
	}
	(out, true)
}

fn clip_end(text: &str, max: usize) -> &str {
	if text.len() <= max {
		return text;
	}
	let mut cut = max;
	while !text.is_char_boundary(cut) {
		cut -= 1;
	}
	&text[..cut]
}

fn clip_start(text: &str, max: usize) -> &str {
	if text.len() <= max {
		return text;
	}
	let mut cut = text.len() - max;
	while !text.is_char_boundary(cut) {
		cut += 1;
	}
	&text[cut..]
}

/// Uses an adaptive fence sized past the longest backtick run, or indented
/// code when the run would eat the budget.
fn bounded_fenced(text: &str, language: &str) -> String {
	let longest = text.split(|c| c != '`').map(str::len).max().unwrap_or(0);
	if longest * 2 > TOOL_IO_MAX_BYTES / 2 {
		let (bounded, truncated) =
			truncate_middle(text, TOOL_IO_MAX_BYTES - ELIDED_MARKER.len() - 2, TOOL_IO_MAX_LINES);
		let body = if truncated { bounded } else { text.to_owned() };
		return body
			.lines()
			.map(|line| format!("    {line}"))
			.collect::<Vec<_>>()
			.join("\n");
	}
	let fence = "`".repeat((longest + 1).max(3));
	let fence_bytes = fence.len() * 2 + language.len() + 2;
	let (bounded, _) = truncate_middle(
		text,
		TOOL_IO_MAX_BYTES.saturating_sub(fence_bytes).max(1),
		TOOL_IO_MAX_LINES,
	);
	format!("{fence}{language}\n{bounded}\n{fence}")
}

fn escape_xml_attribute(text: &str) -> String {
	let mut out = String::with_capacity(text.len());
	for character in text.chars() {
		match character {
			'&' => out.push_str("&amp;"),
			'<' => out.push_str("&lt;"),
			'>' => out.push_str("&gt;"),
			'"' => out.push_str("&quot;"),
			other => out.push(other),
		}
	}
	out
}

fn escape_xml_text(text: &str) -> String {
	let mut out = String::with_capacity(text.len());
	for character in text.chars() {
		match character {
			'&' => out.push_str("&amp;"),
			'<' => out.push_str("&lt;"),
			'>' => out.push_str("&gt;"),
			other => out.push(other),
		}
	}
	out
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn completion_projects_an_independent_advisor_receipt_with_serving_identity() {
		let mut execution = omp_ai::ExecutionReceipt::default();
		execution.serving_model = Some(omp_ai::ServingModelAttribution {
			provider: omp_ai::ProviderId::from("anthropic"),
			model:    omp_ai::ModelKey::from("claude-sonnet-4-5"),
			attempt:  0,
		});
		execution.cost = omp_ai::Cost::from_micro_usd(80_000);
		execution.timings.first_frame = Some(std::time::Duration::from_millis(420));
		execution.timings.total = std::time::Duration::from_millis(1_500);
		let receipt = advisor_receipt(&Completion {
			reason:  omp_ai::FinishReason::Stop,
			blocks:  1,
			usage:   omp_ai::Usage {
				input_tokens: 7_000,
				output_tokens: 80,
				cache_read_tokens: 2_000,
				..omp_ai::Usage::default()
			},
			receipt: Box::new(execution),
		})
		.expect("serving identity");
		assert_eq!(receipt.cost_nano_usd, 80_000_000);
		assert_eq!(receipt.tokens_in, 7_000);
		assert_eq!(receipt.tokens_out, 80);
		assert_eq!(receipt.cache_read, 2_000);
		assert_eq!(receipt.ttft_ms, Some(420));
		assert_eq!(receipt.duration_ms, Some(1_500));
		assert_eq!(
			receipt.identity,
			Some(ReceiptIdentity {
				role:     ReceiptRole::Advisor,
				provider: Str::new_static("anthropic"),
				model:    Str::new_static("claude-sonnet-4-5"),
			})
		);
	}

	#[test]
	fn channel_follows_pi_delivery_rules() {
		let idle = DeliveryFacts { terminal_answer_no_queued_work: true, ..Default::default() };
		assert_eq!(delivery_channel(Severity::Nit, idle), Channel::Aside);
		assert_eq!(delivery_channel(Severity::Concern, idle), Channel::Preserve);
		assert_eq!(delivery_channel(Severity::Blocker, idle), Channel::Steer);
		let queued = DeliveryFacts::default();
		assert_eq!(delivery_channel(Severity::Concern, queued), Channel::Steer);
		let immune = DeliveryFacts { immune_active: true, ..Default::default() };
		assert_eq!(delivery_channel(Severity::Concern, immune), Channel::Aside);
		assert_eq!(delivery_channel(Severity::Blocker, immune), Channel::Steer);
		let plan = DeliveryFacts { plan_mode: true, ..Default::default() };
		assert_eq!(delivery_channel(Severity::Blocker, plan), Channel::Preserve);
		let streaming = DeliveryFacts {
			streaming: true,
			terminal_answer_no_queued_work: true,
			..Default::default()
		};
		assert_eq!(delivery_channel(Severity::Concern, streaming), Channel::Steer);
	}

	#[test]
	fn immune_window_starts_on_the_next_primary_turn_and_is_half_open() {
		let mut advisor = Advisor::new();
		advisor.completed_turns = 1;
		advisor.immune_start = advisor.completed_turns.saturating_add(1);
		assert!(advisor.immune_active(None));
		advisor.completed_turns = 4;
		assert!(advisor.immune_active(None), "the configured three turns are 2, 3, and 4");
		advisor.completed_turns = 5;
		assert!(!advisor.immune_active(None), "the half-open fence ends before turn 5");
	}

	#[test]
	fn normalization_matches_pi() {
		assert_eq!(normalize_note("Stop."), "stop");
		assert_eq!(normalize_note("  No   issue; continue. "), "no issue continue");
		assert!(CONTENT_FREE.contains(&normalize_note("LGTM!").as_str()));
	}

	#[test]
	fn advisory_bytes_match_pi_batch_content() {
		assert_eq!(
			advisory_text(&Note {
				advisor:  Str::new_static("default"),
				severity: Severity::Blocker,
				note:     Str::new_static("a < b"),
			})
			.as_str(),
			"<advisory severity=\"blocker\" guidance=\"weigh, don't blindly obey\">\na &lt; \
			 b\n</advisory>"
		);
		assert_eq!(
			advisory_text(&Note {
				advisor:  Str::new_static("security & \"safety\""),
				severity: Severity::Concern,
				note:     Str::new_static("check it"),
			})
			.as_str(),
			"<advisory advisor=\"security &amp; &quot;safety&quot;\" severity=\"concern\" \
			 guidance=\"weigh, don't blindly obey\">\ncheck it\n</advisory>"
		);
	}

	#[test]
	fn primary_arg_prefers_the_informative_field() {
		assert_eq!(primary_arg("read", &serde_json::json!({"i": "x", "path": "a.rs"})), "a.rs");
		assert_eq!(
			primary_arg("grep", &serde_json::json!({"pattern": "fn", "path": "src"})),
			"fn @ src"
		);
		assert_eq!(primary_arg("todo", &serde_json::json!({"i": "x"})), "{}");
	}

	#[test]
	fn update_renders_watched_roles_and_wip_trailer() {
		let messages = vec![text_message(Role::User, Str::new_static("do it")), Message {
			role:    Role::Assistant,
			content: Arc::from([
				ContentPart::Reasoning { text: Str::new_static("hm"), proof: None },
				ContentPart::Text { text: Str::new_static("ok"), proof: None },
			]),
			name:    None,
		}];
		let update = render_update(&messages, true);
		assert!(
			update.starts_with(
				"### Session update\n\n**user**:\ndo it\n\n**agent**:\n_thinking:_ hm\nok"
			)
		);
		assert!(update.ends_with("---\n\n[in progress — more steps follow]"));
	}

	#[test]
	fn tool_lines_collapse_call_and_bounded_result() {
		let long = "x\n".repeat(200);
		let messages = vec![
			Message {
				role:    Role::Assistant,
				content: Arc::from([ContentPart::ToolCall {
					call:      omp_ai::ToolCallId::from("c1"),
					name:      Str::new_static("bash"),
					arguments: OpaqueJson::new(serde_json::json!({"i": "Listing", "command": "ls"})),
					proof:     None,
				}]),
				name:    None,
			},
			Message {
				role:    Role::Tool,
				content: Arc::from([ContentPart::ToolResult {
					call:     omp_ai::ToolCallId::from("c1"),
					name:     Some(Str::new_static("bash")),
					content:  Arc::from([ToolResultContent::Text(Str::new(long))]),
					is_error: false,
				}]),
				name:    None,
			},
		];
		let update = render_update(&messages, false);
		assert!(update.contains("// Listing\n→ bash(ls) ⇒ ok · 200 lines\nTool result:\n```text\n"));
		assert!(update.contains(ELIDED_MARKER));
		assert_eq!(update.matches("→ bash").count(), 1, "the result folds into its call line");
	}
}
