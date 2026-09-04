//! Recipient-owned IRC side-channel replies.
//!
//! A busy recipient alone accepts the obligation. The model call is ephemeral,
//! and its result crosses back through the same authenticated session authority
//! as ordinary peer traffic.

use std::{
	future::Future,
	pin::Pin,
	sync::{
		Arc, Weak,
		atomic::{AtomicBool, Ordering},
	},
	time::{Duration, SystemTime, UNIX_EPOCH},
};

use futures::StreamExt as _;
use omp_agent::{AutoreplyRequest, PeerAutoreply, ReplyObligations, Up};
use omp_ai::{
	AnswerBody, Call, CallMeta, ChatEvent, ChatRequest, ContentPart, ExecutionBudget, Message,
	NegotiationPolicy, OperationCall, RequestId, Role, Sampling, Setting, Target,
};
use omp_core::{Str, StrMut, Ulid};
use omp_dom::Dom;
use omp_journal::data::{IrcDirection, IrcTraffic};
use parking_lot::{Mutex, RwLock};
use thiserror::Error;
use tokio_util::sync::CancellationToken;

use super::hub::deliver_authenticated_peer;
use crate::{
	headless::{gateway::GatewayInference, kernel::ComposedInference},
	sessions::{SessionId, SessionRegistry},
};

type ReplyFuture<'a> = Pin<Box<dyn Future<Output = Result<Str, AutoreplyError>> + Send + 'a>>;

trait ReplyModel: Send + Sync {
	fn reply<'a>(
		&'a self,
		snapshot: omp_dom::Snapshot,
		blobs: &'a omp_journal::blob::BlobStore,
		request: &'a AutoreplyRequest,
		cancel: CancellationToken,
	) -> ReplyFuture<'a>;
}

/// Cloneable model authority for ephemeral peer replies.
#[derive(Clone)]
enum AutoreplyClient {
	Production { registry: omp_ai::Registry, target: Target },
	Gateway(GatewayInference),
}

impl AutoreplyClient {
	fn from_composed(inference: &ComposedInference) -> Option<Self> {
		if let Some(stack) = inference.production_stack() {
			return Some(Self::Production {
				registry: stack.registry.clone(),
				target:   inference.side_channel_target()?,
			});
		}
		match inference {
			ComposedInference::Gateway { inference, .. } => Some(Self::Gateway(inference.clone())),
			ComposedInference::Production(_) => None,
		}
	}
}

impl ReplyModel for AutoreplyClient {
	fn reply<'a>(
		&'a self,
		snapshot: omp_dom::Snapshot,
		blobs: &'a omp_journal::blob::BlobStore,
		request: &'a AutoreplyRequest,
		cancel: CancellationToken,
	) -> ReplyFuture<'a> {
		Box::pin(async move {
			let request = build_request(snapshot, blobs, request)?;
			let mut stream = match self {
				Self::Production { registry, target } => {
					let meta = CallMeta {
						id:             RequestId::from(format!("irc-autoreply-{}", Ulid::generate())),
						target:         target.clone(),
						deadline:       None,
						budget:         ExecutionBudget::default(),
						session:        None,
						debug_session:  None,
						response_hooks: Default::default(),
					};
					let execute = omp_ai::router::execute_registry_call(
						registry.clone(),
						Call::new(meta, OperationCall::Chat(Arc::new(request))),
						Duration::from_secs(120),
					);
					let answer = tokio::select! {
						biased;
						() = cancel.cancelled() => return Err(AutoreplyError::Cancelled),
						answer = execute => answer.map_err(|source| AutoreplyError::Inference { source })?,
					};
					let AnswerBody::Chat(stream) = answer.body else {
						return Err(AutoreplyError::EmptyOutput);
					};
					stream
				},
				Self::Gateway(inference) => {
					let mut inference = inference.clone();
					tokio::select! {
						biased;
						() = cancel.cancelled() => return Err(AutoreplyError::Cancelled),
						stream = omp_agent::Inference::chat(&mut inference, request) => {
							stream.map_err(|source| AutoreplyError::Inference { source })?
						},
					}
				},
			};
			let mut output = StrMut::new("");
			loop {
				let event = tokio::select! {
					biased;
					() = cancel.cancelled() => return Err(AutoreplyError::Cancelled),
					event = stream.next() => event,
				};
				let Some(event) = event else { break };
				match event.map_err(|source| AutoreplyError::Inference { source })? {
					ChatEvent::TextDelta { text, .. } => output.push_str(text.as_str()),
					ChatEvent::Started(_)
					| ChatEvent::BlockStarted { .. }
					| ChatEvent::ThinkingDelta { .. }
					| ChatEvent::ToolCallStarted { .. }
					| ChatEvent::ToolArgumentsDelta { .. }
					| ChatEvent::ToolCallReady { .. }
					| ChatEvent::Artifact { .. }
					| ChatEvent::Usage(_)
					| ChatEvent::WorkflowAction(_)
					| ChatEvent::WorkflowResume(_)
					| ChatEvent::WorkflowCancelled { .. }
					| ChatEvent::Completed(_) => {},
				}
			}
			let output = output.freeze();
			let body = output.trim();
			if body.is_empty() {
				Err(AutoreplyError::EmptyOutput)
			} else {
				Ok(Str::new(body))
			}
		})
	}
}

