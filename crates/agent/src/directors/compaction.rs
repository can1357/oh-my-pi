//! Journal-derived automatic and manual context compaction.

use std::{str::FromStr, sync::Arc};

use futures::StreamExt;
use omp_ai::{
	ChatEvent, ChatRequest, ContentPart, MediaInput, Message, OpaqueJson, Role, Setting, ToolChoice,
	ToolInputConstraint, ToolResultContent,
	settings::{
		AI_COMPACTION_ENABLED, AI_COMPACTION_KEEP_RECENT_TOKENS, AI_COMPACTION_MID_TURN_ENABLED,
		AI_COMPACTION_RESERVE_TOKENS, AI_COMPACTION_THRESHOLD_TOKENS,
	},
};
use omp_con::Ctx;
use omp_core::{Str, StrMut};
use omp_dom::{Dom, Handle, KnownTag, Node, PropId, PropKey, Tag, Value};
use omp_journal::{EntryId, data::Compaction};
use omp_proto::toolhost::v1::HookEventId;
use omp_session::{project_thread, project_thread_through};

use crate::{
	AI_COMPACT_THRESHOLD, KernelEvent, LifecycleHookError, LifecycleHooks,
	director::{BoxFut, Director, DirectorError, MutDirectorCx, Prepared},
};

const DEFAULT_THRESHOLD: f64 = 0.80;
/// Output headroom subtracted from the window when no explicit reserve is
/// configured.
const DEFAULT_RESERVE_TOKENS: u64 = 16_384;
/// Proportional reserve: 15% of the window.
const RESERVE_FRACTION: f64 = 0.15;
/// Default count of recent tokens retained verbatim.
const DEFAULT_KEEP_RECENT_TOKENS: u64 = 20_000;
const BYTES_PER_TOKEN: u64 = 4;
const MESSAGE_OVERHEAD_TOKENS: u64 = 4;
const TOOL_OVERHEAD_TOKENS: u64 = 16;
const MEDIA_OVERHEAD_TOKENS: u64 = 256;
const PREVIEW_CHARS: usize = 80;
const HOOK_DEADLINE: &str = "60s";
const SUMMARY_INSTRUCTION: &str = include_str!("../../prompts/compaction/handoff-document.md");

/// Compacts projected history before inference when the live context reaches
/// the threshold.
#[derive(Clone, Debug, Default)]
pub struct CompactionDirector {
	focus:  Option<Str>,
	manual: bool,
	/// Journaled `method` for a manual run (`manual`, `handoff`); `None`
	/// uses the automatic/manual default.
	method: Option<Str>,
}

/// Effective compaction settings.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Settings {
	/// Whether automatic compaction is enabled.
	enabled:            bool,
	/// Fraction of the post-reserve window that triggers compaction.
	threshold_fraction: f64,
	/// Explicit token limit that wins over the fraction.
	threshold_tokens:   Option<u64>,
	/// Explicit reserve; `None` marks the defaulted reserve.
	reserve_tokens:     Option<u64>,
	/// Recent history kept verbatim after the summary.
	keep_recent_tokens: u64,
	/// Whether automatic compaction may run after the turn's first inference.
	mid_turn_enabled:   bool,
}

impl Settings {
	/// Resolves from the effective control plane; a host without a console
	/// (headless tests) reads only `ai_compact_threshold` from `<meta><con>`.
	fn resolve(con: Option<&Ctx>, dom: &Dom) -> Self {
		let Some(con) = con else {
			return Self {
				enabled:            true,
				threshold_fraction: dom_compact_threshold(dom),
				threshold_tokens:   None,
				reserve_tokens:     None,
				keep_recent_tokens: DEFAULT_KEEP_RECENT_TOKENS,
				mid_turn_enabled:   true,
			};
		};
		let reserve = AI_COMPACTION_RESERVE_TOKENS.get(con);
		Self {
			enabled:            AI_COMPACTION_ENABLED.get(con),
			threshold_fraction: AI_COMPACT_THRESHOLD.get(con),
			threshold_tokens:   u64::try_from(AI_COMPACTION_THRESHOLD_TOKENS.get(con))
				.ok()
				.filter(|tokens| *tokens > 0),
			reserve_tokens:     (reserve.is_finite() && reserve >= 0.0)
				.then(|| reserve.floor() as u64),
			keep_recent_tokens: u64::try_from(AI_COMPACTION_KEEP_RECENT_TOKENS.get(con)).unwrap_or(0),
			mid_turn_enabled:   AI_COMPACTION_MID_TURN_ENABLED.get(con),
		}
	}
}

