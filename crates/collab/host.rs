//! Host-side peer authentication, visibility classification, and mutation
//! admission.

use std::{collections::BTreeMap, error::Error as StdError, str};

use omp_core::{CredentialTier, Hash32, RemotePrincipal, Str, sf};
use omp_proto::collab::v1::{
	AbortRequest, AgentCommand, CollabFrame, Hello, PromptRequest, UiRequest, UiRequestEnd,
	UiResponse, VisibilityClass as WireVisibility, agent_command, collab_frame,
};
use prost::Message;
use thiserror::Error;

use crate::{
	PROTOCOL_REVISION,
	codec::{FIELD_MAX_BYTES, REPEATED_MAX_COUNT},
	crypto::WriteToken,
};

const DISPLAY_NAME_MAX_CHARS: usize = 64;

/// Explicit host projection visibility; host-local facts never serialize to
/// peers.
#[derive(Clone, Copy, Debug, Eq, PartialEq, strum::IntoStaticStr)]
#[strum(serialize_all = "snake_case")]
pub enum VisibilityClass {
	/// Canonical public transcript content.
	PublicTranscript,
	/// Credential-free state used only for remote presentation.
	PublicPresentation,
	/// Host credentials, internals, advisors, raw providers, or local resources.
	HostLocal,
}

impl VisibilityClass {
	/// Converts a public class to the protobuf vocabulary.
	pub const fn to_wire(self) -> WireVisibility {
		match self {
			Self::PublicTranscript => WireVisibility::PublicTranscript,
			Self::PublicPresentation => WireVisibility::PublicPresentation,
			Self::HostLocal => WireVisibility::HostLocalOmitted,
		}
	}
}

/// Mutation action named in targeted read-only rejection frames.
#[derive(Clone, Copy, Debug, Eq, PartialEq, strum::Display)]
#[strum(serialize_all = "snake_case")]
pub enum MutationAction {
	/// Submit a user prompt or images.
	Prompt,
	/// Interrupt the active host generation.
	Abort,
	/// Chat with, kill, or revive a visible agent.
	AgentCommand,
	/// Answer a host UI request.
	UiResponse,
}

/// Host-authenticated peer retained after a successful hello.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct AuthenticatedPeer {
	principal: RemotePrincipal,
}

impl AuthenticatedPeer {
	/// Returns the immutable principal stamped onto admitted mutations.
	pub const fn principal(&self) -> &RemotePrincipal {
		&self.principal
	}

	/// Returns whether this peer is restricted to observation.
	pub fn read_only(&self) -> bool {
		!self.principal.may_mutate()
	}
}

/// Host-side credential authority for one encrypted collaboration room.
pub struct HostAdmission {
	room_id:     Str,
	write_token: WriteToken,
}

impl HostAdmission {
	/// Creates a room-scoped host admission authority.
	pub const fn new(room_id: Str, write_token: WriteToken) -> Self {
		Self { room_id, write_token }
	}

	/// Validates protocol version, sanitizes the peer name, and classifies
	/// credentials.
	pub fn authenticate(
		&self,
		peer_id: u32,
		hello: &Hello,
	) -> Result<AuthenticatedPeer, AdmissionError> {
		if hello.protocol_revision != PROTOCOL_REVISION {
			return Err(AdmissionError::ProtocolMismatch {
				expected: PROTOCOL_REVISION,
				actual:   hello.protocol_revision,
			});
		}
		let display_name = sanitize_display_name(hello.display_name.as_str(), peer_id);
		let writable = hello
			.write_token
			.as_deref()
			.is_some_and(|candidate| self.write_token.matches(candidate));
		let credential_tier = if writable {
			CredentialTier::FullAccess
		} else {
			CredentialTier::ReadOnly
		};
		let token_digest = writable.then(|| Hash32::sum(self.write_token.as_bytes()));
		Ok(AuthenticatedPeer {
			principal: RemotePrincipal::new(
				peer_id,
				display_name,
				credential_tier,
				self.room_id.clone(),
				token_digest,
			),
		})
	}

