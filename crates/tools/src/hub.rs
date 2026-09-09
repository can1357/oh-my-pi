//! Unified peer, job, and environment-owned named-process coordination.

use std::{collections::BTreeMap, future::Future, sync::Arc};

use async_stream::stream;
use dashmap::DashMap;
use futures::Stream;
use omp_core::{Str, sf};
use omp_tool::{
	Abort, ArgIssue, ArgIssueKind, Constraint, Effects, Ev, IncomingParams, ParamError, Part,
	PromptCaps, Rev, Tool, ToolSpec, ToolTerminal,
};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

const DESCRIPTION: &str = "Coordinates peer agents, detached jobs, and project-scoped named \
                           processes. Peer operations use `to`; process operations use `name`. \
                           `wait` races every selected source and returns the first peer message \
                           or settled job without consuming unrelated events.";
/// Default model-facing peer roster page size.
pub const DEFAULT_LIST_LIMIT: usize = 32;
/// Maximum model-facing peer roster page size.
pub const MAX_LIST_LIMIT: usize = 100;

/// Hub operation vocabulary.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Op {
	/// Send peer text or process input.
	Send,
	/// Wait for peer, job, process, or timeout events.
	Wait,
	/// Drain or peek peer messages.
	Inbox,
	/// List addressable peer agents.
	List,
	/// Snapshot detached jobs.
	Jobs,
	/// Cancel selected jobs.
	Cancel,
	/// Start one named process.
	Start,
	/// List named processes.
	Ps,
	/// Read or follow process output.
	Logs,
	/// Stop one named process.
	Stop,
	/// Restart one named process.
	Restart,
	/// Describe one named process.
	Describe,
}
/// Lifecycle filter accepted by `hub list`.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum ListStatus {
	/// Include only agents with an active turn.
	Running,
	/// Include only live agents waiting for work.
	Idle,
	/// Include only journal-backed parked agents.
	Parked,
}

/// Environment process restart policy.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RestartPolicy {
	/// Never restart automatically.
	No,
	/// Restart only after failure.
	OnFailure,
	/// Restart after every exit.
	Always,
}

/// Named signal accepted by the environment process supervisor.
#[derive(Clone, Copy, Debug, Deserialize, Eq, JsonSchema, PartialEq, Serialize)]
#[serde(rename_all = "SCREAMING_SNAKE_CASE")]
pub enum Signal {
	/// Interrupt.
	Sigint,
	/// Graceful termination.
	Sigterm,
	/// Hangup.
	Sighup,
	/// Quit.
	Sigquit,
	/// Forced termination.
	Sigkill,
}

/// Combined log and TCP readiness criteria.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Ready {
	/// Regex matched against combined process output.
	pub log:     Option<Str>,
	/// TCP port that must accept connections.
	pub port:    Option<u16>,
	/// TCP readiness host, defaulting to `127.0.0.1`.
	pub host:    Option<Str>,
	/// Readiness deadline in seconds.
	pub timeout: Option<f64>,
}

