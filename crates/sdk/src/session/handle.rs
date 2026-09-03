//! Durable embedded-session handle and cold-revival actor.

use std::{error, future::Future, path::PathBuf, pin::Pin, sync, sync::Arc, time, time::Instant};

use flume::Receiver;
use omp_agent::{
	AbortHandle, ActivationId, Agent, AgentError, AgentEvent, AgentRunSummary, EventSubscription,
	ManualCompactionOutcome, ManualCompactionRequest, ModelChange, PromptError, PromptPatchSet,
	Props, Regime, RegimeRecord, RegimeSpec, StartOptions, StartReceipt, TurnClient, TurnId,
};
use omp_core::Str;
use omp_observability::firehose::{Envelope, Event as TelemetryEvent, Firehose, SessionDispatch};
use omp_proto::thread::v1::Item;
use parking_lot::Mutex;
use thiserror::Error;
use tokio::{runtime, sync::watch};
use tracing::Instrument as _;

use super::SessionDiagnostics;
use crate::{ProtocolResolution, RuntimeCallbacks, UiContextUpdate};

/// Stable durable identity retained when a live loop is disposed or parked.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SessionIdentity {
	/// Stable journal/session identifier.
	pub id:                Str,
	/// Append-only v4 journal backing cold revival.
	pub journal_path:      PathBuf,
	/// Optional compare-and-swap revision required before revival.
	pub expected_revision: Option<u64>,
}

impl SessionIdentity {
	/// Creates a durable identity over one authoritative journal.
	pub fn new(id: impl Into<Str>, journal_path: impl Into<PathBuf>) -> Self {
		Self {
			id:                id.into(),
			journal_path:      journal_path.into(),
			expected_revision: None,
		}
	}
}

/// Non-secret request passed to an application-owned cold-revival factory.
#[derive(Clone)]
pub struct SessionRevivalRequest {
	/// Stable durable session identity.
	pub identity:  SessionIdentity,
	/// Complete session-bound callback authority that the reconstructed runtime
	/// must reinstall before accepting work.
	pub callbacks: RuntimeCallbacks,
}

impl std::fmt::Debug for SessionRevivalRequest {
	fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
		formatter
			.debug_struct("SessionRevivalRequest")
			.field("identity", &self.identity)
			.finish_non_exhaustive()
	}
}

/// Typed failure returned by a cold-revival factory.
#[derive(Debug, Error)]
pub enum SessionRevivalError {
	/// The expected journal revision no longer matches the durable authority.
	#[error("session journal revision changed before revival")]
	RevisionConflict,
	/// The journal does not exist or does not belong to the requested session.
	#[error("session journal identity is unavailable for revival")]
	Unavailable,
	/// Application production composition failed.
	#[error("session production composition failed")]
	Composition {
		/// Typed application error retained as the source.
		#[source]
		source: Box<dyn error::Error + Send + Sync>,
	},
}

impl SessionRevivalError {
	/// Wraps a typed application composition error.
	pub fn composition(source: impl error::Error + Send + Sync + 'static) -> Self {
		Self::Composition { source: Box::new(source) }
	}
}

/// Cold, application-owned runtime construction future.
pub type SessionRevivalFuture =
	Pin<Box<dyn Future<Output = Result<SessionRuntime, SessionRevivalError>> + Send + 'static>>;

/// Factory that reconstructs an equivalent loop from the append-only journal.
pub type SessionRevivalFactory =
	Arc<dyn Fn(SessionRevivalRequest) -> SessionRevivalFuture + Send + Sync + 'static>;

/// Observable lifecycle of the in-memory loop behind a durable identity.
#[derive(Clone, Copy, Debug, Eq, PartialEq, strum::IntoStaticStr)]
#[strum(serialize_all = "snake_case")]
pub enum SessionLifecycle {
	/// The in-memory loop is ready for a submission.
	Ready,
	/// A caller submission is active.
	Running,
	/// Live resources were released; a later submit performs cold revival.
	Disposed,
	/// The application factory is reconstructing the loop from its journal.
	Reviving,
	/// The handle actor has terminated and accepts no further work.
	Closed,
}

mod lifecycle_subscription {
	use tokio::sync::watch::{Receiver, error};