	/// Admits only authenticated writable mutation frames and stamps their
	/// principal.
	pub fn admit_mutation(
		&self,
		peer: &AuthenticatedPeer,
		payload: &collab_frame::Payload,
	) -> Result<AuthorizedMutation, AdmissionError> {
		let (action, operation) = match payload {
			collab_frame::Payload::Prompt(request) => {
				(MutationAction::Prompt, RemoteOperation::Prompt(Box::new(request.clone())))
			},
			collab_frame::Payload::Abort(request) => {
				(MutationAction::Abort, RemoteOperation::Abort(Box::new(request.clone())))
			},
			collab_frame::Payload::AgentCommand(request) => {
				(MutationAction::AgentCommand, RemoteOperation::AgentCommand(Box::new(request.clone())))
			},
			collab_frame::Payload::UiResponse(response) => {
				(MutationAction::UiResponse, RemoteOperation::UiResponse(Box::new(response.clone())))
			},
			_ => return Err(AdmissionError::NotMutation),
		};
		if !peer.principal.may_mutate() {
			return Err(AdmissionError::ReadOnly { action });
		}
		Ok(AuthorizedMutation { principal: peer.principal.clone(), operation })
	}
}

/// One foreign protobuf mutation admitted with its immutable remote principal.
#[derive(Clone, Debug)]
pub struct AuthorizedMutation {
	/// Authenticated peer facts carried through Core, Environment, and
	/// approvals.
	pub principal: RemotePrincipal,
	/// Requested operation; protobuf payloads are boxed because generated
	/// foreign messages can grow independently of this compact authorization
	/// envelope.
	pub operation: RemoteOperation,
}

/// Mutation operation accepted by host admission.
#[derive(Clone, Debug)]
pub enum RemoteOperation {
	/// Canonical remote user prompt and optional images.
	Prompt(Box<PromptRequest>),
	/// User interrupt request.
	Abort(Box<AbortRequest>),
	/// Visible-agent chat, kill, or revive request.
	AgentCommand(Box<AgentCommand>),
	/// Response to one active host UI request.
	UiResponse(Box<UiResponse>),
}

/// Host admission failure suitable for a targeted protocol error frame.
#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
pub enum AdmissionError {
	/// Peer and host use incompatible OMP collaboration revisions.
	#[error("collaboration protocol mismatch: host speaks v{expected}, guest sent v{actual}")]
	ProtocolMismatch {
		/// Host protocol revision.
		expected: u32,
		/// Guest protocol revision.
		actual:   u32,
	},
	/// A non-mutation frame was presented to mutation admission.
	#[error("collaboration frame is not a guest mutation")]
	NotMutation,
	/// A read-only peer attempted a mutation.
	#[error("{action} is disabled on a read-only collaboration link")]
	ReadOnly {
		/// Rejected action.
		action: MutationAction,
	},
}
/// Maximum number of unanswered host dialogs retained at once.
pub const MAX_PENDING_UI_REQUESTS: usize = 64;

/// One peer-targeted host frame.
#[derive(Clone, Debug)]
pub struct TargetedFrame {
	/// Destination relay peer.
	pub peer_id: u32,
	/// Plain collaboration payload; the relay owner encrypts it.
	pub frame:   CollabFrame,
}

/// First writable-guest answer to a host UI request.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HostUiAnswer {
	/// Settled request identity.
	pub request_id: u32,
	/// Answering peer.
	pub peer_id:    u32,
	/// Selected/editor value; `None` is a genuine guest cancel.
	pub value:      Option<String>,
}

/// Host-owned UI request set with writable-only broadcast and late-join replay.
#[derive(Default)]
pub struct HostUiDispatcher {
	next_id: u32,
	pending: BTreeMap<u32, UiRequest>,
}

impl HostUiDispatcher {
	/// Starts a request and emits it to every currently writable guest.
	///
	/// Returns `None` without retaining the request when no writable peer is
	/// connected.
	pub fn begin<'a>(
		&mut self,
		mut request: UiRequest,
		peers: impl IntoIterator<Item = (u32, &'a AuthenticatedPeer)>,
	) -> Result<Vec<TargetedFrame>, HostUiBeginError> {
		let encoded = request.encoded_len();
		let options = request.spec.as_ref().map_or(0, |spec| match spec {
			omp_proto::collab::v1::ui_request::Spec::Select(select) => select.options.len(),
			omp_proto::collab::v1::ui_request::Spec::Editor(_) => 0,
		});
		if encoded > FIELD_MAX_BYTES || options > REPEATED_MAX_COUNT {
			return Err(HostUiBeginError::PayloadTooLarge {
				actual:  encoded,
				maximum: FIELD_MAX_BYTES,
			});
		}
		if self.pending.len() >= MAX_PENDING_UI_REQUESTS {
			return Err(HostUiBeginError::Capacity { maximum: MAX_PENDING_UI_REQUESTS });
		}
		let writable = peers
			.into_iter()
			.filter(|(_, peer)| !peer.read_only())
			.map(|(peer_id, _)| peer_id)
			.collect::<Vec<_>>();
		if writable.is_empty() {
			return Err(HostUiBeginError::NoWritablePeer);
		}
		let request_id = (1..=u32::MAX)
			.find_map(|_| {
				self.next_id = self.next_id.wrapping_add(1).max(1);
				(!self.pending.contains_key(&self.next_id)).then_some(self.next_id)
			})
			.ok_or(HostUiBeginError::IdExhausted)?;
		request.request_id = request_id;
		let frame = collab_frame(request.clone(), collab_frame::Payload::UiRequest);
		self.pending.insert(request_id, request);
		Ok(writable
			.into_iter()
			.map(|peer_id| TargetedFrame { peer_id, frame: frame.clone() })
			.collect())
	}