/// Creates the recipient-owned producer installed on one live endpoint.
pub fn producer(
	inference: &ComposedInference,
	registry: &Arc<SessionRegistry>,
	up: flume::Sender<Up>,
	active: Arc<AtomicBool>,
	cancel: CancellationToken,
	obligations: ReplyObligations,
	blobs: omp_journal::blob::BlobStore,
) -> Option<Arc<dyn PeerAutoreply>> {
	let model = Arc::new(AutoreplyClient::from_composed(inference)?);
	let generation_cancel = cancel.child_token();
	Some(Arc::new(SessionAutoreply {
		model,
		registry: Arc::downgrade(registry),
		generation: RwLock::new(Str::new(Ulid::generate().to_string())),
		up,
		active,
		cancel,
		generation_cancel: Mutex::new(generation_cancel),
		obligations,
		blobs: RwLock::new(blobs),
	}))
}

struct SessionAutoreply {
	model:             Arc<dyn ReplyModel>,
	registry:          Weak<SessionRegistry>,
	generation:        RwLock<Str>,
	up:                flume::Sender<Up>,
	active:            Arc<AtomicBool>,
	cancel:            CancellationToken,
	generation_cancel: Mutex<CancellationToken>,
	obligations:       ReplyObligations,
	blobs:             RwLock<omp_journal::blob::BlobStore>,
}

impl PeerAutoreply for SessionAutoreply {
	fn generation(&self) -> Str {
		self.generation.read().clone()
	}

	fn start(&self, request: AutoreplyRequest) -> bool {
		if !self.active.load(Ordering::Acquire) || self.cancel.is_cancelled() {
			return false;
		}
		let generation = self.generation();
		let Some(registry) = self.registry.upgrade() else {
			return false;
		};
		let sender_is_live = registry
			.lookup(SessionId::from_ref(request.from_id.as_str()))
			.is_some_and(|live| live.name == request.from);
		let addressed = registry
			.lookup(SessionId::from_ref(request.to_id.as_str()))
			.filter(|live| live.name == request.to)
			.and_then(|live| live.autoreply)
			.is_some_and(|producer| producer.generation() == generation);
		if !sender_is_live || !addressed {
			return false;
		}
		let obligation = self.obligations.begin();
		if !self.active.load(Ordering::Acquire) || self.cancel.is_cancelled() {
			drop(obligation);
			return false;
		}
		let model = Arc::clone(&self.model);
		let registry = self.registry.clone();
		let up = self.up.clone();
		let cancel = self.generation_cancel.lock().child_token();
		let blobs = self.blobs.read().clone();
		tokio::spawn(async move {
			let _obligation = obligation;
			if let Err(error) = run(model, registry, generation, up, blobs, request, cancel).await
				&& !matches!(error, AutoreplyError::Cancelled | AutoreplyError::StaleSession)
			{
				tracing::warn!(%error, "IRC automatic reply failed");
			}
		});
		true
	}

	fn rebind(&self, blobs: omp_journal::blob::BlobStore) {
		let mut generation_cancel = self.generation_cancel.lock();
		generation_cancel.cancel();
		*generation_cancel = self.cancel.child_token();
		*self.generation.write() = Str::new(Ulid::generate().to_string());
		*self.blobs.write() = blobs;
	}

	fn cancel(&self) {
		self.cancel.cancel();
		self.generation_cancel.lock().cancel();
	}
}

