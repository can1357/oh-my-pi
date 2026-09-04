//! Multiplexed, generation-fenced extension-host invocation routing.

use std::{
	collections::{BTreeMap, VecDeque},
	fs, io,
	path::{Path, PathBuf},
	str::FromStr,
	sync::{
		Arc,
		atomic::{AtomicU64, Ordering},
	},
	time::{Duration, Instant},
};

use flume::Receiver;
use omp_agent::{SlotClass, SlotId};
use omp_core::{CowBytes, InvocationPhase, LifecyclePhase, SparseMap, Str, sf};
use omp_proto::{
	toolhost::{
		v1,
		v1::{
			Dispatch as HookDispatch, FallbackLifecycleEventV1, HookEventId, HookHostEnvelope,
			LifecycleEventContext, RetryLifecycleEventV1, UiHostEnvelope, UiWorkerEnvelope,
			WorkerFrame, hook_host_envelope, lifecycle_worker_envelope, ui_host_envelope,
			ui_worker_envelope, worker_frame,
		},
	},
	ui::v1::{
		CommandDecl, RenderRequest, ShortcutDecl, TriggerDecl, UiDispatch, UiDispatchResult,
		ui_dispatch, ui_dispatch_result,
	},
};
use omp_session::custom_message::{CustomMessage, MessageRendererIdentity, RenderedMessage};
use parking_lot::{Mutex, RwLock};
use prost::Message;
use thiserror::Error;

/// Maximum bytes accepted from a runtime-discovered skill document.
pub const MAX_DISCOVERED_SKILL_BYTES: u64 = 64_000;

/// A contained `ResourceKind.SKILL` contribution admitted before driver
/// discovery.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct SkillPathContribution {
	/// Canonical contributed `SKILL.md`.
	pub path:         PathBuf,
	/// Canonical authority root which contains the contribution.
	pub contain_root: PathBuf,
}

/// A runtime resource contribution escaped or failed validation.
#[derive(Debug, Error)]
pub enum SkillPathAdmissionError {
	/// The hook result did not use the typed object/array contract.
	#[error("resources_discover returned a malformed skill contribution")]
	Malformed,
	/// A contributed skill path was outside every granted Environment root.
	#[error("resources_discover skill path escapes every granted root")]
	Escapes,
	/// A contributed resource could not be resolved.
	#[error("resources_discover skill path could not be resolved")]
	Io(#[source] io::Error),
	/// A contributed resource was not one bounded `SKILL.md` file.
	#[error("resources_discover skill contribution is not a bounded SKILL.md file")]
	InvalidFile,
}

/// Admits the composed `resources_discover` `add` field without following a
/// contribution beyond the invocation's granted roots.
///
/// Non-skill resource kinds are left to their owning discovery domains.
pub fn admit_skill_path_contributions(
	composed: &serde_json::Value,
	allowed_roots: &[PathBuf],
) -> Result<Vec<SkillPathContribution>, SkillPathAdmissionError> {
	let object = composed
		.as_object()
		.ok_or(SkillPathAdmissionError::Malformed)?;
	let patch = object
		.get("patch")
		.and_then(serde_json::Value::as_object)
		.unwrap_or(object);
	let additions = match patch.get("add") {
		Some(additions) => additions
			.as_array()
			.ok_or(SkillPathAdmissionError::Malformed)?,
		None => return Ok(Vec::new()),
	};
	let roots = allowed_roots
		.iter()
		.map(fs::canonicalize)
		.collect::<Result<Vec<_>, _>>()
		.map_err(SkillPathAdmissionError::Io)?;
	let mut admitted = Vec::new();
	for addition in additions {
		let addition = addition
			.as_object()
			.ok_or(SkillPathAdmissionError::Malformed)?;
		let kind = addition
			.get("kind")
			.and_then(serde_json::Value::as_str)
			.ok_or(SkillPathAdmissionError::Malformed)?;
		if kind != "skill" {
			continue;
		}
		addition
			.get("origin")
			.and_then(serde_json::Value::as_str)
			.filter(|origin| !origin.is_empty())
			.ok_or(SkillPathAdmissionError::Malformed)?;
		let uri = addition
			.get("uri")
			.and_then(serde_json::Value::as_str)
			.ok_or(SkillPathAdmissionError::Malformed)?;
		let path = fs::canonicalize(Path::new(uri)).map_err(SkillPathAdmissionError::Io)?;
		let contain_root = roots
			.iter()
			.find(|root| path.starts_with(root))
			.cloned()
			.ok_or(SkillPathAdmissionError::Escapes)?;
		let metadata = fs::metadata(&path).map_err(SkillPathAdmissionError::Io)?;
		if !metadata.is_file()
			|| metadata.len() > MAX_DISCOVERED_SKILL_BYTES
			|| path.file_name().is_none_or(|name| name != "SKILL.md")
		{
			return Err(SkillPathAdmissionError::InvalidFile);
		}
		if !admitted
			.iter()
			.any(|row: &SkillPathContribution| row.path == path)
		{
			admitted.push(SkillPathContribution { path, contain_root });
		}
	}
	admitted.sort_by(|left, right| left.path.cmp(&right.path));
	Ok(admitted)
}

use super::{
	control::{
		ControlConnectionIdentity, ControlDispatch, ControlInvocationAuthority, ControlProtocolError,
		ControlRequestContext, ControlRuntimeError,
	},
	lifecycle::{
		AvailabilityBatch, AvailabilitySink, HeadlessLifecycleSink, HeadlessSinkError,
		VerifiedMessageRendererDeclaration, VerifiedRendererDeclaration, VerifiedUiRoster,
	},
};
use crate::worker::HostKey;

/// Per-declaration callback overlap policy.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum CallbackConcurrency {
	/// The ordinary actor default: exactly one callback enters Python at once.
	Serialized,
	/// An explicit declaration-level overlap limit.
	Concurrent {
		/// Maximum overlapping callback entries.
		limit: usize,
	},
	/// An explicitly thread-safe callback may overlap without a fixed limit.
	Threadsafe,
}

impl CallbackConcurrency {
	fn admits(self, running: usize) -> bool {
		match self {
			Self::Serialized => running == 0,
			Self::Concurrent { limit } => running < limit.max(1),
			Self::Threadsafe => true,
		}
	}
}

/// Generation-fenced host-to-extension callback boundary used by domain
/// owners. Implementations must dispatch through the live CONTROL actor rather
/// than evaluate or synthesize a callback result in the authority layer.
#[async_trait::async_trait]
pub trait CallbackDispatcher: Send + Sync + 'static {
	/// Calls one exact authenticated child binding.
	async fn dispatch(
		&self,
		target: Arc<ControlConnectionIdentity>,
		dispatch: ControlDispatch,
	) -> Result<serde_json::Value, ControlProtocolError>;
	/// Calls one manifest-verified command, shortcut, completion, or renderer
	/// through the typed UI envelope route.
	async fn dispatch_ui(
		&self,
		_target: Arc<ControlConnectionIdentity>,
		_authority: ControlInvocationAuthority,
		_dispatch: UiCallbackDispatch,
		_timeout: Duration,
	) -> Result<UiDispatchResult, ControlProtocolError> {
		Err(ControlProtocolError::new(
			"CallbackUnavailable",
			"typed UI callback dispatch is not installed",
		))
	}
}

/// Late-bound callback dispatcher used to break supervisor construction from
/// domain-authority construction. Requests fail closed until a live supervisor
/// is installed.
#[derive(Clone, Default)]
pub struct CallbackDispatcherSlot {
	dispatcher: Arc<RwLock<Option<Arc<dyn CallbackDispatcher>>>>,
}

impl CallbackDispatcherSlot {
	/// Creates an unbound dispatcher slot.
	pub fn new() -> Arc<Self> {
		Arc::new(Self::default())
	}

	/// Installs or atomically replaces the live supervisor dispatcher.
	pub fn bind(&self, dispatcher: Arc<dyn CallbackDispatcher>) {
		*self.dispatcher.write() = Some(dispatcher);
	}

	/// Removes the callback dispatcher during supervisor shutdown.
	pub fn unbind(&self) {
		*self.dispatcher.write() = None;
	}
}