/// The newest `<meta><compaction>` marker.
struct Marker {
	/// The compaction entry itself.
	id:       EntryId,
	/// Last entry it hides.
	boundary: EntryId,
	summary:  Str,
}

/// Where the next summary cuts the live chain.
struct Cut {
	/// Last entry the summary hides.
	boundary:   EntryId,
	/// The oldest `<turn>` kept verbatim after the summary.
	first_kept: Option<Handle>,
}

/// The facts one prepared compaction reports to extensions.
struct Plan {
	cut:            Cut,
	/// Number of earlier compactions on the chain.
	epoch:          usize,
	/// Live context tokens that triggered (or were measured for) this run.
	context_tokens: u64,
	/// Tokens at which automatic compaction triggers.
	target_tokens:  u64,
}

/// The extension verdict on one prepared compaction.
enum Verdict {
	Proceed {
		/// Extension-authored summary replacing the summariser call.
		summary: Option<Str>,
		warning: Option<Str>,
	},
	Cancel,
}

impl CompactionDirector {
	/// Creates the standard automatic compaction director.
	#[must_use]
	pub const fn new() -> Self {
		Self { focus: None, manual: false, method: None }
	}

	/// Creates a one-shot manual compaction request with optional summary focus.
	#[must_use]
	pub const fn manual(focus: Option<Str>) -> Self {
		Self { focus, manual: true, method: None }
	}

	/// Labels the journaled compaction method (`/handoff` journals
	/// `handoff` so the transcript divider reads "handed-off").
	#[must_use]
	pub fn with_method(mut self, method: impl Into<Str>) -> Self {
		self.method = Some(method.into());
		self
	}

	fn method(&self) -> Str {
		self
			.method
			.clone()
			.unwrap_or_else(|| Str::new_static(if self.manual { "manual" } else { "auto" }))
	}