	/// Replays every pending request to a newly authenticated writable guest.
	pub fn replay_for_join(&self, peer_id: u32, peer: &AuthenticatedPeer) -> Vec<TargetedFrame> {
		if peer.read_only() {
			return Vec::new();
		}
		self
			.pending
			.values()
			.map(|request| TargetedFrame {
				peer_id,
				frame: collab_frame(request.clone(), collab_frame::Payload::UiRequest),
			})
			.collect()
	}

	/// Settles a pending request on the first writable response and emits
	/// `ui_request_end` cleanup to all writable peers.
	pub fn answer<'a>(
		&mut self,
		peer_id: u32,
		peer: &AuthenticatedPeer,
		response: UiResponse,
		peers: impl IntoIterator<Item = (u32, &'a AuthenticatedPeer)>,
	) -> Result<Option<(HostUiAnswer, Vec<TargetedFrame>)>, HostRouteError> {
		if peer.read_only() {
			return Err(HostRouteError::ReadOnly);
		}
		if self.pending.remove(&response.request_id).is_none() {
			return Ok(None);
		}
		let answer = HostUiAnswer { request_id: response.request_id, peer_id, value: response.value };
		let end = UiRequestEnd { request_id: answer.request_id };
		let frame = collab_frame(end, collab_frame::Payload::UiRequestEnd);
		let cleanup = peers
			.into_iter()
			.filter(|(_, peer)| !peer.read_only())
			.map(|(peer_id, _)| TargetedFrame { peer_id, frame: frame.clone() })
			.collect();
		Ok(Some((answer, cleanup)))
	}

	/// Cancels one host request and emits writable-guest cleanup.
	pub fn cancel<'a>(
		&mut self,
		request_id: u32,
		peers: impl IntoIterator<Item = (u32, &'a AuthenticatedPeer)>,
	) -> Vec<TargetedFrame> {
		if self.pending.remove(&request_id).is_none() {
			return Vec::new();
		}
		let end = UiRequestEnd { request_id };
		let frame = collab_frame(end, collab_frame::Payload::UiRequestEnd);
		peers
			.into_iter()
			.filter(|(_, peer)| !peer.read_only())
			.map(|(peer_id, _)| TargetedFrame { peer_id, frame: frame.clone() })
			.collect()
	}

	/// Drains every request during host teardown.
	pub fn cancel_all<'a>(
		&mut self,
		peers: impl IntoIterator<Item = (u32, &'a AuthenticatedPeer)> + Clone,
	) -> Vec<TargetedFrame> {
		let ids = self.pending.keys().copied().collect::<Vec<_>>();
		let mut frames = Vec::new();
		for id in ids {
			frames.extend(self.cancel(id, peers.clone()));
		}
		frames
	}
}

/// Host agent class used to keep advisors outside the collaboration surface.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HostAgentClass {
	/// Main session loop.
	Main,
	/// User-visible task subagent.
	Subagent,
	/// Read-only advisor transcript.
	Advisor,
}

/// App-owned agent lifecycle operations callable by authorized guests.
pub trait HostAgentRuntime {
	/// Concrete lifecycle failure.
	type Error: StdError + Send + Sync + 'static;

	/// Classifies one registry identity, or returns `None` when absent.
	fn class(&self, agent_id: &str) -> Option<HostAgentClass>;
	/// Revives if needed and steers a chat message.
	fn chat(&self, agent_id: &str, text: &str) -> Result<(), Self::Error>;
	/// Aborts a running loop and releases it.
	fn kill(&self, agent_id: &str) -> Result<(), Self::Error>;
	/// Revives a parked or cold agent.
	fn revive(&self, agent_id: &str) -> Result<(), Self::Error>;
}