#[async_trait::async_trait]
impl CallbackDispatcher for CallbackDispatcherSlot {
	async fn dispatch(
		&self,
		target: Arc<ControlConnectionIdentity>,
		dispatch: ControlDispatch,
	) -> Result<serde_json::Value, ControlProtocolError> {
		let dispatcher = self.dispatcher.read().clone().ok_or_else(|| {
			ControlProtocolError::new(
				"CallbackUnavailable",
				"extension callback supervisor is not active",
			)
			.retryable(true)
		})?;
		dispatcher.dispatch(target, dispatch).await
	}

	async fn dispatch_ui(
		&self,
		target: Arc<ControlConnectionIdentity>,
		authority: ControlInvocationAuthority,
		dispatch: UiCallbackDispatch,
		timeout: Duration,
	) -> Result<UiDispatchResult, ControlProtocolError> {
		let dispatcher = self.dispatcher.read().clone().ok_or_else(|| {
			ControlProtocolError::new(
				"CallbackUnavailable",
				"extension callback supervisor is not active",
			)
			.retryable(true)
		})?;
		dispatcher
			.dispatch_ui(target, authority, dispatch, timeout)
			.await
	}
}
/// Exact generation and callback identity owning one UI roster row.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct UiCallbackOwner {
	/// Authenticated worker process identity.
	pub host:           HostKey,
	/// Exact child generation.
	pub generation:     u64,
	/// Stable signed declaration id.
	pub declaration_id: Str,
	/// Qualified callback name inside the worker.
	pub callback:       Str,
}

/// One manifest-verified slash-command roster entry.
#[derive(Clone, Debug)]
pub struct UiCommandRosterEntry {
	/// Generation-fenced callback owner.
	pub owner:       UiCallbackOwner,
	/// Static command metadata available without starting Python.
	pub declaration: CommandDecl,
}

/// One manifest-verified shortcut roster entry.
#[derive(Clone, Debug)]
pub struct UiShortcutRosterEntry {
	/// Generation-fenced callback owner.
	pub owner:       UiCallbackOwner,
	/// Static shortcut metadata available without starting Python.
	pub declaration: ShortcutDecl,
}

/// One manifest-verified transcript-message renderer roster entry.
#[derive(Clone, Debug)]
pub struct UiMessageRendererRosterEntry {
	/// Generation-fenced callback owner.
	pub owner:       UiCallbackOwner,
	/// Frozen renderer declaration.
	pub declaration: VerifiedMessageRendererDeclaration,
}

impl UiMessageRendererRosterEntry {
	/// Builds one generation-fenced pure message-renderer dispatch.
	///
	/// `ctx` is the actor's serialized `RenderCtx`; the semantic message body
	/// is copied into the bounded worker request but remains authoritative in
	/// the session tree.
	///
	/// # Errors
	/// Returns a JSON encoding error when `ctx` cannot be serialized.
	pub fn dispatch(
		&self,
		stable_id: &str,
		message: &CustomMessage,
		ctx: serde_json::Value,
	) -> Result<UiCallbackDispatch, serde_json::Error> {
		let role: &'static str = message.kind.into();
		let presentation: &'static str = message.presentation.into();
		let state = serde_json::to_vec(&serde_json::json!({
			"message": {
				"id": stable_id,
				"kind": message.custom_type,
				"role": role,
				"text": message.body,
				"presentation": {
					"frame": presentation,
					"display": message.display,
				},
			},
			"ctx": ctx,
		}))?;
		Ok(UiCallbackDispatch {
			owner:    self.owner.clone(),
			dispatch: UiDispatch {
				kind:           Some(ui_dispatch::Kind::Render(RenderRequest {
					name:    message.custom_type.to_string(),
					rev:     "message@1".to_owned(),
					call_id: stable_id.to_owned(),
					state:   state.into(),
				})),
				generation:     self.owner.generation,
				declaration_id: self.owner.declaration_id.to_string(),
				props:          None,
			},
		})
	}

	/// Converts a successful callback result into replay-stable renderer
	/// metadata.
	///
	/// Missing, failed, or non-UTF-8 renderer results select native Markdown
	/// fallback by returning `None`.
	#[must_use]
	pub fn rendered(&self, result: &UiDispatchResult) -> Option<RenderedMessage> {
		if result.generation != self.owner.generation
			|| result.declaration_id != self.owner.declaration_id.as_str()
		{
			return None;
		}
		let ui_dispatch_result::Result::Rendered(rendered) = result.result.as_ref()? else {
			return None;
		};
		let source = std::str::from_utf8(&rendered.content.as_ref()?.source).ok()?;
		Some(RenderedMessage {
			renderer: MessageRendererIdentity {
				extension:   self.owner.host.extension().clone(),
				declaration: self.owner.declaration_id.clone(),
				generation:  self.owner.generation,
			},
			tml:      Str::new(source),
		})
	}
}

/// One manifest-verified exact-revision renderer roster entry.
#[derive(Clone, Debug)]
pub struct UiRendererRosterEntry {
	/// Generation-fenced callback owner.
	pub owner:       UiCallbackOwner,
	/// Frozen renderer declaration.
	pub declaration: VerifiedRendererDeclaration,
}
/// One manifest-verified extension completion roster entry.
#[derive(Clone, Debug)]
pub struct UiCompletionRosterEntry {
	/// Generation-fenced callback owner.
	pub owner:       UiCallbackOwner,
	/// Static trigger metadata available without starting Python.
	pub declaration: TriggerDecl,
}

/// Atomic manifest-verified command, shortcut, completion, and renderer
/// ownership table.
#[derive(Clone, Debug, Default)]
pub struct UiRoster {
	commands:          BTreeMap<Str, UiCommandRosterEntry>,
	shortcuts:         BTreeMap<Str, UiShortcutRosterEntry>,
	completions:       BTreeMap<Str, Vec<UiCompletionRosterEntry>>,
	message_renderers: BTreeMap<Str, UiMessageRendererRosterEntry>,
	renderers:         BTreeMap<omp_tool::ToolIdentity, Vec<UiRendererRosterEntry>>,
}

/// A roster publication attempted to shadow another admitted owner.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
#[error("UI roster key {key} is already owned by another extension")]
pub struct UiRosterConflict {
	/// Canonical command spelling, alias, or normalized chord.
	pub key: Str,
}

