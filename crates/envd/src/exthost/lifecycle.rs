//! Extension declaration, verification, and activation lifecycle.

use std::{
	collections::{BTreeMap, BTreeSet},
	future::Future,
	sync::{
		Arc,
		atomic::{AtomicBool, AtomicU64, Ordering},
	},
	time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use bytes::BytesMut;
use flume::Receiver;
use omp_agent::{EnvEvent, GateError, HookEvent, HookGate, HookPatch, HookPhase, KernelSender, Up};
pub use omp_core::{ActivateReason, LifecyclePhase, Principal, RestartReason, sf};
use omp_core::{InvocationPhase, Provenance, Str};
use omp_ext::config::{SettingSchema, StaticDeclaration, StaticDeclarations};
use omp_proto::{
	toolhost::v1::{HookEventId, SetAvailability},
	ui::v1::{CommandDecl, RegisterUi, ShortcutDecl, TriggerDecl, UiEffect, UiRequest},
};
use omp_tool::{AvailabilityDelta, Registry, ToolIdentity};
use thiserror::Error;

use super::{
	control::{ControlDispatch, ControlHandle, ControlInvocationAuthority},
	dispatch::{CallbackConcurrency, EventDeadline},
	quota::QuotaSpec,
	services::ServiceManifest,
};

/// Authenticated, generation-fenced worker availability batch.
///
/// The supervisor calls this only after it verifies the owning child
/// generation, so stale host frames never reach shared catalog state.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct AvailabilityBatch {
	/// Worker-reported mount transitions in one CONTROL frame.
	pub deltas: Box<[AvailabilityDelta]>,
}

impl AvailabilityBatch {
	/// Decodes one `LifecycleWorkerEnvelope.set_availability` body.
	pub fn from_wire(wire: SetAvailability) -> Self {
		Self {
			deltas: wire
				.deltas
				.into_iter()
				.map(|delta| AvailabilityDelta {
					name:    Str::from(delta.name),
					mounted: delta.available,
					reason:  delta.reason.map(Str::from),
				})
				.collect(),
		}
	}
}
/// One generation-stamped extension observation retained by a headless host.
#[derive(Clone, Debug)]
pub struct HeadlessLifecycleEvent {
	/// Session incarnation which owns the sink.
	pub session_generation: u64,
	/// Authenticated extension-host incarnation.
	pub host_generation:    u64,
	/// Typed lifecycle payload.
	pub kind:               HeadlessLifecycleKind,
}

/// Extension observations supported by every headless protocol host.
#[derive(Clone, Debug)]
pub enum HeadlessLifecycleKind {
	/// One extension generation activated.
	Activated(ActivationEvent),
	/// The command registry changed and hosts must refresh their roster.
	CommandRosterInvalidated,
	/// A retained, non-blocking UI effect.
	UiEffect(Box<UiEffect>),
	/// A correlated UI request requiring a typed answer.
	UiRequest(Box<UiRequest>),
	/// A typed extension lifecycle failure.
	ExtensionError {
		/// Extension whose lifecycle failed.
		extension: Str,
		/// Typed lifecycle failure.
		error:     LifecycleError,
	},
}

/// Lossless receiving half of a [`HeadlessLifecycleSink`].
pub struct HeadlessLifecycleSubscription {
	rx: Receiver<Arc<HeadlessLifecycleEvent>>,
}

impl HeadlessLifecycleSubscription {
	/// Receives the next extension observation.
	pub async fn recv(&self) -> Result<Arc<HeadlessLifecycleEvent>, flume::RecvError> {
		self.rx.recv_async().await
	}

	/// Attempts to receive the next observation without waiting.
	pub fn try_recv(&self) -> Result<Arc<HeadlessLifecycleEvent>, flume::TryRecvError> {
		self.rx.try_recv()
	}
}

/// Lossless generation fence shared by print, RPC, and ACP session owners.
#[derive(Clone)]
pub struct HeadlessLifecycleSink {
	session_generation: u64,
	host_generation:    Arc<AtomicU64>,
	active:             Arc<AtomicBool>,
	tx:                 flume::Sender<Arc<HeadlessLifecycleEvent>>,
}

impl HeadlessLifecycleSink {
	/// Creates a sink for one session incarnation.
	pub fn new(session_generation: u64) -> (Self, HeadlessLifecycleSubscription) {
		let (tx, rx) = flume::unbounded();
		(
			Self {
				session_generation,
				host_generation: Arc::new(AtomicU64::new(0)),
				active: Arc::new(AtomicBool::new(false)),
				tx,
			},
			HeadlessLifecycleSubscription { rx },
		)
	}

	/// Advances the accepted host generation after supervised activation.
	pub fn activate(&self, event: ActivationEvent) -> Result<(), HeadlessSinkError> {
		let generation = event.generation;
		let mut current = self.host_generation.load(Ordering::Acquire);
		loop {
			if generation < current {
				return Err(HeadlessSinkError::StaleGeneration {
					expected: current,
					actual:   generation,
				});
			}
			match self.host_generation.compare_exchange_weak(
				current,
				generation,
				Ordering::AcqRel,
				Ordering::Acquire,
			) {
				Ok(_) => break,
				Err(observed) => current = observed,
			}
		}
		self.active.store(true, Ordering::Release);
		self.publish(generation, HeadlessLifecycleKind::Activated(event))
	}

	/// Publishes a command-roster invalidation for the active host generation.
	pub fn invalidate_commands(&self, generation: u64) -> Result<(), HeadlessSinkError> {
		self.publish(generation, HeadlessLifecycleKind::CommandRosterInvalidated)
	}

	/// Publishes a retained UI effect for the active host generation.
	pub fn ui_effect(&self, generation: u64, effect: UiEffect) -> Result<(), HeadlessSinkError> {
		self.publish(generation, HeadlessLifecycleKind::UiEffect(Box::new(effect)))
	}

	/// Publishes a correlated UI request for the active host generation.
	pub fn ui_request(&self, generation: u64, request: UiRequest) -> Result<(), HeadlessSinkError> {
		self.publish(generation, HeadlessLifecycleKind::UiRequest(Box::new(request)))
	}

	/// Publishes a typed extension error for the active host generation.
	pub fn extension_error(
		&self,
		generation: u64,
		extension: impl Into<Str>,
		error: LifecycleError,
	) -> Result<(), HeadlessSinkError> {
		self.publish(generation, HeadlessLifecycleKind::ExtensionError {
			extension: extension.into(),
			error,
		})
	}

	fn publish(
		&self,
		generation: u64,
		kind: HeadlessLifecycleKind,
	) -> Result<(), HeadlessSinkError> {
		if !self.active.load(Ordering::Acquire) {
			return Err(HeadlessSinkError::Inactive);
		}
		let expected = self.host_generation.load(Ordering::Acquire);
		if generation != expected {
			return Err(HeadlessSinkError::StaleGeneration { expected, actual: generation });
		}
		self
			.tx
			.send(Arc::new(HeadlessLifecycleEvent {
				session_generation: self.session_generation,
				host_generation: generation,
				kind,
			}))
			.map_err(|_| HeadlessSinkError::Disconnected)
	}
}

