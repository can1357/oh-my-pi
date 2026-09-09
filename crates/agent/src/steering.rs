//! One upward mailbox for steering and cancellation.
//!
//! Steering is durable from the moment the kernel accepts it: every
//! [`Up::Steer`] or [`Up::SteerAuthored`] lands in `<queues><steering>`
//! through `patch@1` at the mailbox drain that receives it, so a crash or
//! session switch while inference or a tool runs never loses accepted input.
//! The safe point then moves the queued items into the current turn in one
//! atomic patch.

use std::sync::Arc;

use omp_core::Str;
use omp_dom::{Handle, KnownTag, NodeSpec, Op, PropId, PropKey, Tag, Txn, Value};
use omp_journal::data::{Attachment, Compaction, IrcTraffic};
use omp_session::{Session, SessionError};

use crate::SteeringMode;

pub(crate) const EMPTY_OUTPUT_RETRY_CAP: u8 = 3;
const EMPTY_OUTPUT_CAP_NOTICE: &str =
	"Assistant returned no final output after retry cap; try switching models";

/// A live DOM subscription handed back through [`Up::Subscribe`].
pub type DomSubscription = (omp_dom::Snapshot, flume::Receiver<omp_dom::Event>);

/// A turn stop caused by one or more identified tool calls.
///
/// Completed sibling calls need neutral placeholder results when the abort
/// happens during inference, while a call already executing is interrupted
/// without cancelling unrelated execution units.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ToolScopedAbortReason {
	/// Human-facing reason for the turn-level interruption.
	pub message:                   Str,
	/// Per-call labels for calls that caused the interruption.
	pub tool_call_messages:        Arc<[(Str, Str)]>,
	/// Neutral label for other calls in the same assistant batch.
	pub default_tool_call_message: Str,
}

impl ToolScopedAbortReason {
	/// Creates a reason for one offending call and its unaffected siblings.
	#[must_use]
	pub fn one(
		call_id: impl Into<Str>,
		message: impl Into<Str>,
		default_tool_call_message: impl Into<Str>,
	) -> Self {
		let message = message.into();
		Self {
			message:                   message.clone(),
			tool_call_messages:        Arc::from([(call_id.into(), message)]),
			default_tool_call_message: default_tool_call_message.into(),
		}
	}

	/// Returns the call-specific label or the neutral sibling label.
	#[must_use]
	pub fn message_for(&self, call_id: &str) -> &Str {
		self
			.tool_call_messages
			.iter()
			.find_map(|(id, message)| (id.as_str() == call_id).then_some(message))
			.unwrap_or(&self.default_tool_call_message)
	}

	/// Reports whether this call caused the interruption.
	#[must_use]
	pub fn contains(&self, call_id: &str) -> bool {
		self
			.tool_call_messages
			.iter()
			.any(|(id, _)| id.as_str() == call_id)
	}
}

/// One one-shot mutation executed only by the actor that currently owns the
/// authoritative [`Session`].
#[derive(Clone)]
pub struct SessionMutation {
	apply:
		std::sync::Arc<parking_lot::Mutex<Option<Box<dyn FnOnce(&mut Session) + Send + 'static>>>>,
}

impl SessionMutation {
	/// Seals a mutation for delivery through the kernel mailbox.
	pub fn new(apply: impl FnOnce(&mut Session) + Send + 'static) -> Self {
		Self { apply: std::sync::Arc::new(parking_lot::Mutex::new(Some(Box::new(apply)))) }
	}

	/// Applies the mutation at most once.
	pub fn apply(&self, session: &mut Session) {
		let apply = self.apply.lock().take();
		if let Some(apply) = apply {
			apply(session);
		}
	}
}

impl std::fmt::Debug for SessionMutation {
	fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		formatter
			.debug_struct("SessionMutation")
			.finish_non_exhaustive()
	}
}