async fn run(
	model: Arc<dyn ReplyModel>,
	registry: Weak<SessionRegistry>,
	generation: Str,
	up: flume::Sender<Up>,
	blobs: omp_journal::blob::BlobStore,
	request: AutoreplyRequest,
	cancel: CancellationToken,
) -> Result<(), AutoreplyError> {
	let (reply, receive) = flume::bounded(1);
	up.send(Up::Subscribe(reply))
		.map_err(|_| AutoreplyError::StaleSession)?;
	let (snapshot, _) = tokio::select! {
		biased;
		() = cancel.cancelled() => return Err(AutoreplyError::Cancelled),
		subscription = receive.recv_async() => subscription.map_err(|_| AutoreplyError::StaleSession)?,
	};
	let body = model
		.reply(snapshot, &blobs, &request, cancel.clone())
		.await?;
	if cancel.is_cancelled() {
		return Err(AutoreplyError::Cancelled);
	}
	let registry = registry.upgrade().ok_or(AutoreplyError::StaleSession)?;
	let recipient = registry
		.lookup(SessionId::from_ref(request.to_id.as_str()))
		.filter(|live| {
			live.name == request.to
				&& live
					.autoreply
					.as_ref()
					.is_some_and(|producer| producer.generation() == generation)
		})
		.ok_or(AutoreplyError::StaleSession)?;
	let sender = registry
		.lookup(SessionId::from_ref(request.from_id.as_str()))
		.filter(|live| live.name == request.from)
		.ok_or(AutoreplyError::StaleSender)?;
	let timestamp_ms = unix_timestamp_ms();
	let observation = IrcTraffic {
		direction: IrcDirection::Autoreply,
		from: Some(recipient.name.clone()),
		to: Some(sender.name.clone()),
		body: body.clone(),
		reply_to: Some(request.message_id.clone()),
		pool: None,
		mode: None,
		timestamp_ms,
	};
	let (committed, receipt) = flume::bounded(1);
	recipient
		.up
		.send(Up::Autoreply { payload: Arc::new(observation), committed })
		.map_err(|_| AutoreplyError::StaleSession)?;
	let journaled = tokio::select! {
		biased;
		() = cancel.cancelled() => return Err(AutoreplyError::Cancelled),
		journaled = receipt.recv_async() => journaled.map_err(|_| AutoreplyError::StaleSession)?,
	};
	if !journaled {
		return Err(AutoreplyError::CommitFailed);
	}
	deliver_authenticated_peer(
		registry.as_ref(),
		&sender.endpoint(),
		&recipient.endpoint(),
		body,
		Some(request.message_id),
		timestamp_ms,
		false,
	)
	.then_some(())
	.ok_or(AutoreplyError::StaleSender)
}

fn build_request(
	snapshot: omp_dom::Snapshot,
	blobs: &omp_journal::blob::BlobStore,
	request: &AutoreplyRequest,
) -> Result<ChatRequest, AutoreplyError> {
	let dom = Dom::from_snapshot(&snapshot);
	let mut items = omp_agent::PromptSource::system_items(&omp_agent::CanonicalPromptSource, &dom)
		.map_err(|source| AutoreplyError::Prompt { source })?;
	items.extend(
		omp_agent::project_thread_with_attachments(&dom, blobs)
			.map_err(|source| AutoreplyError::Blob { source })?,
	);
	let mut messages =
		Message::from_thread_items(&items).map_err(|source| AutoreplyError::Projection { source })?;
	let mut prompt = StrMut::new("<irc>\nIRC message from agent `");
	prompt.push_str(request.from.as_str());
	prompt.push_str("`");
	if let Some(reply_to) = &request.reply_to {
		prompt.push_str(" (replying to ");
		prompt.push_str(reply_to.as_str());
		prompt.push(')');
	}
	prompt.push_str(
		", mid-task. Side-channel: reply briefly, directly; use available conversation context. \
		 NEVER call tools. Text delivered to the sender as your answer.\n\nMessage:\n",
	);
	prompt.push_str(request.body.as_str());
	prompt.push_str("\n</irc>");
	messages.push(Message {
		role:    Role::User,
		content: Arc::from([ContentPart::Text { text: prompt.freeze(), proof: None }]),
		name:    None,
	});
	Ok(ChatRequest {
		messages:          messages.into(),
		tools:             Arc::from([]),
		hosted_tools:      Arc::from([]),
		tool_choice:       Setting::Unset,
		output:            Setting::Unset,
		reasoning:         Setting::Unset,
		verbosity:         Setting::Unset,
		cache_retention:   Setting::Unset,
		service_tier:      Setting::Unset,
		sampling:          Sampling::default(),
		max_output_tokens: Some(1_536),
		top_logprobs:      None,
		safety:            Arc::from([]),
		negotiation:       NegotiationPolicy::default(),
		forced_call:       None,
	})
}