/// Rejection from a generation-stamped headless lifecycle sink.
#[derive(Clone, Copy, Debug, Error, Eq, PartialEq)]
pub enum HeadlessSinkError {
	/// A worker attempted to publish before supervised activation.
	#[error("headless extension host is not active")]
	Inactive,
	/// An old worker attempted to publish.
	#[error("stale headless host generation: expected {expected}, got {actual}")]
	StaleGeneration {
		/// Active host generation.
		expected: u64,
		/// Published generation.
		actual:   u64,
	},
	/// The owning headless session has already disposed its subscription.
	#[error("headless lifecycle sink is disconnected")]
	Disconnected,
}

/// App-side destination for a verified `SetAvailability` CONTROL frame.
pub trait AvailabilitySink: Send + Sync {
	/// Applies one complete worker availability batch.
	fn set_availability(&self, batch: AvailabilityBatch);
}

/// Catalog and mailbox implementation of [`AvailabilitySink`].
///
/// The registry accepts unmounts immediately and conservatively ignores
/// mounts. The one turn-boundary system item still reports all worker facts,
/// allowing normal next-turn composition to surface availability changes.
pub struct RegistryAvailabilitySink {
	registry: Arc<Registry>,
	mailbox:  KernelSender,
}

impl RegistryAvailabilitySink {
	/// Binds a shared catalog and the agent's turn-boundary mailbox producer.
	pub const fn new(registry: Arc<Registry>, mailbox: KernelSender) -> Self {
		Self { registry, mailbox }
	}
}

impl AvailabilitySink for RegistryAvailabilitySink {
	fn set_availability(&self, batch: AvailabilityBatch) {
		self.registry.apply_availability(&batch.deltas);
		let mut text = String::from("Extension device availability changed:");
		for delta in &batch.deltas {
			text.push(' ');
			text.push_str(delta.name.as_str());
			text.push_str(if delta.mounted {
				" is available"
			} else {
				" is unavailable"
			});
			if let Some(reason) = &delta.reason {
				text.push_str(" (");
				text.push_str(reason.as_str());
				text.push(')');
			}
			text.push('.');
		}
		let payload = serde_json::json!({
			"summary": text,
			"devices": batch.deltas.iter().map(|delta| {
				serde_json::json!({
					"name": delta.name.as_str(),
					"available": delta.mounted,
					"reason": delta.reason.as_deref(),
				})
			}).collect::<Vec<_>>(),
		});
		let _ = self.mailbox.try_send(Up::Env(EnvEvent::DeviceAvailability {
			payload: Str::new(payload.to_string()),
		}));
	}
}
/// A tool identity in the authoritative manifest declaration set.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct ToolDeclarationKey {
	/// Public tool name.
	pub name:   Str,
	/// Compatibility family.
	pub family: Str,
	/// Monotonic revision within the family.
	pub rev:    u16,
}

impl ToolDeclarationKey {
	/// Creates a tool declaration identity.
	pub fn new(name: impl Into<Str>, family: impl Into<Str>, rev: u16) -> Self {
		Self { name: name.into(), family: family.into(), rev }
	}
}

/// A hook identity in the authoritative manifest declaration set.
#[derive(Clone, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub struct HookDeclarationKey {
	/// Stable event name.
	pub event: Str,
	/// Phase in which the handler runs.
	pub phase: HookPhase,
}

impl HookDeclarationKey {
	/// Creates a hook declaration identity.
	pub fn new(event: impl Into<Str>, phase: HookPhase) -> Self {
		Self { event: event.into(), phase }
	}
}

/// Runtime capability declarations whose use must fail closed when absent.
#[derive(Clone, Copy, Debug, Eq, Ord, PartialEq, PartialOrd)]
pub enum EscapeCapability {
	/// Focus-owned bounded raw terminal-input subscription.
	RawTerminalInput,
	/// Trusted direct-filesystem escape with durable grant provenance.
	DirectFilesystem,
}

/// Canonical tool, hook, action, and sanctioned-escape existence sets for one
/// extension.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct DeclarationSet {
	tools:   BTreeSet<ToolDeclarationKey>,
	hooks:   BTreeSet<HookDeclarationKey>,
	actions: BTreeSet<Str>,
	escapes: BTreeSet<EscapeCapability>,
}

impl DeclarationSet {
	/// Builds normalized declaration sets from any input order.
	pub fn new(
		tools: impl IntoIterator<Item = ToolDeclarationKey>,
		hooks: impl IntoIterator<Item = HookDeclarationKey>,
	) -> Self {
		Self {
			tools:   tools.into_iter().collect(),
			hooks:   hooks.into_iter().collect(),
			actions: BTreeSet::new(),
			escapes: BTreeSet::new(),
		}
	}

	/// Adds the exact static action and sanctioned-escape declarations admitted
	/// from the manifest before Python starts.
	pub fn with_runtime(
		mut self,
		actions: impl IntoIterator<Item = Str>,
		escapes: impl IntoIterator<Item = EscapeCapability>,
	) -> Self {
		self.actions = actions.into_iter().collect();
		self.escapes = escapes.into_iter().collect();
		self
	}

	/// Iterates over tool identities in canonical order.
	pub fn tools(&self) -> impl DoubleEndedIterator<Item = &ToolDeclarationKey> + ExactSizeIterator {
		self.tools.iter()
	}

	/// Iterates over hook identities in canonical order.
	pub fn hooks(&self) -> impl DoubleEndedIterator<Item = &HookDeclarationKey> + ExactSizeIterator {
		self.hooks.iter()
	}

	/// Iterates exact action names in canonical order.
	pub fn actions(&self) -> impl DoubleEndedIterator<Item = &Str> + ExactSizeIterator {
		self.actions.iter()
	}

	/// Returns whether a sanctioned escape was statically admitted.
	pub fn permits(&self, capability: EscapeCapability) -> bool {
		self.escapes.contains(&capability)
	}
}

/// Exact differences between the manifest and frozen runtime registry.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct DeclarationDrift {
	/// Manifest tools absent from the runtime registry.
	pub missing_tools:      Box<[ToolDeclarationKey]>,
	/// Runtime tools absent from the manifest.
	pub unexpected_tools:   Box<[ToolDeclarationKey]>,
	/// Manifest hooks absent from the runtime registry.
	pub missing_hooks:      Box<[HookDeclarationKey]>,
	/// Runtime hooks absent from the manifest.
	pub unexpected_hooks:   Box<[HookDeclarationKey]>,
	/// Manifest actions absent from the runtime registry.
	pub missing_actions:    Box<[Str]>,
	/// Runtime actions absent from the manifest.
	pub unexpected_actions: Box<[Str]>,
	/// Manifest sanctioned escapes absent from the runtime registry.
	pub missing_escapes:    Box<[EscapeCapability]>,
	/// Runtime sanctioned escapes absent from the manifest.
	pub unexpected_escapes: Box<[EscapeCapability]>,
}