/// Control sent to a running kernel turn.
#[derive(Clone, Debug)]
pub enum Up {
	/// Adds a user steering aside at the next safe point. `attachments` are
	/// already in the session's blob store and positional against `[Image #N]`
	/// in `text`.
	Steer {
		/// The aside.
		text:        Str,
		/// Media journaled beside it.
		attachments: Vec<Attachment>,
	},
	/// Adds a host-authenticated remote user's steering aside.
	///
	/// Attribution is inserted atomically with the queued user node and moves
	/// with it at the safe point; it never enters model-facing content.
	SteerAuthored {
		/// The aside.
		text:        Str,
		/// Media journaled beside it in relay order.
		attachments: Vec<Attachment>,
		/// Authenticated remote display name.
		author:      Str,
	},
	/// Adds a discovered skill prompt at the next safe point while preserving
	/// its source metadata and exact model-facing body.
	SkillPrompt(omp_journal::data::SkillPrompt),
	/// Queues a peer/hub message for explicit inbox consumption; unlike
	/// steering, it does not redirect the active turn.
	Peer(Str),
	/// Queues a follow-up prompt behind the active turn, journaled into
	/// `<queues><prompts>` at the drain that receives it; the controller pops
	/// it when the turn yields. Never steering: it does not
	/// re-run a safe point. `attachments` are already in the session's blob
	/// store and positional against `[Image #N]` in `text`.
	Queue {
		/// The follow-up prompt.
		text:        Str,
		/// Media journaled beside it.
		attachments: Vec<Attachment>,
	},
	/// Hands back every steering aside not yet consumed at a safe point; the
	/// host restores them to its composer.
	Unqueue(flume::Sender<Vec<Str>>),
	/// Journals the global runtime gate. Active inference and execution units
	/// settle to their next safe point; no continuation starts while paused.
	Pause {
		/// `true` holds runtime work; `false` releases it.
		active: bool,
	},
	/// Interrupts identified tool calls without cancelling their siblings.
	///
	/// During inference this ends the request and settles each materialized
	/// call without admitting execution. During execution only matching scopes
	/// receive the stop request.
	AbortTools(ToolScopedAbortReason),
	/// Interrupts the current inference/tool turn while preserving mutations.
	Interrupt,
	/// Cancels the whole session and every execution scope.
	Cancel,
	/// Runs a one-shot authoritative session mutation on the kernel actor.
	SessionMutation(SessionMutation),
	/// Delivers an environment observation or host-authority request.
	Env(crate::EnvEvent),
	/// Commits an automatic peer response observation before its producer
	/// performs the one ordinary peer delivery.
	Autoreply {
		/// Authenticated producer payload.
		payload:   Arc<IrcTraffic>,
		/// `true` only after the controller journals the payload.
		committed: flume::Sender<bool>,
	},
	/// A policy filed an approval prompt through the kernel-bound
	/// [`crate::ApprovalRoute`]: journaled as a pending `<prompt>` at the
	/// drain that receives it, answered by [`Up::Approve`].
	Approval(crate::ApprovalRequest),
	/// Resolves a journal-backed approval prompt.
	Approve {
		/// Stable prompt identity.
		id:       Str,
		/// Idempotent first decision.
		decision: crate::ApprovalDecision,
	},
	/// Requests a live `(Snapshot, Receiver<Event>)` pair over the session the
	/// kernel is driving (an actor rendering a child session never reads its
	/// `.oms`, ADR 0005). Dropped silently when the requester is gone.
	Subscribe(flume::Sender<DomSubscription>),
}

/// The `<queues><steering>` element.
pub(crate) fn steering_queue(session: &Session) -> Result<Handle, SessionError> {
	session
		.dom()
		.children(session.dom().queues())
		.iter()
		.copied()
		.find(|handle| {
			session
				.dom()
				.get(*handle)
				.is_some_and(|node| node.tag == Tag::Known(KnownTag::Steering))
		})
		.ok_or(SessionError::NoActiveTurn)
}

/// Journals one accepted steering message into `<queues><steering>`; its
/// attachments ride the same `data` prop a `msg.user@1` fold writes, so the
/// safe point moves them into the turn and the projection types them.
pub(crate) fn queue_steering(
	session: &mut Session,
	text: Str,
	attachments: &[Attachment],
) -> Result<(), SessionError> {
	queue_steering_with_author(session, text, attachments, None)
}

/// Journals one authenticated remote steering message with its author in the
/// initial insertion.
pub(crate) fn queue_authored_steering(
	session: &mut Session,
	text: Str,
	attachments: &[Attachment],
	author: Str,
) -> Result<(), SessionError> {
	queue_steering_with_author(session, text, attachments, Some(author))
}