impl UiRoster {
	/// Atomically replaces every row owned by `host` with one verified
	/// generation.
	pub fn install(
		&mut self,
		host: HostKey,
		roster: &VerifiedUiRoster,
	) -> Result<(), UiRosterConflict> {
		let mut commands = self.commands.clone();
		let mut shortcuts = self.shortcuts.clone();
		let mut completions = self.completions.clone();
		let mut message_renderers = self.message_renderers.clone();
		let mut renderers = self.renderers.clone();
		commands.retain(|_, entry| entry.owner.host != host);
		shortcuts.retain(|_, entry| entry.owner.host != host);
		completions.retain(|_, entries| {
			entries.retain(|entry| entry.owner.host != host);
			!entries.is_empty()
		});
		message_renderers.retain(|_, entry| entry.owner.host != host);
		renderers.retain(|_, entries| {
			entries.retain(|entry| entry.owner.host != host);
			!entries.is_empty()
		});
		for declaration in &roster.commands {
			let entry = UiCommandRosterEntry {
				owner:       UiCallbackOwner {
					host:           host.clone(),
					generation:     roster.generation,
					declaration_id: Str::from(declaration.declaration_id.as_str()),
					callback:       Str::from(declaration.callback.as_str()),
				},
				declaration: declaration.clone(),
			};
			for spelling in std::iter::once(declaration.name.as_str())
				.chain(declaration.aliases.iter().map(String::as_str))
			{
				if commands.contains_key(spelling) {
					tracing::warn!(
						extension_id = %host.extension(),
						host_generation = roster.generation,
						roster_key = %spelling,
						"extension UI roster publication rejected",
					);
					return Err(UiRosterConflict { key: Str::from(spelling) });
				}
				commands.insert(Str::from(spelling), entry.clone());
			}
		}
		for declaration in &roster.shortcuts {
			if shortcuts.contains_key(declaration.chord.as_str()) {
				tracing::warn!(
					extension_id = %host.extension(),
					host_generation = roster.generation,
					roster_key = %declaration.chord,
					"extension UI roster publication rejected",
				);
				return Err(UiRosterConflict { key: Str::from(declaration.chord.as_str()) });
			}
			shortcuts.insert(Str::from(declaration.chord.as_str()), UiShortcutRosterEntry {
				owner:       UiCallbackOwner {
					host:           host.clone(),
					generation:     roster.generation,
					declaration_id: Str::from(declaration.declaration_id.as_str()),
					callback:       Str::from(declaration.callback.as_str()),
				},
				declaration: declaration.clone(),
			});
		}
		for declaration in &roster.triggers {
			completions
				.entry(Str::from(declaration.prefix.as_str()))
				.or_default()
				.push(UiCompletionRosterEntry {
					owner:       UiCallbackOwner {
						host:           host.clone(),
						generation:     roster.generation,
						declaration_id: Str::from(declaration.declaration_id.as_str()),
						callback:       Str::from(declaration.callback.as_str()),
					},
					declaration: declaration.clone(),
				});
		}
		for declaration in &roster.message_renderers {
			if message_renderers.contains_key(declaration.custom_type.as_str()) {
				tracing::warn!(
					extension_id = %host.extension(),
					host_generation = roster.generation,
					renderer = %declaration.custom_type,
					"extension message renderer publication rejected",
				);
				return Err(UiRosterConflict { key: declaration.custom_type.clone() });
			}
			message_renderers.insert(declaration.custom_type.clone(), UiMessageRendererRosterEntry {
				owner:       UiCallbackOwner {
					host:           host.clone(),
					generation:     roster.generation,
					declaration_id: declaration.declaration_id.clone(),
					callback:       declaration.callback.clone(),
				},
				declaration: declaration.clone(),
			});
		}
		for declaration in &roster.renderers {
			let entries = renderers.entry(declaration.identity.clone()).or_default();
			if !declaration.decorates && entries.iter().any(|entry| !entry.declaration.decorates) {
				let identity = &declaration.identity;
				tracing::warn!(
					extension_id = %host.extension(),
					host_generation = roster.generation,
					renderer = %identity.name,
					"extension UI roster publication rejected",
				);
				return Err(UiRosterConflict {
					key: sf!("{}@{}.{}", identity.name, identity.rev.family, identity.rev.n),
				});
			}
			entries.push(UiRendererRosterEntry {
				owner:       UiCallbackOwner {
					host:           host.clone(),
					generation:     roster.generation,
					declaration_id: declaration.declaration_id.clone(),
					callback:       declaration.callback.clone(),
				},
				declaration: declaration.clone(),
			});
		}
		self.commands = commands;
		self.shortcuts = shortcuts;
		self.completions = completions;
		self.message_renderers = message_renderers;
		self.renderers = renderers;
		tracing::info!(
			extension_id = %host.extension(),
			host_generation = roster.generation,
			command_count = roster.commands.len(),
			shortcut_count = roster.shortcuts.len(),
			completion_count = roster.triggers.len(),
			message_renderer_count = roster.message_renderers.len(),
			renderer_count = roster.renderers.len(),
			"extension UI roster published",
		);
		Ok(())
	}

	/// Removes every callback owned by one exact process during teardown.
	pub fn remove(&mut self, host: &HostKey) {
		self.commands.retain(|_, entry| &entry.owner.host != host);
		self.shortcuts.retain(|_, entry| &entry.owner.host != host);
		self.completions.retain(|_, entries| {
			entries.retain(|entry| &entry.owner.host != host);
			!entries.is_empty()
		});
		self
			.message_renderers
			.retain(|_, entry| &entry.owner.host != host);
		self.renderers.retain(|_, entries| {
			entries.retain(|entry| &entry.owner.host != host);
			!entries.is_empty()
		});
	}

	/// Resolves a canonical command name or alias without allocating.
	pub fn command(&self, spelling: &str) -> Option<&UiCommandRosterEntry> {
		self.commands.get(spelling)
	}

	/// Resolves a normalized shortcut chord without allocating.
	pub fn shortcut(&self, chord: &str) -> Option<&UiShortcutRosterEntry> {
		self.shortcuts.get(chord)
	}

	/// Iterates canonical command rows without repeating aliases.
	pub fn commands(&self) -> impl Iterator<Item = &UiCommandRosterEntry> {
		self
			.commands
			.iter()
			.filter(|(spelling, entry)| spelling.as_str() == entry.declaration.name.as_str())
			.map(|(_, entry)| entry)
	}

	/// Iterates every normalized shortcut row.
	pub fn shortcuts(&self) -> impl Iterator<Item = &UiShortcutRosterEntry> {
		self.shortcuts.values()
	}

	/// Resolves the one extension fold registered for a custom message type.
	pub fn message_renderer(&self, custom_type: &str) -> Option<&UiMessageRendererRosterEntry> {
		self.message_renderers.get(custom_type)
	}

	/// Returns extension folds registered for one exact tool revision.
	pub fn renderers(
		&self,
		identity: &omp_tool::ToolIdentity,
	) -> impl Iterator<Item = &UiRendererRosterEntry> {
		self.renderers.get(identity).into_iter().flatten()
	}

	/// Iterates every extension completion row in prefix order.
	pub fn completions(&self) -> impl Iterator<Item = &UiCompletionRosterEntry> {
		self.completions.values().flatten()
	}

	/// Resolves every completion provider sharing one literal prefix.
	pub fn completions_for(&self, prefix: &str) -> impl Iterator<Item = &UiCompletionRosterEntry> {
		self.completions.get(prefix).into_iter().flatten()
	}
}

/// Shared callback dispatch builder which issues fresh nested authority for
/// every device body or hook subscription.
pub struct NestedCallbackDispatcher {
	dispatcher: Arc<dyn CallbackDispatcher>,
	next_id:    AtomicU64,
}

impl NestedCallbackDispatcher {
	/// Binds callback construction to the live extension-host dispatcher.
	pub fn new(dispatcher: Arc<dyn CallbackDispatcher>) -> Self {
		Self { dispatcher, next_id: AtomicU64::new(1) }
	}

	/// Dispatches one independently scoped callback. The new callback carries
	/// no effects from its caller and is fenced to `target`.
	pub async fn dispatch(
		&self,
		target: Arc<ControlConnectionIdentity>,
		caller: &ControlRequestContext,
		operation: &'static str,
		arguments: serde_json::Map<String, serde_json::Value>,
		policy: CallbackConcurrency,
		timeout: Duration,
		event: Option<Str>,
		device: Option<Str>,
	) -> Result<serde_json::Value, ControlProtocolError> {
		if target.session_generation != caller.connection.session_generation {
			return Err(ControlProtocolError::new(
				"StaleGeneration",
				"callback target belongs to another session generation",
			));
		}
		let parent = caller.invocation.as_ref().ok_or_else(|| {
			ControlProtocolError::new(
				"InvalidPhase",
				"nested callback dispatch requires a live host-issued invocation",
			)
		})?;
		if parent.lifecycle != LifecyclePhase::Active {
			return Err(ControlProtocolError::new(
				"InvalidPhase",
				"nested callback dispatch requires ACTIVE lifecycle",
			));
		}
		let id = self.next_id.fetch_add(1, Ordering::Relaxed).max(1);
		let invocation = sf!("{}:{}:{}", operation, target.host_generation, id);
		let authority = ControlInvocationAuthority {
			invocation,
			phase: InvocationPhase::EffectsAuthorized,
			session: parent.session.clone(),
			turn: parent.turn,
			event,
			call: parent.call.clone(),
			device,
			effects: Box::new([]),
			place_kind: sf!("host"),
			lifecycle: parent.lifecycle,
			roots: parent.roots.clone(),
			remote: parent.remote,
			has_ui: parent.has_ui,
			headless: parent.headless,
			settings: parent.settings.clone(),
			secret_settings: parent.secret_settings.clone(),
			data: None,
			direct_filesystem: None,
		};
		self
			.dispatcher
			.dispatch(target, ControlDispatch {
				operation: sf!(operation),
				arguments,
				authority,
				policy,
				deadline: EventDeadline { at: Instant::now() + timeout },
			})
			.await
	}