impl DeclarationDrift {
	fn between(expected: &DeclarationSet, actual: &DeclarationSet) -> Self {
		Self {
			missing_tools:      expected.tools.difference(&actual.tools).cloned().collect(),
			unexpected_tools:   actual.tools.difference(&expected.tools).cloned().collect(),
			missing_hooks:      expected.hooks.difference(&actual.hooks).cloned().collect(),
			unexpected_hooks:   actual.hooks.difference(&expected.hooks).cloned().collect(),
			missing_actions:    expected
				.actions
				.difference(&actual.actions)
				.cloned()
				.collect(),
			unexpected_actions: actual
				.actions
				.difference(&expected.actions)
				.cloned()
				.collect(),
			missing_escapes:    expected
				.escapes
				.difference(&actual.escapes)
				.copied()
				.collect(),
			unexpected_escapes: actual
				.escapes
				.difference(&expected.escapes)
				.copied()
				.collect(),
		}
	}

	/// Returns whether the two declaration sets were equal.
	pub fn is_empty(&self) -> bool {
		self.missing_tools.is_empty()
			&& self.unexpected_tools.is_empty()
			&& self.missing_hooks.is_empty()
			&& self.unexpected_hooks.is_empty()
			&& self.missing_actions.is_empty()
			&& self.unexpected_actions.is_empty()
			&& self.missing_escapes.is_empty()
			&& self.unexpected_escapes.is_empty()
	}
}
/// Manifest-verified UI declarations owned by one exact extension generation.
#[derive(Clone, Debug, Default)]
pub struct VerifiedUiRoster {
	/// Exact worker generation that registered the callbacks.
	pub generation:            u64,
	/// Publisher-scoped extension identity.
	pub extension:             Str,
	/// Verified slash-command declarations.
	pub commands:              Box<[CommandDecl]>,
	/// Verified shortcut declarations.
	pub shortcuts:             Box<[ShortcutDecl]>,
	/// Verified completion trigger declarations.
	pub triggers:              Box<[TriggerDecl]>,
	/// Verified transcript message renderer declarations.
	pub message_renderers:     Box<[VerifiedMessageRendererDeclaration]>,
	/// Verified transcript markdown transformer declarations.
	pub markdown_transformers: Box<[VerifiedMarkdownTransformer]>,
	/// Verified exact-revision device renderer declarations.
	pub renderers:             Box<[VerifiedRendererDeclaration]>,
}

/// One manifest-verified exact-revision Python renderer fold.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedRendererDeclaration {
	/// Stable signed declaration id.
	pub declaration_id: Str,
	/// Exact tool identity rendered by the fold.
	pub identity:       ToolIdentity,
	/// Python renderer callable address admitted by the signed manifest.
	pub callback:       Str,
	/// Optional Python reducer callable address.
	pub reduce:         Option<Str>,
	/// Whether this fold augments rather than replaces the winning base.
	pub decorates:      bool,
	/// Package-contained declaration module.
	pub module:         Str,
}

/// One manifest-verified transcript-message renderer callback.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedMessageRendererDeclaration {
	/// Stable signed declaration id.
	pub declaration_id: Str,
	/// Exact custom message type selected by the fold.
	pub custom_type:    Str,
	/// Python callable address admitted by the signed manifest.
	pub callback:       Str,
	/// Package-contained declaration module.
	pub module:         Str,
}

/// One manifest-verified transcript markdown transformer callback.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct VerifiedMarkdownTransformer {
	/// Stable signed declaration id.
	pub declaration_id: Str,
	/// Transformer route name.
	pub name:           Str,
	/// Python callable address admitted by the signed manifest.
	pub callback:       Str,
	/// Package-contained declaration module.
	pub module:         Str,
}

/// Exact reason a worker UI declaration table was rejected before FREEZE.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum UiRegistrationError {
	/// Registration arrived after the generation crossed FREEZE.
	#[error("UI registration arrived after declarations were frozen")]
	RegistrationClosed,
	/// The registration named another admitted extension.
	#[error("UI registration named extension {actual}, expected {expected}")]
	ForeignExtension {
		/// Manifest extension identity.
		expected: Str,
		/// Worker-supplied extension identity.
		actual:   Str,
	},
	/// Two commands claimed one canonical name or alias.
	#[error("duplicate UI command spelling {spelling}")]
	DuplicateCommand {
		/// Colliding canonical name or alias.
		spelling: Str,
	},
	/// Two shortcuts claimed one normalized chord.
	#[error("duplicate UI shortcut chord {chord}")]
	DuplicateShortcut {
		/// Colliding normalized chord.
		chord: Str,
	},
	/// A manifest declaration was absent from the runtime table.
	#[error("UI manifest declaration {declaration} was not registered")]
	Missing {
		/// Stable manifest declaration id.
		declaration: Str,
	},
	/// The runtime table contained a declaration absent from the manifest.
	#[error("UI runtime declaration {declaration} was not admitted")]
	Unexpected {
		/// Stable runtime declaration id.
		declaration: Str,
	},
	/// Runtime metadata differed from the signed manifest row.
	#[error("UI declaration {declaration} metadata differs from the manifest")]
	Metadata {
		/// Stable declaration id.
		declaration: Str,
	},
}

/// The four manifest activation classes.
#[derive(Clone, Copy, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub enum ActivationTrigger {
	/// Static metadata served without starting Python.
	Static,
	/// Start the child when the declared surface is first used.
	FirstReach,
	/// Start the child before the first model prompt.
	BeforeFirstPrompt,
	/// Start the child before the UI first paints or accepts input.
	BeforeUiInput,
}

impl ActivationTrigger {
	/// Returns whether this trigger requires an extension-host child.
	pub const fn requires_host(self) -> bool {
		!matches!(self, Self::Static)
	}
}

/// Why one activation sequence is running.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum ActivationCause {
	/// First activation for a declared surface.
	FirstReach,
	/// Re-activation after the supervisor replaced a child.
	Restart(RestartReason),
}

impl ActivationCause {
	const fn split(self) -> (ActivateReason, Option<RestartReason>) {
		match self {
			Self::FirstReach => (ActivateReason::FirstReach, None),
			Self::Restart(reason) => (reason.activate_reason(), Some(reason)),
		}
	}
}

/// One-daemon principal authority used by the v1 OS-user model.
#[derive(Clone, Debug)]
pub struct PrincipalAuthority {
	principal: Principal,
}

impl PrincipalAuthority {
	/// Pins a daemon to its authenticated operating-system principal.
	pub const fn new(principal: Principal) -> Self {
		Self { principal }
	}

	/// Returns the core-owned principal used for extension contexts and durable
	/// stamps.
	pub const fn principal(&self) -> &Principal {
		&self.principal
	}

	/// Refuses attaching a client authenticated as a different OS user.
	pub fn admit(&self, candidate: &Principal) -> Result<(), PrincipalMismatch> {
		if candidate.id() == self.principal.id() {
			Ok(())
		} else {
			Err(PrincipalMismatch {
				expected: Str::from(self.principal.id()),
				actual:   Str::from(candidate.id()),
			})
		}
	}
}