/// Model arguments for `hub@1`.
#[derive(Clone, Debug, Deserialize, JsonSchema, PartialEq, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Params {
	/// Operation to perform.
	pub op:          Op,
	/// Peer recipient or `all`.
	pub to:          Option<Str>,
	/// Peer message body.
	pub message:     Option<Str>,
	/// Prior peer message ID being answered.
	#[serde(rename = "replyTo")]
	pub reply_to:    Option<Str>,
	/// Block for the recipient's threaded reply.
	///
	/// A terminal recipient turn without a matching reply settles promptly with
	/// a stopped-without-replying note.
	#[serde(rename = "await", default)]
	pub await_reply: bool,
	/// Only accept a peer message from this sender.
	#[serde(rename = "from")]
	pub from_peer:   Option<Str>,
	/// Job IDs selected for wait or cancellation.
	pub ids:         Option<Vec<Str>>,
	/// Explicit timeout in milliseconds; zero means infinite.
	#[serde(rename = "timeoutMs")]
	pub timeout_ms:  Option<u64>,
	/// Inspect inbox without consuming it.
	#[serde(default)]
	pub peek:        bool,
	/// Agent lifecycle filter for `list`; omitted means running plus idle.
	pub status:      Option<ListStatus>,
	/// Maximum peer rows returned by `list`.
	pub limit:       Option<u16>,
	/// Stable process name.
	pub name:        Option<Str>,
	/// Process executable.
	pub application: Option<Str>,
	/// Process argv.
	pub args:        Option<Vec<Str>>,
	/// Process environment.
	pub env:         Option<BTreeMap<Str, Str>>,
	/// Process working directory.
	pub cwd:         Option<Str>,
	/// Allocate an interactive PTY.
	pub pty:         Option<bool>,
	/// Readiness criteria.
	pub ready:       Option<Ready>,
	/// Automatic restart policy.
	pub restart:     Option<RestartPolicy>,
	/// Keep the process beyond the last session handle.
	#[serde(default)]
	pub persist:     bool,
	/// Keep the process beyond environment shutdown; implies persist and
	/// disables PTY.
	#[serde(default)]
	pub detached:    bool,
	/// Log line limit.
	pub lines:       Option<u16>,
	/// Return logs from the beginning.
	#[serde(default)]
	pub head:        bool,
	/// Regex log filter.
	pub grep:        Option<Str>,
	/// Output sequence cursor.
	pub cursor:      Option<u64>,
	/// Follow output after the current cursor.
	#[serde(default)]
	pub follow:      bool,
	/// Process lifecycle target (`ready` or `exit`).
	///
	/// Each wait is fenced to the named process generation observed when the
	/// call starts; a restart settles the wait instead of following the
	/// replacement.
	#[serde(rename = "for")]
	pub wait_for:    Option<Str>,
	/// Output regex taking precedence over lifecycle target.
	pub pattern:     Option<Str>,
	/// Process stdin text.
	pub text:        Option<Str>,
	/// Append Enter after process stdin text.
	pub enter:       Option<bool>,
	/// Named control keys.
	pub keys:        Option<Vec<Str>>,
	/// OS process-group signal.
	pub signal:      Option<Signal>,
	/// Process-operation timeout in seconds.
	pub timeout:     Option<f64>,
}

/// Validated hub request handed to the app-owned broker/process composition.
#[derive(Clone, Debug, PartialEq)]
pub struct Request {
	/// Normalized model arguments.
	pub params: Params,
}

/// Backend response and wait-frame displacement metadata.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Response {
	/// Model-facing response text.
	pub text:    Str,
	/// Whether a stale wait frame may be displaced by a later wait.
	pub useless: bool,
}

/// Stable failure returned by the composed hub backend.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize, thiserror::Error)]
#[error("{message}")]
pub struct Fault {
	/// Stable model-facing explanation.
	pub message: Str,
}

/// Injected host composition over authoritative session trees, the runtime job
/// index, and the environment process host.
///
/// Peer and job implementations must read `<meta><jobs>` and write peer
/// messages as target-session `<queues><steering>` patches. The backend may
/// cache handles for execution, but must rebuild that index from the DOM after
/// open or rewind; it must not maintain a second durable peer/job registry.
///
/// `execute` owns the multi-source wait race. It must check the bounded inbox
/// before subscribing, preserve unrelated FIFO messages, prioritize a peer
/// message racing job settlement, and keep `timeout_ms == Some(0)` infinite.
/// Process starts must observe every readiness criterion before reporting
/// ready. The env wire remains singular: when both log and TCP are requested,
/// the backend waits for the log probe first and then the TCP probe; both must
/// pass. A successful start must acquire a completion-delivery lease before
/// return; every later process operation reattaches the caller's lease, and a
/// process list with no owned live process may release it without dropping
/// queued facts.
pub trait HubBackend: Send + Sync + 'static {
	/// Executes one fully validated request for an authenticated invocation
	/// owner. The backend resolves that owner to its session queues, DOM-derived
	/// job board, completion lease, and environment process client.
	fn execute<'a>(
		&'a self,
		caller_id: &'a str,
		request: Request,
		updates: &'a flume::Sender<Response>,
	) -> impl Future<Output = Result<Response, Fault>> + Send + 'a;
}

/// Shared global-registry router for per-owner hub compositions.
///
/// The production registry owns one router. Agent/session composition attaches
/// one concrete backend under the authenticated invocation owner and removes it
/// when that owner retires.
pub struct HubRouter<B> {
	backends: DashMap<Str, Arc<B>>,
}

impl<B> HubRouter<B> {
	/// Creates an empty owner router.
	pub fn new() -> Self {
		Self { backends: DashMap::new() }
	}

	/// Installs or replaces one authenticated owner's composition.
	pub fn attach(&self, owner: Str, backend: Arc<B>) -> Option<Arc<B>> {
		self.backends.insert(owner, backend)
	}

	/// Removes one owner without disturbing other sessions.
	pub fn detach(&self, owner: &str) -> Option<Arc<B>> {
		self.backends.remove(owner).map(|(_, backend)| backend)
	}