fn queue_steering_with_author(
	session: &mut Session,
	text: Str,
	attachments: &[Attachment],
	author: Option<Str>,
) -> Result<(), SessionError> {
	let steering = steering_queue(session)?;
	let cause = session.head().ok_or(SessionError::NoActiveTurn)?;
	let mut node = NodeSpec::new(KnownTag::User)
		.with_prop(PropId::Status, Value::Str(Str::new_static("queued")))
		.with_content(text);
	if !attachments.is_empty() {
		node =
			node.with_prop(PropId::Data, Value::Json(serde_json::value::to_raw_value(attachments)?));
	}
	if let Some(author) = author {
		node = node.with_prop(PropId::Author, Value::Str(author));
	}
	session.patch(Txn {
		cause,
		label: Some(Str::new_static("steering.queue")),
		ops: vec![Op::Ins {
			parent: steering,
			after: session.dom().children(steering).last().copied(),
			node,
		}],
	})?;
	Ok(())
}

/// Journals one peer message without making it turn steering.
pub(crate) fn queue_peer(session: &mut Session, text: Str) -> Result<(), SessionError> {
	let steering = steering_queue(session)?;
	let cause = session.head().ok_or(SessionError::NoActiveTurn)?;
	session.patch(Txn {
		cause,
		label: Some(Str::new_static("hub.message")),
		ops: vec![Op::Ins {
			parent: steering,
			after:  session.dom().children(steering).last().copied(),
			node:   NodeSpec::new(KnownTag::User)
				.with_prop(PropId::Status, Value::Str(Str::new_static("queued")))
				.with_prop(PropKey::Custom(Str::new_static("hub")), Value::Bool(true))
				.with_content(text),
		}],
	})?;
	Ok(())
}

/// Journals one follow-up prompt as `<prompt kind=queued status=pending>`
/// under `<queues><prompts>` (the controller's `queue.push` shape); its
/// attachments ride the same `data` prop a `msg.user@1` fold writes, so the
/// controller's pop hands them to the next turn typed.
pub fn queue_prompt(
	session: &mut Session,
	text: Str,
	attachments: &[Attachment],
) -> Result<(), SessionError> {
	let prompts = omp_session::components::prompts::prompts_handle(session.dom())
		.ok_or(SessionError::NoActiveTurn)?;
	let cause = session.head().ok_or(SessionError::NoActiveTurn)?;
	let id = Str::new(format!("queued-{}", omp_core::Ulid::generate()));
	let mut node = NodeSpec::new(KnownTag::Prompt)
		.with_prop(PropId::Kind, Value::Str(Str::new_static("queued")))
		.with_prop(PropId::Id, Value::Str(id))
		.with_prop(PropId::Status, Value::Str(Str::new_static("pending")))
		.with_content(text);
	if !attachments.is_empty() {
		node =
			node.with_prop(PropId::Data, Value::Json(serde_json::value::to_raw_value(attachments)?));
	}
	session.patch(Txn {
		cause,
		label: Some(Str::new_static("queue.push")),
		ops: vec![Op::Ins {
			parent: prompts,
			after: session.dom().children(prompts).last().copied(),
			node,
		}],
	})?;
	Ok(())
}