/// A client tried to attach to a daemon owned by another OS principal.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
#[error("daemon principal is {expected}, not {actual}")]
pub struct PrincipalMismatch {
	/// Principal pinned when the daemon started.
	pub expected: Str,
	/// Principal presented by the attaching client.
	pub actual:   Str,
}

/// Host and session generations carried by an activation request.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub struct GenerationFence {
	/// Child restart counter.
	pub host:    u64,
	/// Session epoch into which the child was spawned.
	pub session: u64,
}

/// Payload dispatched to the extension's `extension_activate` handlers.
#[derive(Clone, Debug)]
pub struct ActivationEvent {
	/// Coarse activation class exposed to handlers.
	pub reason:             ActivateReason,
	/// Fine restart cause, absent on first reach.
	pub restart_reason:     Option<RestartReason>,
	/// Original session start time, including for late activation.
	pub session_started_at: SystemTime,
	/// Host generation fenced by core.
	pub generation:         u64,
	/// Manifest trigger which caused this child to be needed.
	pub trigger:            ActivationTrigger,
}

struct ExtensionLoadEvent<'a> {
	extension: &'a str,
	version:   &'a str,
	source:    String,
	trust:     &'a str,
	reloaded:  bool,
}

impl HookEvent for ExtensionLoadEvent<'_> {
	type Return = ();

	const ID: HookEventId = HookEventId::HookEventExtensionLoad;
	const REV: u32 = 1;

	fn encode_into(&self, out: &mut BytesMut) {
		out.extend_from_slice(self.extension.as_bytes());
		out.extend_from_slice(b"\n");
		let payload = serde_json::json!({
			"extension": self.extension,
			"version": self.version,
			"source": self.source.as_str(),
			"trust": self.trust,
			"reloaded": self.reloaded,
		});
		if let Ok(encoded) = serde_json::to_vec(&payload) {
			out.extend_from_slice(&encoded);
		}
	}

	fn apply(&mut self, _: &HookPatch) -> Result<(), GateError> {
		Ok(())
	}
}

struct ExtensionUnloadEvent<'a> {
	extension:     &'a str,
	reason:        &'static str,
	pending_hooks: usize,
}

impl HookEvent for ExtensionUnloadEvent<'_> {
	type Return = ();

	const ID: HookEventId = HookEventId::HookEventExtensionUnload;
	const REV: u32 = 1;

	fn encode_into(&self, out: &mut BytesMut) {
		out.extend_from_slice(self.extension.as_bytes());
		out.extend_from_slice(b"\n");
		let payload = serde_json::json!({
			"extension": self.extension,
			"reason": self.reason,
			"pending_hooks": self.pending_hooks,
		});
		if let Ok(encoded) = serde_json::to_vec(&payload) {
			out.extend_from_slice(&encoded);
		}
	}

	fn apply(&mut self, _: &HookPatch) -> Result<(), GateError> {
		Ok(())
	}
}

struct HostReconnectEvent {
	generation:    u64,
	missed_events: u64,
	restart_cause: &'static str,
	uptime:        Duration,
}

impl HookEvent for HostReconnectEvent {
	type Return = ();

	const ID: HookEventId = HookEventId::HookEventHostReconnect;
	const REV: u32 = 1;

	fn encode_into(&self, out: &mut BytesMut) {
		out.extend_from_slice(self.restart_cause.as_bytes());
		out.extend_from_slice(b"\n");
		let payload = serde_json::json!({
			"generation": self.generation,
			"missed_events": self.missed_events,
			"restart_cause": self.restart_cause,
			"uptime": format!("{}.{:09}s", self.uptime.as_secs(), self.uptime.subsec_nanos()),
		});
		if let Ok(encoded) = serde_json::to_vec(&payload) {
			out.extend_from_slice(&encoded);
		}
	}

	fn apply(&mut self, _: &HookPatch) -> Result<(), GateError> {
		Ok(())
	}
}

/// Emits `extension_load` after activation, without constructing its payload
/// when no extension observes the event.
pub(crate) fn notify_extension_load(gate: &HookGate, provenance: &Provenance, reloaded: bool) {
	if !gate.subscribed(HookEventId::HookEventExtensionLoad) {
		return;
	}
	gate.notify(&ExtensionLoadEvent {
		extension: provenance.extension_id(),
		version: provenance.version(),
		source: provenance.artifact_digest().to_string(),
		trust: provenance.tier(),
		reloaded,
	});
}

/// Emits `extension_unload` before teardown, without constructing its payload
/// when no extension observes the event.
///
/// Supervisor seams pass zero until callback dispatch owns a per-extension
/// pending-hook count; tool invocation counts are not a valid substitute.
pub(crate) fn notify_extension_unload(
	gate: &HookGate,
	extension: &str,
	reason: &'static str,
	pending_hooks: usize,
) {
	if !gate.subscribed(HookEventId::HookEventExtensionUnload) {
		return;
	}
	gate.notify(&ExtensionUnloadEvent { extension, reason, pending_hooks });
}

/// Emits `host_reconnect` after replacement activation, carrying the newly
/// authenticated host generation.
///
/// Callers pass zero for `missed_events` until CONTROL owns a per-host outage
/// counter; the existing global observer-queue drop count is not a truthful
/// proxy for events missed by one replacement host.
pub(crate) fn notify_host_reconnect(
	gate: &HookGate,
	generation: u64,
	missed_events: u64,
	reason: RestartReason,
	uptime: Duration,
) {
	if !gate.subscribed(HookEventId::HookEventHostReconnect) {
		return;
	}
	gate.notify(&HostReconnectEvent {
		generation,
		missed_events,
		restart_cause: reason.into(),
		uptime,
	});
}

/// Result of requesting activation for a generation.
#[derive(Clone, Debug)]
pub enum ActivationDisposition {
	/// The surface is static and intentionally started no child.
	Inert,
	/// A fresh generation completed activation.
	Activated(ActivationEvent),
	/// This generation had already activated and was not dispatched twice.
	AlreadyActive(ActivationEvent),
}

/// Runtime boundary used by the lifecycle machine after declaration.
///
/// Implementations are CONTROL-host adapters for the post-`RegisterTools`
/// handshake. Neither method may route through the journal or agent messaging.
pub trait LifecycleHost {
	/// Sends `FreezeDeclarations` and waits for the child to seal its registry.
	fn freeze(&mut self) -> impl Future<Output = Result<(), Str>> + Send;
	/// Dispatches `extension_activate` over CONTROL.
	fn activate(
		&mut self,
		event: &ActivationEvent,
		principal: &Principal,
	) -> impl Future<Output = Result<(), Str>> + Send;
}
/// Live CONTROL implementation of the post-declaration lifecycle boundary.
pub struct ControlLifecycleHost {
	control:         ControlHandle,
	extension:       Str,
	session:         Str,
	host_generation: u64,
	next_invocation: AtomicU64,
}

impl ControlLifecycleHost {
	/// Binds lifecycle dispatch to one authenticated child incarnation.
	pub fn new(control: ControlHandle, extension: Str, session: Str, host_generation: u64) -> Self {
		Self { control, extension, session, host_generation, next_invocation: AtomicU64::new(1) }
	}