	use super::SessionLifecycle;

	/// Lifecycle receiver that does not expose the mutable watch sender.
	#[derive(Clone)]
	pub struct SessionLifecycleSubscription {
		pub(super) rx: Receiver<SessionLifecycle>,
	}

	impl SessionLifecycleSubscription {
		/// Returns the latest lifecycle state.
		pub fn current(&self) -> SessionLifecycle {
			*self.rx.borrow()
		}

		/// Waits for and returns the next lifecycle state.
		pub async fn changed(&mut self) -> Result<SessionLifecycle, error::RecvError> {
			self.rx.changed().await?;
			Ok(*self.rx.borrow())
		}
	}
}

pub use lifecycle_subscription::SessionLifecycleSubscription;

/// Session-handle operation failure.
#[derive(Debug, Error)]
pub enum SessionHandleError {
	/// The live agent loop rejected or failed the submission.
	#[error(transparent)]
	Agent(#[from] AgentError),
	/// Cold revival failed before a loop could accept the submission.
	#[error(transparent)]
	Revival(#[from] SessionRevivalError),
	/// The handle actor was closed.
	#[error("session handle is closed")]
	Closed,
	/// Launch requires an active Tokio runtime.
	#[error("session handle launch requires an active Tokio runtime")]
	NoRuntime,
	/// No revival factory was installed for a disposed runtime.
	#[error("disposed session has no cold-revival factory")]
	NotRevivable,
}

type SubmitFuture<'a> =
	Pin<Box<dyn Future<Output = Result<AgentRunSummary, AgentError>> + Send + 'a>>;
type RetryFuture<'a> = Pin<
	Box<
		dyn Future<Output = Result<Option<(Vec<Item>, Str, AgentRunSummary)>, AgentError>>
			+ Send
			+ 'a,
	>,
>;
type CompactFuture<'a> =
	Pin<Box<dyn Future<Output = Result<ManualCompactionOutcome, AgentError>> + Send + 'a>>;
type StartRegimeFuture<'a> =
	Pin<Box<dyn Future<Output = Result<(StartReceipt, Vec<RegimeRecord>), AgentError>> + Send + 'a>>;
type ActiveRegimesFuture<'a> =
	Pin<Box<dyn Future<Output = Result<Vec<RegimeRecord>, AgentError>> + Send + 'a>>;
type StopRegimeFuture<'a> =
	Pin<Box<dyn Future<Output = Result<(bool, Vec<RegimeRecord>), AgentError>> + Send + 'a>>;
type ModelOverrideFuture<'a> = Pin<Box<dyn Future<Output = Result<u64, AgentError>> + Send + 'a>>;

trait RuntimeDriver: Send {
	fn install_callbacks(&mut self, callbacks: &RuntimeCallbacks);
	fn submit<'a>(&'a mut self, items: Vec<Item>, turn_id: TurnId) -> SubmitFuture<'a>;
	fn retry<'a>(&'a mut self, turn_id: TurnId) -> RetryFuture<'a>;
	fn compact<'a>(&'a mut self, request: ManualCompactionRequest) -> CompactFuture<'a>;
	fn start_regime<'a>(
		&'a mut self,
		spec: Arc<RegimeSpec>,
		regime: Box<dyn Regime>,
		options: StartOptions,
	) -> StartRegimeFuture<'a>;
	fn active_regimes(&mut self) -> ActiveRegimesFuture<'_>;
	fn stop_regime<'a>(&'a mut self, activation: ActivationId, now_ms: u64) -> StopRegimeFuture<'a>;
	fn model_override<'a>(&'a mut self, ts: u64, model: ModelChange) -> ModelOverrideFuture<'a>;
}

struct AgentRuntime<C: TurnClient + Clone + Send + 'static> {
	agent: Agent<C>,
}