/// Takes the oldest `<prompt kind=queued status=pending>` under
/// `<queues><prompts>`, journaling it `sent`, and returns its text with the
/// attachments [`queue_prompt`] stored. A follow-up runs "when the agent
/// yields", so hosts call this once a turn settles and start the next turn
/// from the result.
pub fn pop_queued_prompt(
	session: &mut Session,
) -> Result<Option<(Str, Vec<Attachment>)>, SessionError> {
	let Some(prompts) = omp_session::components::prompts::prompts_handle(session.dom()) else {
		return Ok(None);
	};
	let kind = PropKey::from(PropId::Kind);
	let status = PropKey::from(PropId::Status);
	let data = PropKey::from(PropId::Data);
	let dom = session.dom();
	let Some((handle, text)) = dom.children(prompts).iter().find_map(|handle| {
		let node = dom.get(*handle)?;
		let queued = node.tag == Tag::Known(KnownTag::Prompt)
			&& node.prop(&kind).and_then(Value::as_str) == Some("queued")
			&& node.prop(&status).and_then(Value::as_str) == Some("pending");
		queued.then(|| (*handle, node.content.clone().unwrap_or_default()))
	}) else {
		return Ok(None);
	};
	let attachments = match dom.get(handle).and_then(|node| node.prop(&data)) {
		Some(Value::Json(raw)) => serde_json::from_str(raw.get())?,
		_ => Vec::new(),
	};
	let cause = session.head().ok_or(SessionError::NoActiveTurn)?;
	session.patch(Txn {
		cause,
		label: Some(Str::new_static("queue.pop")),
		ops: vec![Op::Set {
			h:     handle,
			prop:  status,
			value: Value::Str(Str::new_static("sent")),
		}],
	})?;
	Ok(Some((text, attachments)))
}

fn is_peer(session: &Session, handle: Handle) -> bool {
	session
		.dom()
		.get(handle)
		.and_then(|node| node.prop(&PropKey::Custom(Str::new_static("hub"))))
		.is_some_and(|value| matches!(value, Value::Bool(true)))
}

/// Asides currently queued in `<queues><steering>` with their attachments,
/// oldest first.
pub(crate) fn queued_steering(session: &Session) -> Vec<(Str, Vec<Attachment>)> {
	let Ok(steering) = steering_queue(session) else {
		return Vec::new();
	};
	session
		.dom()
		.children(steering)
		.iter()
		.filter(|handle| !is_peer(session, **handle))
		.filter_map(|handle| {
			let node = session.dom().get(*handle)?;
			let attachments = match node.prop(&PropKey::from(PropId::Data)) {
				Some(Value::Json(raw)) => serde_json::from_str(raw.get()).unwrap_or_default(),
				_ => Vec::new(),
			};
			Some((node.content.clone()?, attachments))
		})
		.collect()
}

/// Whether any accepted steering awaits a safe point.
pub(crate) fn steering_pending(session: &Session) -> bool {
	steering_queue(session).is_ok_and(|steering| {
		session
			.dom()
			.children(steering)
			.iter()
			.any(|handle| !is_peer(session, *handle))
	})
}

/// Moves queued steering into `turn` in one atomic patch: the queue items are
/// removed and re-inserted as `<user steering=true>` turn children, preserving
/// user authorship. Under [`SteeringMode::OneAtATime`] only the oldest item
/// moves and the rest stay queued (so [`steering_pending`] keeps the loop
/// reaching further safe points); [`SteeringMode::All`] moves every item.
/// Returns the consumed texts in queue order.
pub(crate) fn consume_steering(
	session: &mut Session,
	turn: Handle,
	mode: SteeringMode,
) -> Result<Vec<Str>, SessionError> {
	let steering = steering_queue(session)?;
	let queued = session
		.dom()
		.children(steering)
		.iter()
		.filter(|handle| !is_peer(session, **handle))
		.filter_map(|handle| {
			let node = session.dom().get(*handle)?;
			let data = node.prop(&PropKey::from(PropId::Data)).cloned();
			let author = node.prop(&PropKey::from(PropId::Author)).cloned();
			Some((*handle, node.content.clone()?, data, author))
		})
		.take(match mode {
			SteeringMode::OneAtATime => 1,
			SteeringMode::All => usize::MAX,
		})
		.collect::<Vec<_>>();
	if queued.is_empty() {
		return Ok(Vec::new());
	}
	let cause = session.head().ok_or(SessionError::NoActiveTurn)?;
	let tail = session.dom().children(turn).last().copied();
	let mut ops = Vec::with_capacity(queued.len() * 2);
	ops.extend(queued.iter().map(|(handle, ..)| Op::Rm(*handle)));
	// Every insert anchors on the turn's current tail; inserting in reverse
	// queue order therefore lands the items in queue order after it. The
	// aside keeps its attachments (`data`) so the projection types them.
	ops.extend(queued.iter().rev().map(|(_, text, data, author)| {
		let mut node = NodeSpec::new(KnownTag::User)
			.with_prop(PropKey::Custom(Str::new_static("steering")), Value::Bool(true))
			.with_content(text.clone());
		if let Some(data) = data {
			node = node.with_prop(PropId::Data, data.clone());
		}
		if let Some(author) = author {
			node = node.with_prop(PropId::Author, author.clone());
		}
		Op::Ins { parent: turn, after: tail, node }
	}));
	session.patch(Txn { cause, label: Some(Str::new_static("steering.safe-point")), ops })?;
	Ok(queued.into_iter().map(|(_, text, ..)| text).collect())
}