	/// Returns whether an owner currently has a routed composition.
	pub fn contains(&self, owner: &str) -> bool {
		self.backends.contains_key(owner)
	}
}

impl<B> Default for HubRouter<B> {
	fn default() -> Self {
		Self::new()
	}
}

impl<B: HubBackend> HubBackend for HubRouter<B> {
	async fn execute<'a>(
		&'a self,
		caller_id: &'a str,
		request: Request,
		updates: &'a flume::Sender<Response>,
	) -> Result<Response, Fault> {
		let backend = self
			.backends
			.get(caller_id)
			.map(|entry| Arc::clone(&entry))
			.ok_or_else(|| Fault {
				message: sf!("hub owner '{caller_id}' is not attached; the session may have retired"),
			})?;
		backend.execute(caller_id, request, updates).await
	}
}

/// Unified hub tool over an injected app-owned backend.
pub struct Hub<B> {
	backend: B,
	spec:    ToolSpec,
}

/// Returns the canonical `hub@2` declaration shared by registry advertisement
/// and session-owned execution.
#[must_use]
pub fn spec() -> ToolSpec {
	ToolSpec {
		name:            sf!("hub"),
		rev:             Rev { family: Default::default(), n: 2 },
		description:     sf!(DESCRIPTION),
		schema:          omp_tool::schema::<Params>(),
		constraint:      Constraint::Schema {
			priority:       100,
			on_unsupported: omp_tool::Fallback::Unspecified,
		},
		effects:         Effects::default(),
		projection_code: omp_tool::native_projection_code(
			env!("CARGO_PKG_NAME"),
			env!("CARGO_PKG_VERSION"),
			include_bytes!("hub.rs"),
		)
		.into(),
	}
}

/// Constructs `hub@2` over the per-agent broker/process composition.
pub fn tool<B: HubBackend>(backend: B) -> Hub<B> {
	Hub { backend, spec: spec() }
}

impl<B: HubBackend> Tool for Hub<B> {
	type Fault = Fault;
	type Params = Params;
	type Payload = Response;
	type Update = Response;

	fn spec(&self) -> &ToolSpec {
		&self.spec
	}

	fn call<'c>(
		&'c self,
		mut params: IncomingParams<'c>,
	) -> impl Stream<Item = Ev<Self::Update, Self::Payload, Self::Fault>> + Send + 'c {
		stream! {
			let Some(caller_id) = params.owner().cloned() else {
				yield done(Err(invalid("hub requires an authenticated invocation owner")), false);
				return;
			};
			let arguments = match params.whole::<Params>().await {
				Ok(arguments) => arguments,
				Err(error) => { yield param_event(error); return; },
			};
			let request = match validate(arguments, &caller_id) {
				Ok(request) => request,
				Err(fault) => { yield done(Err(fault), false); return; },
			};
			if let Err(error) = params.interruptable().committed().await {
				yield commit_event(error);
				return;
			}
			let (updates_tx, updates_rx) = flume::bounded(1);
			let execution = self.backend.execute(&caller_id, request, &updates_tx);
			tokio::pin!(execution);
			loop {
				let next = tokio::select! {
					biased;
					result = &mut execution => Ok(result),
					update = updates_rx.recv_async() => Err(update),
				};
				match next {
					Ok(Ok(response)) => {
						let useless = response.useless;
						yield done(Ok(response), useless);
						break;
					},
					Ok(Err(fault)) => {
						yield done(Err(fault), false);
						break;
					},
					Err(Ok(update)) => yield Ev::Update(update),
					Err(Err(_)) => continue,
				}
			}
		}
	}

	fn prompt(&self, view: Result<&Response, &Fault>, _: &PromptCaps) -> Vec<Part> {
		vec![Part::Text {
			text: match view {
				Ok(response) => response.text.clone(),
				Err(fault) => fault.message.clone(),
			},
		}]
	}
}