impl<C: TurnClient + Clone + Send + 'static> RuntimeDriver for AgentRuntime<C> {
	fn install_callbacks(&mut self, callbacks: &RuntimeCallbacks) {
		callbacks.configure_agent(&mut self.agent);
	}

	fn submit<'a>(&'a mut self, items: Vec<Item>, turn_id: TurnId) -> SubmitFuture<'a> {
		Box::pin(self.agent.submit(items, turn_id))
	}

	fn retry<'a>(&'a mut self, turn_id: TurnId) -> RetryFuture<'a> {
		Box::pin(self.agent.retry_last_turn(turn_id))
	}

	fn compact<'a>(&'a mut self, request: ManualCompactionRequest) -> CompactFuture<'a> {
		Box::pin(self.agent.compact_manual(request))
	}

	fn start_regime<'a>(
		&'a mut self,
		spec: Arc<RegimeSpec>,
		regime: Box<dyn Regime>,
		options: StartOptions,
	) -> StartRegimeFuture<'a> {
		Box::pin(async move {
			let receipt = self.agent.start_regime(spec, regime, options)?;
			let records = self.agent.arbiter().regimes().records();
			Ok((receipt, records))
		})
	}

	fn active_regimes(&mut self) -> ActiveRegimesFuture<'_> {
		Box::pin(async move { Ok(self.agent.arbiter().regimes().records()) })
	}

	fn stop_regime<'a>(&'a mut self, activation: ActivationId, now_ms: u64) -> StopRegimeFuture<'a> {
		Box::pin(async move {
			let stopped = self.agent.stop_regime(activation.as_str(), now_ms)?;
			let records = self.agent.arbiter().regimes().records();
			Ok((stopped, records))
		})
	}

	fn model_override<'a>(&'a mut self, ts: u64, model: ModelChange) -> ModelOverrideFuture<'a> {
		Box::pin(async move {
			self
				.agent
				.record_model_override(ts, model)
				.map_err(AgentError::from)
		})
	}
}

/// Erased live-loop bundle consumed once by [`SessionHandle`].
///
/// Embedders can construct this from the native agent loop, but cannot recover
/// mutable loop, process, or journal internals after handing it to the handle.
pub struct SessionRuntime {
	driver:  Box<dyn RuntimeDriver>,
	events:  EventSubscription,
	abort:   AbortHandle,
	dispose: Vec<Box<dyn FnOnce() + Send + 'static>>,
}

impl SessionRuntime {
	fn install_callbacks(&mut self, callbacks: &RuntimeCallbacks) {
		self.driver.install_callbacks(callbacks);
	}

	/// Takes ownership of one fully composed native agent loop.
	pub fn from_agent<C>(agent: Agent<C>) -> Self
	where
		C: TurnClient + Clone + Send + 'static,
	{
		let events = agent.events().subscribe_lossless();
		let abort = agent.abort_handle();
		Self { driver: Box::new(AgentRuntime { agent }), events, abort, dispose: Vec::new() }
	}

	/// Registers one synchronous authority-release action run when this runtime
	/// is disposed, replaced during revival, or dropped after actor shutdown.
	pub fn on_dispose(mut self, callback: impl FnOnce() + Send + 'static) -> Self {
		self.dispose.push(Box::new(callback));
		self
	}
}

impl Drop for SessionRuntime {
	fn drop(&mut self) {
		for callback in self.dispose.drain(..).rev() {
			callback();
		}
	}
}

enum Command {
	Submit {
		items:   Vec<Item>,
		turn_id: TurnId,
		reply:   flume::Sender<Result<AgentRunSummary, SessionHandleError>>,
	},
	Retry {
		turn_id: TurnId,
		reply:   flume::Sender<Result<Option<(Vec<Item>, Str, AgentRunSummary)>, SessionHandleError>>,
	},
	Compact {
		request: ManualCompactionRequest,
		reply:   flume::Sender<Result<ManualCompactionOutcome, SessionHandleError>>,
	},
	StartRegime {
		spec:    Arc<RegimeSpec>,
		regime:  Box<dyn Regime>,
		options: StartOptions,
		reply:   flume::Sender<Result<(StartReceipt, Vec<RegimeRecord>), SessionHandleError>>,
	},
	ActiveRegimes {
		reply: flume::Sender<Result<Vec<RegimeRecord>, SessionHandleError>>,
	},
	StopRegime {
		activation: ActivationId,
		now_ms:     u64,
		reply:      flume::Sender<Result<(bool, Vec<RegimeRecord>), SessionHandleError>>,
	},
	ModelOverride {
		ts:    u64,
		model: ModelChange,
		reply: flume::Sender<Result<u64, SessionHandleError>>,
	},
	Dispose {
		reply: flume::Sender<()>,
	},
}