/// Routes one authenticated guest agent operation.
pub fn route_agent_command<R: HostAgentRuntime>(
	peer: &AuthenticatedPeer,
	command: &AgentCommand,
	runtime: &R,
) -> Result<(), AgentCommandError<R::Error>> {
	if peer.read_only() {
		return Err(AgentCommandError::ReadOnly);
	}
	let Some(class) = runtime.class(command.agent_id.as_str()) else {
		return Err(AgentCommandError::UnknownAgent);
	};
	if class == HostAgentClass::Advisor {
		return Err(AgentCommandError::Advisor);
	}
	match agent_command::Command::try_from(command.command) {
		Ok(agent_command::Command::Chat) => {
			let text = command
				.text
				.as_deref()
				.map(str::trim)
				.filter(|text| !text.is_empty())
				.ok_or(AgentCommandError::EmptyChat)?;
			runtime.chat(&command.agent_id, text)?;
		},
		Ok(agent_command::Command::Kill) => runtime.kill(&command.agent_id)?,
		Ok(agent_command::Command::Revive) => runtime.revive(&command.agent_id)?,
		Err(_) => return Err(AgentCommandError::UnknownCommand),
	}
	Ok(())
}

fn collab_frame<T>(message: T, wrap: impl FnOnce(T) -> collab_frame::Payload) -> CollabFrame {
	CollabFrame {
		protocol_revision: PROTOCOL_REVISION,
		payload: Some(wrap(message)),
		..CollabFrame::default()
	}
}

/// Failure to start a host UI broadcast.
#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
pub enum HostUiBeginError {
	/// No connected editor can answer.
	#[error("no writable collaboration peer is connected")]
	NoWritablePeer,
	/// The request exceeds the bounded frame budget.
	#[error("collaboration UI request uses {actual} bytes; maximum is {maximum}")]
	PayloadTooLarge {
		/// Encoded protobuf byte count.
		actual:  usize,
		/// Maximum accepted byte count.
		maximum: usize,
	},
	/// The bounded correlation table is full.
	#[error("collaboration UI request capacity {maximum} is exhausted")]
	Capacity {
		/// Maximum simultaneous requests.
		maximum: usize,
	},
	/// Every non-zero request identity is still live.
	#[error("collaboration UI request identities are exhausted")]
	IdExhausted,
}

/// Host UI routing failure.
#[derive(Clone, Copy, Debug, Eq, Error, PartialEq)]
pub enum HostRouteError {
	/// A viewer attempted to answer a dialog.
	#[error("UI responses are disabled on a read-only collaboration link")]
	ReadOnly,
}

/// Guest agent-command routing failure.
#[derive(Debug, Error)]
pub enum AgentCommandError<E: StdError + 'static> {
	/// A viewer attempted agent control.
	#[error("agent control is disabled on a read-only collaboration link")]
	ReadOnly,
	/// The requested agent is absent.
	#[error("collaboration agent does not exist")]
	UnknownAgent,
	/// Advisors never enter the guest-visible registry.
	#[error("advisor transcripts are read-only")]
	Advisor,
	/// Chat requires non-whitespace text.
	#[error("collaboration agent chat message is empty")]
	EmptyChat,
	/// The wire carried an unknown command enum value.
	#[error("collaboration agent command is unknown")]
	UnknownCommand,
	/// The app-owned lifecycle operation failed.
	#[error(transparent)]
	Runtime(#[from] E),
}

/// Classifies an agent registry row without exposing advisor identities.
pub const fn registry_visibility(is_advisor: bool) -> VisibilityClass {
	if is_advisor {
		VisibilityClass::HostLocal
	} else {
		VisibilityClass::PublicPresentation
	}
}

/// Classifies `EventBus` channels; only the two task channels are peer-visible.
pub fn bus_visibility(channel: i32) -> VisibilityClass {
	use omp_proto::collab::v1::bus_event::Channel;
	match Channel::try_from(channel) {
		Ok(Channel::TaskSubagentProgress | Channel::TaskSubagentLifecycle) => {
			VisibilityClass::PublicPresentation
		},
		_ => VisibilityClass::HostLocal,
	}
}

fn sanitize_display_name(name: &str, peer_id: u32) -> Str {
	let name = name.trim();
	if name.is_empty() {
		return sf!("guest-{peer_id}");
	}
	let end = name
		.char_indices()
		.nth(DISPLAY_NAME_MAX_CHARS)
		.map_or(name.len(), |(index, _)| index);
	Str::new(&name[..end])
}

#[cfg(test)]
mod tests {

	use omp_proto::collab::v1::{self, ui_request};