/// Validates cross-field operation contracts and normalizes detached starts.
pub fn validate(mut params: Params, caller_id: &str) -> Result<Request, Fault> {
	match params.op {
		Op::Send if params.to.is_some() && params.name.is_some() => {
			return Err(invalid("send accepts exactly one of `to` or `name`"));
		},
		Op::Send if params.to.is_none() && params.name.is_none() => {
			return Err(invalid("send requires `to` for peers or `name` for a process"));
		},
		Op::Send
			if params
				.to
				.as_deref()
				.is_some_and(|to| to.eq_ignore_ascii_case(caller_id)) =>
		{
			return Err(invalid("cannot send a hub message to the calling agent"));
		},
		Op::Send if params.await_reply && params.to.as_deref() == Some("all") => {
			return Err(invalid("broadcast send cannot await a reply"));
		},
		Op::Send if params.to.is_some() && params.message.as_deref().is_none_or(str::is_empty) => {
			return Err(invalid("peer send requires a non-empty `message`"));
		},
		Op::Send
			if params.name.is_some()
				&& params.text.is_none()
				&& params.keys.as_ref().is_none_or(Vec::is_empty)
				&& params.signal.is_none() =>
		{
			return Err(invalid("process send requires `text`, `keys`, or `signal`"));
		},
		Op::Start => {
			let name = params.name.as_deref().unwrap_or_default();
			if name.is_empty() || name.len() > 48 || !name.bytes().all(valid_name_byte) {
				return Err(invalid(
					"start requires a 1-48 character alphanumeric/dot/underscore/hyphen `name`",
				));
			}
			if params.application.as_deref().is_none_or(str::is_empty) {
				return Err(invalid("start requires non-empty `application`"));
			}
			if let Some(ready) = &params.ready {
				if ready.log.is_none() && ready.port.is_none() {
					return Err(invalid("ready requires at least `log` or `port`"));
				}
				if ready
					.timeout
					.is_some_and(|timeout| !timeout.is_finite() || timeout <= 0.0)
				{
					return Err(invalid("ready.timeout must be a positive finite number"));
				}
			}
			if params.detached {
				params.persist = true;
				params.pty = Some(false);
			}
		},
		Op::Wait
			if params.name.is_some() && params.ids.as_ref().is_some_and(|ids| !ids.is_empty()) =>
		{
			return Err(invalid("wait accepts a process `name` or job `ids`, not both"));
		},
		Op::Wait
			if params
				.wait_for
				.as_deref()
				.is_some_and(|target| target != "ready" && target != "exit") =>
		{
			return Err(invalid("wait `for` must be `ready` or `exit`"));
		},
		Op::Wait
			if params.name.is_none() && (params.wait_for.is_some() || params.pattern.is_some()) =>
		{
			return Err(invalid("process wait fields require `name`"));
		},
		Op::Logs | Op::Stop | Op::Restart | Op::Describe if params.name.is_none() => {
			return Err(invalid("process operation requires `name`"));
		},
		Op::Cancel if params.ids.as_ref().is_none_or(Vec::is_empty) => {
			return Err(invalid("cancel requires non-empty `ids`"));
		},
		_ => {},
	}
	if params
		.lines
		.is_some_and(|lines| lines == 0 || lines > 1_000)
	{
		return Err(invalid("logs `lines` must be between 1 and 1000"));
	}
	if params
		.limit
		.is_some_and(|limit| limit == 0 || usize::from(limit) > MAX_LIST_LIMIT)
	{
		return Err(invalid("list `limit` must be between 1 and 100"));
	}
	if params
		.timeout
		.is_some_and(|timeout| !timeout.is_finite() || timeout <= 0.0)
	{
		return Err(invalid("process timeout must be a positive finite number"));
	}
	if params.grep.as_deref().is_some_and(str::is_empty)
		|| params.pattern.as_deref().is_some_and(str::is_empty)
	{
		return Err(invalid("log and wait patterns must be non-empty"));
	}
	Ok(Request { params })
}

const fn valid_name_byte(byte: u8) -> bool {
	byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-')
}

const fn invalid(message: &'static str) -> Fault {
	Fault { message: sf!(message) }
}

const fn done(result: Result<Response, Fault>, useless: bool) -> Ev<Response, Response, Fault> {
	Ev::Done(ToolTerminal::Done { result, useless })
}
fn param_event(error: ParamError) -> Ev<Response, Response, Fault> {
	match error {
		ParamError::Args(issue) => Ev::Args(*issue),
		ParamError::Interrupted(interrupt) => {
			Ev::Aborted(Abort::Interrupted { reason: interrupt.reason })
		},
		ParamError::Protocol(message) => Ev::Args(protocol_issue(message)),
	}
}

fn commit_event(error: omp_tool::CommitError) -> Ev<Response, Response, Fault> {
	match error {
		omp_tool::CommitError::Aborted => Ev::Aborted(Abort::InputDropped),
		omp_tool::CommitError::Interrupted(interrupt) => {
			Ev::Aborted(Abort::Interrupted { reason: interrupt.reason })
		},
		omp_tool::CommitError::Protocol(message) => Ev::Args(protocol_issue(message)),
	}
}