	fn authority(
		&self,
		name: &'static str,
		phase: InvocationPhase,
		lifecycle: LifecyclePhase,
	) -> ControlInvocationAuthority {
		let id = self.next_invocation.fetch_add(1, Ordering::Relaxed);
		ControlInvocationAuthority {
			invocation: sf!("lifecycle:{}:{}:{}", self.extension, self.host_generation, id),
			phase,
			session: self.session.clone(),
			turn: None,
			event: Some(sf!("{name}")),
			call: None,
			device: None,
			effects: Box::new([]),
			place_kind: sf!("host"),
			lifecycle,
			roots: Box::new([]),
			remote: false,
			has_ui: false,
			headless: true,
			settings: serde_json::Map::new(),
			secret_settings: Box::new([]),
			data: None,
			direct_filesystem: None,
		}
	}
}

impl LifecycleHost for ControlLifecycleHost {
	fn freeze(&mut self) -> impl Future<Output = Result<(), Str>> + Send {
		let dispatch = ControlDispatch {
			operation: sf!("omp.lifecycle.freeze"),
			arguments: serde_json::Map::new(),
			authority: self.authority("freeze", InvocationPhase::Open, LifecyclePhase::Frozen),
			policy:    CallbackConcurrency::Serialized,
			deadline:  EventDeadline { at: Instant::now() + Duration::from_secs(10) },
		};
		async move {
			self
				.control
				.dispatch(dispatch)
				.await
				.map(|_| ())
				.map_err(|error| Str::from(error.to_string()))
		}
	}

	fn activate(
		&mut self,
		event: &ActivationEvent,
		_principal: &Principal,
	) -> impl Future<Output = Result<(), Str>> + Send {
		let reason: &str = event.reason.into();
		let trigger = match event.trigger {
			ActivationTrigger::Static => "static",
			ActivationTrigger::FirstReach => "first_reach",
			ActivationTrigger::BeforeFirstPrompt => "before_first_prompt",
			ActivationTrigger::BeforeUiInput => "before_ui_input",
		};
		let started_at_ms = event
			.session_started_at
			.duration_since(UNIX_EPOCH)
			.unwrap_or_default()
			.as_millis()
			.try_into()
			.unwrap_or(u64::MAX);
		let mut arguments = serde_json::Map::new();
		arguments.insert(
			String::from("payload"),
			serde_json::json!({
				"extension": self.extension.as_str(),
				"reason": reason,
				"session_started_at": started_at_ms,
				"generation": event.generation,
				"trigger": trigger,
			}),
		);
		let dispatch = ControlDispatch {
			operation: sf!("omp.lifecycle.activate"),
			arguments,
			authority: self.authority(
				"extension_activate",
				InvocationPhase::EffectsAuthorized,
				LifecyclePhase::Active,
			),
			policy: CallbackConcurrency::Serialized,
			deadline: EventDeadline { at: Instant::now() + Duration::from_secs(10) },
		};
		async move {
			self
				.control
				.dispatch(dispatch)
				.await
				.map(|_| ())
				.map_err(|error| Str::from(error.to_string()))
		}
	}
}

/// Failure of a declaration or activation sequence.
#[derive(Clone, Debug, Error, Eq, PartialEq)]
pub enum LifecycleError {
	/// A frame belonged to an old host or session generation.
	#[error(
		"stale generation: expected session {expected_session} and host >= {current_host}, got \
		 session {actual_session} host {actual_host}"
	)]
	StaleGeneration {
		/// Session generation owned by the machine.
		expected_session: u64,
		/// Last accepted host generation.
		current_host:     u64,
		/// Session generation on the request.
		actual_session:   u64,
		/// Host generation on the request.
		actual_host:      u64,
	},
	/// Dispatch attempted through a boot class absent from the manifest.
	#[error("activation trigger {0:?} is not declared by the extension manifest")]
	UndeclaredTrigger(ActivationTrigger),
	/// Importing one manifest module failed.
	#[error("declaration import {module} failed: {message}")]
	Import {
		/// Module whose body failed.
		module:  Str,
		/// Host-provided failure description.
		message: Str,
	},
	/// The child could not seal its declaration registry.
	#[error("declaration freeze failed: {0}")]
	Freeze(Str),
	/// The frozen runtime registry differed from the manifest.
	#[error("frozen declarations differ from the manifest")]
	Drift(DeclarationDrift),
	/// The typed UI registry differed from the signed manifest rows.
	#[error(transparent)]
	UiRegistration(#[from] UiRegistrationError),
	/// An activation handler failed.
	#[error("extension activation failed: {0}")]
	Activation(Str),
}

/// Authoritative admitted manifest data required to start one extension.
///
/// This value is built from static deployment metadata before Python starts.
/// Runtime registration is never used to infer any expected declaration.
#[derive(Clone, Debug)]
pub struct ExtensionManifest {
	/// Core-authenticated artifact and installation provenance.
	pub provenance:               Provenance,
	/// Canonical entry module imported first.
	pub entry:                    Str,
	/// Declaration modules in manifest order after `entry`.
	pub declaration_modules:      Box<[Str]>,
	/// Authoritative tool and hook existence sets.
	pub declarations:             DeclarationSet,
	/// Provider declarations and consumer service grants.
	pub services:                 ServiceManifest,
	/// Uniform sealed CONTROL declaration snapshot from the deployment manifest.
	static_declarations:          Arc<StaticDeclarations>,
	/// Whether the deployment supplied the uniform declaration table.
	uniform_declarations:         bool,
	/// Whether an operator-trusted module may publish declarations at runtime.
	runtime_declarations_trusted: bool,
	/// Manifest-declared extension settings installed as dynamic convars before
	/// the child starts.
	pub setting_schemas:          BTreeMap<Str, SettingSchema>,
	/// Per-extension CONTROL quota definitions.
	pub resource_limits:          Box<[QuotaSpec]>,
	/// Every boot class reachable from this manifest's declaration rows.
	pub activation_triggers:      BTreeSet<ActivationTrigger>,
}

impl ExtensionManifest {
	/// Builds a mandatory manifest contract from deployment-owned data.
	pub fn new(
		provenance: Provenance,
		entry: impl Into<Str>,
		declaration_modules: impl IntoIterator<Item = Str>,
		declarations: DeclarationSet,
		services: ServiceManifest,
		resource_limits: impl IntoIterator<Item = QuotaSpec>,
		activation_triggers: impl IntoIterator<Item = ActivationTrigger>,
	) -> Self {
		let mut manifest = Self::new_with_static(
			provenance,
			entry,
			declaration_modules,
			declarations,
			services,
			StaticDeclarations::default(),
			resource_limits,
			activation_triggers,
		);
		manifest.uniform_declarations = false;
		manifest
	}