	async fn compact(
		&self,
		cx: &mut MutDirectorCx<'_>,
		request: &ChatRequest,
	) -> Result<Prepared, DirectorError> {
		let Some(head) = cx.session.head() else {
			return Ok(Prepared::Unchanged);
		};
		let dom = cx.session.dom();
		let settings = Settings::resolve(cx.con, dom);
		let previous = newest_marker(dom);
		let previous_boundary = previous.as_ref().map(|marker| marker.boundary);
		let context_window = cx.route.context_window;
		let context_tokens = context_tokens(dom, previous_boundary, request);
		let target_tokens = threshold_tokens(context_window, &settings);
		if !self.manual {
			// The dead-end guard rejects a request whose newest marker is the
			// head: that request already compacted.
			if !settings.enabled
				|| context_window == 0
				|| previous.as_ref().is_some_and(|marker| marker.id == head)
				|| context_tokens <= target_tokens
				|| (!settings.mid_turn_enabled && turn_has_inference(dom, cx.turn))
			{
				return Ok(Prepared::Unchanged);
			}
		}
		let Some(cut) = cut_point(
			dom,
			cx.turn,
			head,
			previous_boundary,
			settings.keep_recent_tokens,
			!self.manual,
		) else {
			return Ok(Prepared::Unchanged);
		};
		let hidden = Message::from_thread_items(&project_thread_through(dom, cut.boundary))?;
		if hidden.is_empty() {
			// Nothing to summarize is a no-op.
			return Ok(Prepared::Unchanged);
		}
		// Thread items map one-to-one onto request messages, so whatever the
		// request holds before the projected thread is the live system prompt;
		// the projected items past the previous summary and the hidden run are
		// the tail kept verbatim.
		let thread = project_thread(dom);
		let system_prefix = request.messages.len().saturating_sub(thread.len());
		let kept_from = usize::from(previous.is_some())
			.saturating_add(hidden.len())
			.min(thread.len());
		let kept = Message::from_thread_items(&thread[kept_from..])?;
		let plan = Plan { cut, epoch: compaction_count(dom), context_tokens, target_tokens };
		let (summary, warning) = match cx.hooks {
			Some(hooks) => {
				let payload = self.hook_event(
					dom,
					&plan,
					&hidden,
					&kept,
					previous.as_ref().map(|marker| marker.summary.as_str()),
				);
				match gate_compaction(hooks, payload).await? {
					Verdict::Cancel => return Ok(Prepared::Unchanged),
					Verdict::Proceed { summary, warning } => (summary, warning),
				}
			},
			None => (None, None),
		};
		let from_extension = summary.is_some();

		// The gauge tick pulses while the summary is produced and settles once
		// the boundary lands (or the run fails).
		cx.notify(KernelEvent::CompactionSpeculating {
			percent: occupancy_percent(context_tokens, context_window),
		});
		let summarized = if let Some(summary) = summary {
			Ok(summary)
		} else {
			let summary_request = summary_request(
				&request.messages[..system_prefix],
				previous.as_ref().map(|marker| marker.summary.clone()),
				&hidden,
				self.focus.as_deref(),
			);
			self.summarize(cx, summary_request).await
		};
		cx.notify(KernelEvent::CompactionSettled { applied: summarized.is_ok() });
		let summary = summarized?;
		let tokens_after = estimate_text_tokens(summary.as_str()).saturating_add(
			kept
				.iter()
				.map(estimate_message_tokens)
				.fold(0_u64, u64::saturating_add),
		);
		let blob = cx.session.blobs().put(summary.as_bytes())?;
		let summary_bytes = u64_len(summary.len());
		cx.session.compaction(Compaction {
			summary:       blob,
			boundary:      plan.cut.boundary,
			method:        Some(self.method()),
			tokens_before: Some(context_tokens),
			tokens_after:  Some(tokens_after),
			warning:       warning.clone(),
			frames:        Vec::new(),
		})?;
		if let Some(hooks) = cx.hooks {
			hooks.notify(
				HookEventId::HookEventCompactionDone,
				serde_json::json!({
					"preparation_id": plan.cut.boundary.to_string(),
					"tiers_run": [self.tier()],
					"from_extension": from_extension.then_some("hook"),
					"tokens_before": context_tokens,
					"tokens_after": tokens_after,
					"first_kept_id": first_kept_id(cx.session.dom(), plan.cut.first_kept),
					"epoch": plan.epoch,
					"summary_bytes": summary_bytes,
					"warning": warning,
				}),
			)?;
		}
		Ok(Prepared::Rebuild)
	}

	/// Python `CompactionEvent`, the `compaction` gate payload.
	fn hook_event(
		&self,
		dom: &Dom,
		plan: &Plan,
		hidden: &[Message],
		kept: &[Message],
		previous_summary: Option<&str>,
	) -> serde_json::Value {
		let refs = |messages: &[Message], offset: usize| {
			messages
				.iter()
				.enumerate()
				.map(|(index, message)| message_ref(offset.saturating_add(index), message))
				.collect::<Vec<_>>()
		};
		serde_json::json!({
			"preparation_id": plan.cut.boundary.to_string(),
			"tier": self.tier(),
			"reason": if self.manual { "manual" } else { "threshold" },
			"epoch": plan.epoch,
			"tokens_before": plan.context_tokens,
			"target_tokens": plan.target_tokens,
			"suggested_first_kept": first_kept_id(dom, plan.cut.first_kept),
			"to_summarize": refs(hidden, 0),
			"to_retain": refs(kept, hidden.len()),
			"split_turn": false,
			"previous_summary": previous_summary,
			"previous_preserve": serde_json::Value::Null,
			"custom_instructions": self.focus.as_deref(),
			"deadline": HOOK_DEADLINE,
		})
	}