struct HandleInner {
	identity:    SessionIdentity,
	diagnostics: SessionDiagnostics,
	callbacks:   RuntimeCallbacks,
	commands:    flume::Sender<Command>,
	abort:       Mutex<Option<AbortHandle>>,
	lifecycle:   watch::Sender<SessionLifecycle>,
	firehose:    Option<Arc<Firehose>>,
}

/// Clone-cheap handle for submitting to, interrupting, disposing, and reviving
/// one durable agent journal.
#[derive(Clone)]
pub struct SessionHandle {
	inner: Arc<HandleInner>,
}

impl Drop for SessionHandle {
	fn drop(&mut self) {
		if Arc::strong_count(&self.inner) == 1 {
			self.interrupt();
		}
	}
}

impl SessionHandle {
	pub(crate) fn launch(
		identity: SessionIdentity,
		diagnostics: SessionDiagnostics,
		callbacks: RuntimeCallbacks,
		mut runtime: Option<SessionRuntime>,
		revival: Option<SessionRevivalFactory>,
		constructed_at: Instant,
		firehose: Option<Arc<Firehose>>,
	) -> Result<Self, SessionHandleError> {
		if let Some(runtime) = runtime.as_mut() {
			runtime.install_callbacks(&callbacks);
		}
		let initial = if runtime.is_some() {
			SessionLifecycle::Ready
		} else {
			SessionLifecycle::Disposed
		};
		let (commands, rx) = flume::unbounded();
		let (lifecycle, _) = watch::channel(initial);
		let abort = runtime.as_ref().map(|runtime| runtime.abort.clone());
		let inner = Arc::new(HandleInner {
			identity,
			diagnostics,
			callbacks,
			commands,
			abort: Mutex::new(abort),
			lifecycle,
			firehose,
		});
		let actor_inner = Arc::downgrade(&inner);
		let runtime_handle =
			runtime::Handle::try_current().map_err(|_| SessionHandleError::NoRuntime)?;
		runtime_handle.spawn(run_handle_actor(actor_inner, rx, runtime, revival, constructed_at));
		tracing::info!(
			session_id = %inner.identity.id,
			lifecycle = ?initial,
			"SDK session launched"
		);
		Ok(Self { inner })
	}

	/// Returns the stable journal identity.
	pub fn identity(&self) -> &SessionIdentity {
		&self.inner.identity
	}

	/// Returns typed construction, fallback, LSP, and launch diagnostics.
	pub fn diagnostics(&self) -> &SessionDiagnostics {
		&self.inner.diagnostics
	}

	/// Returns the complete callback authority installed for this session.
	pub fn runtime_callbacks(&self) -> &RuntimeCallbacks {
		&self.inner.callbacks
	}

	/// Publishes a host-owned typed event through the handle fan-out.
	pub fn publish(&self, event: AgentEvent) {
		let callbacks = self.inner.callbacks.callback_set();
		for callback in &callbacks.events {
			callback(&event);
		}
		callbacks.events_bus().publish_shared(Arc::new(event));
	}

	/// Publishes one UI-context update to the installed host boundary.
	pub fn update_ui_context(&self, update: &UiContextUpdate) {
		self.inner.callbacks.update_ui_context(update);
	}

	/// Resolves a URL through its installed host-local protocol boundary.
	pub fn resolve_local_protocol(&self, url: &url::Url) -> Option<ProtocolResolution> {
		self.inner.callbacks.resolve_local_protocol(url)
	}

	/// Produces title-system-prompt patches from the live session authority.
	pub fn title_prompt(&self, props: &Props) -> Option<Result<PromptPatchSet, PromptError>> {
		self.inner.callbacks.title_prompt(props)
	}

	/// Adds a bounded lossy typed-event subscription suitable for host UI.
	pub fn subscribe(&self, capacity: usize) -> omp_agent::LossyEventSubscription {
		self
			.inner
			.callbacks
			.callback_set()
			.events_bus()
			.subscribe_ui(capacity)
	}