/// Removes every queued steering message (host `Unqueue`: the composer takes
/// them back) and returns their texts.
pub(crate) fn unqueue_steering(session: &mut Session) -> Result<Vec<Str>, SessionError> {
	let steering = steering_queue(session)?;
	let queued = session
		.dom()
		.children(steering)
		.iter()
		.filter(|handle| !is_peer(session, **handle))
		.filter_map(|handle| Some((*handle, session.dom().get(*handle)?.content.clone()?)))
		.collect::<Vec<_>>();
	if queued.is_empty() {
		return Ok(Vec::new());
	}
	let cause = session.head().ok_or(SessionError::NoActiveTurn)?;
	let (handles, texts): (Vec<_>, Vec<_>) = queued.into_iter().unzip();
	session.patch(Txn {
		cause,
		label: Some(Str::new_static("steering.unqueue")),
		ops: handles.into_iter().map(Op::Rm).collect(),
	})?;
	Ok(texts)
}

pub(crate) fn append_notice(
	session: &mut Session,
	turn: Handle,
	text: Str,
) -> Result<(), SessionError> {
	append_notice_with_kind(session, turn, text, Str::new_static("info"))
}

/// Appends a `<notice kind=error>` describing why the turn failed.
pub(crate) fn append_error_notice(
	session: &mut Session,
	turn: Handle,
	text: Str,
) -> Result<(), SessionError> {
	append_notice_with_kind(session, turn, text, Str::new_static("error"))
}

/// Appends a durable custom message as model-visible developer context.
///
/// Visible legacy `handoff` messages are normalized at this producer boundary
/// into the ordinary compaction journal kind. That keeps new journals free of
/// the obsolete custom-message shape while the fold retains replay support for
/// journals that already contain it.
pub(crate) fn append_custom_message(
	session: &mut Session,
	turn: Handle,
	message: omp_session::custom_message::CustomMessage,
) -> Result<(), SessionError> {
	if let Some(document) = message.legacy_handoff_document() {
		let boundary = session.head().ok_or(SessionError::NoActiveTurn)?;
		let summary = session.blobs().put(document.as_bytes())?;
		let mut compaction = Compaction::new(summary, boundary);
		compaction.method = Some(Str::new_static("handoff"));
		session.compaction(compaction)?;
		return Ok(());
	}
	append_turn_child(session, turn, message.into_node(), Str::new_static("kernel.custom-message"))
}

/// Appends a producer-named notice (`<notice kind=hook name=…>`).
pub(crate) fn append_named_notice(
	session: &mut Session,
	turn: Handle,
	kind: Str,
	name: Option<Str>,
	body: Str,
) -> Result<(), SessionError> {
	let mut node = NodeSpec::new(KnownTag::Notice)
		.with_prop(PropId::Kind, Value::Str(kind))
		.with_content(body);
	if let Some(name) = name {
		node = node.with_prop(PropKey::Custom(Str::new_static("name")), Value::Str(name));
	}
	append_turn_child(session, turn, node, Str::new_static("kernel.notice"))
}

/// Appends the `<notice kind=warn>` that ends an interrupted turn.
pub(crate) fn append_interrupt_notice(
	session: &mut Session,
	turn: Handle,
) -> Result<(), SessionError> {
	append_notice_with_kind(
		session,
		turn,
		Str::new_static("Turn interrupted"),
		Str::new_static("warn"),
	)
}