fn unix_timestamp_ms() -> u64 {
	SystemTime::now()
		.duration_since(UNIX_EPOCH)
		.map_or(0, |elapsed| u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX))
}

#[derive(Debug, Error)]
enum AutoreplyError {
	#[error("automatic peer reply was cancelled")]
	Cancelled,
	#[error("recipient session changed before automatic reply delivery")]
	StaleSession,
	#[error("sender session changed before automatic reply delivery")]
	StaleSender,
	#[error("automatic peer reply inference failed")]
	Inference {
		#[source]
		source: omp_ai::Error,
	},
	#[error("automatic peer reply system prompt projection failed")]
	Prompt {
		#[source]
		source: omp_agent::PromptError,
	},
	#[error("automatic peer reply attachment materialization failed")]
	Blob {
		#[source]
		source: omp_journal::blob::Error,
	},
	#[error("automatic peer reply history projection failed")]
	Projection {
		#[source]
		source: omp_ai::ThreadProjectionError,
	},
	#[error("automatic peer reply completed without text")]
	EmptyOutput,
	#[error("automatic peer reply observation could not be journaled")]
	CommitFailed,
}

#[cfg(test)]
mod tests {
	use super::*;
	use crate::sessions::KernelHandle;

	struct FixedReply {
		body: Str,
	}

