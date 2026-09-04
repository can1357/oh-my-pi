//! Process-local owner for replica-backed collaboration relay sessions.

use std::{collections::BTreeMap, time::Duration};

use bytes::Bytes;
use omp_collab::{
	PROTOCOL_REVISION,
	codec::RelayRoute,
	host::{
		AuthenticatedPeer, AuthorizedMutation, HostAdmission, HostUiAnswer, HostUiBeginError,
		HostUiDispatcher,
	},
	link::{CollabLink, HostedRoom, RelayEndpoint},
	presence::{CollabRole, ConnectionState, PresenceFacts},
	relay::{Handshake, RelayClient, RelayInbound, RelayRole, SendDisposition},
};
use omp_core::{Str, base64_url};
use omp_dom::{Dom, Event, Snapshot, SnapshotDecodeError};
use omp_journal::EntryId;
use omp_proto::collab::v1::{
	AbortRequest, AgentCommand, AgentViewCancel, AgentViewEnd, AgentViewEvent, AgentViewRequest,
	AgentViewSnapshot, CollabFrame, ErrorMessage, Hello, ImageAttachment, JournalRecord,
	Participant, PromptRequest, RegistrySnapshot, SessionHeader, SessionStateUpdate, SnapshotChunk,
	UiRequest, UiResponse, VisibilityClass, Welcome, collab_frame,
};
use serde::Deserialize;
use serde_json::value::RawValue;
use tokio::{sync::watch, task::JoinHandle};
use tokio_util::sync::CancellationToken;

use super::observer::{
	AgentViewFailureCode, HostAgentBridge, RemoteAgentView, RemoteAgentViewError, registry_snapshot,
};

const INITIAL_HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(30);
const SNAPSHOT_CHUNK_BYTES: usize = 256 * 1024;
const SNAPSHOT_CHUNK_MAX_COUNT: usize = 256;
const SNAPSHOT_MAX_BYTES: usize = SNAPSHOT_CHUNK_BYTES * SNAPSHOT_CHUNK_MAX_COUNT;
const AGENT_VIEW_SNAPSHOT_MAX_BYTES: usize = 16 * 1024 * 1024;
const AGENT_VIEW_REQUEST_CAP: usize = 32;
const AGENT_VIEW_EVENT_CAP: usize = 256;
const HOST_UI_REQUEST_CAP: usize = 16;

/// One operation serialized through the collaboration owner.
#[derive(Clone)]
pub enum CollabOwnerCommand {
	/// Host a generated room and begin broadcasting this session's snapshot and
	/// ordered patch stream.
	Start {
		/// Validated relay origin.
		relay:    RelayEndpoint,
		/// Race-free session snapshot captured with `events`.
		snapshot: Snapshot,
		/// Events following `snapshot` in journal order.
		events:   flume::Receiver<Event>,
		/// Controller-owned child transcript subscription authority.
		agents:   HostAgentBridge,
	},
	/// Join a parsed room link under the resolved local identity.
	Join {
		/// Parsed room endpoint and credentials.
		link:         CollabLink,
		/// Local participant name.
		display_name: Str,
	},
	/// Submit a prompt through the authenticated host controller.
	Prompt {
		/// User-authored text.
		text:   Str,
		/// Inline images transported to the host's blob authority.
		images: Vec<ImageAttachment>,
	},
	/// Interrupt the host's active generation.
	Abort,
	/// Control one host-visible agent.
	Agent(AgentCommand),
	/// Answer a host-owned UI request.
	UiResponse(UiResponse),
	/// Leave or close the active room.
	Leave,
	/// Broadcast one host-owned UI request to writable guests.
	HostUi {
		/// Select/editor specification; the owner assigns its correlation id.
		request: UiRequest,
		/// Cancellation for the originating local dialog/request.
		cancel:  CancellationToken,
		/// First remote answer, or a typed unavailability.
		answer:  flume::Sender<Result<HostUiAnswer, HostUiRequestError>>,
	},
	/// Subscribe to a host agent as a remote actor.
	ObserveAgent {
		/// Stable host agent id.
		agent_id: Str,
		/// Correlated snapshot-plus-events result.
		reply:    flume::Sender<Result<RemoteAgentView, RemoteAgentViewError>>,
	},
	/// Read the current room state.
	Status,
}

/// Host dialog broadcast failure.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum HostUiRequestError {
	/// The active room is not a host.
	#[error("collaboration UI broadcast requires a host connection")]
	NotHost,
	/// No writable guest is connected.
	#[error("no writable collaboration peer is connected")]
	Unavailable,
	/// The request exceeds the bounded collaboration frame budget.
	#[error("collaboration UI request is too large")]
	TooLarge,
	/// The bounded request correlation table is full.
	#[error("collaboration UI request capacity is exhausted")]
	Capacity,
	/// The originating request was cancelled.
	#[error("collaboration UI request was cancelled")]
	Cancelled,
	/// The relay owner stopped before an answer arrived.
	#[error("collaboration UI request owner stopped")]
	OwnerStopped,
}

/// Settled collaboration command result.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct CollabCommandResult {
	/// Current presence facts.
	pub presence:    Option<PresenceFacts>,
	/// Writable guest link while hosting.
	pub editor_link: Option<Str>,
	/// Read-only guest link while hosting.
	pub viewer_link: Option<Str>,
}