	/// Adds an ordered lossless typed-event subscription suitable for an SDK
	/// host.
	pub fn subscribe_lossless(&self) -> EventSubscription {
		self
			.inner
			.callbacks
			.callback_set()
			.events_bus()
			.subscribe_lossless()
	}

	/// Subscribes to in-memory lifecycle transitions.
	pub fn lifecycle(&self) -> SessionLifecycleSubscription {
		SessionLifecycleSubscription { rx: self.inner.lifecycle.subscribe() }
	}

	/// Submits canonical caller-authored items. A disposed handle transparently
	/// reloads its journal through the guarded revival factory first.
	#[tracing::instrument(
		level = "debug",
		name = "sdk_session_submit",
		skip_all,
		fields(session_id = %self.inner.identity.id)
	)]
	pub async fn submit(
		&self,
		items: impl IntoIterator<Item = Item>,
		turn_id: TurnId,
	) -> Result<AgentRunSummary, SessionHandleError> {
		let (reply, rx) = flume::bounded(1);
		self
			.inner
			.commands
			.send_async(Command::Submit { items: items.into_iter().collect(), turn_id, reply })
			.await
			.map_err(|_| actor_transport_closed())?;
		rx.recv_async()
			.await
			.map_err(|_| actor_transport_closed())?
	}

	/// Rewinds and resubmits the latest durable user turn.
	#[tracing::instrument(
		level = "debug",
		name = "sdk_session_retry",
		skip_all,
		fields(session_id = %self.inner.identity.id)
	)]
	pub async fn retry_last_turn(
		&self,
		turn_id: TurnId,
	) -> Result<Option<(Vec<Item>, Str, AgentRunSummary)>, SessionHandleError> {
		let (reply, response) = flume::bounded(1);
		self
			.inner
			.commands
			.send_async(Command::Retry { turn_id, reply })
			.await
			.map_err(|_| actor_transport_closed())?;
		response
			.recv_async()
			.await
			.map_err(|_| actor_transport_closed())?
	}

	/// Executes and commits one manual compaction on the live agent loop.
	#[tracing::instrument(
		level = "debug",
		name = "sdk_session_compact",
		skip_all,
		fields(session_id = %self.inner.identity.id)
	)]
	pub async fn compact_manual(
		&self,
		request: ManualCompactionRequest,
	) -> Result<ManualCompactionOutcome, SessionHandleError> {
		let (reply, response) = flume::bounded(1);
		self
			.inner
			.commands
			.send_async(Command::Compact { request, reply })
			.await
			.map_err(|_| actor_transport_closed())?;
		response
			.recv_async()
			.await
			.map_err(|_| actor_transport_closed())?
	}

	/// Starts and journals a regime on the actor-owned agent loop, returning its
	/// receipt and the complete active-regime projection.
	#[tracing::instrument(
		level = "debug",
		name = "sdk_session_start_regime",
		skip_all,
		fields(session_id = %self.inner.identity.id)
	)]
	pub async fn start_regime(
		&self,
		spec: Arc<RegimeSpec>,
		regime: Box<dyn Regime>,
		options: StartOptions,
	) -> Result<(StartReceipt, Vec<RegimeRecord>), SessionHandleError> {
		let (reply, response) = flume::bounded(1);
		self
			.inner
			.commands
			.send_async(Command::StartRegime { spec, regime, options, reply })
			.await
			.map_err(|_| actor_transport_closed())?;
		response
			.recv_async()
			.await
			.map_err(|_| actor_transport_closed())?
	}

	/// Returns the complete active-regime projection from the actor-owned loop.
	#[tracing::instrument(
		level = "debug",
		name = "sdk_session_active_regimes",
		skip_all,
		fields(session_id = %self.inner.identity.id)
	)]
	pub async fn active_regimes(&self) -> Result<Vec<RegimeRecord>, SessionHandleError> {
		let (reply, response) = flume::bounded(1);
		self
			.inner
			.commands
			.send_async(Command::ActiveRegimes { reply })
			.await
			.map_err(|_| actor_transport_closed())?;
		response
			.recv_async()
			.await
			.map_err(|_| actor_transport_closed())?
	}

	/// Stops one activation and returns whether it was stopped together with
	/// the resulting complete active-regime projection.
	#[tracing::instrument(
		level = "debug",
		name = "sdk_session_stop_regime",
		skip_all,
		fields(session_id = %self.inner.identity.id)
	)]
	pub async fn stop_regime(
		&self,
		activation: ActivationId,
		now_ms: u64,
	) -> Result<(bool, Vec<RegimeRecord>), SessionHandleError> {
		let (reply, response) = flume::bounded(1);
		self
			.inner
			.commands
			.send_async(Command::StopRegime { activation, now_ms, reply })
			.await
			.map_err(|_| actor_transport_closed())?;
		response
			.recv_async()
			.await
			.map_err(|_| actor_transport_closed())?
	}

	/// Appends a durable model override on the actor-owned live agent.
	#[tracing::instrument(
		level = "debug",
		name = "sdk_session_model_override",
		skip_all,
		fields(session_id = %self.inner.identity.id)
	)]
	pub async fn model_override(
		&self,
		ts: u64,
		model: ModelChange,
	) -> Result<u64, SessionHandleError> {
		let (reply, response) = flume::bounded(1);
		self
			.inner
			.commands
			.send_async(Command::ModelOverride { ts, model, reply })
			.await
			.map_err(|_| actor_transport_closed())?;
		response
			.recv_async()
			.await
			.map_err(|_| actor_transport_closed())?
	}

	/// Interrupts the active submission without waiting for the actor mailbox.
	pub fn interrupt(&self) {
		if let Some(abort) = self.inner.abort.lock().as_ref() {
			abort.abort();
		}
	}

	/// Releases live loop resources while retaining durable identity. A later
	/// submission remains valid when a cold-revival factory is installed.
	#[tracing::instrument(
		level = "debug",
		name = "sdk_session_dispose",
		skip_all,
		fields(session_id = %self.inner.identity.id)
	)]
	pub async fn dispose(&self) -> Result<(), SessionHandleError> {
		self.interrupt();
		let (reply, rx) = flume::bounded(1);
		self
			.inner
			.commands
			.send_async(Command::Dispose { reply })
			.await
			.map_err(|_| actor_transport_closed())?;
		rx.recv_async().await.map_err(|_| actor_transport_closed())
	}
}