	/// Python `CompactionTier` of this run.
	fn tier(&self) -> &'static str {
		if self.method.as_deref() == Some("handoff") {
			"handoff"
		} else {
			"local"
		}
	}

	async fn summarize(
		&self,
		cx: &mut MutDirectorCx<'_>,
		summary_request: ChatRequest,
	) -> Result<Str, DirectorError> {
		let mut stream = cx.inference.execute(summary_request).await?;
		let mut summary = StrMut::new("");
		while let Some(event) = stream.next().await {
			if let ChatEvent::TextDelta { text, .. } = event? {
				summary.push_str(text.as_str());
			}
		}
		let summary = summary.freeze();
		if summary.trim().is_empty() {
			return Err(DirectorError::EmptyCompactionSummary);
		}
		Ok(summary)
	}
}

impl Director for CompactionDirector {
	fn id(&self) -> &'static str {
		"compaction"
	}

	fn before_inference<'a>(
		&'a self,
		cx: &'a mut MutDirectorCx<'_>,
		request: &'a ChatRequest,
	) -> BoxFut<'a, Result<Prepared, DirectorError>> {
		Box::pin(self.compact(cx, request))
	}
}

/// Runs the `compaction` gate: a denial cancels this run; a transform may
/// supply the summary (Python `CustomSummary.summary` / `.warning`).
async fn gate_compaction(
	hooks: &LifecycleHooks,
	payload: serde_json::Value,
) -> Result<Verdict, DirectorError> {
	match hooks.gate(HookEventId::HookEventCompaction, payload).await {
		Ok(effective) => {
			let field = |name: &str| {
				effective
					.get(name)
					.and_then(serde_json::Value::as_str)
					.filter(|text| !text.trim().is_empty())
					.map(Str::new)
			};
			Ok(Verdict::Proceed { summary: field("summary"), warning: field("warning") })
		},
		Err(LifecycleHookError::Denied { .. }) => Ok(Verdict::Cancel),
		Err(error) => Err(DirectorError::Hook(error)),
	}
}

/// Body-free `MessageRef` for one projected message.
pub(crate) fn message_ref(seq: usize, message: &Message) -> serde_json::Value {
	let (kind, is_error) = match message.content.first() {
		Some(ContentPart::ToolCall { .. }) => ("tool_call", false),
		Some(ContentPart::ToolResult { is_error, .. }) => ("tool_result", *is_error),
		_ => match message.role {
			Role::System | Role::Developer => ("system", false),
			Role::User => ("user", false),
			Role::Assistant => ("assistant", false),
			Role::Tool => ("tool_result", false),
		},
	};
	let role = match message.role {
		Role::System => "system",
		Role::Developer => "developer",
		Role::User => "user",
		Role::Assistant => "assistant",
		Role::Tool => "tool",
	};
	let media_count = message
		.content
		.iter()
		.filter(|part| {
			matches!(part, ContentPart::Image(_) | ContentPart::Audio(_) | ContentPart::Document(_))
		})
		.count();
	let preview = message
		.content
		.iter()
		.find_map(|part| match part {
			ContentPart::Text { text, .. } => Some(text.as_str()),
			ContentPart::ToolCall { name, .. } => Some(name.as_str()),
			_ => None,
		})
		.map(|text| text.chars().take(PREVIEW_CHARS).collect::<String>())
		.unwrap_or_default();
	let byte_len = estimate_message_bytes(message);
	serde_json::json!({
		"id": seq.to_string(),
		"event": 0,
		"seq": seq,
		"kind": kind,
		"role": role,
		"turn_id": serde_json::Value::Null,
		"created_at_ms": 0,
		"tokens": byte_len.div_ceil(BYTES_PER_TOKEN),
		"byte_len": byte_len,
		"part_count": message.content.len(),
		"media_count": media_count,
		"tool": serde_json::Value::Null,
		"is_error": is_error,
		"useless": false,
		"pinned": false,
		"elided": false,
		"superseded_by": serde_json::Value::Null,
		"artifacts": [],
		"preview": preview,
	})
}

