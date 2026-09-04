//! Durable approval prompts backed by the authoritative session DOM.

use std::{
	str::FromStr,
	sync::{
		Arc,
		atomic::{AtomicU64, Ordering},
	},
	time::Duration,
};

use omp_core::{Str, sf};
use omp_dom::{Handle, KnownTag, NodeSpec, Op, PropId, PropKey, Tag, Txn, Value};
use omp_session::{Session, SessionError, components::prompts::prompts_handle};
use parking_lot::Mutex;
use serde::{Deserialize, Deserializer, Serialize, Serializer};
use thiserror::Error;
use tokio::time;
use tokio_util::sync::CancellationToken;

/// One requirement merged into an invocation's approval prompt.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ApprovalSpec {
	/// Short user-visible description.
	pub title:         Str,
	/// TML-safe explanatory text.
	pub body:          Str,
	/// Exact command, path, or device subject.
	pub subject:       Str,
	/// Presentation and configuration vocabulary such as `exec` or `write`.
	pub kind:          Str,
	/// Offered grant scopes in strictness order.
	pub scopes:        Vec<Str>,
	/// Optional timeout default; the kernel never invents one.
	pub default:       Option<bool>,
	/// Requested approver route.
	pub route:         Str,
	/// Optional named external approver.
	pub approver:      Option<Str>,
	/// Maximum wait in milliseconds; zero means no timeout.
	pub timeout_ms:    u64,
	/// Unreachable-route behavior.
	pub unreachable:   Str,
	/// Forbids non-human decisions.
	pub require_human: bool,
	/// Scope-bearing approval pattern.
	pub pattern:       Option<Str>,
	/// Rule and derived-fact evidence.
	pub evidence:      Vec<Str>,
}

/// Granted lifetime of an approval decision.
#[derive(Clone, Debug, Eq, PartialEq, strum::Display, strum::EnumString, strum::IntoStaticStr)]
#[strum(serialize_all = "lowercase")]
pub enum ApprovalScope {
	/// This operation only.
	Once,
	/// This call only.
	Call,
	/// The current turn.
	Turn,
	/// The current session.
	Session,
	/// Persisted policy.
	Persist,
	/// A forward-compatible host-defined scope.
	#[strum(default)]
	Custom(Str),
}

impl ApprovalScope {
	/// Returns the stable wire spelling.
	#[must_use]
	pub fn as_str(&self) -> &str {
		match self {
			Self::Custom(value) => value.as_str(),
			known => known.into(),
		}
	}
}

impl Serialize for ApprovalScope {
	fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
	where
		S: Serializer,
	{
		serializer.serialize_str(self.as_str())
	}
}

impl<'de> Deserialize<'de> for ApprovalScope {
	fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
	where
		D: Deserializer<'de>,
	{
		let value = Str::deserialize(deserializer)?;
		Self::from_str(value.as_str()).map_err(serde::de::Error::custom)
	}
}

/// Durable state of an approval prompt.
#[derive(
	Clone,
	Copy,
	Debug,
	Deserialize,
	Eq,
	PartialEq,
	Serialize,
	strum::Display,
	strum::EnumString,
	strum::IntoStaticStr,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum TicketState {
	/// Awaiting one idempotent answer.
	Pending,
	/// Answered exactly once.
	Decided,
	/// Invocation ended before an answer.
	Withdrawn,
}

/// Source that supplied an approval result.
#[derive(
	Clone,
	Copy,
	Debug,
	Deserialize,
	Eq,
	PartialEq,
	Serialize,
	strum::Display,
	strum::EnumString,
	strum::IntoStaticStr,
)]
#[serde(rename_all = "snake_case")]
#[strum(serialize_all = "snake_case")]
pub enum ApprovalSource {
	/// A local user answered.
	User,
	/// An authenticated external approver answered.
	External,
	/// A parent agent answered.
	Forwarded,
	/// Frozen configuration pre-answered the prompt.
	Config,
	/// An authorized extension answered.
	Extension,
	/// An explicit timeout default answered.
	Timeout,
	/// The requested route was unavailable.
	Unavailable,
}