pub(crate) fn append_empty_output_retry(
	session: &mut Session,
	turn: Handle,
	attempt: u8,
) -> Result<(), SessionError> {
	append_turn_child(
		session,
		turn,
		NodeSpec::new(KnownTag::Developer).with_content(Str::new(format!(
			"<system-injection>\nStopped without actionable output; task incomplete. Continue with a \
			 user-visible final answer or the next required tool call.\nAttempt \
			 #{attempt}/{EMPTY_OUTPUT_RETRY_CAP}\n</system-injection>"
		))),
		Str::new_static("kernel.empty-output-retry"),
	)
}

pub(crate) fn append_empty_output_cap_notice(
	session: &mut Session,
	turn: Handle,
) -> Result<(), SessionError> {
	append_notice_with_kind(
		session,
		turn,
		Str::new_static(EMPTY_OUTPUT_CAP_NOTICE),
		Str::new_static("error"),
	)
}

fn append_notice_with_kind(
	session: &mut Session,
	turn: Handle,
	text: Str,
	kind: Str,
) -> Result<(), SessionError> {
	append_turn_child(
		session,
		turn,
		NodeSpec::new(KnownTag::Notice)
			.with_prop(PropId::Kind, Value::Str(kind))
			.with_content(text),
		Str::new_static("kernel.notice"),
	)
}

fn append_turn_child(
	session: &mut Session,
	turn: Handle,
	node: NodeSpec,
	label: Str,
) -> Result<(), SessionError> {
	session.patch(Txn {
		cause: session.head().ok_or(SessionError::NoActiveTurn)?,
		label: Some(label),
		ops:   vec![Op::Ins {
			parent: turn,
			after: session.dom().children(turn).last().copied(),
			node,
		}],
	})?;
	Ok(())
}

#[cfg(test)]
mod tests {
	use omp_session::ComponentRegistry;

	use super::*;

	fn session_with_turn(path: &std::path::Path) -> (Session, Handle) {
		let mut session =
			Session::create(path, ComponentRegistry::default()).expect("session creates");
		session.begin_turn().expect("turn starts");
		let turn = *session
			.dom()
			.children(session.dom().body())
			.last()
			.expect("turn exists");
		(session, turn)
	}

	fn turn_steering(session: &Session, turn: Handle) -> Vec<Str> {
		session
			.dom()
			.children(turn)
			.iter()
			.filter_map(|handle| {
				let node = session.dom().get(*handle)?;
				(node.tag == Tag::Known(KnownTag::User)
					&& node.prop(&PropKey::Custom(Str::new_static("steering")))
						== Some(&Value::Bool(true)))
				.then(|| node.content.clone())
				.flatten()
			})
			.collect()
	}

	#[test]
	fn runtime_legacy_handoff_journals_an_ordinary_compaction() {
		let directory = tempfile::tempdir().expect("temporary session directory");
		let path = directory.path().join("handoff.oms");
		let (mut session, turn) = session_with_turn(&path);
		append_custom_message(
			&mut session,
			turn,
			omp_session::custom_message::CustomMessage::new(
				"handoff",
				"before<handoff-context>\n# State\nContinue.\n</handoff-context>after",
			),
		)
		.expect("handoff journals");

		let head = session.head().expect("journal head");
		assert_eq!(
			session.entry(head).expect("head entry").kind.name.as_str(),
			"compaction",
			"new runtime handoffs use compaction@1 rather than a compatibility patch"
		);
		let handle = session
			.dom()
			.select("meta compaction[method=handoff]")
			.expect("selector")
			.next()
			.expect("handoff compaction");
		let node = session.dom().get(handle).expect("compaction node");
		assert_eq!(
			node.prop(&PropId::Summary.into()).and_then(Value::as_str),
			Some("# State\nContinue.")
		);
		assert!(
			session
				.dom()
				.select("body turn developer[name=handoff]")
				.expect("selector")
				.next()
				.is_none()
		);
		let live = session.dom().snapshot();
		drop(session);

		let restored =
			Session::open(&path, ComponentRegistry::default()).expect("handoff compaction replays");
		assert_eq!(restored.dom().snapshot(), live);
	}