/// Collaboration owner failure.
#[derive(Debug, thiserror::Error)]
pub enum CollabCommandFault {
	/// Owner task has stopped.
	#[error("collaboration owner stopped")]
	OwnerStopped,
	/// Relay operation failed.
	#[error("collaboration relay failed")]
	Relay(#[from] omp_collab::relay::RelayError),
	/// Room key was invalid.
	#[error("collaboration room key was invalid")]
	Crypto(#[from] omp_collab::crypto::CryptoError),
	/// Snapshot or patch projection failed.
	#[error("collaboration replication projection failed")]
	Projection(#[from] serde_json::Error),
	/// A replica snapshot was malformed or internally inconsistent.
	#[error("collaboration replica snapshot was invalid")]
	Snapshot(#[from] SnapshotDecodeError),
	/// A replicated DOM event could not be applied.
	#[error("collaboration replica event was invalid")]
	Dom(#[from] omp_dom::DomError),
	/// The host did not complete the welcome and snapshot handshake in time.
	#[error("collaboration host handshake timed out")]
	HandshakeTimeout,
	/// The host refused the guest handshake.
	#[error("collaboration host refused the guest handshake")]
	HandshakeRefused,
	/// The host welcome did not include a complete DOM snapshot.
	#[error("collaboration host welcome omitted the session snapshot")]
	MissingSnapshot,
	/// A DOM snapshot fragment was not a valid authenticated chunk.
	#[error("collaboration host sent an invalid session snapshot fragment")]
	InvalidSnapshotFragment,
	/// A snapshot exceeded the bounded in-memory replica budget.
	#[error("collaboration snapshot uses {actual} bytes; maximum is {maximum}")]
	SnapshotTooLarge {
		/// Observed byte count.
		actual:  usize,
		/// Maximum accepted byte count.
		maximum: usize,
	},
	/// A local mutation was attempted from a read-only guest link.
	#[error("collaboration link is read-only")]
	ReadOnly,
	/// No room is active.
	#[error("not joined to a collaboration room")]
	NotJoined,
	/// This operation is available only while joined as a guest.
	#[error("collaboration operation requires a guest connection")]
	NotGuest,
	/// This operation is available only while hosting.
	#[error("collaboration operation requires a host connection")]
	NotHost,
	/// A bounded collaboration request queue is full.
	#[error("collaboration request capacity is exhausted")]
	RequestCapacity,
	/// The relay did not confirm delivery of a guest mutation.
	#[error("collaboration mutation was not delivered while the relay was connected")]
	MutationNotDelivered,
}

struct Request {
	command: CollabOwnerCommand,
	reply:   flume::Sender<Result<CollabCommandResult, CollabCommandFault>>,
}

/// Cloneable command, presence, replica, and admitted-mutation projection.
#[derive(Clone)]
pub struct CollabCommandHandle {
	commands:         flume::Sender<Request>,
	presence:         watch::Receiver<Option<PresenceFacts>>,
	state:            watch::Receiver<Option<SessionStateUpdate>>,
	agents:           watch::Receiver<RegistrySnapshot>,
	host_state:       watch::Sender<SessionStateUpdate>,
	replica:          watch::Receiver<Option<Snapshot>>,
	replica_events:   flume::Receiver<Event>,
	remote_ui:        flume::Receiver<RemoteUiRequest>,
	remote_mutations: flume::Receiver<AuthorizedMutation>,
}

impl CollabCommandHandle {
	/// Requests one serialized owner operation.
	pub async fn request(
		&self,
		command: CollabOwnerCommand,
	) -> Result<CollabCommandResult, CollabCommandFault> {
		let (reply, result) = flume::bounded(1);
		self
			.commands
			.send_async(Request { command, reply })
			.await
			.map_err(|_| CollabCommandFault::OwnerStopped)?;
		result
			.recv_async()
			.await
			.map_err(|_| CollabCommandFault::OwnerStopped)?
	}

	/// Returns current presence facts.
	#[must_use]
	pub fn presence(&self) -> Option<PresenceFacts> {
		*self.presence.borrow()
	}

	/// Subscribes to presence changes.
	#[must_use]
	pub fn subscribe_presence(&self) -> watch::Receiver<Option<PresenceFacts>> {
		self.presence.clone()
	}

	/// Returns the latest authoritative session state received from the host.
	#[must_use]
	pub fn state(&self) -> Option<SessionStateUpdate> {
		self.state.borrow().clone()
	}

	/// Subscribes to authoritative session-state changes.
	#[must_use]
	pub fn subscribe_state(&self) -> watch::Receiver<Option<SessionStateUpdate>> {
		self.state.clone()
	}

	/// Returns the latest host agent-registry projection.
	#[must_use]
	pub fn agents(&self) -> RegistrySnapshot {
		self.agents.borrow().clone()
	}

	/// Subscribes to host agent-registry projection changes.
	#[must_use]
	pub fn subscribe_agents(&self) -> watch::Receiver<RegistrySnapshot> {
		self.agents.clone()
	}

	/// Opens one remote child through the same detached actor contract as a
	/// local child inspector.
	pub async fn observe_agent(
		&self,
		agent_id: impl Into<Str>,
	) -> Result<RemoteAgentView, RemoteAgentViewError> {
		let (reply, result) = flume::bounded(1);
		self
			.request(CollabOwnerCommand::ObserveAgent { agent_id: agent_id.into(), reply })
			.await
			.map_err(|error| match error {
				CollabCommandFault::RequestCapacity => RemoteAgentViewError::Capacity,
				CollabCommandFault::NotJoined | CollabCommandFault::NotGuest => {
					RemoteAgentViewError::NotGuest
				},
				_ => RemoteAgentViewError::Disconnected,
			})?;
		result
			.recv_async()
			.await
			.unwrap_or(Err(RemoteAgentViewError::Disconnected))
	}

	/// Broadcasts a host-owned UI request; the first writable response wins.
	pub async fn request_guest_ui(
		&self,
		request: UiRequest,
		cancel: CancellationToken,
	) -> Result<HostUiAnswer, HostUiRequestError> {
		let (answer, settled) = flume::bounded(1);
		self
			.request(CollabOwnerCommand::HostUi { request, cancel, answer })
			.await
			.map_err(|error| match error {
				CollabCommandFault::NotJoined | CollabCommandFault::NotHost => {
					HostUiRequestError::NotHost
				},
				CollabCommandFault::RequestCapacity => HostUiRequestError::Capacity,
				_ => HostUiRequestError::OwnerStopped,
			})?;
		settled
			.recv_async()
			.await
			.unwrap_or(Err(HostUiRequestError::OwnerStopped))
	}

	/// Replaces the host's locally projected session state.
	///
	/// Presence membership is owned by the relay task and is merged into this
	/// projection before it is published locally or sent to guests.
	pub fn publish_state(&self, state: SessionStateUpdate) {
		if *self.host_state.borrow() != state {
			self.host_state.send_replace(state);
		}
	}

	/// Returns the host's latest locally projected session state.
	#[must_use]
	pub fn published_state(&self) -> SessionStateUpdate {
		self.host_state.borrow().clone()
	}

	/// Returns the latest complete guest replica snapshot.
	#[must_use]
	pub fn replica_snapshot(&self) -> Option<Snapshot> {
		self.replica.borrow().clone()
	}

	/// Returns the single ordered queue of post-snapshot replica events.
	///
	/// The app controller must create one receiver and retain it for its
	/// lifetime. Clones compete for delivery and therefore are not actor
	/// subscriptions.
	#[must_use]
	pub fn replica_events(&self) -> flume::Receiver<Event> {
		self.replica_events.clone()
	}

	/// Returns the guest actor's bounded host-dialog queue.
	///
	/// Exactly one actor should retain this receiver. Answer through
	/// [`CollabOwnerCommand::UiResponse`].
	#[must_use]
	pub fn remote_ui_requests(&self) -> flume::Receiver<RemoteUiRequest> {
		self.remote_ui.clone()
	}

	/// Returns the host controller's authenticated remote-mutation queue.
	///
	/// Every item was admitted against the room's write token before entering
	/// this queue.
	#[must_use]
	pub fn remote_mutations(&self) -> flume::Receiver<AuthorizedMutation> {
		self.remote_mutations.clone()
	}
}

struct Outbound {
	frame: CollabFrame,
	reply: flume::Sender<bool>,
}

/// One host-owned select/editor request delivered to the guest actor.
pub struct RemoteUiRequest {
	/// Correlated request specification.
	pub request: UiRequest,
	/// Cancelled when another peer answers, the host withdraws the request, or
	/// this guest disconnects.
	pub cancel:  CancellationToken,
}

struct AgentViewOpen {
	agent_id: Str,
	reply:    flume::Sender<Result<RemoteAgentView, RemoteAgentViewError>>,
}

struct HostUiOpen {
	request: UiRequest,
	cancel:  CancellationToken,
	answer:  flume::Sender<Result<HostUiAnswer, HostUiRequestError>>,
}

struct HostUiWaiter {
	answer:       flume::Sender<Result<HostUiAnswer, HostUiRequestError>>,
	cancellation: JoinHandle<()>,
}

struct ActiveSession {
	cancel:      CancellationToken,
	task:        JoinHandle<()>,
	presence:    watch::Receiver<Option<PresenceFacts>>,
	outbound:    Option<flume::Sender<Outbound>>,
	agent_views: Option<flume::Sender<AgentViewOpen>>,
	host_ui:     Option<flume::Sender<HostUiOpen>>,
	editor_link: Option<Str>,
	viewer_link: Option<Str>,
}

impl ActiveSession {
	fn result(&self) -> CollabCommandResult {
		CollabCommandResult {
			presence:    *self.presence.borrow(),
			editor_link: self.editor_link.clone(),
			viewer_link: self.viewer_link.clone(),
		}
	}

	async fn close(self) {
		self.cancel.cancel();
		let _ = self.task.await;
	}
}

/// Receiving half retained by the relay lifecycle owner.
pub struct CollabSessionAuthority {
	commands:         flume::Receiver<Request>,
	presence:         watch::Sender<Option<PresenceFacts>>,
	state:            watch::Sender<Option<SessionStateUpdate>>,
	agents:           watch::Sender<RegistrySnapshot>,
	host_state:       watch::Receiver<SessionStateUpdate>,
	replica:          watch::Sender<Option<Snapshot>>,
	replica_events:   flume::Sender<Event>,
	remote_ui:        flume::Sender<RemoteUiRequest>,
	remote_mutations: flume::Sender<AuthorizedMutation>,
}

impl CollabSessionAuthority {
	/// Constructs the collaboration owner.
	#[must_use]
	pub fn new() -> (Self, CollabCommandHandle) {
		let (commands, requests) = flume::bounded(16);
		let (presence, observed) = watch::channel(None);
		let (state, state_observed) = watch::channel(None);
		let (agents, agents_observed) = watch::channel(RegistrySnapshot::default());
		let (host_state, host_state_observed) = watch::channel(SessionStateUpdate::default());
		let (replica, replica_observed) = watch::channel(None);
		let (replica_events, observed_events) = flume::bounded(AGENT_VIEW_EVENT_CAP);
		let (remote_ui, observed_ui) = flume::bounded(HOST_UI_REQUEST_CAP);
		let (remote_mutations, observed_mutations) = flume::bounded(64);
		(
			Self {
				commands: requests,
				presence,
				state,
				agents,
				host_state: host_state_observed,
				replica,
				replica_events,
				remote_ui,
				remote_mutations,
			},
			CollabCommandHandle {
				commands,
				presence: observed,
				state: state_observed,
				agents: agents_observed,
				host_state,
				replica: replica_observed,
				replica_events: observed_events,
				remote_ui: observed_ui,
				remote_mutations: observed_mutations,
			},
		)
	}

	async fn run(self) {
		let mut active: Option<ActiveSession> = None;
		while let Ok(request) = self.commands.recv_async().await {
			let result = match request.command {
				CollabOwnerCommand::Start { relay, snapshot, events, agents } => {
					if let Some(previous) = active.take() {
						previous.close().await;
					}
					self.replica.send_replace(None);
					self.state.send_replace(None);
					self.agents.send_replace(RegistrySnapshot::default());
					match start_host(
						relay,
						snapshot,
						events,
						agents,
						self.presence.clone(),
						self.state.clone(),
						self.agents.clone(),
						self.host_state.clone(),
						self.remote_mutations.clone(),
					)
					.await
					{
						Ok(session) => {
							let result = session.result();
							active = Some(session);
							Ok(result)
						},
						Err(error) => {
							self.presence.send_replace(None);
							self.state.send_replace(None);
							self.agents.send_replace(RegistrySnapshot::default());
							Err(error)
						},
					}
				},
				CollabOwnerCommand::Join { link, display_name } => {
					if let Some(previous) = active.take() {
						previous.close().await;
					}
					self.replica.send_replace(None);
					self.state.send_replace(None);
					self.agents.send_replace(RegistrySnapshot::default());
					match start_guest(
						link,
						display_name,
						self.presence.clone(),
						self.state.clone(),
						self.agents.clone(),
						self.replica.clone(),
						self.replica_events.clone(),
						self.remote_ui.clone(),
					)
					.await
					{
						Ok(session) => {
							let result = session.result();
							active = Some(session);
							Ok(result)
						},
						Err(error) => {
							self.presence.send_replace(None);
							self.state.send_replace(None);
							self.agents.send_replace(RegistrySnapshot::default());
							Err(error)
						},
					}
				},
				CollabOwnerCommand::Prompt { text, images } => {
					send_guest_frame(
						active.as_ref(),
						collab_frame::Payload::Prompt(PromptRequest { text: text.to_string(), images }),
					)
					.await
				},
				CollabOwnerCommand::Abort => {
					send_guest_frame(
						active.as_ref(),
						collab_frame::Payload::Abort(AbortRequest {
							reason: "User interrupt".to_owned(),
						}),
					)
					.await
				},
				CollabOwnerCommand::Agent(command) => {
					send_guest_frame(active.as_ref(), collab_frame::Payload::AgentCommand(command)).await
				},
				CollabOwnerCommand::UiResponse(response) => {
					send_guest_frame(active.as_ref(), collab_frame::Payload::UiResponse(response)).await
				},
				CollabOwnerCommand::HostUi { request, cancel, answer } => {
					enqueue_host_ui(active.as_ref(), request, cancel, answer)
				},
				CollabOwnerCommand::ObserveAgent { agent_id, reply } => {
					enqueue_agent_view(active.as_ref(), agent_id, reply)
				},
				CollabOwnerCommand::Leave => match active.take() {
					Some(session) => {
						session.close().await;
						self.presence.send_replace(None);
						self.state.send_replace(None);
						self.agents.send_replace(RegistrySnapshot::default());
						self.replica.send_replace(None);
						Ok(disconnected_result())
					},
					None => Err(CollabCommandFault::NotJoined),
				},
				CollabOwnerCommand::Status => active
					.as_ref()
					.map(ActiveSession::result)
					.ok_or(CollabCommandFault::NotJoined),
			};
			let _ = request.reply.send(result);
		}
		if let Some(session) = active {
			session.close().await;
		}
	}
}

fn enqueue_host_ui(
	active: Option<&ActiveSession>,
	request: UiRequest,
	cancel: CancellationToken,
	answer: flume::Sender<Result<HostUiAnswer, HostUiRequestError>>,
) -> Result<CollabCommandResult, CollabCommandFault> {
	let active = active.ok_or(CollabCommandFault::NotJoined)?;
	let sender = active.host_ui.as_ref().ok_or(CollabCommandFault::NotHost)?;
	sender
		.try_send(HostUiOpen { request, cancel, answer })
		.map_err(|error| match error {
			flume::TrySendError::Full(open) => {
				let _ = open.answer.try_send(Err(HostUiRequestError::Capacity));
				CollabCommandFault::RequestCapacity
			},
			flume::TrySendError::Disconnected(open) => {
				let _ = open.answer.try_send(Err(HostUiRequestError::OwnerStopped));
				CollabCommandFault::OwnerStopped
			},
		})?;
	Ok(active.result())
}

fn enqueue_agent_view(
	active: Option<&ActiveSession>,
	agent_id: Str,
	reply: flume::Sender<Result<RemoteAgentView, RemoteAgentViewError>>,
) -> Result<CollabCommandResult, CollabCommandFault> {
	let active = active.ok_or(CollabCommandFault::NotJoined)?;
	let sender = active
		.agent_views
		.as_ref()
		.ok_or(CollabCommandFault::NotGuest)?;
	sender
		.try_send(AgentViewOpen { agent_id, reply })
		.map_err(|error| match error {
			flume::TrySendError::Full(open) => {
				let _ = open.reply.try_send(Err(RemoteAgentViewError::Capacity));
				CollabCommandFault::RequestCapacity
			},
			flume::TrySendError::Disconnected(open) => {
				let _ = open.reply.try_send(Err(RemoteAgentViewError::Disconnected));
				CollabCommandFault::OwnerStopped
			},
		})?;
	Ok(active.result())
}

async fn send_guest_frame(
	active: Option<&ActiveSession>,
	payload: collab_frame::Payload,
) -> Result<CollabCommandResult, CollabCommandFault> {
	let active = active.ok_or(CollabCommandFault::NotJoined)?;
	let presence = (*active.presence.borrow()).ok_or(CollabCommandFault::NotJoined)?;
	if presence.role() != CollabRole::Guest {
		return Err(CollabCommandFault::NotGuest);
	}
	if presence.read_only() {
		return Err(CollabCommandFault::ReadOnly);
	}
	let outbound = active
		.outbound
		.as_ref()
		.ok_or(CollabCommandFault::NotGuest)?;
	let (reply, delivered) = flume::bounded(1);
	outbound
		.send_async(Outbound {
			frame: CollabFrame {
				protocol_revision: PROTOCOL_REVISION,
				payload: Some(payload),
				..CollabFrame::default()
			},
			reply,
		})
		.await
		.map_err(|_| CollabCommandFault::OwnerStopped)?;
	if !delivered
		.recv_async()
		.await
		.map_err(|_| CollabCommandFault::OwnerStopped)?
	{
		return Err(CollabCommandFault::MutationNotDelivered);
	}
	Ok(active.result())
}

fn disconnected_result() -> CollabCommandResult {
	CollabCommandResult { presence: None, editor_link: None, viewer_link: None }
}

struct ActiveHostView {
	generation: u64,
	cancel:     CancellationToken,
}

struct HostViewReady {
	peer_id:    u32,
	request_id: u32,
	generation: u64,
	result:     Result<RemoteAgentView, super::observer::AgentViewError>,
}

struct HostViewEvent {
	peer_id:    u32,
	request_id: u32,
	generation: u64,
	event:      Option<Event>,
}

struct GuestView {
	agent_id: Str,
	reply:    Option<flume::Sender<Result<RemoteAgentView, RemoteAgentViewError>>>,
	events:   Option<flume::Sender<Event>>,
	chunks:   Vec<Bytes>,
	next:     u32,
}

async fn start_host(
	relay_endpoint: RelayEndpoint,
	snapshot: Snapshot,
	events: flume::Receiver<Event>,
	agents: HostAgentBridge,
	presence_tx: watch::Sender<Option<PresenceFacts>>,
	state_tx: watch::Sender<Option<SessionStateUpdate>>,
	agents_tx: watch::Sender<RegistrySnapshot>,
	mut host_state: watch::Receiver<SessionStateUpdate>,
	remote_mutations: flume::Sender<AuthorizedMutation>,
) -> Result<ActiveSession, CollabCommandFault> {
	let room = HostedRoom::generate(relay_endpoint)?;
	let room_id = Str::from(base64_url::encode_raw(room.full.room_id().as_bytes()).into_string());
	let admission = HostAdmission::new(room_id, room.write_token.clone());
	let mut relay = RelayClient::new(room.full.room_url(), RelayRole::Host, room.room_key)?;
	presence_tx.send_replace(Some(PresenceFacts::host(ConnectionState::Connecting, 0)));
	relay.connect().await?;
	presence_tx.send_replace(Some(PresenceFacts::host(ConnectionState::Connected, 0)));
	state_tx.send_replace(Some(session_state(&BTreeMap::new(), &host_state.borrow())));
	let cancel = CancellationToken::new();
	let task_cancel = cancel.clone();
	let (host_ui, host_ui_rx) = flume::bounded::<HostUiOpen>(HOST_UI_REQUEST_CAP);
	let editor_link = Some(Str::new(room.full.compact()));
	let viewer_link = Some(Str::new(room.view.compact()));
	let presence = presence_tx.subscribe();
	let task = tokio::spawn(async move {
		let mut replica = Dom::from_snapshot(&snapshot);
		let mut peers = BTreeMap::<u32, AuthenticatedPeer>::new();
		let mut ui = HostUiDispatcher::default();
		let mut ui_answers = BTreeMap::<u32, HostUiWaiter>::new();
		let (ui_cancel, ui_cancel_rx) = flume::bounded::<u32>(HOST_UI_REQUEST_CAP);
		let (view_ready, view_ready_rx) = flume::bounded::<HostViewReady>(AGENT_VIEW_REQUEST_CAP);
		let (view_event, view_event_rx) = flume::bounded::<HostViewEvent>(AGENT_VIEW_EVENT_CAP);
		let mut views = BTreeMap::<(u32, u32), ActiveHostView>::new();
		let mut view_generation = 0_u64;
		let mut sequence = 0_u64;
		let initial_registry = registry_snapshot(&replica, &host_state.borrow());
		agents_tx.send_replace(initial_registry);
		loop {
			enum Wake {
				Cancel,
				Event(Result<Event, flume::RecvError>),
				State(Result<(), watch::error::RecvError>),
				HostUi(Result<HostUiOpen, flume::RecvError>),
				UiCancel(Result<u32, flume::RecvError>),
				ViewReady(Result<HostViewReady, flume::RecvError>),
				ViewEvent(Result<HostViewEvent, flume::RecvError>),
				Inbound(Result<Option<RelayInbound>, omp_collab::relay::RelayError>),
			}
			let wake = tokio::select! {
				() = task_cancel.cancelled() => Wake::Cancel,
				event = events.recv_async() => Wake::Event(event),
				state = host_state.changed() => Wake::State(state),
				request = host_ui_rx.recv_async() => Wake::HostUi(request),
				request_id = ui_cancel_rx.recv_async() => Wake::UiCancel(request_id),
				ready = view_ready_rx.recv_async() => Wake::ViewReady(ready),
				event = view_event_rx.recv_async() => Wake::ViewEvent(event),
				inbound = relay.receive() => Wake::Inbound(inbound),
			};
			match wake {
				Wake::Cancel => break,
				Wake::Event(Ok(event)) => {
					if replica.apply_event(&event).is_err() {
						break;
					}
					sequence = sequence.saturating_add(1);
					let Ok(record) = event_record(sequence, event) else {
						break;
					};
					let frame = live_record_frame(sequence, record);
					if relay.send(RelayRoute { peer_id: 0 }, &frame).await.is_err() {
						break;
					}
					let registry = registry_snapshot(&replica, &host_state.borrow());
					if *agents_tx.borrow() != registry {
						agents_tx.send_replace(registry.clone());
						sequence = sequence.saturating_add(1);
						let frame = registry_frame(sequence, registry);
						if relay.send(RelayRoute { peer_id: 0 }, &frame).await.is_err() {
							break;
						}
					}
				},
				Wake::Event(Err(_)) => break,
				Wake::State(Ok(())) => {
					sequence = sequence.saturating_add(1);
					let state = session_state(&peers, &host_state.borrow());
					state_tx.send_replace(Some(state.clone()));
					let frame = state_frame(sequence, state);
					if relay.send(RelayRoute { peer_id: 0 }, &frame).await.is_err() {
						break;
					}
					let registry = registry_snapshot(&replica, &host_state.borrow());
					if *agents_tx.borrow() != registry {
						agents_tx.send_replace(registry.clone());
						sequence = sequence.saturating_add(1);
						let frame = registry_frame(sequence, registry);
						if relay.send(RelayRoute { peer_id: 0 }, &frame).await.is_err() {
							break;
						}
					}
				},
				Wake::State(Err(_)) => break,
				Wake::HostUi(Ok(open)) => {
					match ui.begin(open.request, peers.iter().map(|(&id, peer)| (id, peer))) {
						Ok(frames) => {
							let request_id = frames
								.first()
								.and_then(|target| target.frame.payload.as_ref())
								.and_then(|payload| match payload {
									collab_frame::Payload::UiRequest(request) => Some(request.request_id),
									_ => None,
								})
								.expect("dispatcher emits UI request frames");
							let cancelled = open.cancel;
							let tx = ui_cancel.clone();
							let cancellation = tokio::spawn(async move {
								cancelled.cancelled().await;
								let _ = tx.send_async(request_id).await;
							});
							ui_answers
								.insert(request_id, HostUiWaiter { answer: open.answer, cancellation });
							for mut target in frames {
								sequence = sequence.saturating_add(1);
								target.frame.sequence = sequence;
								if relay
									.send(RelayRoute { peer_id: target.peer_id }, &target.frame)
									.await
									.is_err()
								{
									break;
								}
							}
						},
						Err(HostUiBeginError::NoWritablePeer) => {
							let _ = open.answer.try_send(Err(HostUiRequestError::Unavailable));
						},
						Err(HostUiBeginError::PayloadTooLarge { .. }) => {
							let _ = open.answer.try_send(Err(HostUiRequestError::TooLarge));
						},
						Err(HostUiBeginError::Capacity { .. } | HostUiBeginError::IdExhausted) => {
							let _ = open.answer.try_send(Err(HostUiRequestError::Capacity));
						},
					}
				},
				Wake::HostUi(Err(_)) => break,
				Wake::UiCancel(Ok(request_id)) => {
					for mut target in ui.cancel(request_id, peers.iter().map(|(&id, peer)| (id, peer))) {
						sequence = sequence.saturating_add(1);
						target.frame.sequence = sequence;
						let _ = relay
							.send(RelayRoute { peer_id: target.peer_id }, &target.frame)
							.await;
					}
					if let Some(waiter) = ui_answers.remove(&request_id) {
						waiter.cancellation.abort();
						let _ = waiter.answer.try_send(Err(HostUiRequestError::Cancelled));
					}
				},
				Wake::UiCancel(Err(_)) => break,
				Wake::ViewReady(Ok(ready)) => {
					let key = (ready.peer_id, ready.request_id);
					let Some(active) = views.get(&key) else {
						continue;
					};
					if active.generation != ready.generation {
						continue;
					}
					let cancel = active.cancel.clone();
					match ready.result {
						Ok(view) => {
							if view.snapshot.as_bytes().len() > AGENT_VIEW_SNAPSHOT_MAX_BYTES {
								sequence = sequence.saturating_add(1);
								let frame = agent_view_end_frame(
									sequence,
									ready.request_id,
									Some(AgentViewFailureCode::Capacity),
								);
								let _ = relay
									.send(RelayRoute { peer_id: ready.peer_id }, &frame)
									.await;
								views.remove(&key);
								continue;
							}
							let chunks = view
								.snapshot
								.as_bytes()
								.chunks(SNAPSHOT_CHUNK_BYTES)
								.collect::<Vec<_>>();
							let mut sent = true;
							for (index, bytes) in chunks.iter().enumerate() {
								sequence = sequence.saturating_add(1);
								let frame = agent_view_snapshot_frame(
									sequence,
									ready.request_id,
									u32::try_from(index).unwrap_or(u32::MAX),
									Bytes::copy_from_slice(bytes),
									index + 1 == chunks.len(),
								);
								if relay
									.send(RelayRoute { peer_id: ready.peer_id }, &frame)
									.await
									.is_err()
								{
									cancel.cancel();
									sent = false;
									break;
								}
							}
							if !sent {
								views.remove(&key);
								continue;
							}
							if let Some(events) = view.events {
								let tx = view_event.clone();
								tokio::spawn(async move {
									loop {
										tokio::select! {
											() = cancel.cancelled() => break,
											event = events.recv_async() => match event {
												Ok(event) => {
													let update = HostViewEvent {
														peer_id: ready.peer_id,
														request_id: ready.request_id,
														generation: ready.generation,
														event: Some(event),
													};
													tokio::select! {
														() = cancel.cancelled() => break,
														result = tx.send_async(update) => {
															if result.is_err() {
																break;
															}
														},
													}
												},
												Err(_) => break,
											},
										}
									}
									let _ = tx
										.send_async(HostViewEvent {
											peer_id:    ready.peer_id,
											request_id: ready.request_id,
											generation: ready.generation,
											event:      None,
										})
										.await;
								});
							} else {
								sequence = sequence.saturating_add(1);
								let frame = agent_view_end_frame(sequence, ready.request_id, None);
								let _ = relay
									.send(RelayRoute { peer_id: ready.peer_id }, &frame)
									.await;
								views.remove(&key);
							}
						},
						Err(error) => {
							let code = match error {
								super::observer::AgentViewError::UnknownAgent => {
									AgentViewFailureCode::UnknownAgent
								},
								super::observer::AgentViewError::Session(_) => {
									AgentViewFailureCode::Unavailable
								},
							};
							sequence = sequence.saturating_add(1);
							let frame = agent_view_end_frame(sequence, ready.request_id, Some(code));
							let _ = relay
								.send(RelayRoute { peer_id: ready.peer_id }, &frame)
								.await;
							views.remove(&key);
						},
					}
				},
				Wake::ViewReady(Err(_)) => break,
				Wake::ViewEvent(Ok(update)) => {
					let key = (update.peer_id, update.request_id);
					if views
						.get(&key)
						.is_none_or(|active| active.generation != update.generation)
					{
						continue;
					}
					match update.event {
						Some(event) => {
							sequence = sequence.saturating_add(1);
							let Ok(record) = event_record(sequence, event) else {
								if let Some(active) = views.remove(&key) {
									active.cancel.cancel();
								}
								sequence = sequence.saturating_add(1);
								let frame = agent_view_end_frame(
									sequence,
									update.request_id,
									Some(AgentViewFailureCode::InvalidProjection),
								);
								let _ = relay
									.send(RelayRoute { peer_id: update.peer_id }, &frame)
									.await;
								continue;
							};
							let frame = agent_view_event_frame(sequence, update.request_id, record);
							if relay
								.send(RelayRoute { peer_id: update.peer_id }, &frame)
								.await
								.is_err() && let Some(active) = views.remove(&key)
							{
								active.cancel.cancel();
							}
						},
						None => {
							sequence = sequence.saturating_add(1);
							let frame = agent_view_end_frame(sequence, update.request_id, None);
							let _ = relay
								.send(RelayRoute { peer_id: update.peer_id }, &frame)
								.await;
							views.remove(&key);
						},
					}
				},
				Wake::ViewEvent(Err(_)) => break,
				Wake::Inbound(Ok(Some(RelayInbound::PeerJoined(_)))) => {},
				Wake::Inbound(Ok(Some(RelayInbound::PeerLeft(left)))) => {
					peers.remove(&left.peer_id);
					let abandoned = views
						.keys()
						.filter(|(peer_id, _)| *peer_id == left.peer_id)
						.copied()
						.collect::<Vec<_>>();
					for key in abandoned {
						if let Some(active) = views.remove(&key) {
							active.cancel.cancel();
						}
					}
					presence_tx
						.send_replace(Some(PresenceFacts::host(ConnectionState::Connected, peers.len())));
					sequence = sequence.saturating_add(1);
					let state = session_state(&peers, &host_state.borrow());
					state_tx.send_replace(Some(state.clone()));
					let frame = state_frame(sequence, state);
					let _ = relay.send(RelayRoute { peer_id: 0 }, &frame).await;
				},
				Wake::Inbound(Ok(Some(RelayInbound::Frame(routed)))) => {
					let peer_id = routed.route.peer_id;
					match routed.frame.payload.as_ref() {
						Some(collab_frame::Payload::Hello(hello)) => {
							let mut handshake = Handshake::new(RelayRole::Host);
							if handshake.accept(&routed.frame).is_err() {
								send_error(&mut relay, peer_id, "protocol", "Protocol mismatch").await;
								continue;
							}
							let Ok(peer) = admission.authenticate(peer_id, hello) else {
								send_error(&mut relay, peer_id, "admission", "Guest admission failed")
									.await;
								continue;
							};
							let read_only = peer.read_only();
							peers.insert(peer_id, peer);
							presence_tx.send_replace(Some(PresenceFacts::host(
								ConnectionState::Connected,
								peers.len(),
							)));
							let snapshot = replica.snapshot();
							if snapshot.as_bytes().len() > SNAPSHOT_MAX_BYTES {
								peers.remove(&peer_id);
								presence_tx.send_replace(Some(PresenceFacts::host(
									ConnectionState::Connected,
									peers.len(),
								)));
								send_error(
									&mut relay,
									peer_id,
									"snapshot_too_large",
									"Host session snapshot exceeds the collaboration limit",
								)
								.await;
								continue;
							}
							let chunks = snapshot_chunks(snapshot.as_bytes());
							let chunk_count = chunks.len();
							sequence = sequence.saturating_add(1);
							let welcome = welcome_frame(
								sequence,
								read_only,
								u32::try_from(chunk_count).unwrap_or(u32::MAX),
								session_state(&peers, &host_state.borrow()),
								registry_snapshot(&replica, &host_state.borrow()),
							);
							if relay.send(RelayRoute { peer_id }, &welcome).await.is_err() {
								continue;
							}
							for (index, bytes) in chunks.into_iter().enumerate() {
								sequence = sequence.saturating_add(1);
								let frame = snapshot_frame(
									sequence,
									bytes,
									index + 1 == chunk_count,
									u64::try_from(chunk_count).unwrap_or(u64::MAX),
								);
								if relay.send(RelayRoute { peer_id }, &frame).await.is_err() {
									break;
								}
							}
							sequence = sequence.saturating_add(1);
							let state = session_state(&peers, &host_state.borrow());
							state_tx.send_replace(Some(state.clone()));
							let frame = state_frame(sequence, state);
							let _ = relay.send(RelayRoute { peer_id: 0 }, &frame).await;
							if let Some(peer) = peers.get(&peer_id) {
								for mut target in ui.replay_for_join(peer_id, peer) {
									sequence = sequence.saturating_add(1);
									target.frame.sequence = sequence;
									let _ = relay
										.send(RelayRoute { peer_id: target.peer_id }, &target.frame)
										.await;
								}
							}
						},
						Some(collab_frame::Payload::AgentViewRequest(request)) => {
							let Some(_peer) = peers.get(&peer_id) else {
								send_error(&mut relay, peer_id, "hello_required", "Guest hello required")
									.await;
								continue;
							};
							if views.len() >= AGENT_VIEW_REQUEST_CAP {
								sequence = sequence.saturating_add(1);
								let frame = agent_view_end_frame(
									sequence,
									request.request_id,
									Some(AgentViewFailureCode::Capacity),
								);
								let _ = relay.send(RelayRoute { peer_id }, &frame).await;
								continue;
							}
							let key = (peer_id, request.request_id);
							if let Some(previous) = views.remove(&key) {
								previous.cancel.cancel();
							}
							view_generation = view_generation.saturating_add(1);
							let generation = view_generation;
							let cancel = CancellationToken::new();
							views.insert(key, ActiveHostView { generation, cancel });
							let bridge = agents.clone();
							let ready = view_ready.clone();
							let agent_id = request.agent_id.clone();
							let request_id = request.request_id;
							tokio::spawn(async move {
								let result = bridge.view(&agent_id).await;
								let _ = ready
									.send_async(HostViewReady { peer_id, request_id, generation, result })
									.await;
							});
						},
						Some(collab_frame::Payload::AgentViewCancel(request)) => {
							if let Some(active) = views.remove(&(peer_id, request.request_id)) {
								active.cancel.cancel();
							}
						},
						Some(collab_frame::Payload::UiResponse(response)) => {
							let Some(peer) = peers.get(&peer_id) else {
								send_error(&mut relay, peer_id, "hello_required", "Guest hello required")
									.await;
								continue;
							};
							match ui.answer(
								peer_id,
								peer,
								response.clone(),
								peers.iter().map(|(&id, peer)| (id, peer)),
							) {
								Ok(Some((answer, cleanup))) => {
									if let Some(waiter) = ui_answers.remove(&answer.request_id) {
										waiter.cancellation.abort();
										let _ = waiter.answer.try_send(Ok(answer));
									}
									for mut target in cleanup {
										sequence = sequence.saturating_add(1);
										target.frame.sequence = sequence;
										let _ = relay
											.send(RelayRoute { peer_id: target.peer_id }, &target.frame)
											.await;
									}
								},
								Ok(None) => {},
								Err(_) => {
									send_error(&mut relay, peer_id, "read_only", "UI response is disabled")
										.await;
								},
							}
						},
						Some(payload) => {
							let Some(peer) = peers.get(&peer_id) else {
								send_error(&mut relay, peer_id, "hello_required", "Guest hello required")
									.await;
								continue;
							};
							match admission.admit_mutation(peer, payload) {
								Ok(mutation) => {
									if remote_mutations.try_send(mutation).is_err() {
										send_error(
											&mut relay,
											peer_id,
											"capacity",
											"Host collaboration command queue is full",
										)
										.await;
									}
								},
								Err(_) => {
									send_error(
										&mut relay,
										peer_id,
										"read_only",
										"Mutation is disabled on a read-only link",
									)
									.await;
								},
							}
						},
						None => {},
					}
				},
				Wake::Inbound(Ok(None)) | Wake::Inbound(Err(_)) => {
					peers.clear();
					for (_, active) in views.split_off(&(0, 0)) {
						active.cancel.cancel();
					}
					presence_tx
						.send_replace(Some(PresenceFacts::host(ConnectionState::Reconnecting, 0)));
					if !reconnect(&mut relay, &task_cancel).await {
						break;
					}
					presence_tx.send_replace(Some(PresenceFacts::host(ConnectionState::Connected, 0)));
				},
			}
		}
		for (_, waiter) in ui_answers {
			waiter.cancellation.abort();
			let _ = waiter
				.answer
				.try_send(Err(HostUiRequestError::OwnerStopped));
		}
		for (_, active) in views {
			active.cancel.cancel();
		}
		presence_tx.send_replace(Some(PresenceFacts::host(ConnectionState::Disconnected, 0)));
		state_tx.send_replace(None);
		agents_tx.send_replace(RegistrySnapshot::default());
		let _ = relay.close().await;
	});
	Ok(ActiveSession {
		cancel,
		task,
		presence,
		outbound: None,
		agent_views: None,
		host_ui: Some(host_ui),
		editor_link,
		viewer_link,
	})
}

async fn start_guest(
	link: CollabLink,
	display_name: Str,
	presence_tx: watch::Sender<Option<PresenceFacts>>,
	state_tx: watch::Sender<Option<SessionStateUpdate>>,
	agents_tx: watch::Sender<RegistrySnapshot>,
	replica_tx: watch::Sender<Option<Snapshot>>,
	replica_events: flume::Sender<Event>,
	remote_ui: flume::Sender<RemoteUiRequest>,
) -> Result<ActiveSession, CollabCommandFault> {
	let key = omp_collab::crypto::RoomKey::from_bytes(*link.credentials().key())?;
	let mut relay = RelayClient::new(link.room_url(), RelayRole::Guest, key)?;
	let read_only = link.credentials().is_read_only();
	presence_tx.send_replace(Some(PresenceFacts::guest(ConnectionState::Connecting, 1, read_only)));
	relay.connect().await?;
	let hello = Hello {
		protocol_revision: PROTOCOL_REVISION,
		display_name:      display_name.to_string(),
		write_token:       link
			.credentials()
			.write_token()
			.map(|token| Bytes::copy_from_slice(token.as_bytes())),
		client_version:    env!("CARGO_PKG_VERSION").to_owned(),
	};
	let mut sequence = 1_u64;
	let hello_frame = Handshake::hello(sequence, hello.clone());
	let _ = relay.send(RelayRoute { peer_id: 0 }, &hello_frame).await?;
	let cancel = CancellationToken::new();
	let task_cancel = cancel.clone();
	let (outbound, outbound_rx) = flume::bounded::<Outbound>(64);
	let (agent_views, agent_views_rx) = flume::bounded::<AgentViewOpen>(AGENT_VIEW_REQUEST_CAP);
	let (ready_tx, ready_rx) = flume::bounded(1);
	let presence = presence_tx.subscribe();
	let task = tokio::spawn(async move {
		let mut handshake = Handshake::new(RelayRole::Guest);
		let mut replica: Option<Dom> = None;
		let mut snapshot_records = Vec::<JournalRecord>::new();
		let mut views = BTreeMap::<u32, GuestView>::new();
		let mut ui_requests = BTreeMap::<u32, CancellationToken>::new();
		let mut next_view_id = 0_u32;
		let mut sweep = tokio::time::interval(Duration::from_secs(1));
		sweep.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Skip);
		let mut initial = true;
		loop {
			enum Wake {
				Cancel,
				Outbound(Result<Outbound, flume::RecvError>),
				AgentView(Result<AgentViewOpen, flume::RecvError>),
				Sweep,
				Inbound(Result<Option<RelayInbound>, omp_collab::relay::RelayError>),
			}
			let wake = tokio::select! {
				() = task_cancel.cancelled() => Wake::Cancel,
				frame = outbound_rx.recv_async() => Wake::Outbound(frame),
				request = agent_views_rx.recv_async() => Wake::AgentView(request),
				_ = sweep.tick() => Wake::Sweep,
				inbound = relay.receive() => Wake::Inbound(inbound),
			};
			match wake {
				Wake::Cancel => break,
				Wake::Outbound(Ok(mut outbound)) => {
					sequence = sequence.saturating_add(1);
					outbound.frame.sequence = sequence;
					outbound.frame.protocol_revision = PROTOCOL_REVISION;
					let delivered = matches!(
						relay.send(RelayRoute { peer_id: 0 }, &outbound.frame).await,
						Ok(SendDisposition::Sent)
					);
					let _ = outbound.reply.send(delivered);
					if !delivered {
						continue;
					}
				},
				Wake::Outbound(Err(_)) => break,
				Wake::AgentView(Ok(open)) => {
					if views.len() >= AGENT_VIEW_REQUEST_CAP {
						let _ = open.reply.try_send(Err(RemoteAgentViewError::Capacity));
						continue;
					}
					let Some(request_id) = allocate_view_id(&mut next_view_id, &views) else {
						let _ = open.reply.try_send(Err(RemoteAgentViewError::Capacity));
						continue;
					};
					sequence = sequence.saturating_add(1);
					let frame = agent_view_request_frame(sequence, request_id, open.agent_id.clone());
					if !matches!(
						relay.send(RelayRoute { peer_id: 0 }, &frame).await,
						Ok(SendDisposition::Sent)
					) {
						let _ = open.reply.try_send(Err(RemoteAgentViewError::Disconnected));
						continue;
					}
					views.insert(request_id, GuestView {
						agent_id: open.agent_id,
						reply:    Some(open.reply),
						events:   None,
						chunks:   Vec::new(),
						next:     0,
					});
				},
				Wake::AgentView(Err(_)) => break,
				Wake::Sweep => {
					let closed = views
						.iter()
						.filter_map(|(&id, view)| {
							view
								.events
								.as_ref()
								.is_some_and(flume::Sender::is_disconnected)
								.then_some(id)
						})
						.collect::<Vec<_>>();
					for request_id in closed {
						views.remove(&request_id);
						sequence = sequence.saturating_add(1);
						let frame = agent_view_cancel_frame(sequence, request_id);
						let _ = relay.send(RelayRoute { peer_id: 0 }, &frame).await;
					}
				},
				Wake::Inbound(Ok(Some(RelayInbound::Frame(routed)))) => {
					if matches!(&routed.frame.payload, Some(collab_frame::Payload::Welcome(_)))
						&& handshake.accept(&routed.frame).is_err()
					{
						if initial {
							let _ = ready_tx.send(Err(CollabCommandFault::HandshakeRefused));
						}
						break;
					}
					match routed.frame.payload {
						Some(collab_frame::Payload::Welcome(welcome)) => {
							snapshot_records.clear();
							let participant_count = welcome
								.initial_state
								.as_ref()
								.map_or(1, |state| state.participants.len().max(1));
							state_tx.send_replace(welcome.initial_state.clone());
							agents_tx.send_replace(welcome.initial_agents.unwrap_or_default());
							for (&request_id, view) in &mut views {
								view.chunks.clear();
								view.next = 0;
								sequence = sequence.saturating_add(1);
								let frame =
									agent_view_request_frame(sequence, request_id, view.agent_id.clone());
								let _ = relay.send(RelayRoute { peer_id: 0 }, &frame).await;
							}
							presence_tx.send_replace(Some(PresenceFacts::guest(
								ConnectionState::Connecting,
								participant_count,
								welcome.read_only,
							)));
						},
						Some(collab_frame::Payload::SnapshotChunk(chunk)) => {
							if snapshot_records.len().saturating_add(chunk.entries.len())
								> SNAPSHOT_CHUNK_MAX_COUNT
							{
								if initial {
									let _ = ready_tx.send(Err(CollabCommandFault::SnapshotTooLarge {
										actual:  snapshot_records.len().saturating_add(chunk.entries.len())
											* SNAPSHOT_CHUNK_BYTES,
										maximum: SNAPSHOT_MAX_BYTES,
									}));
								}
								break;
							}
							snapshot_records.extend(chunk.entries);
							if chunk.r#final {
								if snapshot_records.is_empty() {
									if initial {
										let _ = ready_tx.send(Err(CollabCommandFault::MissingSnapshot));
									}
									break;
								}
								let encoded = match decode_snapshot_chunks(&snapshot_records) {
									Ok(encoded) => encoded,
									Err(error) => {
										if initial {
											let _ = ready_tx.send(Err(error));
										}
										break;
									},
								};
								match Snapshot::from_bytes(&encoded) {
									Ok(snapshot) => {
										replica = Some(Dom::from_snapshot(&snapshot));
										replica_tx.send_replace(Some(snapshot.clone()));
										if !initial
											&& replica_events.try_send(Event::Reset { snapshot }).is_err()
										{
											break;
										}
										presence_tx.send_replace(Some(PresenceFacts::guest(
											ConnectionState::Connected,
											(*presence_tx.borrow())
												.map_or(1, PresenceFacts::participant_count),
											read_only,
										)));
										if initial {
											initial = false;
											let _ = ready_tx.send(Ok(()));
										}
									},
									Err(error) => {
										if initial {
											let _ = ready_tx.send(Err(CollabCommandFault::Snapshot(error)));
										}
										break;
									},
								}
							}
						},
						Some(collab_frame::Payload::JournalRecord(record)) => {
							let Some(dom) = replica.as_mut() else {
								continue;
							};
							match decode_event(&record).and_then(|event| {
								dom.apply_event(&event)?;
								Ok(event)
							}) {
								Ok(event) => {
									if replica_events.try_send(event).is_err() {
										break;
									}
								},
								Err(_) => break,
							}
						},
						Some(collab_frame::Payload::Agents(registry)) => {
							agents_tx.send_replace(registry);
						},
						Some(collab_frame::Payload::UiRequest(request)) => {
							if read_only || ui_requests.contains_key(&request.request_id) {
								continue;
							}
							let cancel = CancellationToken::new();
							if remote_ui
								.try_send(RemoteUiRequest {
									request: request.clone(),
									cancel:  cancel.clone(),
								})
								.is_ok()
							{
								ui_requests.insert(request.request_id, cancel);
							}
						},
						Some(collab_frame::Payload::UiRequestEnd(end)) => {
							if let Some(cancel) = ui_requests.remove(&end.request_id) {
								cancel.cancel();
							}
						},
						Some(collab_frame::Payload::AgentViewSnapshot(chunk)) => {
							let Some(view) = views.get_mut(&chunk.request_id) else {
								continue;
							};
							if chunk.chunk_index != view.next {
								if let Some(reply) = view.reply.take() {
									let _ = reply.try_send(Err(RemoteAgentViewError::InvalidProjection));
								}
								views.remove(&chunk.request_id);
								cancel_remote_view(&mut relay, &mut sequence, chunk.request_id).await;
								continue;
							}
							let aggregate = view
								.chunks
								.iter()
								.map(Bytes::len)
								.sum::<usize>()
								.saturating_add(chunk.snapshot_bytes.len());
							if aggregate > AGENT_VIEW_SNAPSHOT_MAX_BYTES {
								if let Some(reply) = view.reply.take() {
									let _ = reply.try_send(Err(RemoteAgentViewError::Capacity));
								}
								views.remove(&chunk.request_id);
								cancel_remote_view(&mut relay, &mut sequence, chunk.request_id).await;
								continue;
							}
							view.next = view.next.saturating_add(1);
							view.chunks.push(chunk.snapshot_bytes);
							if chunk.r#final {
								let mut encoded = Vec::new();
								for bytes in view.chunks.drain(..) {
									encoded.extend_from_slice(&bytes);
								}
								let Ok(snapshot) = Snapshot::from_bytes(&encoded) else {
									if let Some(reply) = view.reply.take() {
										let _ = reply.try_send(Err(RemoteAgentViewError::InvalidProjection));
									}
									views.remove(&chunk.request_id);
									cancel_remote_view(&mut relay, &mut sequence, chunk.request_id).await;
									continue;
								};
								if let Some(reply) = view.reply.take() {
									let (events, observed) = flume::bounded(AGENT_VIEW_EVENT_CAP);
									view.events = Some(events);
									let _ = reply
										.try_send(Ok(RemoteAgentView { snapshot, events: Some(observed) }));
								} else if let Some(events) = &view.events
									&& events.try_send(Event::Reset { snapshot }).is_err()
								{
									views.remove(&chunk.request_id);
									cancel_remote_view(&mut relay, &mut sequence, chunk.request_id).await;
								}
							}
						},
						Some(collab_frame::Payload::AgentViewEvent(update)) => {
							let Some(record) = update.event.as_ref() else {
								if let Some(view) = views.remove(&update.request_id)
									&& let Some(reply) = view.reply
								{
									let _ = reply.try_send(Err(RemoteAgentViewError::InvalidProjection));
								}
								cancel_remote_view(&mut relay, &mut sequence, update.request_id).await;
								continue;
							};
							let Ok(event) = decode_event(record) else {
								if let Some(view) = views.remove(&update.request_id)
									&& let Some(reply) = view.reply
								{
									let _ = reply.try_send(Err(RemoteAgentViewError::InvalidProjection));
								}
								cancel_remote_view(&mut relay, &mut sequence, update.request_id).await;
								continue;
							};
							let disconnected = views
								.get(&update.request_id)
								.and_then(|view| view.events.as_ref())
								.is_none_or(|events| events.try_send(event).is_err());
							if disconnected {
								views.remove(&update.request_id);
								cancel_remote_view(&mut relay, &mut sequence, update.request_id).await;
							}
						},
						Some(collab_frame::Payload::AgentViewEnd(end)) => {
							if let Some(view) = views.remove(&end.request_id)
								&& let Some(reply) = view.reply
							{
								let error = end
									.error
									.map_or(RemoteAgentViewError::Disconnected, |error| {
										RemoteAgentViewError::Refused {
											code: error
												.code
												.parse()
												.unwrap_or(AgentViewFailureCode::Unavailable),
										}
									});
								let _ = reply.try_send(Err(error));
							}
						},
						Some(collab_frame::Payload::State(state)) => {
							let participant_count = state.participants.len().max(1);
							state_tx.send_replace(Some(state));
							presence_tx.send_replace(Some(PresenceFacts::guest(
								ConnectionState::Connected,
								participant_count,
								read_only,
							)));
						},
						Some(collab_frame::Payload::Error(_)) if initial => {
							let _ = ready_tx.send(Err(CollabCommandFault::HandshakeRefused));
							break;
						},
						Some(collab_frame::Payload::Bye(_)) => break,
						_ => {},
					}
				},
				Wake::Inbound(Ok(Some(RelayInbound::PeerJoined(_) | RelayInbound::PeerLeft(_)))) => {},
				Wake::Inbound(Ok(None)) | Wake::Inbound(Err(_)) => {
					for (_, cancel) in std::mem::take(&mut ui_requests) {
						cancel.cancel();
					}
					presence_tx.send_replace(Some(PresenceFacts::guest(
						ConnectionState::Reconnecting,
						(*presence_tx.borrow()).map_or(1, PresenceFacts::participant_count),
						read_only,
					)));
					if !reconnect(&mut relay, &task_cancel).await {
						if initial {
							let _ = ready_tx.send(Err(CollabCommandFault::HandshakeRefused));
						}
						break;
					}
					handshake = Handshake::new(RelayRole::Guest);
					sequence = sequence.saturating_add(1);
					let frame = Handshake::hello(sequence, hello.clone());
					if relay.send(RelayRoute { peer_id: 0 }, &frame).await.is_err() {
						break;
					}
				},
			}
		}
		for (_, view) in views {
			if let Some(reply) = view.reply {
				let _ = reply.try_send(Err(RemoteAgentViewError::Disconnected));
			}
		}
		for (_, cancel) in ui_requests {
			cancel.cancel();
		}
		presence_tx.send_replace(Some(PresenceFacts::guest(
			ConnectionState::Disconnected,
			1,
			read_only,
		)));
		state_tx.send_replace(None);
		agents_tx.send_replace(RegistrySnapshot::default());
		let _ = relay.close().await;
	});
	match tokio::time::timeout(INITIAL_HANDSHAKE_TIMEOUT, ready_rx.recv_async()).await {
		Ok(Ok(Ok(()))) => Ok(ActiveSession {
			cancel,
			task,
			presence,
			outbound: Some(outbound),
			agent_views: Some(agent_views),
			host_ui: None,
			editor_link: None,
			viewer_link: None,
		}),
		Ok(Ok(Err(error))) => {
			cancel.cancel();
			let _ = task.await;
			Err(error)
		},
		Ok(Err(_)) => {
			cancel.cancel();
			let _ = task.await;
			Err(CollabCommandFault::OwnerStopped)
		},
		Err(_) => {
			cancel.cancel();
			let _ = task.await;
			Err(CollabCommandFault::HandshakeTimeout)
		},
	}
}

async fn cancel_remote_view(relay: &mut RelayClient, sequence: &mut u64, request_id: u32) {
	*sequence = sequence.saturating_add(1);
	let frame = agent_view_cancel_frame(*sequence, request_id);
	let _ = relay.send(RelayRoute { peer_id: 0 }, &frame).await;
}

fn allocate_view_id(next: &mut u32, views: &BTreeMap<u32, GuestView>) -> Option<u32> {
	(1..=u32::MAX).find_map(|_| {
		*next = next.wrapping_add(1).max(1);
		(!views.contains_key(next)).then_some(*next)
	})
}

async fn reconnect(relay: &mut RelayClient, cancel: &CancellationToken) -> bool {
	loop {
		let Ok(delay) = relay.reconnect_delay() else {
			return false;
		};
		tokio::select! {
			() = cancel.cancelled() => return false,
			() = tokio::time::sleep(delay) => {},
		}
		if relay.connect().await.is_ok() {
			return true;
		}
	}
}

async fn send_error(
	relay: &mut RelayClient,
	peer_id: u32,
	code: &'static str,
	message: &'static str,
) {
	let frame = CollabFrame {
		protocol_revision: PROTOCOL_REVISION,
		payload: Some(collab_frame::Payload::Error(ErrorMessage {
			code:    code.to_owned(),
			message: message.to_owned(),
		})),
		..CollabFrame::default()
	};
	let _ = relay.send(RelayRoute { peer_id }, &frame).await;
}

fn welcome_frame(
	sequence: u64,
	read_only: bool,
	total_entry_count: u32,
	state: SessionStateUpdate,
	agents: RegistrySnapshot,
) -> CollabFrame {
	Handshake::welcome(sequence, Welcome {
		protocol_revision: PROTOCOL_REVISION,
		header: Some(SessionHeader {
			session_id: state.session_name.clone(),
			title: state.session_name.clone(),
			host_cwd: state.host_cwd.clone(),
			..SessionHeader::default()
		}),
		initial_state: Some(state),
		initial_agents: Some(agents),
		total_entry_count,
		read_only,
	})
}

fn registry_frame(sequence: u64, agents: RegistrySnapshot) -> CollabFrame {
	CollabFrame {
		protocol_revision: PROTOCOL_REVISION,
		sequence,
		payload: Some(collab_frame::Payload::Agents(agents)),
		..CollabFrame::default()
	}
}

fn agent_view_request_frame(sequence: u64, request_id: u32, agent_id: Str) -> CollabFrame {
	CollabFrame {
		protocol_revision: PROTOCOL_REVISION,
		sequence,
		payload: Some(collab_frame::Payload::AgentViewRequest(AgentViewRequest {
			request_id,
			agent_id: agent_id.to_string(),
		})),
		..CollabFrame::default()
	}
}

fn agent_view_cancel_frame(sequence: u64, request_id: u32) -> CollabFrame {
	CollabFrame {
		protocol_revision: PROTOCOL_REVISION,
		sequence,
		payload: Some(collab_frame::Payload::AgentViewCancel(AgentViewCancel { request_id })),
		..CollabFrame::default()
	}
}

fn agent_view_snapshot_frame(
	sequence: u64,
	request_id: u32,
	chunk_index: u32,
	snapshot_bytes: Bytes,
	r#final: bool,
) -> CollabFrame {
	CollabFrame {
		protocol_revision: PROTOCOL_REVISION,
		sequence,
		payload: Some(collab_frame::Payload::AgentViewSnapshot(AgentViewSnapshot {
			request_id,
			chunk_index,
			snapshot_bytes,
			r#final,
		})),
		..CollabFrame::default()
	}
}

fn agent_view_event_frame(sequence: u64, request_id: u32, event: JournalRecord) -> CollabFrame {
	CollabFrame {
		protocol_revision: PROTOCOL_REVISION,
		sequence,
		payload: Some(collab_frame::Payload::AgentViewEvent(AgentViewEvent {
			request_id,
			event: Some(event),
		})),
		..CollabFrame::default()
	}
}

fn agent_view_end_frame(
	sequence: u64,
	request_id: u32,
	error: Option<AgentViewFailureCode>,
) -> CollabFrame {
	CollabFrame {
		protocol_revision: PROTOCOL_REVISION,
		sequence,
		payload: Some(collab_frame::Payload::AgentViewEnd(AgentViewEnd {
			request_id,
			error: error
				.map(|code| ErrorMessage { code: code.to_string(), message: code.to_string() }),
		})),
		..CollabFrame::default()
	}
}

fn state_frame(sequence: u64, state: SessionStateUpdate) -> CollabFrame {
	CollabFrame {
		protocol_revision: PROTOCOL_REVISION,
		sequence,
		payload: Some(collab_frame::Payload::State(state)),
		..CollabFrame::default()
	}
}

fn session_state(
	peers: &BTreeMap<u32, AuthenticatedPeer>,
	base: &SessionStateUpdate,
) -> SessionStateUpdate {
	let mut participants = Vec::with_capacity(peers.len() + 1);
	participants.push(Participant {
		display_name: "Host".to_owned(),
		is_host:      true,
		read_only:    false,
		peer_id:      0,
	});
	participants.extend(peers.iter().map(|(&peer_id, peer)| Participant {
		display_name: peer.principal().display_name().to_owned(),
		is_host: false,
		read_only: peer.read_only(),
		peer_id,
	}));
	SessionStateUpdate { participants, ..base.clone() }
}

fn snapshot_chunks(bytes: &[u8]) -> Vec<Bytes> {
	bytes
		.chunks(SNAPSHOT_CHUNK_BYTES)
		.enumerate()
		.map(|(index, chunk)| {
			Bytes::from(
				serde_json::to_vec(&serde_json::json!({
					"kind": "dom.snapshot.chunk@1",
					"index": index,
					"data": base64_url::encode_raw(chunk).into_string(),
				}))
				.expect("snapshot chunk JSON is infallible"),
			)
		})
		.collect()
}

fn decode_snapshot_chunks(records: &[JournalRecord]) -> Result<Vec<u8>, CollabCommandFault> {
	if records.len() > SNAPSHOT_CHUNK_MAX_COUNT {
		return Err(CollabCommandFault::SnapshotTooLarge {
			actual:  records.len().saturating_mul(SNAPSHOT_CHUNK_BYTES),
			maximum: SNAPSHOT_MAX_BYTES,
		});
	}
	let mut decoded = Vec::new();
	for (expected, record) in records.iter().enumerate() {
		let value: serde_json::Value = serde_json::from_slice(&record.transcript_v4_json)?;
		if value.get("kind").and_then(serde_json::Value::as_str) != Some("dom.snapshot.chunk@1")
			|| value.get("index").and_then(serde_json::Value::as_u64) != u64::try_from(expected).ok()
		{
			return Err(CollabCommandFault::InvalidSnapshotFragment);
		}
		let data = value
			.get("data")
			.and_then(serde_json::Value::as_str)
			.ok_or(CollabCommandFault::InvalidSnapshotFragment)?;
		let bytes = base64_url::decode_raw(data.as_bytes())
			.into_vec()
			.map_err(|_| CollabCommandFault::InvalidSnapshotFragment)?;
		let actual = decoded.len().saturating_add(bytes.len());
		if actual > SNAPSHOT_MAX_BYTES {
			return Err(CollabCommandFault::SnapshotTooLarge { actual, maximum: SNAPSHOT_MAX_BYTES });
		}
		decoded.extend_from_slice(&bytes);
	}
	Ok(decoded)
}

fn event_record(revision: u64, event: Event) -> Result<JournalRecord, serde_json::Error> {
	let value = match event {
		Event::Patch(patch) => serde_json::json!({"kind": "patch@1", "data": patch}),
		Event::Reset { snapshot } => serde_json::json!({
			"kind": "snapshot@1",
			"data": serde_json::from_slice::<serde_json::Value>(snapshot.as_bytes())?,
		}),
		Event::Stream { cause, sid, op, node, prop, text } => serde_json::json!({
			"kind": "stream@1",
			"cause": cause,
			"sid": sid,
			"op": op,
			"node": node,
			"prop": prop,
			"text": text,
		}),
	};
	Ok(JournalRecord {
		revision,
		transcript_v4_json: Bytes::from(serde_json::to_vec(&value)?),
		visibility_class: VisibilityClass::PublicTranscript as i32,
	})
}

#[derive(Deserialize)]
#[serde(tag = "kind")]
enum ReplicatedEvent {
	#[serde(rename = "patch@1")]
	Patch { data: omp_dom::Patch },
	#[serde(rename = "snapshot@1")]
	Reset { data: Box<RawValue> },
	#[serde(rename = "stream@1")]
	Stream {
		cause: EntryId,
		sid:   omp_dom::Sid,
		op:    omp_dom::StreamOp,
		node:  Option<omp_dom::Handle>,
		prop:  Option<omp_dom::PropKey>,
		text:  Option<Str>,
	},
}

fn decode_event(record: &JournalRecord) -> Result<Event, CollabCommandFault> {
	let event: ReplicatedEvent = serde_json::from_slice(&record.transcript_v4_json)?;
	Ok(match event {
		ReplicatedEvent::Patch { data } => Event::Patch(data),
		ReplicatedEvent::Reset { data } => {
			Event::Reset { snapshot: Snapshot::from_bytes(data.get().as_bytes())? }
		},
		ReplicatedEvent::Stream { cause, sid, op, node, prop, text } => {
			Event::Stream { cause, sid, op, node, prop, text }
		},
	})
}

fn snapshot_frame(sequence: u64, bytes: Bytes, r#final: bool, watermark: u64) -> CollabFrame {
	CollabFrame {
		protocol_revision: PROTOCOL_REVISION,
		sequence,
		payload: Some(collab_frame::Payload::SnapshotChunk(SnapshotChunk {
			entries: vec![JournalRecord {
				revision:           sequence,
				transcript_v4_json: bytes,
				visibility_class:   VisibilityClass::PublicTranscript as i32,
			}],
			r#final,
			host_revision_watermark: watermark,
		})),
		..CollabFrame::default()
	}
}

fn live_record_frame(sequence: u64, record: JournalRecord) -> CollabFrame {
	CollabFrame {
		protocol_revision: PROTOCOL_REVISION,
		sequence,
		payload: Some(collab_frame::Payload::JournalRecord(record)),
		..CollabFrame::default()
	}
}

/// Starts the native relay-backed command owner.
#[must_use]
pub fn spawn_session_owner(authority: CollabSessionAuthority) -> JoinHandle<()> {
	tokio::spawn(authority.run())
}

#[cfg(test)]
mod tests {
	use super::*;

	fn pending_view(id: &'static str) -> GuestView {
		let (reply, _) = flume::bounded(1);
		GuestView {
			agent_id: Str::new_static(id),
			reply:    Some(reply),
			events:   None,
			chunks:   Vec::new(),
			next:     0,
		}
	}

	#[test]
	fn agent_view_request_ids_skip_live_ids_across_wrap() {
		let mut views = BTreeMap::new();
		views.insert(1, pending_view("one"));
		let mut next = u32::MAX;
		assert_eq!(allocate_view_id(&mut next, &views), Some(2));
	}

	#[test]
	fn replica_snapshot_fragment_count_is_bounded_before_decoding() {
		let records = (0..=SNAPSHOT_CHUNK_MAX_COUNT)
			.map(|_| JournalRecord::default())
			.collect::<Vec<_>>();
		assert!(matches!(
			decode_snapshot_chunks(&records),
			Err(CollabCommandFault::SnapshotTooLarge { maximum: SNAPSHOT_MAX_BYTES, .. })
		));
	}
}