fn protocol_issue(message: Str) -> ArgIssue {
	ArgIssue {
		path:     Vec::new(),
		expected: sf!("one committed hub@2 argument object"),
		kind:     ArgIssueKind::Protocol,
		example:  Some(sf!(r#"{{"op":"list"}}"#)),
		found:    Some(message),
	}
}

#[cfg(test)]
mod tests {
	use std::collections::BTreeMap;

	use super::{ListStatus, Op, Params, Ready, RestartPolicy, validate};

	fn params(op: Op) -> Params {
		Params {
			op,
			to: None,
			message: None,
			reply_to: None,
			await_reply: false,
			from_peer: None,
			ids: None,
			timeout_ms: None,
			peek: false,
			status: None,
			limit: None,
			name: None,
			application: None,
			args: None,
			env: None::<BTreeMap<_, _>>,
			cwd: None,
			pty: None,
			ready: None,
			restart: None,
			persist: false,
			detached: false,
			lines: None,
			head: false,
			grep: None,
			cursor: None,
			follow: false,
			wait_for: None,
			pattern: None,
			text: None,
			enter: None,
			keys: None,
			signal: None,
			timeout: None,
		}
	}

	#[test]
	fn rejects_self_send_and_broadcast_await() {
		let mut self_send = params(Op::Send);
		self_send.to = Some("Agent7".into());
		self_send.message = Some("hello".into());
		assert!(validate(self_send, "agent7").is_err());
		let mut broadcast = params(Op::Send);
		broadcast.to = Some("all".into());
		broadcast.message = Some("hello".into());
		broadcast.await_reply = true;
		assert!(validate(broadcast, "main").is_err());
	}

	#[test]
	fn detached_start_normalizes_persist_and_pty() {
		let mut start = params(Op::Start);
		start.name = Some("web".into());
		start.application = Some("bun".into());
		start.detached = true;
		start.pty = Some(true);
		start.restart = Some(RestartPolicy::OnFailure);
		start.ready = Some(Ready {
			log:     Some("ready".into()),
			port:    Some(3000),
			host:    None,
			timeout: Some(30.0),
		});
		let normalized = validate(start, "main").unwrap().params;
		assert!(normalized.persist);
		assert_eq!(normalized.pty, Some(false));
	}

	#[test]
	fn wait_preserves_zero_as_infinite() {
		let mut wait = params(Op::Wait);
		wait.timeout_ms = Some(0);
		assert_eq!(validate(wait, "main").unwrap().params.timeout_ms, Some(0));
	}
	#[test]
	fn list_limit_is_bounded() {
		let mut list = params(Op::List);
		list.status = Some(ListStatus::Parked);
		list.limit = Some(100);
		assert!(validate(list.clone(), "main").is_ok());
		list.limit = Some(101);
		assert!(validate(list, "main").is_err());
	}

	#[test]
	fn every_hub_operation_has_a_valid_branch() {
		let mut send_peer = params(Op::Send);
		send_peer.to = Some("peer".into());
		send_peer.message = Some("hello".into());
		assert!(validate(send_peer, "main").is_ok());

		let mut send_process = params(Op::Send);
		send_process.name = Some("proc".into());
		send_process.text = Some("status".into());
		assert!(validate(send_process, "main").is_ok());

		assert!(validate(params(Op::Wait), "main").is_ok());
		assert!(validate(params(Op::Inbox), "main").is_ok());
		assert!(validate(params(Op::List), "main").is_ok());
		assert!(validate(params(Op::Jobs), "main").is_ok());
		let mut cancel = params(Op::Cancel);
		cancel.ids = Some(vec!["job-1".into()]);
		assert!(validate(cancel, "main").is_ok());

		let mut start = params(Op::Start);
		start.name = Some("proc".into());
		start.application = Some("echo".into());
		assert!(validate(start, "main").is_ok());
		assert!(validate(params(Op::Ps), "main").is_ok());
		for op in [Op::Logs, Op::Stop, Op::Restart, Op::Describe] {
			let mut request = params(op);
			request.name = Some("proc".into());
			assert!(validate(request, "main").is_ok());
		}
	}

	#[test]
	fn process_wait_contract_rejects_shadowed_routes() {
		let mut mixed = params(Op::Wait);
		mixed.name = Some("proc".into());
		mixed.ids = Some(vec!["job-1".into()]);
		assert!(validate(mixed, "main").is_err());

		let mut bad_target = params(Op::Wait);
		bad_target.name = Some("proc".into());
		bad_target.wait_for = Some("running".into());
		assert!(validate(bad_target, "main").is_err());

		let mut valid = params(Op::Wait);
		valid.name = Some("proc".into());
		valid.wait_for = Some("ready".into());
		assert!(validate(valid, "main").is_ok());
	}
}