	#[test]
	fn one_at_a_time_consumes_one_item_per_safe_point() {
		let directory = tempfile::tempdir().expect("temporary session directory");
		let (mut session, turn) = session_with_turn(&directory.path().join("steer.oms"));
		queue_steering(&mut session, Str::new_static("first"), &[]).expect("first queues");
		queue_steering(&mut session, Str::new_static("second"), &[]).expect("second queues");

		let consumed =
			consume_steering(&mut session, turn, SteeringMode::OneAtATime).expect("first safe point");
		assert_eq!(consumed, [Str::new_static("first")]);
		assert_eq!(turn_steering(&session, turn), [Str::new_static("first")]);
		assert_eq!(queued_steering(&session), [(Str::new_static("second"), Vec::new())]);
		assert!(steering_pending(&session), "the remaining item waits for another safe point");

		let consumed =
			consume_steering(&mut session, turn, SteeringMode::OneAtATime).expect("second safe point");
		assert_eq!(consumed, [Str::new_static("second")]);
		assert_eq!(turn_steering(&session, turn), [
			Str::new_static("first"),
			Str::new_static("second")
		]);
		assert!(queued_steering(&session).is_empty());
		assert!(!steering_pending(&session));
	}

	#[test]
	fn all_consumes_every_item_at_one_safe_point() {
		let directory = tempfile::tempdir().expect("temporary session directory");
		let (mut session, turn) = session_with_turn(&directory.path().join("steer-all.oms"));
		queue_steering(&mut session, Str::new_static("first"), &[]).expect("first queues");
		queue_steering(&mut session, Str::new_static("second"), &[]).expect("second queues");

		let consumed = consume_steering(&mut session, turn, SteeringMode::All).expect("safe point");
		assert_eq!(consumed, [Str::new_static("first"), Str::new_static("second")]);
		assert_eq!(turn_steering(&session, turn), [
			Str::new_static("first"),
			Str::new_static("second")
		]);
		assert!(!steering_pending(&session));
	}

	#[test]
	fn queue_journals_pending_prompt_under_queues_prompts() {
		let directory = tempfile::tempdir().expect("temporary session directory");
		let (mut session, _) = session_with_turn(&directory.path().join("queue.oms"));
		queue_prompt(&mut session, Str::new_static("follow up"), &[]).expect("prompt queues");

		assert!(!steering_pending(&session), "a queued prompt is not steering");
		let prompts = omp_session::components::prompts::prompts_handle(session.dom())
			.expect("prompt queue exists");
		let children = session.dom().children(prompts);
		assert_eq!(children.len(), 1);
		let node = session.dom().get(children[0]).expect("queued prompt node");
		assert_eq!(node.tag, Tag::Known(KnownTag::Prompt));
		assert_eq!(node.content.as_deref(), Some("follow up"));
		assert_eq!(
			node.prop(&PropKey::from(PropId::Kind)),
			Some(&Value::Str(Str::new_static("queued")))
		);
		assert_eq!(
			node.prop(&PropKey::from(PropId::Status)),
			Some(&Value::Str(Str::new_static("pending")))
		);
		assert!(
			node
				.prop(&PropKey::from(PropId::Id))
				.and_then(Value::as_str)
				.is_some_and(|id| id.starts_with("queued-"))
		);
		assert!(node.prop(&PropKey::from(PropId::Data)).is_none(), "no attachments, no data prop");
	}

	/// A queued prompt keeps its images in the same `data` shape a
	/// `msg.user@1` fold writes, so the pop that starts the next turn carries
	/// them typed instead of dropping them.
	#[test]
	fn queue_journals_attachments_beside_the_prompt() {
		let directory = tempfile::tempdir().expect("temporary session directory");
		let (mut session, _) = session_with_turn(&directory.path().join("queue-images.oms"));
		let attachments = vec![Attachment {
			blob: omp_journal::blob::BlobRef { hash: omp_core::Hash32::new([0xab; 32]), size: 5 },
			mime: Str::new_static("image/png"),
		}];
		queue_prompt(&mut session, Str::new_static("look [Image #1]"), &attachments)
			.expect("prompt queues");

		let prompts = omp_session::components::prompts::prompts_handle(session.dom())
			.expect("prompt queue exists");
		let children = session.dom().children(prompts);
		let node = session.dom().get(children[0]).expect("queued prompt node");
		let Some(Value::Json(raw)) = node.prop(&PropKey::from(PropId::Data)) else {
			panic!("queued prompt carries its attachments as data");
		};
		assert_eq!(
			serde_json::from_str::<Vec<Attachment>>(raw.get()).expect("attachment json"),
			attachments
		);
	}