	/// Builds a mandatory manifest contract including every sealed public
	/// declaration table parsed from authenticated deployment data.
	pub fn new_with_static(
		provenance: Provenance,
		entry: impl Into<Str>,
		declaration_modules: impl IntoIterator<Item = Str>,
		declarations: DeclarationSet,
		services: ServiceManifest,
		static_declarations: StaticDeclarations,
		resource_limits: impl IntoIterator<Item = QuotaSpec>,
		activation_triggers: impl IntoIterator<Item = ActivationTrigger>,
	) -> Self {
		let entry = entry.into();
		let mut ordered_modules = Vec::new();
		for row in &static_declarations.ordered {
			if !row.module.is_empty() && row.module != entry && !ordered_modules.contains(&row.module)
			{
				ordered_modules.push(row.module.clone());
			}
		}
		for module in declaration_modules {
			if module != entry && !ordered_modules.contains(&module) {
				ordered_modules.push(module);
			}
		}
		let mut activation_triggers = activation_triggers.into_iter().collect::<BTreeSet<_>>();
		for row in &static_declarations.ordered {
			let trigger = match row.trigger.as_str() {
				"static" => Some(ActivationTrigger::Static),
				"lazy" | "first_reach" => Some(ActivationTrigger::FirstReach),
				"eager-prompt" | "before_first_prompt" => Some(ActivationTrigger::BeforeFirstPrompt),
				"eager-ui" | "before_ui_input" => Some(ActivationTrigger::BeforeUiInput),
				"" => Some(match row.kind.as_str() {
					"completion" => ActivationTrigger::BeforeUiInput,
					"prompt_slot" => ActivationTrigger::BeforeFirstPrompt,
					"credential" | "secret" | "placement" | "skills" | "rules" | "context-files"
					| "prompts" | "themes" | "agents" | "lsp-servers" | "dap-adapters" => {
						ActivationTrigger::Static
					},
					_ => ActivationTrigger::FirstReach,
				}),
				_ => Some(ActivationTrigger::FirstReach),
			};
			activation_triggers.extend(trigger);
		}
		Self {
			provenance,
			entry,
			declaration_modules: ordered_modules.into_boxed_slice(),
			declarations,
			services,
			static_declarations: Arc::new(static_declarations),
			uniform_declarations: true,
			runtime_declarations_trusted: false,
			setting_schemas: BTreeMap::new(),
			resource_limits: resource_limits.into_iter().collect(),
			activation_triggers,
		}
	}

	/// Installs the authenticated extension setting declaration table.
	#[must_use]
	pub fn with_setting_schemas(mut self, settings: BTreeMap<Str, SettingSchema>) -> Self {
		self.setting_schemas = settings;
		self
	}

	/// Returns the immutable declaration snapshot admitted before child import.
	pub fn static_declarations(&self) -> &StaticDeclarations {
		&self.static_declarations
	}

	/// Returns whether the deployment supplied an authoritative uniform table.
	pub const fn has_uniform_declarations(&self) -> bool {
		self.uniform_declarations
	}

	/// Allows an explicitly operator-trusted module to publish runtime
	/// declarations.
	pub fn trust_runtime_declarations(&mut self) {
		self.runtime_declarations_trusted = true;
	}

	/// Returns whether runtime-published declarations are operator-trusted.
	pub const fn runtime_declarations_trusted(&self) -> bool {
		self.runtime_declarations_trusted
	}

	/// Creates a lifecycle machine fenced to one session epoch.
	pub fn lifecycle(
		&self,
		session_started_at: SystemTime,
		session_generation: u64,
	) -> LifecycleMachine {
		LifecycleMachine::new(
			self.provenance.extension_id(),
			self.entry.clone(),
			self.declaration_modules.iter().cloned(),
			self.declarations.clone(),
			self.runtime_declarations_trusted,
			Arc::clone(&self.static_declarations),
			self.activation_triggers.clone(),
			session_started_at,
			session_generation,
		)
	}
}

/// Deterministic lifecycle state for one admitted extension.
pub struct LifecycleMachine {
	extension:           Str,
	modules:             Box<[Str]>,
	expected:            DeclarationSet,
	trust_runtime:       bool,
	expected_ui:         Arc<StaticDeclarations>,
	verified_ui:         Option<VerifiedUiRoster>,
	activation_triggers: BTreeSet<ActivationTrigger>,
	phase:               LifecyclePhase,
	session_started_at:  SystemTime,
	session_generation:  u64,
	host_generation:     u64,
	last_event:          Option<ActivationEvent>,
}

impl LifecycleMachine {
	/// Builds a machine and resolves the canonical import order: entry first,
	/// followed by distinct declaration modules in manifest order.
	fn new(
		extension: impl Into<Str>,
		entry: impl Into<Str>,
		declaration_modules: impl IntoIterator<Item = Str>,
		expected: DeclarationSet,
		trust_runtime: bool,
		expected_ui: Arc<StaticDeclarations>,
		activation_triggers: BTreeSet<ActivationTrigger>,
		session_started_at: SystemTime,
		session_generation: u64,
	) -> Self {
		let entry = entry.into();
		let mut seen = BTreeSet::new();
		let mut modules = Vec::new();
		seen.insert(entry.clone());
		modules.push(entry);
		for module in declaration_modules {
			if seen.insert(module.clone()) {
				modules.push(module);
			}
		}
		Self {
			extension: extension.into(),
			modules: modules.into_boxed_slice(),
			expected,
			trust_runtime,
			expected_ui,
			verified_ui: None,
			activation_triggers,
			phase: LifecyclePhase::Declared,
			session_started_at,
			session_generation,
			host_generation: 0,
			last_event: None,
		}
	}

	fn quarantine(&mut self, error: LifecycleError) -> LifecycleError {
		self.phase = LifecyclePhase::Degraded;
		let failure_kind = match &error {
			LifecycleError::StaleGeneration { .. } => "stale_generation",
			LifecycleError::UndeclaredTrigger(_) => "undeclared_trigger",
			LifecycleError::Import { .. } => "import",
			LifecycleError::Freeze(_) => "freeze",
			LifecycleError::Drift(_) => "declaration_drift",
			LifecycleError::UiRegistration(_) => "ui_registration",
			LifecycleError::Activation(_) => "activation",
		};
		tracing::warn!(
			extension_id = %self.extension,
			host_generation = self.host_generation,
			failure_kind,
			"extension host generation quarantined",
		);
		error
	}

	/// Returns the machine's current child lifecycle phase.
	pub const fn phase(&self) -> LifecyclePhase {
		self.phase
	}