	/// Dispatches one provider hook through the authenticated hook callback
	/// operation while preserving its exact domain event in nested authority.
	pub async fn dispatch_provider_hook(
		&self,
		target: Arc<ControlConnectionIdentity>,
		caller: &ControlRequestContext,
		event: &'static str,
		arguments: serde_json::Map<String, serde_json::Value>,
		policy: CallbackConcurrency,
		timeout: Duration,
	) -> Result<serde_json::Value, ControlProtocolError> {
		self
			.dispatch(
				target,
				caller,
				"omp.hooks.dispatch",
				arguments,
				policy,
				timeout,
				Some(Str::new_static(event)),
				None,
			)
			.await
	}
}

/// One host-owned deadline for a dispatched event.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct EventDeadline {
	/// Monotonic expiration instant.
	pub at: Instant,
}

/// Maximum encoded payload for an observational extension lifecycle event.
pub const MAX_LIFECYCLE_EVENT_BYTES: usize = 8 * 1024;

/// One revisioned observational lifecycle fact ready for hook dispatch.
#[derive(Clone, Debug)]
pub struct LifecycleEvent {
	/// Closed protocol event identifier.
	pub id:       HookEventId,
	/// Payload schema revision.
	pub revision: u32,
	/// Already encoded revision-specific payload.
	pub payload:  CowBytes<'static>,
}

/// Invalid revisioned lifecycle event payload.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum LifecycleEventError {
	/// The event is not one of the sanctioned observational lifecycle facts.
	#[error("hook event is not a sanctioned lifecycle observation")]
	Unsupported,
	/// Only revision 1 is currently admitted.
	#[error("unsupported lifecycle event revision {0}")]
	Revision(u32),
	/// Encoded payload exceeded the extension event ceiling.
	#[error("lifecycle event payload exceeds {MAX_LIFECYCLE_EVENT_BYTES} bytes")]
	PayloadTooLarge,
}

impl LifecycleEvent {
	/// Validates an authoritative event and encodes its hook envelope. The
	/// resulting bytes still travel through the ordinary dispatch router,
	/// deadline, quota, cancellation, and failure-policy path.
	pub fn encode(
		self,
		dispatch_id: u64,
		deadline_ms: u64,
	) -> Result<CowBytes<'static>, LifecycleEventError> {
		if !matches!(
			self.id,
			HookEventId::HookEventTtsrTriggered
				| HookEventId::HookEventRetryStart
				| HookEventId::HookEventRetryEnd
				| HookEventId::HookEventFallbackApplied
				| HookEventId::HookEventFallbackSucceeded
		) {
			return Err(LifecycleEventError::Unsupported);
		}
		if self.revision != 1 {
			return Err(LifecycleEventError::Revision(self.revision));
		}
		if self.payload.len() > MAX_LIFECYCLE_EVENT_BYTES {
			return Err(LifecycleEventError::PayloadTooLarge);
		}
		let envelope = HookHostEnvelope {
			body:  Some(hook_host_envelope::Body::Dispatch(HookDispatch {
				event_id: self.id as i32,
				event_rev: self.revision,
				dispatch_id,
				phase: v1::HookPhase::Observe as i32,
				payload: self.payload.clone().into_bytes(),
				deadline_ms,
				subscription_ids: Vec::new(),
				props: None,
			})),
			props: None,
		};
		Ok(CowBytes::from(envelope.encode_to_vec()))
	}
}

/// Emits one revision-1 inference retry transition.
pub fn retry_event(
	context: LifecycleEventContext,
	started: bool,
	attempt: u32,
	maximum: u32,
	delay_ms: u64,
	reason: Str,
	outcome: Option<Str>,
) -> Result<LifecycleEvent, LifecycleEventError> {
	let event = RetryLifecycleEventV1 {
		context: Some(context),
		attempt,
		maximum,
		delay_ms,
		reason: bounded_event_text(reason, 512),
		outcome: outcome.map(|value| bounded_event_text(value, 512)),
	};
	lifecycle_event(
		if started {
			HookEventId::HookEventRetryStart
		} else {
			HookEventId::HookEventRetryEnd
		},
		event,
	)
}

/// Emits one revision-1 inference fallback transition.
pub fn fallback_event(
	context: LifecycleEventContext,
	succeeded: bool,
	source_model: Str,
	target_model: Str,
	reason: Str,
) -> Result<LifecycleEvent, LifecycleEventError> {
	let event = FallbackLifecycleEventV1 {
		context:      Some(context),
		source_model: bounded_event_text(source_model, 512),
		target_model: bounded_event_text(target_model, 512),
		reason:       bounded_event_text(reason, 512),
	};
	lifecycle_event(
		if succeeded {
			HookEventId::HookEventFallbackSucceeded
		} else {
			HookEventId::HookEventFallbackApplied
		},
		event,
	)
}

fn lifecycle_event(
	id: HookEventId,
	payload: impl Message,
) -> Result<LifecycleEvent, LifecycleEventError> {
	let payload = CowBytes::from(payload.encode_to_vec());
	if payload.len() > MAX_LIFECYCLE_EVENT_BYTES {
		return Err(LifecycleEventError::PayloadTooLarge);
	}
	Ok(LifecycleEvent { id, revision: 1, payload })
}

fn bounded_event_text(value: Str, limit: usize) -> String {
	let mut value = value.to_string();
	value.truncate(value.floor_char_boundary(limit));
	value
}

/// Default maximum UTF-8 bytes allocated to one extension prompt contribution.
pub const DEFAULT_PROMPT_CONTRIBUTION_BUDGET: usize = 64 * 1024;

/// One manifest-verified prompt renderer reachable through CONTROL.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PromptSlotBinding {
	/// Stable callable identity within the owning extension.
	pub key:          Str,
	/// Authenticated extension identity.
	pub owner:        Str,
	/// Catalog destination.
	pub slot:         SlotId,
	/// Declared stability band.
	pub class:        SlotClass,
	/// Descending order within the slot.
	pub priority:     i16,
	/// Maximum accepted UTF-8 bytes.
	pub budget_bytes: usize,
	/// Stable qualified Python callable selected by the sealed declaration.
	pub callback:     Str,
}

/// Immutable context supplied to one pure Python prompt renderer.
#[derive(Clone, Debug, serde::Deserialize, serde::Serialize)]
pub struct PromptPullContext {
	/// Stable session identity.
	pub session_id:     Str,
	/// Selected model identity.
	pub model:          Str,
	/// Selected provider identity.
	pub provider:       Str,
	/// Model context window in tokens.
	pub context_window: u64,
	/// Current compaction epoch.
	pub epoch:          u64,
	/// Active working directory.
	pub cwd:            Str,
	/// Active workspace roots.
	pub roots:          Vec<Str>,
	/// Current VCS branch, when known.
	pub vcs_branch:     Option<Str>,
	/// Current VCS commit, when known.
	pub vcs_commit:     Option<Str>,
	/// Whether this prompt belongs to a child agent.
	pub is_subagent:    bool,
	/// Child agent kind, when applicable.
	pub agent_kind:     Option<Str>,
}

/// Cached, bounded result of one prompt renderer pull.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PromptContributionRecord {
	/// Declaration which produced these bytes.
	pub binding:   PromptSlotBinding,
	/// Valid UTF-8 contribution bytes.
	pub content:   Str,
	/// Whether the worker result exceeded its allocation.
	pub truncated: bool,
}

/// Pulls manifest-verified prompt declarations through live extension actors.
#[async_trait::async_trait]
pub trait PromptContributionProvider: Send + Sync + 'static {
	/// Returns every declaration available before the first prompt.
	fn declarations(&self) -> Vec<PromptSlotBinding>;

	/// Refreshes one exact declaration from its owning Python extension host.
	async fn pull(
		&self,
		binding: &PromptSlotBinding,
		context: &PromptPullContext,
	) -> Result<PromptContributionRecord, PromptDispatchError>;
}