	impl ReplyModel for FixedReply {
		fn reply<'a>(
			&'a self,
			_snapshot: omp_dom::Snapshot,
			_blobs: &'a omp_journal::blob::BlobStore,
			_request: &'a AutoreplyRequest,
			_cancel: CancellationToken,
		) -> ReplyFuture<'a> {
			Box::pin(async move { Ok(self.body.clone()) })
		}
	}

	struct GatedReply {
		started: flume::Sender<()>,
		release: flume::Receiver<()>,
	}

	impl ReplyModel for GatedReply {
		fn reply<'a>(
			&'a self,
			_snapshot: omp_dom::Snapshot,
			_blobs: &'a omp_journal::blob::BlobStore,
			_request: &'a AutoreplyRequest,
			_cancel: CancellationToken,
		) -> ReplyFuture<'a> {
			Box::pin(async move {
				let _ = self.started.send(());
				self
					.release
					.recv_async()
					.await
					.map_err(|_| AutoreplyError::Cancelled)?;
				Ok(Str::new_static("later"))
			})
		}
	}

	fn endpoint(
		id: &'static str,
		name: &'static str,
		up: flume::Sender<Up>,
		autoreply: Option<Arc<dyn PeerAutoreply>>,
	) -> KernelHandle {
		KernelHandle {
			id: SessionId::new(id),
			name: Str::new_static(name),
			up,
			snapshot: Arc::new(RwLock::new(Dom::new().snapshot())),
			topology: omp_agent::SessionTopology::main(Str::new_static(id)),
			relay: crate::sessions::IrcRelayPolicy::default(),
			autoreply,
		}
	}

	fn request() -> AutoreplyRequest {
		AutoreplyRequest {
			message_id: Str::new_static("message-1"),
			from_id:    Str::new_static("sender-id"),
			from:       Str::new_static("Sender"),
			to_id:      Str::new_static("recipient-id"),
			to:         Str::new_static("Recipient"),
			body:       Str::new_static("Can you answer?"),
			reply_to:   Some(Str::new_static("prior")),
		}
	}

	#[tokio::test]
	async fn autoreply_journals_once_and_delivers_one_ordinary_peer_message() {
		let temp = tempfile::tempdir().expect("temporary directory");
		let blobs =
			omp_journal::blob::BlobStore::open(temp.path().join("artifacts")).expect("blob store");
		let registry = Arc::new(SessionRegistry::new());
		let (recipient_tx, recipient_rx) = flume::unbounded();
		let (sender_tx, sender_rx) = flume::unbounded();
		let obligations = ReplyObligations::default();
		let cancel = CancellationToken::new();
		let actor = Arc::new(SessionAutoreply {
			model: Arc::new(FixedReply { body: Str::new_static("brief answer") }),
			registry: Arc::downgrade(&registry),
			generation: RwLock::new(Str::new_static("generation-1")),
			up: recipient_tx.clone(),
			active: Arc::new(AtomicBool::new(true)),
			generation_cancel: Mutex::new(cancel.child_token()),
			cancel,
			obligations: obligations.clone(),
			blobs: RwLock::new(blobs),
		});
		let actor_dyn: Arc<dyn PeerAutoreply> = actor.clone();
		registry.register(
			Str::new_static("Recipient"),
			endpoint("recipient-id", "Recipient", recipient_tx, Some(actor_dyn)),
		);
		registry
			.register(Str::new_static("Sender"), endpoint("sender-id", "Sender", sender_tx, None));

		assert!(actor.start(request()));
		let Up::Subscribe(subscription) = recipient_rx.recv_async().await.expect("subscription")
		else {
			panic!("autoreply requests the live recipient snapshot");
		};
		let (_, patches) = flume::unbounded();
		subscription
			.send((Dom::new().snapshot(), patches))
			.expect("snapshot response");
		let Up::Autoreply { payload, committed } = recipient_rx
			.recv_async()
			.await
			.expect("autoreply observation")
		else {
			panic!("recipient receives an autoreply observation");
		};
		assert_eq!(payload.direction, IrcDirection::Autoreply);
		assert_eq!(payload.from.as_deref(), Some("Recipient"));
		assert_eq!(payload.to.as_deref(), Some("Sender"));
		assert_eq!(payload.reply_to.as_deref(), Some("message-1"));
		assert_eq!(payload.body, "brief answer");
		committed.send(true).expect("journal acknowledgement");
		let Up::Env(omp_agent::EnvEvent::IrcTraffic { payload }) =
			sender_rx.recv_async().await.expect("incoming observation")
		else {
			panic!("sender receives the ordinary incoming observation");
		};
		assert_eq!(payload.direction, IrcDirection::Incoming);
		assert_eq!(payload.reply_to.as_deref(), Some("message-1"));
		let Up::Peer(body) = sender_rx
			.recv_async()
			.await
			.expect("ordinary model delivery")
		else {
			panic!("sender receives one ordinary peer delivery");
		};
		assert_eq!(body, "brief answer");
		obligations.wait().await;
		assert!(recipient_rx.try_recv().is_err());
		assert!(sender_rx.try_recv().is_err());
	}

	#[tokio::test]
	async fn session_generation_change_discards_inflight_reply() {
		let temp = tempfile::tempdir().expect("temporary directory");
		let blobs =
			omp_journal::blob::BlobStore::open(temp.path().join("artifacts")).expect("blob store");
		let registry = Arc::new(SessionRegistry::new());
		let (recipient_tx, recipient_rx) = flume::unbounded();
		let (sender_tx, sender_rx) = flume::unbounded();
		let (started_tx, started_rx) = flume::bounded(1);
		let (release_tx, release_rx) = flume::bounded(1);
		let obligations = ReplyObligations::default();
		let cancel = CancellationToken::new();
		let actor = Arc::new(SessionAutoreply {
			model: Arc::new(GatedReply { started: started_tx, release: release_rx }),
			registry: Arc::downgrade(&registry),
			generation: RwLock::new(Str::new_static("old-generation")),
			up: recipient_tx.clone(),
			active: Arc::new(AtomicBool::new(true)),
			generation_cancel: Mutex::new(cancel.child_token()),
			cancel,
			obligations: obligations.clone(),
			blobs: RwLock::new(blobs),
		});
		let actor_dyn: Arc<dyn PeerAutoreply> = actor.clone();
		registry.register(
			Str::new_static("Recipient"),
			endpoint("recipient-id", "Recipient", recipient_tx.clone(), Some(actor_dyn)),
		);
		registry
			.register(Str::new_static("Sender"), endpoint("sender-id", "Sender", sender_tx, None));

		assert!(actor.start(request()));
		let Up::Subscribe(subscription) = recipient_rx.recv_async().await.expect("subscription")
		else {
			panic!("autoreply requests the live recipient snapshot");
		};
		let (_, patches) = flume::unbounded();
		subscription
			.send((Dom::new().snapshot(), patches))
			.expect("snapshot response");
		started_rx.recv_async().await.expect("model started");
		let replacement_blobs =
			omp_journal::blob::BlobStore::open(temp.path().join("replacement-artifacts"))
				.expect("replacement blob store");
		actor.rebind(replacement_blobs);
		release_tx.send(()).expect("release model");
		obligations.wait().await;
		assert!(recipient_rx.try_recv().is_err());
		assert!(sender_rx.try_recv().is_err());
	}
}