/// One idempotent approval result.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ApprovalDecision {
	/// Whether every merged requirement is approved.
	pub approved:   bool,
	/// Granted lifetime.
	pub scope:      ApprovalScope,
	/// Source of the answer.
	pub source:     ApprovalSource,
	/// Optional authenticated decider.
	pub decided_by: Option<Str>,
	/// Optional user-visible rationale.
	pub reason:     Option<Str>,
	/// Whether a fail-open result was durably audited.
	pub audited:    bool,
}

/// Journal-derived approval prompt projection.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct ApprovalTicket {
	/// Stable idempotency key.
	pub ticket_id:     Str,
	/// Invocation this prompt blocks, if any.
	pub invocation_id: Option<Str>,
	/// Every unresolved requirement in filing order.
	pub reasons:       Vec<ApprovalSpec>,
	/// Current durable state.
	pub state:         TicketState,
	/// Present only after a decision.
	pub decision:      Option<ApprovalDecision>,
	/// Journal-clock epoch milliseconds at filing.
	pub created_at_ms: u64,
}

/// Approval DOM operation failure.
#[derive(Debug, Error)]
pub enum ApprovalError {
	/// Session persistence or DOM mutation failed.
	#[error(transparent)]
	Session(#[from] SessionError),
	/// The canonical prompts subtree is absent.
	#[error("session prompts component is absent")]
	MissingPrompts,
	/// The requested ticket does not exist.
	#[error("approval ticket {id} does not exist")]
	UnknownTicket {
		/// Missing ticket id.
		id: Str,
	},
	/// Stored prompt JSON is malformed.
	#[error("approval prompt state is malformed")]
	Malformed(#[from] serde_json::Error),
}

/// Stateless runtime index over `<queues><prompts>`.
///
/// Every lookup is rebuilt from the DOM; this value owns only an id prefix and
/// can never disagree with replayed session state.
pub struct ApprovalBook {
	prefix: Str,
}

impl ApprovalBook {
	/// Creates the ordinary approval family.
	#[must_use]
	pub const fn new() -> Self {
		Self { prefix: Str::new_static("approval") }
	}

	/// Creates a disjoint approval id family.
	#[must_use]
	pub fn with_prefix(prefix: impl Into<Str>) -> Self {
		Self { prefix: prefix.into() }
	}

	/// Opens one prompt in the session tree.
	pub fn open(
		&self,
		session: &mut Session,
		spec: ApprovalSpec,
	) -> Result<ApprovalTicket, ApprovalError> {
		self.open_for(session, None, vec![spec], epoch_millis())
	}

	/// Opens or merges the prompt for an invocation.
	pub fn open_for(
		&self,
		session: &mut Session,
		invocation_id: Option<Str>,
		reasons: Vec<ApprovalSpec>,
		created_at_ms: u64,
	) -> Result<ApprovalTicket, ApprovalError> {
		let existing = invocation_id.as_deref().and_then(|invocation_id| {
			tickets(session).find(|(_, ticket)| {
				ticket.invocation_id.as_deref() == Some(invocation_id)
					&& ticket.state == TicketState::Pending
			})
		});
		if let Some((handle, mut ticket)) = existing {
			ticket.reasons.extend(reasons);
			let encoded = serde_json::to_string(&ticket)?;
			session.patch(Txn {
				cause: session.head().ok_or(ApprovalError::MissingPrompts)?,
				label: Some(Str::new_static("approval.merge")),
				ops:   vec![Op::Set {
					h:     handle,
					prop:  custom("ticket"),
					value: Value::Str(Str::new(encoded)),
				}],
			})?;
			return Ok(ticket);
		}

		let prompts = prompts_handle(session.dom()).ok_or(ApprovalError::MissingPrompts)?;
		let ticket_id = sf!("{}-{}", self.prefix, session.dom().high_water().saturating_add(1));
		let ticket = ApprovalTicket {
			ticket_id: ticket_id.clone(),
			invocation_id,
			reasons,
			state: TicketState::Pending,
			decision: None,
			created_at_ms,
		};
		let encoded = serde_json::to_string(&ticket)?;
		let first = ticket.reasons.first();
		let mut node = NodeSpec::new(KnownTag::Prompt)
			.with_prop(PropId::Kind, Value::Str(Str::new_static("approval")))
			.with_prop(PropId::Id, Value::Str(ticket_id))
			.with_prop(PropId::Status, Value::Str(Str::new_static("pending")))
			.with_prop(custom("ticket"), Value::Str(Str::new(encoded)));
		if let Some(spec) = first {
			node = node
				.with_prop(PropId::Label, Value::Str(spec.title.clone()))
				.with_prop(PropId::Detail, Value::Str(spec.body.clone()))
				.with_prop(custom("subject"), Value::Str(spec.subject.clone()))
				.with_prop(
					custom("scope"),
					Value::Str(spec.scopes.first().cloned().unwrap_or_else(|| sf!("once"))),
				)
				.with_prop(
					custom("timeout-ms"),
					Value::Int(i64::try_from(spec.timeout_ms).unwrap_or(i64::MAX)),
				);
		}
		session.patch(Txn {
			cause: session.head().ok_or(ApprovalError::MissingPrompts)?,
			label: Some(Str::new_static("approval.open")),
			ops:   vec![Op::Ins {
				parent: prompts,
				after: session.dom().children(prompts).last().copied(),
				node,
			}],
		})?;
		Ok(ticket)
	}

	/// Applies an idempotent first decision to a prompt.
	pub fn decide(
		&self,
		session: &mut Session,
		ticket_id: &str,
		decision: ApprovalDecision,
	) -> Result<ApprovalTicket, ApprovalError> {
		let (handle, mut ticket) = find_ticket(session, ticket_id)?;
		if ticket.state == TicketState::Pending {
			ticket.state = TicketState::Decided;
			ticket.decision = Some(decision.clone());
			let encoded = serde_json::to_string(&ticket)?;
			let decision_json = serde_json::to_string(&decision)?;
			session.patch(Txn {
				cause: session.head().ok_or(ApprovalError::MissingPrompts)?,
				label: Some(Str::new_static("approval.decide")),
				ops:   vec![
					Op::Set {
						h:     handle,
						prop:  PropId::Status.into(),
						value: Value::Str(sf!("decided")),
					},
					Op::Set {
						h:     handle,
						prop:  custom("ticket"),
						value: Value::Str(Str::new(encoded)),
					},
					Op::Set {
						h:     handle,
						prop:  custom("decision"),
						value: Value::Str(Str::new(decision_json)),
					},
					Op::Set {
						h:     handle,
						prop:  custom("approved"),
						value: Value::Bool(decision.approved),
					},
					Op::Set {
						h:     handle,
						prop:  custom("scope"),
						value: Value::Str(Str::new(decision.scope.as_str())),
					},
					Op::Set {
						h:     handle,
						prop:  custom("source"),
						value: Value::Str(sf!(<&'static str>::from(decision.source))),
					},
				],
			})?;
		}
		Ok(ticket)
	}

	/// Withdraws an unanswered prompt.
	pub fn withdraw(
		&self,
		session: &mut Session,
		ticket_id: &str,
	) -> Result<ApprovalTicket, ApprovalError> {
		let (handle, mut ticket) = find_ticket(session, ticket_id)?;
		if ticket.state == TicketState::Pending {
			ticket.state = TicketState::Withdrawn;
			let encoded = serde_json::to_string(&ticket)?;
			session.patch(Txn {
				cause: session.head().ok_or(ApprovalError::MissingPrompts)?,
				label: Some(Str::new_static("approval.withdraw")),
				ops:   vec![
					Op::Set {
						h:     handle,
						prop:  PropId::Status.into(),
						value: Value::Str(sf!("withdrawn")),
					},
					Op::Set {
						h:     handle,
						prop:  custom("ticket"),
						value: Value::Str(Str::new(encoded)),
					},
				],
			})?;
		}
		Ok(ticket)
	}

	/// Rebuilds one ticket from the authoritative DOM.
	pub fn ticket(&self, session: &Session, ticket_id: &str) -> Option<ApprovalTicket> {
		tickets(session)
			.find_map(|(_, ticket)| (ticket.ticket_id.as_str() == ticket_id).then_some(ticket))
	}

	/// Rebuilds pending tickets in tree order.
	pub fn pending(&self, session: &Session) -> Vec<ApprovalTicket> {
		tickets(session)
			.filter_map(|(_, ticket)| (ticket.state == TicketState::Pending).then_some(ticket))
			.collect()
	}
}

impl Default for ApprovalBook {
	fn default() -> Self {
		Self::new()
	}
}

const fn custom(name: &'static str) -> PropKey {
	PropKey::Custom(Str::new_static(name))
}

fn tickets(session: &Session) -> impl Iterator<Item = (Handle, ApprovalTicket)> + '_ {
	let prompts = prompts_handle(session.dom());
	prompts
		.into_iter()
		.flat_map(|prompts| session.dom().children(prompts).iter().copied())
		.filter_map(|handle| {
			let node = session.dom().get(handle)?;
			if node.tag != Tag::Known(KnownTag::Prompt)
				|| node
					.prop(&PropKey::from(PropId::Kind))
					.and_then(Value::as_str)
					!= Some("approval")
			{
				return None;
			}
			let encoded = node.prop(&custom("ticket")).and_then(Value::as_str)?;
			serde_json::from_str(encoded)
				.ok()
				.map(|ticket| (handle, ticket))
		})
}

fn find_ticket(
	session: &Session,
	ticket_id: &str,
) -> Result<(Handle, ApprovalTicket), ApprovalError> {
	tickets(session)
		.find(|(_, ticket)| ticket.ticket_id.as_str() == ticket_id)
		.ok_or_else(|| ApprovalError::UnknownTicket { id: Str::new(ticket_id) })
}

pub(crate) fn epoch_millis() -> u64 {
	std::time::SystemTime::now()
		.duration_since(std::time::UNIX_EPOCH)
		.map_or(0, |elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
}

/// Cloneable request/reply route between environment policy and the host actor.
#[derive(Clone)]
pub struct ApprovalRoute {
	inner: Arc<RouteInner>,
}

struct RouteInner {
	next_id: AtomicU64,
	tx:      RouteSink,
	pending: Mutex<std::collections::BTreeMap<Str, PendingRequest>>,
	/// `tool_approval_requested` / `tool_approval_resolved` observers around
	/// every prompted approval.
	hooks:   Option<crate::LifecycleHooks>,
}

impl RouteInner {
	fn notify_requested(&self, ticket: &ApprovalTicket) {
		let Some(hooks) = &self.hooks else {
			return;
		};
		let requested_by = ticket
			.reasons
			.first()
			.map_or("user", |spec| spec.route.as_str());
		let _ = hooks.notify(
			omp_proto::toolhost::v1::HookEventId::HookEventToolApprovalRequested,
			serde_json::json!({
				"call_id": ticket.invocation_id.as_deref().unwrap_or(""),
				"ticket_id": ticket.ticket_id,
				"target": approval_target(ticket),
				"reasons": ticket.reasons.iter().map(|spec| spec.body.as_str()).collect::<Vec<_>>(),
				"requested_by": requested_by,
			}),
		);
	}

	fn notify_resolved(
		&self,
		ticket: &ApprovalTicket,
		decision: &ApprovalDecision,
		waited: Duration,
	) {
		let Some(hooks) = &self.hooks else {
			return;
		};
		let _ = hooks.notify(
			omp_proto::toolhost::v1::HookEventId::HookEventToolApprovalResolved,
			serde_json::json!({
				"call_id": ticket.invocation_id.as_deref().unwrap_or(""),
				"ticket_id": ticket.ticket_id,
				"target": approval_target(ticket),
				"approved": decision.approved,
				"reason": decision.reason,
				"resolved_by": <&'static str>::from(decision.source),
				"waited": format!("{}ms", waited.as_millis()),
			}),
		);
	}
}

/// The Python `CallTarget` of an approval prompt: the route only knows the
/// subject (command, path, dynamic target) and its tier, which travel as a
/// core target named by the subject.
fn approval_target(ticket: &ApprovalTicket) -> serde_json::Value {
	let first = ticket.reasons.first();
	serde_json::json!({
		"kind": "core",
		"name": first.map_or("", |spec| spec.subject.as_str()),
		"rev": "",
		"args": {
			"kind": first.map_or("", |spec| spec.kind.as_str()),
			"subject": first.map_or("", |spec| spec.subject.as_str()),
			"pattern": first.and_then(|spec| spec.pattern.as_deref()),
		},
	})
}

/// Where a route delivers the prompts it files: a standalone host inbox, or
/// the kernel mailbox so the request is journaled and answered at the same
/// safe points as every other control message.
enum RouteSink {
	Inbox(flume::Sender<ApprovalRequest>),
	Kernel(flume::Sender<crate::Up>),
}

impl RouteSink {
	fn deliver(&self, request: ApprovalRequest) -> Result<(), ()> {
		match self {
			Self::Inbox(tx) => tx.send(request).map_err(|_| ()),
			Self::Kernel(tx) => tx.send(crate::Up::Approval(request)).map_err(|_| ()),
		}
	}
}

#[derive(Clone)]
struct PendingRequest {
	ticket: ApprovalTicket,
	reply:  flume::Sender<ApprovalDecision>,
}

struct PendingGuard {
	inner:     Arc<RouteInner>,
	ticket_id: Str,
}

impl Drop for PendingGuard {
	fn drop(&mut self) {
		self.inner.pending.lock().remove(&self.ticket_id);
	}
}

/// Host-facing receiving half of an approval route.
pub struct ApprovalInbox {
	rx: flume::Receiver<ApprovalRequest>,
}

/// One pending approval delivered to the host actor.
#[derive(Clone, Debug)]
pub struct ApprovalRequest {
	/// Prompt awaiting a decision.
	pub ticket: ApprovalTicket,
	reply:      flume::Sender<ApprovalDecision>,
}

impl ApprovalRequest {
	/// Answers the request. The first response wins.
	pub fn respond(self, decision: ApprovalDecision) -> Result<(), ApprovalDecision> {
		self
			.reply
			.try_send(decision)
			.map_err(|error| error.into_inner())
	}

	/// Whether the requesting policy stopped waiting (cancelled, timed out,
	/// or the invocation ended) so no answer can reach it any more.
	#[must_use]
	pub fn is_abandoned(&self) -> bool {
		self.reply.is_disconnected()
	}
}

/// Kernel-owned bridge between route prompts and the journaled `<prompt>`
/// elements a host answers through [`crate::Up::Approve`].
///
/// The DOM is the authority: filing opens (or merges into) the durable
/// prompt, a decision is journaled first and only then relayed to the waiting
/// policy, and a session-scoped grant already in the tree answers a repeated
/// subject without prompting again. Only the reply channels live here.
#[derive(Clone)]
pub struct ApprovalDesk {
	book:    Arc<ApprovalBook>,
	pending: Arc<Mutex<std::collections::BTreeMap<Str, Vec<ApprovalRequest>>>>,
	events:  crate::events::KernelEvents,
}

impl ApprovalDesk {
	/// Creates the desk publishing [`crate::KernelEvent::ApprovalRequested`]
	/// on `events`.
	#[must_use]
	pub fn new(events: crate::events::KernelEvents) -> Self {
		Self {
			book: Arc::new(ApprovalBook::new()),
			pending: Arc::new(Mutex::new(std::collections::BTreeMap::new())),
			events,
		}
	}

	/// Journals one route request as a pending prompt and keeps its reply
	/// channel until [`Self::decide`]; a matching session-wide grant already
	/// in the tree decides it immediately.
	pub fn file(
		&self,
		session: &mut Session,
		request: ApprovalRequest,
	) -> Result<ApprovalTicket, ApprovalError> {
		let ticket = self.book.open_for(
			session,
			request.ticket.invocation_id.clone(),
			request.ticket.reasons.clone(),
			request.ticket.created_at_ms,
		)?;
		if let Some(grant) = session_grant(session, &ticket) {
			let ticket = self
				.book
				.decide(session, ticket.ticket_id.as_str(), grant.clone())?;
			let _ = request.respond(grant);
			return Ok(ticket);
		}
		self
			.pending
			.lock()
			.entry(ticket.ticket_id.clone())
			.or_default()
			.push(request);
		self
			.events
			.publish(crate::KernelEvent::ApprovalRequested(ticket.clone()));
		Ok(ticket)
	}

	/// Journals one prompt raised by host admission policy for `call_id`
	/// (no reply channel: the dispatcher observes the decision through the
	/// mailbox); a matching session-wide grant decides it immediately.
	pub fn file_spec(
		&self,
		session: &mut Session,
		call_id: Str,
		spec: ApprovalSpec,
	) -> Result<ApprovalTicket, ApprovalError> {
		self.file_specs(session, call_id, vec![spec])
	}

	/// Journals every hook and tool-admission requirement for one call as one
	/// durable prompt.
	pub fn file_specs(
		&self,
		session: &mut Session,
		call_id: Str,
		specs: Vec<ApprovalSpec>,
	) -> Result<ApprovalTicket, ApprovalError> {
		let ticket = self
			.book
			.open_for(session, Some(call_id), specs, epoch_millis())?;
		if let Some(grant) = session_grant(session, &ticket) {
			return self.book.decide(session, ticket.ticket_id.as_str(), grant);
		}
		self
			.events
			.publish(crate::KernelEvent::ApprovalRequested(ticket.clone()));
		Ok(ticket)
	}

	/// Journals the first decision for `ticket_id` and relays it to every
	/// policy waiting on that prompt.
	pub fn decide(
		&self,
		session: &mut Session,
		ticket_id: &str,
		decision: ApprovalDecision,
	) -> Result<ApprovalTicket, ApprovalError> {
		let ticket = self.book.decide(session, ticket_id, decision.clone())?;
		let waiting = self.pending.lock().remove(ticket_id).unwrap_or_default();
		for request in waiting {
			let _ = request.respond(decision.clone());
		}
		Ok(ticket)
	}

	/// Withdraws every journaled prompt whose requesting policy stopped
	/// waiting (route timeout, cancelled or finished invocation).
	pub fn sweep(&self, session: &mut Session) -> Result<(), ApprovalError> {
		let abandoned = {
			let mut pending = self.pending.lock();
			let ids = pending
				.iter()
				.filter(|(_, requests)| requests.iter().all(ApprovalRequest::is_abandoned))
				.map(|(id, _)| id.clone())
				.collect::<Vec<_>>();
			for id in &ids {
				pending.remove(id);
			}
			ids
		};
		for id in abandoned {
			self.book.withdraw(session, id.as_str())?;
		}
		Ok(())
	}

	/// Prompt ids currently waiting on a host answer.
	#[must_use]
	pub fn waiting(&self) -> Vec<Str> {
		self.pending.lock().keys().cloned().collect()
	}
}

/// A decided prompt in the tree whose session-wide (or persisted) approval
/// covers every reason of `ticket`: same kind and subject.
fn session_grant(session: &Session, ticket: &ApprovalTicket) -> Option<ApprovalDecision> {
	let covered = |decided: &ApprovalTicket, spec: &ApprovalSpec| {
		decided
			.reasons
			.iter()
			.any(|granted| granted.kind == spec.kind && granted.subject == spec.subject)
	};
	tickets(session).find_map(|(_, decided)| {
		let decision = decided.decision.as_ref()?;
		let granted = decision.approved
			&& matches!(decision.scope, ApprovalScope::Session | ApprovalScope::Persist)
			&& decided.ticket_id != ticket.ticket_id
			&& !ticket.reasons.is_empty()
			&& ticket.reasons.iter().all(|spec| covered(&decided, spec));
		granted.then(|| ApprovalDecision {
			approved:   true,
			scope:      decision.scope.clone(),
			source:     ApprovalSource::Config,
			decided_by: decision.decided_by.clone(),
			reason:     Some(sf!("granted by {} for this session", decided.ticket_id)),
			audited:    false,
		})
	})
}

impl ApprovalInbox {
	/// Receives the next pending request.
	pub async fn recv(&self) -> Result<ApprovalRequest, flume::RecvError> {
		self.rx.recv_async().await
	}

	/// Attempts to receive a request without waiting.
	pub fn try_recv(&self) -> Result<ApprovalRequest, flume::TryRecvError> {
		self.rx.try_recv()
	}
}

impl ApprovalRoute {
	/// Creates a route and its single host inbox.
	#[must_use]
	pub fn new(
		_book: Arc<ApprovalBook>,
		hook_gate: Option<Arc<crate::HookGate>>,
	) -> (Self, ApprovalInbox) {
		let (tx, rx) = flume::unbounded();
		(
			Self {
				inner: Arc::new(RouteInner {
					next_id: AtomicU64::new(1),
					tx:      RouteSink::Inbox(tx),
					pending: Mutex::new(std::collections::BTreeMap::new()),
					hooks:   hook_gate.map(crate::LifecycleHooks::new),
				}),
			},
			ApprovalInbox { rx },
		)
	}

	/// Creates a route whose prompts land in the kernel mailbox as
	/// [`crate::Up::Approval`], where the turn loop journals them and relays
	/// the host's [`crate::Up::Approve`] back through the same request.
	#[must_use]
	pub fn to_kernel(
		mailbox: flume::Sender<crate::Up>,
		hook_gate: Option<Arc<crate::HookGate>>,
	) -> Self {
		Self {
			inner: Arc::new(RouteInner {
				next_id: AtomicU64::new(1),
				tx:      RouteSink::Kernel(mailbox),
				pending: Mutex::new(std::collections::BTreeMap::new()),
				hooks:   hook_gate.map(crate::LifecycleHooks::new),
			}),
		}
	}

	/// Files, dispatches, and awaits one approval prompt.
	pub async fn request(
		&self,
		invocation_id: Option<Str>,
		reasons: Vec<ApprovalSpec>,
		created_at_ms: u64,
	) -> ApprovalTicket {
		self
			.request_cancellable(invocation_id, reasons, created_at_ms, CancellationToken::new())
			.await
	}

	/// Files and awaits one approval, withdrawing it if cancellation wins.
	///
	/// The pending-table guard is owned by this future, so dropping the future
	/// also removes the exact request it filed.
	pub async fn request_cancellable(
		&self,
		invocation_id: Option<Str>,
		reasons: Vec<ApprovalSpec>,
		created_at_ms: u64,
		cancellation: CancellationToken,
	) -> ApprovalTicket {
		let ticket_id = sf!("approval-{}", self.inner.next_id.fetch_add(1, Ordering::Relaxed));
		let mut ticket = ApprovalTicket {
			ticket_id: ticket_id.clone(),
			invocation_id,
			reasons,
			state: TicketState::Pending,
			decision: None,
			created_at_ms,
		};
		let (reply, response) = flume::bounded(1);
		self
			.inner
			.pending
			.lock()
			.insert(ticket_id.clone(), PendingRequest {
				ticket: ticket.clone(),
				reply:  reply.clone(),
			});
		let _guard =
			PendingGuard { inner: Arc::clone(&self.inner), ticket_id: ticket_id.clone() };
		let timeout_ms = ticket
			.reasons
			.iter()
			.map(|reason| reason.timeout_ms)
			.filter(|value| *value != 0)
			.min();
		let filed = std::time::Instant::now();
		if self
			.inner
			.tx
			.deliver(ApprovalRequest { ticket: ticket.clone(), reply })
			.is_err()
		{
			let decision = unreachable_decision(&ticket, "approval host disconnected");
			self
				.inner
				.notify_resolved(&ticket, &decision, filed.elapsed());
			ticket.state = TicketState::Decided;
			ticket.decision = Some(decision);
			self.inner.pending.lock().remove(&ticket_id);
			return ticket;
		}
		self.inner.notify_requested(&ticket);
		let decision = if let Some(timeout_ms) = timeout_ms {
			tokio::select! {
				biased;
				() = cancellation.cancelled() => {
					unreachable_decision(&ticket, "approval request cancelled")
				},
				result = time::timeout(Duration::from_millis(timeout_ms), response.recv_async()) => {
					match result {
						Ok(Ok(decision)) => decision,
						Ok(Err(_)) => unreachable_decision(&ticket, "approval host became unreachable"),
						Err(_) => timeout_decision(&ticket),
					}
				},
			}
		} else {
			tokio::select! {
				biased;
				() = cancellation.cancelled() => {
					unreachable_decision(&ticket, "approval request cancelled")
				},
				result = response.recv_async() => result.unwrap_or_else(|_| {
					unreachable_decision(&ticket, "approval host became unreachable")
				}),
			}
		};
		self.inner.pending.lock().remove(&ticket_id);
		self
			.inner
			.notify_resolved(&ticket, &decision, filed.elapsed());
		ticket.state = TicketState::Decided;
		ticket.decision = Some(decision);
		ticket
	}

	/// Returns a currently dispatched prompt.
	#[must_use]
	pub fn ticket(&self, ticket_id: &str) -> Option<ApprovalTicket> {
		self
			.inner
			.pending
			.lock()
			.get(ticket_id)
			.map(|pending| pending.ticket.clone())
	}

	/// Returns every currently dispatched prompt in filing order.
	#[must_use]
	pub fn pending(&self) -> Vec<ApprovalTicket> {
		self
			.inner
			.pending
			.lock()
			.values()
			.map(|request| request.ticket.clone())
			.filter(|ticket| ticket.state == TicketState::Pending)
			.collect()
	}

	/// Sends a decision to a currently dispatched prompt.
	pub fn decide(&self, ticket_id: &str, decision: ApprovalDecision) -> Option<ApprovalTicket> {
		let mut pending = self.inner.pending.lock();
		let request = pending.get_mut(ticket_id)?;
		if request.reply.try_send(decision.clone()).is_err() {
			return Some(request.ticket.clone());
		}
		request.ticket.state = TicketState::Decided;
		request.ticket.decision = Some(decision);
		Some(request.ticket.clone())
	}
}

pub(crate) fn timeout_decision(ticket: &ApprovalTicket) -> ApprovalDecision {
	let mut defaults = ticket.reasons.iter().map(|reason| reason.default);
	let first = defaults.next().flatten();
	let approved = first.is_some() && defaults.all(|value| value == first) && first == Some(true);
	ApprovalDecision {
		approved,
		scope: ApprovalScope::Once,
		source: ApprovalSource::Timeout,
		decided_by: None,
		reason: Some(sf!("approval request timed out")),
		audited: approved,
	}
}

pub(crate) fn unreachable_decision(
	ticket: &ApprovalTicket,
	reason: &'static str,
) -> ApprovalDecision {
	let approved = !ticket.reasons.is_empty()
		&& ticket
			.reasons
			.iter()
			.all(|spec| matches!(spec.unreachable.as_str(), "allow" | "approve" | "fail_open"));
	ApprovalDecision {
		approved,
		scope: ApprovalScope::Once,
		source: ApprovalSource::Unavailable,
		decided_by: None,
		reason: Some(Str::new_static(reason)),
		audited: approved,
	}
}