/// Invalid prompt registration, pull, or CONTROL contribution.
#[derive(Debug, Error)]
pub enum PromptDispatchError {
	/// A declaration named an unknown catalog slot.
	#[error("prompt declaration names unknown slot {0}")]
	UnknownSlot(Str),
	/// A declaration targeted a core-owned slot.
	#[error("prompt declaration targets non-writable slot {0}")]
	ReadOnlySlot(SlotId),
	/// A declaration class was malformed.
	#[error("prompt declaration has invalid class")]
	InvalidClass,
	/// A declaration attempted to place weaker content in a stronger band.
	#[error("prompt declaration class is looser than slot {slot}")]
	ClassConflict {
		/// Catalog slot.
		slot: SlotId,
	},
	/// A declaration priority did not fit the supported ordering type.
	#[error("prompt declaration priority is out of range")]
	Priority,
	/// A frozen prompt declaration was malformed.
	#[error("prompt declaration is malformed")]
	MalformedDeclaration,
	/// The prompt provider was not activated with immutable context.
	#[error("prompt provider has no active prompt context")]
	MissingContext,
	/// Prompt context could not be encoded.
	#[error("prompt context could not be encoded")]
	Context(#[source] serde_json::Error),
	/// A CONTROL response was not a prompt contribution.
	#[error("extension host returned no prompt contribution")]
	MissingContribution,
	/// A contribution did not match the declaration which was pulled.
	#[error("extension host returned a prompt contribution for another declaration")]
	StaleContribution,
	/// The owning extension host could not complete the pull.
	#[error("prompt contribution CONTROL dispatch failed")]
	Control(#[source] ControlRuntimeError),
}

/// Decodes one frozen CONTROL declaration using its transport-authenticated
/// owner.
pub fn prompt_slot_binding(
	owner: impl Into<Str>,
	declaration: &serde_json::Value,
) -> Result<PromptSlotBinding, PromptDispatchError> {
	let owner = owner.into();
	let declaration = declaration
		.as_object()
		.ok_or(PromptDispatchError::MalformedDeclaration)?;
	let slot_name = declaration
		.get("slot")
		.and_then(serde_json::Value::as_str)
		.filter(|slot| !slot.is_empty())
		.ok_or(PromptDispatchError::MalformedDeclaration)?;
	let slot = SlotId::from_str(slot_name)
		.map_err(|_| PromptDispatchError::UnknownSlot(Str::new(slot_name)))?;
	if !prompt_slot_writable(slot) {
		return Err(PromptDispatchError::ReadOnlySlot(slot));
	}
	let class_name = declaration
		.get("class")
		.and_then(serde_json::Value::as_str)
		.ok_or(PromptDispatchError::MalformedDeclaration)?;
	let class = match class_name {
		"epochal" => SlotClass::Dynamic,
		name => SlotClass::from_str(name).map_err(|_| PromptDispatchError::InvalidClass)?,
	};
	if class > prompt_slot_default_class(slot) {
		return Err(PromptDispatchError::ClassConflict { slot });
	}
	let priority = declaration
		.get("priority")
		.and_then(serde_json::Value::as_i64)
		.and_then(|priority| i16::try_from(priority).ok())
		.ok_or(PromptDispatchError::Priority)?;
	let callback = declaration
		.get("callback")
		.and_then(serde_json::Value::as_object)
		.and_then(|callback| callback.get("$omp.callable"))
		.and_then(serde_json::Value::as_str)
		.filter(|callback| !callback.is_empty())
		.map(Str::new)
		.ok_or(PromptDispatchError::MalformedDeclaration)?;
	let key = sf!("{owner}:{slot}:{priority}:{callback}");
	Ok(PromptSlotBinding {
		key,
		owner,
		slot,
		class,
		priority,
		budget_bytes: DEFAULT_PROMPT_CONTRIBUTION_BUDGET,
		callback,
	})
}

/// Builds one CONTROL argument object for an exact prompt declaration.
pub fn prompt_dispatch_arguments(
	binding: &PromptSlotBinding,
	context: &PromptPullContext,
) -> Result<serde_json::Map<String, serde_json::Value>, PromptDispatchError> {
	let mut context = serde_json::to_value(context).map_err(PromptDispatchError::Context)?;
	let object = context
		.as_object_mut()
		.expect("PromptPullContext serializes as an object");
	object.insert(
		"cls".to_owned(),
		serde_json::Value::String(match binding.class {
			SlotClass::Dynamic => "epochal".to_owned(),
			class => class.to_string(),
		}),
	);
	object.insert("budget_bytes".to_owned(), serde_json::Value::from(binding.budget_bytes));
	Ok(serde_json::Map::from_iter([
		("slot".to_owned(), serde_json::Value::String(binding.slot.to_string())),
		("callback".to_owned(), serde_json::Value::String(binding.callback.to_string())),
		("context".to_owned(), context),
	]))
}

/// Decodes, identity-checks, and bounds one CONTROL prompt contribution.
pub fn decode_prompt_contribution(
	value: serde_json::Value,
	binding: &PromptSlotBinding,
) -> Result<PromptContributionRecord, PromptDispatchError> {
	let contribution = value
		.as_object()
		.ok_or(PromptDispatchError::MissingContribution)?;
	let slot = binding.slot.to_string();
	if contribution.get("slot").and_then(serde_json::Value::as_str) != Some(slot.as_str())
		|| contribution
			.get("callback")
			.and_then(serde_json::Value::as_str)
			!= Some(binding.callback.as_str())
	{
		return Err(PromptDispatchError::StaleContribution);
	}
	let mut content = contribution
		.get("content")
		.and_then(serde_json::Value::as_str)
		.ok_or(PromptDispatchError::MissingContribution)?
		.to_owned();
	let truncated = content.len() > binding.budget_bytes;
	if truncated {
		content.truncate(content.floor_char_boundary(binding.budget_bytes));
	}
	Ok(PromptContributionRecord { binding: binding.clone(), content: Str::from(content), truncated })
}

const fn prompt_slot_writable(slot: SlotId) -> bool {
	matches!(
		slot,
		SlotId::Runtime
			| SlotId::Policy
			| SlotId::Workflow
			| SlotId::Skills
			| SlotId::Rules
			| SlotId::Guidance
			| SlotId::Workspace
			| SlotId::Memory
			| SlotId::Standing
			| SlotId::Recall
			| SlotId::Status
	)
}

const fn prompt_slot_default_class(slot: SlotId) -> SlotClass {
	match slot {
		SlotId::Runtime | SlotId::Workflow => SlotClass::Frozen,
		SlotId::Policy | SlotId::Skills | SlotId::Rules | SlotId::Guidance | SlotId::Workspace => {
			SlotClass::Stable
		},
		SlotId::Memory | SlotId::Standing => SlotClass::Dynamic,
		SlotId::Recall | SlotId::Status => SlotClass::Volatile,
		SlotId::Conventions | SlotId::Role | SlotId::Tools | SlotId::Delivery => SlotClass::Frozen,
	}
}

/// Invocation bytes awaiting host dispatch.
#[derive(Clone, Debug)]
pub struct DispatchRequest {
	/// Nonzero host-local correlation id.
	pub id:       u64,
	/// Registered callback overlap policy.
	pub policy:   CallbackConcurrency,
	/// Deadline applied by the host frame pump.
	pub deadline: EventDeadline,
	/// Already encoded request payload.
	pub payload:  CowBytes<'static>,
}

/// One typed UI callback routed to an exact roster owner.
#[derive(Clone, Debug)]
pub struct UiCallbackDispatch {
	/// Generation-fenced roster owner.
	pub owner:    UiCallbackOwner,
	/// Typed UI payload; arbitrary extension JSON is not accepted.
	pub dispatch: UiDispatch,
}

impl UiCallbackDispatch {
	/// Encodes the typed UI frame with serialized actor composition.
	pub fn request(
		mut self,
		id: u64,
		timeout: Duration,
	) -> Result<DispatchRequest, UiDispatchError> {
		if id == 0 {
			return Err(UiDispatchError::ZeroId);
		}
		if self.dispatch.generation != self.owner.generation
			|| self.dispatch.declaration_id != self.owner.declaration_id.as_str()
		{
			return Err(UiDispatchError::StaleGeneration {
				expected: self.owner.generation,
				actual:   self.dispatch.generation,
			});
		}
		self.dispatch.props = None;
		let envelope = UiHostEnvelope {
			body:  Some(ui_host_envelope::Body::Dispatch(self.dispatch)),
			props: None,
		};
		Ok(DispatchRequest {
			id,
			policy: CallbackConcurrency::Serialized,
			deadline: EventDeadline { at: Instant::now() + timeout },
			payload: CowBytes::from(envelope.encode_to_vec()),
		})
	}
}

/// Invalid typed UI callback envelope, identity, or result.
#[derive(Debug, Error)]
pub enum UiDispatchError {
	/// Zero cannot identify a correlated callback.
	#[error("UI dispatch correlation id must be nonzero")]
	ZeroId,
	/// The typed frame did not name the exact roster generation.
	#[error("stale UI callback generation: expected {expected}, got {actual}")]
	StaleGeneration {
		/// Roster generation.
		expected: u64,
		/// Frame generation.
		actual:   u64,
	},
	/// The typed frame did not name the exact signed declaration.
	#[error("UI callback returned another declaration")]
	StaleDeclaration,
	/// The worker payload was malformed protobuf.
	#[error("worker returned a malformed UI dispatch result")]
	Decode(#[source] prost::DecodeError),
	/// The worker payload was not a typed UI dispatch result.
	#[error("worker returned no UI dispatch result")]
	MissingResult,
}

/// Decodes and generation-fences one command or shortcut callback result.
pub fn decode_ui_dispatch_result(
	payload: &[u8],
	owner: &UiCallbackOwner,
) -> Result<UiDispatchResult, UiDispatchError> {
	let envelope = UiWorkerEnvelope::decode(payload).map_err(UiDispatchError::Decode)?;
	let Some(ui_worker_envelope::Body::DispatchResult(result)) = envelope.body else {
		return Err(UiDispatchError::MissingResult);
	};
	if result.generation != owner.generation {
		return Err(UiDispatchError::StaleGeneration {
			expected: owner.generation,
			actual:   result.generation,
		});
	}
	if result.declaration_id != owner.declaration_id.as_str() {
		return Err(UiDispatchError::StaleDeclaration);
	}
	Ok(result)
}

/// Applies shortcut fail-open semantics: failed actions are dropped after the
/// chord has already been consumed by the local matcher.
pub fn shortcut_dispatch_succeeded(payload: &[u8], owner: &UiCallbackOwner) -> bool {
	decode_ui_dispatch_result(payload, owner)
		.ok()
		.and_then(|result| result.result)
		.is_some_and(|result| matches!(result, ui_dispatch_result::Result::Shortcut(_)))
}

/// Correlated completion receiver returned to the caller.
pub struct DispatchPending {
	response: Receiver<Result<CowBytes<'static>, DispatchError>>,
	deadline: EventDeadline,
}

impl DispatchPending {
	/// Waits for the terminal worker response.
	pub async fn response(self) -> Result<CowBytes<'static>, DispatchError> {
		use tokio::time::{self, Instant};
		let deadline = Instant::from_std(self.deadline.at);
		time::timeout_at(deadline, self.response.recv_async())
			.await
			.map_err(|_| DispatchError::Deadline)?
			.map_err(|_| DispatchError::HostGone)?
	}
}

struct Pending {
	generation: u64,
	deadline:   EventDeadline,
	response:   flume::Sender<Result<CowBytes<'static>, DispatchError>>,
}

struct ExtensionActor {
	running: usize,
	queued:  VecDeque<DispatchRequest>,
}

/// Failure while projecting a verified extension frame into a headless sink.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum HeadlessDispatchError {
	/// Worker dispatch generation or correlation was stale.
	#[error(transparent)]
	Dispatch(#[from] DispatchError),
	/// The owning headless lifecycle sink rejected the frame.
	#[error(transparent)]
	Sink(#[from] HeadlessSinkError),
}

/// One generation-fenced host router.
///
/// Frame multiplexing only correlates concurrent CONTROL traffic. Callback
/// entry remains serialized unless the declaration explicitly opts out.
pub struct DispatchRouter {
	host:       HostKey,
	generation: u64,
	pending:    Arc<Mutex<SparseMap<u64, Pending>>>,
	actors:     BTreeMap<Str, ExtensionActor>,
}

/// Router rejection or terminal failure.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum DispatchError {
	/// Zero cannot identify an invocation.
	#[error("dispatch correlation id must be nonzero")]
	ZeroId,
	/// A duplicate live correlation was supplied.
	#[error("dispatch correlation {0} is already live")]
	Duplicate(u64),
	/// A frame arrived from an old child generation.
	#[error("stale worker frame generation: expected {expected}, got {actual}")]
	StaleGeneration {
		/// Current host generation.
		expected: u64,
		/// Generation authenticated at the transport boundary.
		actual:   u64,
	},
	/// A terminal frame named no live invocation.
	#[error("stale worker frame correlation {0}")]
	StaleCorrelation(u64),
	/// The child disconnected before a terminal response.
	#[error("extension host disconnected")]
	HostGone,
	/// A per-event deadline elapsed.
	#[error("extension event deadline elapsed")]
	Deadline,
	/// A queued callback was cancelled before entering Python.
	#[error("extension event was cancelled before dispatch")]
	Cancelled,
}

impl DispatchRouter {
	/// Creates a router for one authenticated child generation.
	pub fn new(host: HostKey, generation: u64) -> Self {
		Self {
			host,
			generation,
			pending: Arc::new(Mutex::new(SparseMap::new())),
			actors: BTreeMap::new(),
		}
	}

	/// Queues an invocation and installs its correlation before any frame is
	/// written. Returns the request immediately only when actor policy admits
	/// it.
	pub fn dispatch(
		&mut self,
		extension: impl Into<Str>,
		request: DispatchRequest,
	) -> Result<(Option<DispatchRequest>, DispatchPending), DispatchError> {
		if request.id == 0 {
			return Err(DispatchError::ZeroId);
		}
		let (tx, rx) = flume::bounded(1);
		if self.pending.lock().get(request.id).is_some() {
			return Err(DispatchError::Duplicate(request.id));
		}
		self.pending.lock().insert(request.id, Pending {
			generation: self.generation,
			deadline:   request.deadline,
			response:   tx,
		});
		let actor = self
			.actors
			.entry(extension.into())
			.or_insert_with(|| ExtensionActor { running: 0, queued: VecDeque::new() });
		let deadline = request.deadline;
		if actor.policy_admits(request.policy) {
			actor.running += 1;
			Ok((Some(request), DispatchPending { response: rx, deadline }))
		} else {
			actor.queued.push_back(request);
			Ok((None, DispatchPending { response: rx, deadline }))
		}
	}

	/// Validates every inbound frame against the transport-authenticated child
	/// generation before domain-specific dispatch examines the frame body.
	pub const fn accept_frame(
		&self,
		generation: u64,
		_frame: &WorkerFrame,
	) -> Result<(), DispatchError> {
		if generation == self.generation {
			Ok(())
		} else {
			Err(DispatchError::StaleGeneration { expected: self.generation, actual: generation })
		}
	}

	/// Consumes a generation-fenced `SetAvailability` lifecycle frame.
	///
	/// The caller supplies the generation authenticated by the CONTROL
	/// transport. A stale frame therefore fails before it reaches the shared
	/// registry or emits a turn-boundary notification.
	///
	/// Returns `true` only when the worker frame contained this lifecycle arm.
	pub fn dispatch_availability(
		&self,
		generation: u64,
		frame: WorkerFrame,
		sink: &dyn AvailabilitySink,
	) -> Result<bool, DispatchError> {
		self.accept_frame(generation, &frame)?;
		let Some(worker_frame::Body::Lifecycle(lifecycle)) = frame.body else {
			return Ok(false);
		};
		let Some(lifecycle_worker_envelope::Body::SetAvailability(availability)) = lifecycle.body
		else {
			return Ok(false);
		};
		sink.set_availability(AvailabilityBatch::from_wire(availability));
		Ok(true)
	}

	/// Consumes typed UI effects and requests into the shared headless sink.
	///
	/// Returns `true` only for a retained UI payload. Registration and dispatch
	/// result frames remain owned by their dedicated registries.
	pub fn dispatch_headless_ui(
		&self,
		generation: u64,
		frame: WorkerFrame,
		sink: &HeadlessLifecycleSink,
	) -> Result<bool, HeadlessDispatchError> {
		self.accept_frame(generation, &frame)?;
		let Some(worker_frame::Body::Ui(ui)) = frame.body else {
			return Ok(false);
		};
		match ui.body {
			Some(ui_worker_envelope::Body::Effect(effect)) => {
				sink.ui_effect(generation, effect)?;
				Ok(true)
			},
			Some(ui_worker_envelope::Body::Request(request)) => {
				sink.ui_request(generation, request)?;
				Ok(true)
			},
			_ => Ok(false),
		}
	}

	/// Completes a correlation and releases one serialized callback slot.
	pub fn complete(
		&mut self,
		extension: &str,
		id: u64,
		generation: u64,
		result: Result<CowBytes<'static>, DispatchError>,
	) -> Result<Option<DispatchRequest>, DispatchError> {
		if generation != self.generation {
			return Err(DispatchError::StaleGeneration {
				expected: self.generation,
				actual:   generation,
			});
		}
		let record = self
			.pending
			.lock()
			.remove(id)
			.ok_or(DispatchError::StaleCorrelation(id))?;
		if record.generation != generation {
			return Err(DispatchError::StaleGeneration {
				expected: record.generation,
				actual:   generation,
			});
		}
		let _ = record.response.send(result);
		let Some(actor) = self.actors.get_mut(extension) else {
			return Ok(None);
		};
		actor.running = actor.running.saturating_sub(1);
		let next = actor.queued.pop_front();
		if next.is_some() {
			actor.running += 1;
		}
		Ok(next)
	}

	/// Removes a callback which has not entered the child actor yet.
	///
	/// Returns `false` when the callback is already running and therefore needs
	/// an explicit `CancelDispatch` frame.
	pub fn cancel_queued(&mut self, extension: &str, id: u64) -> Result<bool, DispatchError> {
		if self.pending.lock().get(id).is_none() {
			return Err(DispatchError::StaleCorrelation(id));
		}
		let Some(actor) = self.actors.get_mut(extension) else {
			return Ok(false);
		};
		let Some(position) = actor.queued.iter().position(|request| request.id == id) else {
			return Ok(false);
		};
		actor.queued.remove(position);
		if let Some(record) = self.pending.lock().remove(id) {
			let _ = record.response.send(Err(DispatchError::Cancelled));
		}
		Ok(true)
	}

	/// Fails every outstanding callback when the child CONTROL descriptor
	/// closes.
	pub fn disconnect(&mut self) {
		self.pending.lock().retain(|_, record| {
			let _ = record.response.send(Err(DispatchError::HostGone));
			false
		});
		self.actors.clear();
	}

	/// Expires outstanding per-host event deadlines without waiting for another
	/// frame.
	pub fn expire(&self, now: Instant) {
		self.pending.lock().retain(|_, record| {
			if record.deadline.at > now {
				return true;
			}
			let _ = record.response.send(Err(DispatchError::Deadline));
			false
		});
	}

	/// Returns the authenticated host identity.
	pub const fn host(&self) -> &HostKey {
		&self.host
	}
}

impl ExtensionActor {
	fn policy_admits(&self, policy: CallbackConcurrency) -> bool {
		policy.admits(self.running)
	}
}
#[cfg(test)]
mod tests {
	use omp_proto::ui::v1::{
		CommandDispatchResult, CommandInvoked, ShortcutDispatchResult, UiError,
		command_dispatch_result, ui_dispatch,
	};

	use super::*;
	fn ui_owner() -> UiCallbackOwner {
		UiCallbackOwner {
			host:           HostKey::new("project", "trusted", "extension"),
			generation:     7,
			declaration_id: sf!("command"),
			callback:       sf!("extension.command"),
		}
	}

	fn ui_result(result: ui_dispatch_result::Result) -> Vec<u8> {
		UiWorkerEnvelope {
			body:  Some(ui_worker_envelope::Body::DispatchResult(UiDispatchResult {
				result: Some(result),
				generation: 7,
				declaration_id: "command".to_owned(),
				..Default::default()
			})),
			props: None,
		}
		.encode_to_vec()
	}

	#[test]
	fn skill_path_contributions_require_containment_and_bounds() {
		let tree = tempfile::tempdir().expect("tree");
		let root = tree.path().join("allowed");
		let outside = tree.path().join("outside");
		fs::create_dir_all(root.join("review")).expect("skill directory");
		fs::create_dir_all(&outside).expect("outside");
		let skill = root.join("review/SKILL.md");
		fs::write(&skill, "---\ndescription: review\n---\nbody").expect("skill");
		let result = admit_skill_path_contributions(
			&serde_json::json!({
				"kind": "modify",
				"patch": {
					"add": [{
						"uri": skill.to_string_lossy(),
						"kind": "skill",
						"origin": "publisher.extension"
					}]
				}
			}),
			std::slice::from_ref(&root),
		)
		.expect("contained skill");
		assert_eq!(result.len(), 1);
		assert_eq!(result[0].path, fs::canonicalize(&skill).expect("canonical skill"));

		let escaped = outside.join("SKILL.md");
		fs::write(&escaped, "outside").expect("outside skill");
		assert!(matches!(
			admit_skill_path_contributions(
				&serde_json::json!({"add": [{
					"uri": escaped.to_string_lossy(),
					"kind": "skill",
					"origin": "publisher.extension"
				}]}),
				std::slice::from_ref(&root),
			),
			Err(SkillPathAdmissionError::Escapes)
		));
		fs::write(&skill, vec![b'x'; 64_001]).expect("oversized skill");
		assert!(matches!(
			admit_skill_path_contributions(
				&serde_json::json!({"add": [{
					"uri": skill.to_string_lossy(),
					"kind": "skill",
					"origin": "publisher.extension"
				}]}),
				std::slice::from_ref(&root),
			),
			Err(SkillPathAdmissionError::InvalidFile)
		));
	}

	#[test]
	fn command_dispatch_is_typed_and_generation_fenced() {
		let owner = ui_owner();
		let request = UiCallbackDispatch {
			owner:    owner.clone(),
			dispatch: UiDispatch {
				kind:           Some(ui_dispatch::Kind::Command(CommandInvoked {
					name: "alias".to_owned(),
					argv: vec!["one".to_owned(), "two".to_owned()],
					raw:  "one two".to_owned(),
					mode: "interactive".to_owned(),
				})),
				generation:     7,
				declaration_id: "command".to_owned(),
				props:          None,
			},
		}
		.request(9, Duration::from_secs(1))
		.expect("typed command dispatch");
		assert_eq!(request.policy, CallbackConcurrency::Serialized);
		let envelope = UiHostEnvelope::decode(request.payload.as_ref()).expect("UI host envelope");
		let Some(ui_host_envelope::Body::Dispatch(dispatch)) = envelope.body else {
			panic!("UI dispatch body");
		};
		let Some(ui_dispatch::Kind::Command(command)) = dispatch.kind else {
			panic!("command body");
		};
		assert_eq!(command.argv, ["one", "two"]);

		let prompt = ui_result(ui_dispatch_result::Result::Command(CommandDispatchResult {
			outcome: Some(command_dispatch_result::Outcome::Prompt("Review $1".to_owned())),
			submit:  Some(true),
		}));
		assert!(matches!(
			decode_ui_dispatch_result(&prompt, &owner)
				.expect("command result")
				.result,
			Some(ui_dispatch_result::Result::Command(_))
		));
		let mut stale = owner.clone();
		stale.generation = 8;
		assert!(matches!(
			decode_ui_dispatch_result(&prompt, &stale),
			Err(UiDispatchError::StaleGeneration { .. })
		));
	}

	#[test]
	fn shortcut_errors_fail_open_after_local_consumption() {
		let owner = ui_owner();
		let failed = ui_result(ui_dispatch_result::Result::Error(UiError {
			code: "CallbackFailed".to_owned(),
			message: "handler raised".to_owned(),
			..Default::default()
		}));
		assert!(!shortcut_dispatch_succeeded(&failed, &owner));
		let succeeded = ui_result(ui_dispatch_result::Result::Shortcut(ShortcutDispatchResult {}));
		assert!(shortcut_dispatch_succeeded(&succeeded, &owner));
		assert!(!shortcut_dispatch_succeeded(&[0xff], &owner));
	}

	fn message_renderer_declaration(
		declaration_id: &'static str,
		custom_type: &'static str,
	) -> VerifiedMessageRendererDeclaration {
		VerifiedMessageRendererDeclaration {
			declaration_id: sf!(declaration_id),
			custom_type:    sf!(custom_type),
			callback:       sf!("extension.render_message"),
			module:         sf!("extension"),
		}
	}

	#[test]
	fn message_renderer_roster_replaces_its_own_generation_and_rejects_competing_owners() {
		let host = HostKey::new("project", "trusted", "extension");
		let mut roster = UiRoster::default();
		roster
			.install(host.clone(), &VerifiedUiRoster {
				generation: 7,
				extension: sf!("extension"),
				message_renderers: vec![message_renderer_declaration("renderer-v1", "audit")]
					.into_boxed_slice(),
				..Default::default()
			})
			.expect("first generation");
		assert_eq!(
			roster
				.message_renderer("audit")
				.expect("message renderer")
				.owner
				.generation,
			7
		);
		roster
			.install(host.clone(), &VerifiedUiRoster {
				generation: 8,
				extension: sf!("extension"),
				message_renderers: vec![message_renderer_declaration("renderer-v2", "audit")]
					.into_boxed_slice(),
				..Default::default()
			})
			.expect("same owner replaces its generation");
		let replacement = roster.message_renderer("audit").expect("replacement");
		assert_eq!(replacement.owner.generation, 8);
		assert_eq!(replacement.declaration.declaration_id, "renderer-v2");

		let competing = HostKey::new("project", "trusted", "competing");
		assert!(
			roster
				.install(competing, &VerifiedUiRoster {
					generation: 1,
					extension: sf!("competing"),
					message_renderers: vec![message_renderer_declaration("competing", "audit")]
						.into_boxed_slice(),
					..Default::default()
				})
				.is_err()
		);
		let entry = roster.message_renderer("audit").expect("replacement");
		let request = entry
			.dispatch(
				"01message",
				&CustomMessage::live_delegation("semantic body"),
				serde_json::json!({
					"width": 80,
					"charset": "unicode",
					"appearance": "dark",
					"graphics": "none",
					"hyperlinks": true,
					"focused": true,
					"collapsed": false,
					"place": "transcript",
				}),
			)
			.expect("typed message dispatch");
		let Some(ui_dispatch::Kind::Render(render)) = request.dispatch.kind else {
			panic!("render dispatch");
		};
		let state: serde_json::Value =
			serde_json::from_slice(&render.state).expect("renderer state JSON");
		assert_eq!(state["message"]["text"], "semantic body");
		assert_eq!(state["message"]["presentation"]["frame"], "live-delegation");
		let rendered = entry
			.rendered(&UiDispatchResult {
				result: Some(ui_dispatch_result::Result::Rendered(omp_proto::ui::v1::RenderedView {
					content: Some(omp_proto::ui::v1::Tml {
						source: bytes::Bytes::from_static(b"<text>replacement</text>"),
						hash:   0,
					}),
					state:   bytes::Bytes::new(),
				})),
				generation: 8,
				declaration_id: "renderer-v2".to_owned(),
				..Default::default()
			})
			.expect("durable renderer result");
		assert_eq!(rendered.renderer.extension, "extension");
		assert_eq!(rendered.renderer.declaration, "renderer-v2");
		assert_eq!(rendered.renderer.generation, 8);
		assert_eq!(rendered.tml, "<text>replacement</text>");

		roster.remove(&host);
		assert!(roster.message_renderer("audit").is_none());
	}

	fn renderer_declaration(
		identity: omp_tool::ToolIdentity,
		decorates: bool,
	) -> VerifiedRendererDeclaration {
		VerifiedRendererDeclaration {
			declaration_id: sf!("renderer"),
			identity,
			callback: sf!("extension.render"),
			reduce: Some(sf!("extension.reduce")),
			decorates,
			module: sf!("extension"),
		}
	}

	#[test]
	fn renderer_roster_is_exact_revision_and_composes_decorations() {
		let identity = omp_tool::ToolIdentity {
			name: sf!("counter"),
			rev:  omp_tool::Rev { family: sf!("counter"), n: 2 },
		};
		let host = HostKey::new("project", "trusted", "extension");
		let mut roster = UiRoster::default();
		roster
			.install(host.clone(), &VerifiedUiRoster {
				generation: 7,
				extension: sf!("extension"),
				renderers: vec![
					renderer_declaration(identity.clone(), false),
					renderer_declaration(identity.clone(), true),
				]
				.into_boxed_slice(),
				..Default::default()
			})
			.unwrap();
		let rows = roster.renderers(&identity).collect::<Vec<_>>();
		assert_eq!(rows.len(), 2);
		assert!(!rows[0].declaration.decorates);
		assert!(rows[1].declaration.decorates);

		let competing = HostKey::new("project", "trusted", "competing");
		assert!(
			roster
				.install(competing, &VerifiedUiRoster {
					generation: 8,
					extension: sf!("competing"),
					renderers: vec![renderer_declaration(identity.clone(), false)].into_boxed_slice(),
					..Default::default()
				})
				.is_err()
		);
		roster.remove(&host);
		assert_eq!(roster.renderers(&identity).count(), 0);
	}

	#[test]
	fn prompt_contribution_is_identity_checked_and_truncated_at_utf8_boundary() {
		let declaration = serde_json::json!({
			"slot": "policy",
			"class": "stable",
			"priority": 20,
			"callback": {"$omp.callable": "extension.render_policy"},
		});
		let mut binding = prompt_slot_binding("dev.example", &declaration).expect("binding");
		binding.budget_bytes = 5;
		let contribution = decode_prompt_contribution(
			serde_json::json!({
				"slot": "policy",
				"callback": "extension.render_policy",
				"content": "ééé",
			}),
			&binding,
		)
		.expect("contribution");
		assert_eq!(contribution.content.as_str(), "éé");
		assert!(contribution.truncated);
		assert!(matches!(
			decode_prompt_contribution(
				serde_json::json!({
					"slot": "memory",
					"callback": "extension.render_policy",
					"content": "stale",
				}),
				&binding,
			),
			Err(PromptDispatchError::StaleContribution)
		));
	}

	#[test]
	fn prompt_dispatch_carries_exact_context_and_declaration_identity() {
		let binding = PromptSlotBinding {
			key:          sf!("dev.example.memory"),
			owner:        sf!("dev.example"),
			slot:         SlotId::Memory,
			class:        SlotClass::Dynamic,
			priority:     4,
			budget_bytes: 1024,
			callback:     sf!("extension.render_memory"),
		};
		let context = PromptPullContext {
			session_id:     sf!("session"),
			model:          sf!("model"),
			provider:       sf!("provider"),
			context_window: 32_000,
			epoch:          3,
			cwd:            sf!("/workspace"),
			roots:          vec![sf!("/workspace")],
			vcs_branch:     Some(sf!("main")),
			vcs_commit:     None,
			is_subagent:    false,
			agent_kind:     None,
		};
		let arguments = prompt_dispatch_arguments(&binding, &context).expect("arguments");
		assert_eq!(arguments["slot"], "memory");
		assert_eq!(arguments["callback"], "extension.render_memory");
		assert_eq!(arguments["context"]["budget_bytes"], 1024);
		assert_eq!(arguments["context"]["cls"], "epochal");
	}
}