fn first_kept_id(dom: &Dom, first_kept: Option<Handle>) -> String {
	first_kept
		.and_then(|handle| dom.get(handle))
		.and_then(|node| prop_text(node, PropId::Id))
		.unwrap_or_default()
		.to_owned()
}

/// The summariser request: the handoff instruction, the live system prompt
/// verbatim so providers hit the cached prefix, the previous summary, then
/// only the history the new boundary hides.
fn summary_request(
	system: &[Message],
	previous_summary: Option<Str>,
	hidden: &[Message],
	focus: Option<&str>,
) -> ChatRequest {
	let mut instruction = StrMut::new(SUMMARY_INSTRUCTION);
	if let Some(focus) = focus.filter(|focus| !focus.trim().is_empty()) {
		instruction.push_str("\n\nFocus the handoff on: ");
		instruction.push_str(focus);
	}
	let mut messages =
		Vec::with_capacity(system.len().saturating_add(hidden.len()).saturating_add(2));
	messages.push(text_message(Role::System, instruction.freeze()));
	messages.extend(system.iter().cloned());
	if let Some(previous) = previous_summary {
		messages.push(text_message(Role::User, previous));
	}
	// The summariser reads history as text; attached media becomes `[image]`
	// rather than re-uploading bytes, which the hidden run may no longer
	// resolve.
	messages.extend(hidden.iter().map(media_as_text));
	ChatRequest {
		messages:          messages.into(),
		tools:             Arc::from([]),
		hosted_tools:      Arc::from([]),
		tool_choice:       Setting::Require(ToolChoice::Disabled),
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

/// The message with every media part replaced by `[image]` text.
fn media_as_text(message: &Message) -> Message {
	if !message.content.iter().any(|part| {
		matches!(part, ContentPart::Image(_) | ContentPart::Audio(_) | ContentPart::Document(_))
	}) {
		return message.clone();
	}
	let content = message
		.content
		.iter()
		.map(|part| match part {
			ContentPart::Image(_) | ContentPart::Audio(_) | ContentPart::Document(_) => {
				ContentPart::Text { text: Str::new_static("[image]"), proof: None }
			},
			other => other.clone(),
		})
		.collect::<Arc<[ContentPart]>>();
	Message { role: message.role, content, name: message.name.clone() }
}

/// Context occupancy in whole percent of the window, saturating at 100 (an
/// unknown window reads as 0).
fn occupancy_percent(context_tokens: u64, context_window: u64) -> u8 {
	let Some(percent) = context_tokens
		.saturating_mul(100)
		.checked_div(context_window)
	else {
		return 0;
	};
	u8::try_from(percent.min(100)).unwrap_or(100)
}

/// Calculates context tokens from the newest receipt on the live body after
/// the previous compaction boundary; the byte estimate of the projected
/// request stands in until a receipt exists.
fn context_tokens(dom: &Dom, previous_boundary: Option<EntryId>, request: &ChatRequest) -> u64 {
	for turn in dom.children(dom.body()).iter().rev() {
		for child in dom.children(*turn).iter().rev() {
			let Some(node) = dom.get(*child) else {
				continue;
			};
			if node.tag != Tag::Known(KnownTag::Usage)
				|| node
					.prop(&PropKey::from(PropId::Kind))
					.and_then(Value::as_str)
					== Some("advisor")
				|| !after_boundary(node, previous_boundary)
			{
				continue;
			}
			return [PropId::TokensIn, PropId::TokensOut, PropId::CacheRead, PropId::CacheWrite]
				.into_iter()
				.fold(0_u64, |total, prop| total.saturating_add(prop_u64(node, prop)));
		}
	}
	estimate_request_tokens(request)
}

/// An explicit token limit wins; otherwise use the configured fraction of the
/// window left after the reserve. Both stay strictly below the window.
fn threshold_tokens(context_window: u64, settings: &Settings) -> u64 {
	let ceiling = context_window.saturating_sub(1);
	if let Some(explicit) = settings.threshold_tokens {
		return explicit.max(1).min(ceiling);
	}
	let usable = context_window
		.saturating_sub(budget_reserve_tokens(context_window, settings))
		.min(ceiling);
	(usable as f64 * settings.threshold_fraction).floor() as u64
}

/// Uses the larger of 15% and the configured (or default) reserve, falling
/// back to the proportional reserve when a defaulted absolute reserve would
/// leave no usable budget.
fn budget_reserve_tokens(context_window: u64, settings: &Settings) -> u64 {
	let proportional = (context_window as f64 * RESERVE_FRACTION).floor() as u64;
	let effective = proportional.max(settings.reserve_tokens.unwrap_or(DEFAULT_RESERVE_TOKENS));
	let proportional = proportional.max(1);
	let defaulted_impossible =
		settings.reserve_tokens.is_none() && effective >= context_window.saturating_sub(proportional);
	if defaulted_impossible || effective >= context_window {
		proportional
	} else {
		effective
	}
}

/// Finds a cut point at turn granularity: walk turns newest-first, keeping
/// each one while the kept tail is still under `keep_recent_tokens`. The turn
/// that crosses the budget stays. The current turn is always kept when
/// `keep_current` (automatic compaction never hides the prompt that triggered
/// it). The boundary is the entry before the oldest kept turn; when nothing
/// is kept it is the head.
fn cut_point(
	dom: &Dom,
	current: Handle,
	head: EntryId,
	previous_boundary: Option<EntryId>,
	keep_recent_tokens: u64,
	keep_current: bool,
) -> Option<Cut> {
	let mut accumulated = 0_u64;
	let mut first_kept = None;
	for turn in dom.children(dom.body()).iter().rev() {
		let Some(node) = dom.get(*turn) else {
			continue;
		};
		if node.tag != Tag::Known(KnownTag::Turn) {
			continue;
		}
		if !after_boundary(node, previous_boundary) {
			break;
		}
		let mandatory = keep_current && *turn == current;
		if !mandatory && accumulated >= keep_recent_tokens {
			break;
		}
		accumulated = accumulated.saturating_add(turn_estimate_tokens(dom, *turn));
		first_kept = Some(*turn);
	}
	let boundary = match first_kept {
		Some(turn) => {
			prop_text(dom.get(turn)?, PropId::Cause).and_then(|cause| EntryId::from_str(cause).ok())?
		},
		None => head,
	};
	Some(Cut { boundary, first_kept })
}

/// Whether the turn already ran inference (an assistant message exists), the
/// mid-turn case the setting gates.
fn turn_has_inference(dom: &Dom, turn: Handle) -> bool {
	dom.children(turn).iter().any(|child| {
		dom.get(*child)
			.is_some_and(|node| node.tag == Tag::Known(KnownTag::Assistant))
	})
}

/// Byte/4 estimate of everything a turn projects: element text, text props,
/// and structured data, plus one message overhead per turn child.
fn turn_estimate_tokens(dom: &Dom, turn: Handle) -> u64 {
	fn subtree_bytes(dom: &Dom, handle: Handle, total: &mut u64) {
		if let Some(node) = dom.get(handle) {
			*total = total.saturating_add(node_bytes(node));
		}
		for child in dom.children(handle) {
			subtree_bytes(dom, *child, total);
		}
	}
	let mut bytes = 0_u64;
	for child in dom.children(turn) {
		bytes = bytes.saturating_add(MESSAGE_OVERHEAD_TOKENS.saturating_mul(BYTES_PER_TOKEN));
		subtree_bytes(dom, *child, &mut bytes);
	}
	bytes.div_ceil(BYTES_PER_TOKEN)
}

fn node_bytes(node: &Node) -> u64 {
	let mut bytes = node
		.content
		.as_deref()
		.map_or(0, |text| u64_len(text.len()));
	for prop in [PropId::Text, PropId::Data] {
		bytes = bytes.saturating_add(match node.prop(&PropKey::from(prop)) {
			Some(Value::Str(text)) => u64_len(text.len()),
			Some(Value::Json(raw)) => u64_len(raw.get().len()),
			_ => 0,
		});
	}
	bytes
}

fn dom_compact_threshold(dom: &Dom) -> f64 {
	let Ok(vars) = dom.select("con var") else {
		return DEFAULT_THRESHOLD;
	};
	for handle in vars {
		let Some(node) = dom.get(handle) else {
			continue;
		};
		let name = node
			.prop(&PropKey::from(PropId::Name))
			.or_else(|| node.prop(&PropKey::Custom(Str::new_static("name"))))
			.and_then(Value::as_str);
		if name != Some(AI_COMPACT_THRESHOLD.name()) {
			continue;
		}
		let value = node
			.prop(&PropKey::from(PropId::Value))
			.or_else(|| node.prop(&PropKey::Custom(Str::new_static("value"))))
			.and_then(threshold_value)
			.or_else(|| node.content.as_deref().and_then(|value| value.parse().ok()));
		return value
			.filter(|value| value.is_finite() && *value > 0.0 && *value <= 1.0)
			.unwrap_or(DEFAULT_THRESHOLD);
	}
	DEFAULT_THRESHOLD
}

fn threshold_value(value: &Value) -> Option<f64> {
	match value {
		Value::Float(value) => Some(*value),
		Value::Int(value) => Some(*value as f64),
		Value::Str(value) => value.parse().ok(),
		_ => None,
	}
}

fn compaction_markers(dom: &Dom) -> impl Iterator<Item = &Node> {
	dom.children(dom.meta())
		.iter()
		.filter_map(|handle| dom.get(*handle))
		.filter(|node| node.tag.as_str() == "compaction")
}

fn compaction_count(dom: &Dom) -> usize {
	compaction_markers(dom).count()
}

fn newest_marker(dom: &Dom) -> Option<Marker> {
	compaction_markers(dom).last().and_then(|node| {
		Some(Marker {
			id:       prop_text(node, PropId::Cause).and_then(|id| EntryId::from_str(id).ok())?,
			boundary: prop_text(node, PropId::Boundary).and_then(|id| EntryId::from_str(id).ok())?,
			summary:  Str::new(prop_text(node, PropId::Summary).unwrap_or_default()),
		})
	})
}

/// Whether an element was journaled after `boundary` (the projection's own
/// visibility rule: `order`, else `id`, else `cause`).
fn after_boundary(node: &Node, boundary: Option<EntryId>) -> bool {
	let Some(boundary) = boundary else {
		return true;
	};
	prop_text(node, PropId::Order)
		.or_else(|| prop_text(node, PropId::Id))
		.or_else(|| prop_text(node, PropId::Cause))
		.and_then(|id| EntryId::from_str(id).ok())
		.is_some_and(|id| id > boundary)
}

fn prop_text(node: &Node, prop: PropId) -> Option<&str> {
	node.prop(&PropKey::from(prop)).and_then(Value::as_str)
}

fn prop_u64(node: &Node, prop: PropId) -> u64 {
	match node.prop(&PropKey::from(prop)) {
		Some(Value::Int(value)) => u64::try_from(*value).unwrap_or(0),
		Some(Value::Str(value)) => value.parse().unwrap_or(0),
		_ => 0,
	}
}

fn estimate_request_tokens(request: &ChatRequest) -> u64 {
	let message_bytes = request.messages.iter().fold(0_u64, |total, message| {
		total
			.saturating_add(estimate_message_bytes(message))
			.saturating_add(MESSAGE_OVERHEAD_TOKENS.saturating_mul(BYTES_PER_TOKEN))
	});
	let tool_bytes = request.tools.iter().fold(0_u64, |total, tool| {
		let schema = match &tool.input {
			ToolInputConstraint::JsonSchema { parameters, .. } => estimate_json_bytes(parameters),
			ToolInputConstraint::Grammar { grammar, fallback } => {
				u64_len(grammar.definition.len()).saturating_add(estimate_json_bytes(fallback))
			},
		};
		total
			.saturating_add(u64_len(tool.name.len()))
			.saturating_add(
				tool
					.description
					.as_ref()
					.map_or(0, |text| u64_len(text.len())),
			)
			.saturating_add(schema)
			.saturating_add(TOOL_OVERHEAD_TOKENS.saturating_mul(BYTES_PER_TOKEN))
	});
	message_bytes
		.saturating_add(tool_bytes)
		.div_ceil(BYTES_PER_TOKEN)
}

/// Tokens one projected message occupies: its bytes plus one message
/// overhead, at the same bytes-per-token estimate as the request side.
fn estimate_message_tokens(message: &Message) -> u64 {
	estimate_message_bytes(message)
		.saturating_add(MESSAGE_OVERHEAD_TOKENS.saturating_mul(BYTES_PER_TOKEN))
		.div_ceil(BYTES_PER_TOKEN)
}

/// Tokens the summary occupies once it replaces the hidden history.
fn estimate_text_tokens(text: &str) -> u64 {
	u64_len(text.len())
		.saturating_add(MESSAGE_OVERHEAD_TOKENS.saturating_mul(BYTES_PER_TOKEN))
		.div_ceil(BYTES_PER_TOKEN)
}

fn estimate_message_bytes(message: &Message) -> u64 {
	message.content.iter().fold(0_u64, |total, part| {
		total.saturating_add(match part {
			ContentPart::Text { text, .. } | ContentPart::Reasoning { text, .. } => {
				u64_len(text.len())
			},
			ContentPart::Image(media) | ContentPart::Audio(media) | ContentPart::Document(media) => {
				estimate_media_bytes(media)
			},
			ContentPart::ToolCall { name, arguments, .. } => {
				u64_len(name.len()).saturating_add(estimate_json_bytes(arguments))
			},
			ContentPart::ToolResult { name, content, .. } => name
				.as_ref()
				.map_or(0, |name| u64_len(name.len()))
				.saturating_add(content.iter().fold(0_u64, |subtotal, item| {
					subtotal.saturating_add(estimate_tool_result_bytes(item))
				})),
			ContentPart::CachePoint(_) => 0,
		})
	})
}

fn estimate_tool_result_bytes(content: &ToolResultContent) -> u64 {
	match content {
		ToolResultContent::Text(text) => u64_len(text.len()),
		ToolResultContent::Json(value) => estimate_json_bytes(value),
		ToolResultContent::Image(media) | ToolResultContent::Document(media) => {
			estimate_media_bytes(media)
		},
	}
}

fn estimate_media_bytes(media: &MediaInput) -> u64 {
	match media {
		MediaInput::Bytes { data, .. } => u64_len(data.len()),
		MediaInput::Stored(_) | MediaInput::Body { .. } => {
			MEDIA_OVERHEAD_TOKENS.saturating_mul(BYTES_PER_TOKEN)
		},
		MediaInput::Remote { uri, .. } => {
			u64_len(uri.len()).saturating_add(MEDIA_OVERHEAD_TOKENS.saturating_mul(BYTES_PER_TOKEN))
		},
	}
}

fn estimate_json_bytes(value: &OpaqueJson) -> u64 {
	fn value_bytes(value: &serde_json::Value) -> u64 {
		match value {
			serde_json::Value::Null => 4,
			serde_json::Value::Bool(value) => {
				if *value {
					4
				} else {
					5
				}
			},
			serde_json::Value::Number(_) => 24,
			serde_json::Value::String(value) => u64_len(value.len()).saturating_add(2),
			serde_json::Value::Array(values) => values
				.iter()
				.fold(2_u64, |total, value| total.saturating_add(value_bytes(value)).saturating_add(1)),
			serde_json::Value::Object(values) => values.iter().fold(2_u64, |total, (key, value)| {
				total
					.saturating_add(u64_len(key.len()))
					.saturating_add(value_bytes(value))
					.saturating_add(4)
			}),
		}
	}
	value_bytes(value.as_value())
}

fn u64_len(length: usize) -> u64 {
	u64::try_from(length).unwrap_or(u64::MAX)
}