fn actor_transport_closed() -> SessionHandleError {
	tracing::warn!("SDK session actor transport closed");
	SessionHandleError::Closed
}

async fn run_handle_actor(
	inner: sync::Weak<HandleInner>,
	commands: Receiver<Command>,
	mut runtime: Option<SessionRuntime>,
	revival: Option<SessionRevivalFactory>,
	constructed_at: Instant,
) {
	while let Ok(command) = commands.recv_async().await {
		let Some(shared) = inner.upgrade() else {
			break;
		};
		match command {
			Command::Dispose { reply } => {
				shared.abort.lock().take();
				runtime = None;
				shared.lifecycle.send_replace(SessionLifecycle::Disposed);
				tracing::info!(
					session_id = %shared.identity.id,
					"SDK session disposed"
				);
				let _ = reply.send(());
				continue;
			},
			Command::StartRegime { spec, regime, options, reply } => {
				let Some(live) = runtime.as_mut() else {
					let _ = reply.send(Err(SessionHandleError::NotRevivable));
					continue;
				};
				let result = live
					.driver
					.start_regime(spec, regime, options)
					.await
					.map_err(SessionHandleError::from);
				let _ = reply.send(result);
			},
			Command::ActiveRegimes { reply } => {
				let Some(live) = runtime.as_mut() else {
					let _ = reply.send(Err(SessionHandleError::NotRevivable));
					continue;
				};
				let result = live
					.driver
					.active_regimes()
					.await
					.map_err(SessionHandleError::from);
				let _ = reply.send(result);
			},
			Command::StopRegime { activation, now_ms, reply } => {
				let Some(live) = runtime.as_mut() else {
					let _ = reply.send(Err(SessionHandleError::NotRevivable));
					continue;
				};
				let result = live
					.driver
					.stop_regime(activation, now_ms)
					.await
					.map_err(SessionHandleError::from);
				let _ = reply.send(result);
			},
			Command::ModelOverride { ts, model, reply } => {
				let Some(live) = runtime.as_mut() else {
					let _ = reply.send(Err(SessionHandleError::NotRevivable));
					continue;
				};
				let result = live
					.driver
					.model_override(ts, model)
					.await
					.map_err(SessionHandleError::from);
				let _ = reply.send(result);
			},
			Command::Retry { turn_id, reply } => {
				let Some(live) = runtime.as_mut() else {
					let _ = reply.send(Err(SessionHandleError::NotRevivable));
					continue;
				};
				shared.lifecycle.send_replace(SessionLifecycle::Running);
				let retry = live.driver.retry(turn_id);
				tokio::pin!(retry);
				let result = loop {
					tokio::select! {
						result = &mut retry => break result.map_err(SessionHandleError::from),
						event = live.events.recv() => {
							let Ok(event) = event else { continue; };
							publish_event(&shared, event, constructed_at);
						},
					}
				};
				while let Ok(event) = live.events.try_recv() {
					publish_event(&shared, event, constructed_at);
				}
				shared.lifecycle.send_replace(SessionLifecycle::Ready);
				let _ = reply.send(result);
			},
			Command::Compact { request, reply } => {
				let Some(live) = runtime.as_mut() else {
					let _ = reply.send(Err(SessionHandleError::NotRevivable));
					continue;
				};
				shared.lifecycle.send_replace(SessionLifecycle::Running);
				let compact = live.driver.compact(request);
				tokio::pin!(compact);
				let result = loop {
					tokio::select! {
						result = &mut compact => break result.map_err(SessionHandleError::from),
						event = live.events.recv() => {
							let Ok(event) = event else { continue; };
							publish_event(&shared, event, constructed_at);
						},
					}
				};
				while let Ok(event) = live.events.try_recv() {
					publish_event(&shared, event, constructed_at);
				}
				shared.lifecycle.send_replace(SessionLifecycle::Ready);
				let _ = reply.send(result);
			},
			Command::Submit { items, turn_id, reply } => {
				if runtime.is_none() {
					shared.lifecycle.send_replace(SessionLifecycle::Reviving);
					tracing::info!(
						session_id = %shared.identity.id,
						"SDK session revival started"
					);
					let revived = if let Some(factory) = &revival {
						factory(SessionRevivalRequest {
							identity:  shared.identity.clone(),
							callbacks: shared.callbacks.clone(),
						})
						.instrument(tracing::debug_span!(
							"sdk_session_revive",
							session_id = %shared.identity.id
						))
						.await
					} else {
						Err(SessionRevivalError::Unavailable)
					};
					match revived {
						Ok(mut next) => {
							next.install_callbacks(&shared.callbacks);
							*shared.abort.lock() = Some(next.abort.clone());
							runtime = Some(next);
							shared.lifecycle.send_replace(SessionLifecycle::Ready);
							tracing::info!(
								session_id = %shared.identity.id,
								"SDK session revival completed"
							);
						},
						Err(SessionRevivalError::Unavailable) if revival.is_none() => {
							shared.lifecycle.send_replace(SessionLifecycle::Disposed);
							let _ = reply.send(Err(SessionHandleError::NotRevivable));
							continue;
						},
						Err(error) => {
							shared.lifecycle.send_replace(SessionLifecycle::Disposed);
							tracing::warn!(
								session_id = %shared.identity.id,
								%error,
								"SDK session revival failed"
							);
							let _ = reply.send(Err(error.into()));
							continue;
						},
					}
				}
				shared.lifecycle.send_replace(SessionLifecycle::Running);
				let Some(live) = runtime.as_mut() else {
					let _ = reply.send(Err(SessionHandleError::NotRevivable));
					continue;
				};
				let submit = live.driver.submit(items, turn_id);
				tokio::pin!(submit);
				let result = loop {
					tokio::select! {
						result = &mut submit => break result.map_err(SessionHandleError::from),
						event = live.events.recv() => {
							let Ok(event) = event else { continue; };
							publish_event(&shared, event, constructed_at);
						},
					}
				};
				while let Ok(event) = live.events.try_recv() {
					publish_event(&shared, event, constructed_at);
				}
				shared.lifecycle.send_replace(SessionLifecycle::Ready);
				let _ = reply.send(result);
			},
		}
	}
	if let Some(shared) = inner.upgrade() {
		shared.abort.lock().take();
		shared.lifecycle.send_replace(SessionLifecycle::Closed);
		tracing::info!(
			session_id = %shared.identity.id,
			"SDK session closed"
		);
	}
}