	/// Exact-validates the typed UI registry before FREEZE and retains its
	/// generation-owned roster for publication.
	pub fn register_ui(
		&mut self,
		registration: RegisterUi,
		fence: GenerationFence,
	) -> Result<&VerifiedUiRoster, LifecycleError> {
		if matches!(
			self.phase,
			LifecyclePhase::Frozen
				| LifecyclePhase::Verified
				| LifecyclePhase::Active
				| LifecyclePhase::Degraded
		) {
			return Err(self.quarantine(UiRegistrationError::RegistrationClosed.into()));
		}
		if self.verified_ui.is_some() {
			return Err(self.quarantine(UiRegistrationError::RegistrationClosed.into()));
		}
		if fence.session != self.session_generation
			|| fence.host < self.host_generation
			|| registration.generation != fence.host
		{
			let error = LifecycleError::StaleGeneration {
				expected_session: self.session_generation,
				current_host:     self.host_generation,
				actual_session:   fence.session,
				actual_host:      registration.generation,
			};
			return Err(self.quarantine(error));
		}
		if registration.extension_id != self.extension.as_str() {
			let error = UiRegistrationError::ForeignExtension {
				expected: self.extension.clone(),
				actual:   Str::from(registration.extension_id),
			};
			return Err(self.quarantine(error.into()));
		}
		let roster = match verify_ui_registration(&self.expected_ui, registration) {
			Ok(roster) => roster,
			Err(error) => {
				return Err(self.quarantine(error.into()));
			},
		};
		self.host_generation = fence.host;
		self.verified_ui = Some(roster);
		let roster = self
			.verified_ui
			.as_ref()
			.expect("verified UI roster was stored");
		tracing::info!(
			extension_id = %self.extension,
			host_generation = roster.generation,
			command_count = roster.commands.len(),
			shortcut_count = roster.shortcuts.len(),
			completion_count = roster.triggers.len(),
			renderer_count = roster.renderers.len(),
			"extension UI roster admitted",
		);
		Ok(roster)
	}

	/// Returns the manifest-verified UI roster, when registration completed.
	pub fn verified_ui(&self) -> Option<&VerifiedUiRoster> {
		self.verified_ui.as_ref()
	}

	/// Iterates over the resolved import order.
	pub fn modules(&self) -> impl DoubleEndedIterator<Item = &str> + ExactSizeIterator {
		self.modules.iter().map(Str::as_str)
	}

	/// Records a failed sequential manifest import and degrades this generation.
	pub fn import_failed(
		&mut self,
		module: impl Into<Str>,
		message: impl Into<Str>,
	) -> LifecycleError {
		let error = LifecycleError::Import { module: module.into(), message: message.into() };
		self.quarantine(error)
	}

	/// Validates a completed `RegisterTools` declaration set, then runs
	/// FREEZE → ACTIVATE while recording the verified lifecycle transition.
	///
	/// Python imports have already run sequentially in [`Self::modules`] order
	/// before this method is entered. Repeating an already-active generation is
	/// idempotent. Older host or session generations are rejected before any
	/// host callback is entered.
	#[tracing::instrument(
		level = "debug",
		name = "extension_host_activation",
		skip_all,
		fields(
			extension_id = %self.extension,
			host_generation = fence.host,
			session_generation = fence.session,
		)
	)]
	pub async fn activate_declared<H: LifecycleHost>(
		&mut self,
		host: &mut H,
		declared: &DeclarationSet,
		fence: GenerationFence,
		trigger: ActivationTrigger,
		cause: ActivationCause,
		principal: &Principal,
	) -> Result<ActivationDisposition, LifecycleError> {
		if !self.activation_triggers.contains(&trigger) {
			tracing::warn!(
				extension_id = %self.extension,
				host_generation = fence.host,
				session_generation = fence.session,
				trigger = ?trigger,
				"extension host activation denied for undeclared trigger",
			);
			return Err(LifecycleError::UndeclaredTrigger(trigger));
		}
		if !trigger.requires_host() {
			return Ok(ActivationDisposition::Inert);
		}
		if fence.session != self.session_generation || fence.host < self.host_generation {
			tracing::warn!(
				extension_id = %self.extension,
				expected_host_generation = self.host_generation,
				expected_session_generation = self.session_generation,
				host_generation = fence.host,
				session_generation = fence.session,
				"extension host activation denied for stale generation",
			);
			return Err(LifecycleError::StaleGeneration {
				expected_session: self.session_generation,
				current_host:     self.host_generation,
				actual_session:   fence.session,
				actual_host:      fence.host,
			});
		}
		if fence.host == self.host_generation
			&& self.phase == LifecyclePhase::Active
			&& let Some(event) = self.last_event.clone()
		{
			return Ok(ActivationDisposition::AlreadyActive(event));
		}

		self.host_generation = fence.host;
		self.phase = LifecyclePhase::Declared;
		if self.verified_ui.is_none()
			&& let Some(row) = self
				.expected_ui
				.ui
				.commands
				.first()
				.or_else(|| self.expected_ui.ui.shortcuts.first())
		{
			let declaration = row.id.clone();
			return Err(self.quarantine(UiRegistrationError::Missing { declaration }.into()));
		}
		if !self.trust_runtime {
			let drift = DeclarationDrift::between(&self.expected, declared);
			if !drift.is_empty() {
				return Err(self.quarantine(LifecycleError::Drift(drift)));
			}
		}
		if let Err(message) = host.freeze().await {
			return Err(self.quarantine(LifecycleError::Freeze(message)));
		}
		self.phase = LifecyclePhase::Frozen;
		self.phase = LifecyclePhase::Verified;

		let (reason, restart_reason) = cause.split();
		let event = ActivationEvent {
			reason,
			restart_reason,
			session_started_at: self.session_started_at,
			generation: fence.host,
			trigger,
		};
		if let Err(message) = host.activate(&event, principal).await {
			return Err(self.quarantine(LifecycleError::Activation(message)));
		}
		self.phase = LifecyclePhase::Active;
		self.last_event = Some(event.clone());
		tracing::info!(
			extension_id = %self.extension,
			host_generation = fence.host,
			session_generation = fence.session,
			"extension host generation admitted",
		);
		Ok(ActivationDisposition::Activated(event))
	}
}

/// Exact-validates one typed UI registration against authenticated manifest
/// rows.
pub fn verify_ui_registration(
	expected: &StaticDeclarations,
	registration: RegisterUi,
) -> Result<VerifiedUiRoster, UiRegistrationError> {
	let generation = registration.generation;
	let extension = Str::from(registration.extension_id.as_str());
	validate_ui_commands(&expected.ui.commands, &registration.commands)?;
	validate_ui_shortcuts(&expected.ui.shortcuts, &registration.shortcuts)?;
	validate_ui_completions(&expected.ui.completions, &registration.triggers)?;
	Ok(VerifiedUiRoster {
		generation,
		extension,
		commands: registration.commands.into_boxed_slice(),
		shortcuts: registration.shortcuts.into_boxed_slice(),
		triggers: registration.triggers.into_boxed_slice(),
		message_renderers: Box::new([]),
		markdown_transformers: Box::new([]),
		renderers: Box::new([]),
	})
}