	/// The follow-up queue is FIFO and pop is a journaled `sent` mark: the
	/// oldest pending prompt comes out first with its attachments, the node
	/// stays (status `sent`) so replay agrees, and an exhausted queue yields
	/// `None`.
	#[test]
	fn pop_takes_the_oldest_pending_prompt_and_marks_it_sent() {
		let directory = tempfile::tempdir().expect("temporary session directory");
		let (mut session, _) = session_with_turn(&directory.path().join("queue-pop.oms"));
		let attachments = vec![Attachment {
			blob: omp_journal::blob::BlobRef { hash: omp_core::Hash32::new([0xcd; 32]), size: 3 },
			mime: Str::new_static("image/png"),
		}];
		queue_prompt(&mut session, Str::new_static("first [Image #1]"), &attachments)
			.expect("first queues");
		queue_prompt(&mut session, Str::new_static("second"), &[]).expect("second queues");

		let popped = pop_queued_prompt(&mut session).expect("pop journals");
		assert_eq!(popped, Some((Str::new_static("first [Image #1]"), attachments)));
		let popped = pop_queued_prompt(&mut session).expect("pop journals");
		assert_eq!(popped, Some((Str::new_static("second"), Vec::new())));
		assert_eq!(pop_queued_prompt(&mut session).expect("pop journals"), None);

		let prompts = omp_session::components::prompts::prompts_handle(session.dom())
			.expect("prompt queue exists");
		let statuses: Vec<_> = session
			.dom()
			.children(prompts)
			.iter()
			.filter_map(|handle| session.dom().get(*handle))
			.map(|node| node.prop(&PropKey::from(PropId::Status)).cloned())
			.collect();
		assert_eq!(statuses, vec![
			Some(Value::Str(Str::new_static("sent"))),
			Some(Value::Str(Str::new_static("sent")))
		]);
	}

	#[test]
	fn malformed_queue_data_is_not_silently_dropped() {
		let directory = tempfile::tempdir().expect("temporary session directory");
		let (mut session, _) = session_with_turn(&directory.path().join("queue-invalid-data.oms"));
		queue_prompt(&mut session, Str::new_static("follow up [Image #1]"), &[])
			.expect("prompt queues");
		let prompts = omp_session::components::prompts::prompts_handle(session.dom())
			.expect("prompt queue exists");
		let prompt = session.dom().children(prompts)[0];
		let cause = session.head().expect("journal head");
		session
			.patch(Txn {
				cause,
				label: Some(Str::new_static("test.invalid-queue-data")),
				ops: vec![Op::Set {
					h:     prompt,
					prop:  PropId::Data.into(),
					value: Value::Json(
						serde_json::value::to_raw_value(&serde_json::json!({ "not": "attachments" }))
							.expect("valid raw json"),
					),
				}],
			})
			.expect("invalid attachment shape is journaled");

		assert!(
			pop_queued_prompt(&mut session).is_err(),
			"invalid attachment data must fail instead of turning into an attachment-free prompt"
		);
		let node = session.dom().get(prompt).expect("queued prompt remains");
		assert_eq!(
			node
				.prop(&PropKey::from(PropId::Status))
				.and_then(Value::as_str),
			Some("pending"),
			"a failed decode must not mark the prompt sent"
		);
	}

	#[test]
	fn one_at_a_time_skips_peer_messages() {
		let directory = tempfile::tempdir().expect("temporary session directory");
		let (mut session, turn) = session_with_turn(&directory.path().join("steer-peer.oms"));
		queue_peer(&mut session, Str::new_static("hub hello")).expect("peer queues");
		queue_steering(&mut session, Str::new_static("redirect"), &[]).expect("steer queues");

		let consumed =
			consume_steering(&mut session, turn, SteeringMode::OneAtATime).expect("safe point");
		assert_eq!(consumed, [Str::new_static("redirect")]);
		assert!(!steering_pending(&session));
		let steering = steering_queue(&session).expect("queue exists");
		assert_eq!(session.dom().children(steering).len(), 1, "the peer message stays queued");
	}
}