fn publish_event(inner: &HandleInner, event: Arc<AgentEvent>, constructed_at: Instant) {
	let callbacks = inner.callbacks.callback_set();
	let first_provider_event =
		matches!(event.as_ref(), AgentEvent::PhaseChanged { to: omp_agent::AgentPhase::Turning, .. })
			&& inner.diagnostics.launch().first_dispatch_ms.is_none();
	if first_provider_event {
		let elapsed = constructed_at.elapsed();
		let elapsed_ms = u64::try_from(elapsed.as_millis()).unwrap_or(u64::MAX);
		inner.diagnostics.record_first_dispatch(elapsed_ms);
		if let Some(firehose) = &inner.firehose {
			firehose.publish(TelemetryEvent::SessionDispatch(SessionDispatch {
				envelope:   Envelope {
					session_id: inner.identity.id.clone(),
					agent_id: inner.identity.id.clone(),
					occurred_at_ms: now_ms(),
					..Envelope::default()
				},
				latency_ms: elapsed_ms,
			}));
		}
		if let Some(callback) = &callbacks.first_dispatch {
			callback(elapsed);
		}
	}
	for callback in &callbacks.events {
		callback(&event);
	}
	callbacks.events_bus().publish_shared(event);
}

fn now_ms() -> u64 {
	time::SystemTime::now()
		.duration_since(time::UNIX_EPOCH)
		.map_or(0, |duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
}
#[cfg(test)]
mod tests {
	use std::sync::{
		Arc,
		atomic::{AtomicUsize, Ordering},
	};

	use omp_inference::transport::http::PreconnectLaunch;
	use parking_lot::RwLock;

	use super::*;
	use crate::{
		CallbackSet, LaunchDiagnostic, RuntimeCallbacks, ServiceTierDiagnostic, ThinkingDiagnostic,
		UiContextUpdate,
	};

	#[tokio::test]
	async fn cold_revival_receives_the_installed_callback_authority() {
		let calls = Arc::new(AtomicUsize::new(0));
		let mut callbacks = CallbackSet::default();
		let callback_calls = Arc::clone(&calls);
		callbacks.ui_context = Some(Arc::new(move |update| {
			assert_eq!(update.surface.as_deref(), Some("revived"));
			callback_calls.fetch_add(1, Ordering::Relaxed);
		}));
		let revival_calls = Arc::clone(&calls);
		let revival: SessionRevivalFactory = Arc::new(move |request| {
			assert_eq!(request.identity.id, "cold-session");
			request.callbacks.update_ui_context(&UiContextUpdate {
				surface:     Some("revived".into()),
				interactive: true,
			});
			revival_calls.fetch_add(1, Ordering::Relaxed);
			Box::pin(async { Err(SessionRevivalError::Unavailable) })
		});
		let diagnostics = SessionDiagnostics {
			models:       Box::new([]),
			thinking:     ThinkingDiagnostic::default(),
			service_tier: ServiceTierDiagnostic::default(),
			launch:       Arc::new(RwLock::new(LaunchDiagnostic {
				preconnect:        PreconnectLaunch::NoRuntime,
				first_dispatch_ms: None,
			})),
			lsp:          Box::new([]),
		};
		let handle = SessionHandle::launch(
			SessionIdentity::new("cold-session", "cold-session.jsonl"),
			diagnostics,
			RuntimeCallbacks::new("cold-session".into(), callbacks),
			None,
			Some(revival),
			Instant::now(),
			None,
		)
		.expect("launch cold handle");

		let result = handle
			.submit(Vec::<Item>::new(), TurnId::new("cold-turn"))
			.await;
		assert!(matches!(result, Err(SessionHandleError::Revival(SessionRevivalError::Unavailable))));
		assert_eq!(calls.load(Ordering::Relaxed), 2);
	}
}