fn validate_ui_completions(
	expected: &[StaticDeclaration],
	actual: &[TriggerDecl],
) -> Result<(), UiRegistrationError> {
	let expected = expected
		.iter()
		.map(|row| (row.id.as_str(), row))
		.collect::<BTreeMap<_, _>>();
	let mut ids = BTreeSet::new();
	for trigger in actual {
		if trigger.prefix.is_empty()
			|| trigger.kind != "completion"
			|| trigger.max_results == 0
			|| !ids.insert(trigger.declaration_id.as_str())
		{
			return Err(UiRegistrationError::Unexpected {
				declaration: Str::from(trigger.declaration_id.as_str()),
			});
		}
		let Some(row) = expected.get(trigger.declaration_id.as_str()) else {
			return Err(UiRegistrationError::Unexpected {
				declaration: Str::from(trigger.declaration_id.as_str()),
			});
		};
		let callback = manifest_string(row, "callback");
		if trigger.prefix != row.key.as_str()
			|| trigger.module != row.module.as_str()
			|| (!row.trigger.is_empty() && trigger.activation_trigger != row.trigger.as_str())
			|| callback.is_some_and(|callback| trigger.callback != callback)
		{
			return Err(UiRegistrationError::Metadata { declaration: row.id.clone() });
		}
	}
	for id in expected.keys() {
		if !ids.contains(id) {
			return Err(UiRegistrationError::Missing { declaration: Str::from(*id) });
		}
	}
	Ok(())
}

fn validate_ui_commands(
	expected: &[StaticDeclaration],
	actual: &[CommandDecl],
) -> Result<(), UiRegistrationError> {
	let expected = expected
		.iter()
		.map(|row| (row.id.as_str(), row))
		.collect::<BTreeMap<_, _>>();
	let mut ids = BTreeSet::new();
	let mut spellings = BTreeSet::new();
	for command in actual {
		if !ids.insert(command.declaration_id.as_str()) {
			return Err(UiRegistrationError::Unexpected {
				declaration: Str::from(command.declaration_id.as_str()),
			});
		}
		for spelling in
			std::iter::once(command.name.as_str()).chain(command.aliases.iter().map(String::as_str))
		{
			if spelling.is_empty() || !spellings.insert(spelling) {
				return Err(UiRegistrationError::DuplicateCommand { spelling: Str::from(spelling) });
			}
		}
		let Some(row) = expected.get(command.declaration_id.as_str()) else {
			return Err(UiRegistrationError::Unexpected {
				declaration: Str::from(command.declaration_id.as_str()),
			});
		};
		if !command_matches_manifest(command, row) {
			return Err(UiRegistrationError::Metadata { declaration: row.id.clone() });
		}
	}
	for id in expected.keys() {
		if !ids.contains(id) {
			return Err(UiRegistrationError::Missing { declaration: Str::from(*id) });
		}
	}
	Ok(())
}

fn validate_ui_shortcuts(
	expected: &[StaticDeclaration],
	actual: &[ShortcutDecl],
) -> Result<(), UiRegistrationError> {
	let expected = expected
		.iter()
		.map(|row| (row.id.as_str(), row))
		.collect::<BTreeMap<_, _>>();
	let mut ids = BTreeSet::new();
	let mut chords = BTreeSet::new();
	for shortcut in actual {
		if !ids.insert(shortcut.declaration_id.as_str()) {
			return Err(UiRegistrationError::Unexpected {
				declaration: Str::from(shortcut.declaration_id.as_str()),
			});
		}
		if shortcut.chord.is_empty() || !chords.insert(shortcut.chord.as_str()) {
			return Err(UiRegistrationError::DuplicateShortcut {
				chord: Str::from(shortcut.chord.as_str()),
			});
		}
		let Some(row) = expected.get(shortcut.declaration_id.as_str()) else {
			return Err(UiRegistrationError::Unexpected {
				declaration: Str::from(shortcut.declaration_id.as_str()),
			});
		};
		if !shortcut_matches_manifest(shortcut, row) {
			return Err(UiRegistrationError::Metadata { declaration: row.id.clone() });
		}
	}
	for id in expected.keys() {
		if !ids.contains(id) {
			return Err(UiRegistrationError::Missing { declaration: Str::from(*id) });
		}
	}
	Ok(())
}

fn command_matches_manifest(command: &CommandDecl, row: &StaticDeclaration) -> bool {
	let args = row
		.properties
		.get("args")
		.and_then(serde_json::Value::as_array)
		.map_or(&[][..], Vec::as_slice);
	command.name == row.key.as_str()
		&& command.description == manifest_string(row, "description").unwrap_or_default()
		&& command.hint.as_deref() == manifest_string(row, "hint")
		&& command
			.aliases
			.iter()
			.map(String::as_str)
			.eq(manifest_strings(row, "aliases"))
		&& command.args.len() == args.len()
		&& command.args.iter().zip(args).all(|(actual, expected)| {
			actual.name == json_string(expected, "name").unwrap_or_default()
				&& actual.description == json_string(expected, "description").unwrap_or_default()
				&& actual.usage.as_deref() == json_string(expected, "usage")
		}) && command.callback == manifest_string(row, "callback").unwrap_or_default()
		&& command.arg_completion_callback.as_deref() == manifest_string(row, "arg_completions")
		&& command.module == row.module.as_str()
		&& command.activation_trigger == row.trigger.as_str()
}

fn shortcut_matches_manifest(shortcut: &ShortcutDecl, row: &StaticDeclaration) -> bool {
	shortcut.chord == row.key.as_str()
		&& shortcut.action_id
			== manifest_string(row, "action_id")
				.or_else(|| manifest_string(row, "action"))
				.unwrap_or_default()
		&& shortcut.description == manifest_string(row, "description").unwrap_or_default()
		&& shortcut
			.when
			.iter()
			.map(String::as_str)
			.eq(manifest_strings(row, "when"))
		&& shortcut.callback == manifest_string(row, "callback").unwrap_or_default()
		&& shortcut.module == row.module.as_str()
		&& shortcut.activation_trigger == row.trigger.as_str()
}

fn manifest_string<'a>(row: &'a StaticDeclaration, key: &str) -> Option<&'a str> {
	row.properties.get(key).and_then(serde_json::Value::as_str)
}

fn manifest_strings<'a>(
	row: &'a StaticDeclaration,
	key: &str,
) -> impl Iterator<Item = &'a str> + Clone {
	row.properties
		.get(key)
		.and_then(serde_json::Value::as_array)
		.into_iter()
		.flatten()
		.filter_map(serde_json::Value::as_str)
}

fn json_string<'a>(value: &'a serde_json::Value, key: &str) -> Option<&'a str> {
	value
		.as_object()
		.and_then(|object| object.get(key))
		.and_then(serde_json::Value::as_str)
}

#[cfg(test)]
mod tests {
	use super::*;

	#[test]
	fn stale_ui_registration_degrades_generation() {
		let mut lifecycle = LifecycleMachine::new(
			"extension",
			"entry",
			[],
			DeclarationSet::default(),
			false,
			Arc::new(StaticDeclarations::default()),
			BTreeSet::new(),
			SystemTime::UNIX_EPOCH,
			2,
		);
		let error = lifecycle
			.register_ui(
				RegisterUi {
					generation: 3,
					extension_id: "extension".to_owned(),
					..Default::default()
				},
				GenerationFence { host: 4, session: 2 },
			)
			.expect_err("registration generation must match transport generation");
		assert!(matches!(error, LifecycleError::StaleGeneration { .. }));
		assert_eq!(lifecycle.phase(), LifecyclePhase::Degraded);
	}
}