	use super::*;

	fn admission() -> HostAdmission {
		HostAdmission::new(sf!("room"), WriteToken::from_bytes([9; 16]))
	}

	#[test]
	fn hello_classifies_timing_safe_credentials_and_sanitizes_name() {
		let authority = admission();
		let full = authority
			.authenticate(7, &Hello {
				protocol_revision: PROTOCOL_REVISION,
				display_name:      "  guest  ".to_owned(),
				write_token:       Some(vec![9; 16].into()),
				client_version:    String::new(),
			})
			.expect("authenticate");
		assert_eq!(full.principal().display_name(), "guest");
		assert_eq!(full.principal().credential_tier(), CredentialTier::FullAccess);
		assert!(full.principal().token_digest().is_some());
	}

	#[test]
	fn read_only_mutations_are_rejected_at_host_admission() {
		let authority = admission();
		let peer = authority
			.authenticate(2, &Hello {
				protocol_revision: PROTOCOL_REVISION,
				display_name:      String::new(),
				write_token:       None,
				client_version:    String::new(),
			})
			.expect("authenticate");
		let payload = collab_frame::Payload::Abort(AbortRequest { reason: String::new() });
		assert_eq!(
			authority.admit_mutation(&peer, &payload).unwrap_err(),
			AdmissionError::ReadOnly { action: MutationAction::Abort }
		);
	}
	#[test]
	fn ui_dispatch_capacity_and_no_editor_are_typed() {
		let authority = admission();
		let viewer = authority
			.authenticate(2, &Hello {
				protocol_revision: PROTOCOL_REVISION,
				display_name:      "viewer".to_owned(),
				write_token:       None,
				client_version:    String::new(),
			})
			.expect("authenticate");
		let writable = authority
			.authenticate(7, &Hello {
				protocol_revision: PROTOCOL_REVISION,
				display_name:      "editor".to_owned(),
				write_token:       Some(vec![9; 16].into()),
				client_version:    String::new(),
			})
			.expect("authenticate");
		let mut dispatcher = HostUiDispatcher::default();
		assert_eq!(
			dispatcher
				.begin(UiRequest::default(), [(2, &viewer)])
				.unwrap_err(),
			HostUiBeginError::NoWritablePeer
		);
		assert!(matches!(
			dispatcher
				.begin(UiRequest { title: "x".repeat(FIELD_MAX_BYTES + 1), ..UiRequest::default() }, [
					(7, &writable)
				]),
			Err(HostUiBeginError::PayloadTooLarge { .. })
		));
		for _ in 0..MAX_PENDING_UI_REQUESTS {
			dispatcher
				.begin(UiRequest::default(), [(7, &writable)])
				.expect("within cap");
		}
		assert_eq!(
			dispatcher
				.begin(UiRequest::default(), [(7, &writable)])
				.unwrap_err(),
			HostUiBeginError::Capacity { maximum: MAX_PENDING_UI_REQUESTS }
		);
	}

	#[test]
	fn ui_dispatch_settles_first_writable_answer_and_replays_late_joiners() {
		let authority = admission();
		let writable = authority
			.authenticate(7, &Hello {
				protocol_revision: PROTOCOL_REVISION,
				display_name:      "guest".to_owned(),
				write_token:       Some(vec![9; 16].into()),
				client_version:    String::new(),
			})
			.expect("authenticate");
		let mut dispatcher = HostUiDispatcher::default();
		let frames = dispatcher
			.begin(
				UiRequest {
					title: "Choose".to_owned(),
					spec: Some(ui_request::Spec::Editor(v1::EditorSpec { prefill: None })),
					..UiRequest::default()
				},
				[(7, &writable)],
			)
			.expect("writable peer");
		let request_id = match frames[0].frame.payload.as_ref() {
			Some(collab_frame::Payload::UiRequest(request)) => request.request_id,
			_ => panic!("UI request frame"),
		};
		assert_eq!(dispatcher.replay_for_join(8, &writable).len(), 1);

		let settled = dispatcher
			.answer(7, &writable, UiResponse { request_id, value: Some("answer".to_owned()) }, [
				(7, &writable),
				(8, &writable),
			])
			.expect("answer")
			.expect("first answer");
		assert_eq!(settled.0.value.as_deref(), Some("answer"));
		assert_eq!(settled.1.len(), 2);
		assert!(
			dispatcher
				.answer(7, &writable, UiResponse { request_id, value: None }, [(7, &writable)],)
				.expect("duplicate")
				.is_none()
		);
	}
}
