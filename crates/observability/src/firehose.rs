//! Droppable, post-hoc telemetry delivery.
//!
//! [`Firehose::publish`] is deliberately synchronous: it allocates exactly one
//! [`Arc`] for an event, uses bounded `try_send` rings, and never waits for a
//! host, sink, or exporter. Durable accounting remains the journal's job.

use std::sync::{
	Arc, Weak,
	atomic::{AtomicU64, Ordering},
};

use flume::{Receiver, Sender, TryRecvError, TrySendError};
use omp_core::{Hash32, Str};
use omp_proto::omp::inference::v1;
/// Existing tool-layer vocabularies consumed verbatim by firehose payloads.
pub use omp_tool::{ArgIssueKind, ArtifactLifetime, PolicyDenied};
use parking_lot::RwLock;
use serde_json::Value;
use smallvec::SmallVec;

use crate::redact;
pub use crate::semconv::{
	BranchOp, Capture, CompactionReason, Consent, DegradeAction, ExportProtocol, IssueStatus, Kind,
	RepairKind, RetentionTier, SpillReason, ToolStatus,
};
/// Default number of events retained for one subscription.
pub const QUEUE_DEFAULT: usize = 4_096;
/// Largest permitted subscription ring, in events.
pub const QUEUE_MAX: usize = 65_536;

/// Effective core-side capture grant for one subscriber.
///
/// Content requires both the capture level and its explicit durable grant;
/// provider detail additionally requires the narrower vendor-detail grant.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct CaptureGrant {
	/// Maximum field class the subscriber may observe.
	pub capture:         Capture,
	/// Explicit durable grant for raw argument content.
	pub capture_content: bool,
	/// Explicit durable grant for provider-specific usage detail.
	pub vendor_detail:   bool,
}

impl CaptureGrant {
	/// Returns the effective capture level after explicit grant checks.
	pub fn effective(self) -> Capture {
		if self.capture == Capture::Content && !self.capture_content {
			Capture::Structure
		} else {
			self.capture
		}
	}
}
/// Loss accounting for one bounded telemetry subscription.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub struct DropStats {
	/// Events refused because the bounded live ring was full.
	pub dropped:        u64,
	/// Oldest matching events omitted from a bounded replay suffix.
	pub replay_skipped: u64,
	/// Events offered after the receiving host disconnected.
	pub disconnected:   u64,
}

#[derive(Default)]
struct DropCounters {
	dropped:        AtomicU64,
	replay_skipped: AtomicU64,
	disconnected:   AtomicU64,
}

impl DropCounters {
	fn snapshot(&self) -> DropStats {
		DropStats {
			dropped:        self.dropped.load(Ordering::Relaxed),
			replay_skipped: self.replay_skipped.load(Ordering::Relaxed),
			disconnected:   self.disconnected.load(Ordering::Relaxed),
		}
	}
}

/// An error in a core-side subscription declaration.
#[derive(Clone, Copy, Debug, Eq, PartialEq, thiserror::Error)]
pub enum SubscriptionError {
	/// No event kind was selected.
	#[error("a telemetry subscription must select at least one kind")]
	EmptyKinds,
	/// The bounded ring capacity is outside the contract range.
	#[error("telemetry subscription queue must be in 1..={QUEUE_MAX}")]
	InvalidQueue,
}

/// Core-side parameters for one telemetry subscription.
#[derive(Clone, Debug)]
pub struct SubscriptionOptions {
	/// Event kinds filtered before a frame crosses CONTROL.
	pub kinds: SmallVec<Kind, 2>,
	/// Ring capacity in events.
	pub queue: usize,
}

impl SubscriptionOptions {
	/// Validates a core-side subscription declaration.
	///
	/// # Errors
	/// Returns [`SubscriptionError`] when no kinds are selected or the queue is
	/// not bounded by the public subscription contract.
	pub fn new(
		kinds: impl IntoIterator<Item = Kind>,
		queue: usize,
	) -> Result<Self, SubscriptionError> {
		let mut unique = SmallVec::<Kind, 2>::new();
		for kind in kinds {
			if !unique.contains(&kind) {
				unique.push(kind);
			}
		}
		if unique.is_empty() {
			return Err(SubscriptionError::EmptyKinds);
		}
		if !(1..=QUEUE_MAX).contains(&queue) {
			return Err(SubscriptionError::InvalidQueue);
		}
		Ok(Self { kinds: unique, queue })
	}
}

/// Shared metadata carried by every event body.
#[derive(Clone, Debug, Default)]
pub struct Envelope {
	/// Session that observed the event.
	pub session_id:     Str,
	/// Agent that emitted the event.
	pub agent_id:       Str,
	/// Authenticated principal associated with the session.
	pub principal:      Str,
	/// Extension-host generation at observation time.
	pub generation:     u64,
	/// Wall-clock event timestamp in Unix milliseconds.
	pub occurred_at_ms: u64,
}

/// A prompt-slot digest in assembler order.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct PromptSlotDigest {
	/// Stable prompt-slot key.
	pub key:    Str,
	/// Truncated BLAKE3 digest of this slot's emitted bytes.
	pub digest: [u8; 16],
}

/// Prompt-cache identity computed by the prompt assembler.
#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct PromptFingerprint {
	/// Truncated BLAKE3 digest over the concatenated per-slot digests.
	pub digest:              [u8; 16],
	/// Per-slot digests in prompt assembly order.
	pub slots:               SmallVec<PromptSlotDigest, 8>,
	/// Slot keys differing from the prior assembled prompt, in assembly order.
	pub changed:             SmallVec<Str, 8>,
	/// Common byte prefix with the prior assembled prompt.
	pub prefix_stable_bytes: usize,
	/// Cache-affinity key sent to the provider.
	pub cache_key:           Option<Str>,
}

impl PromptFingerprint {
	/// Computes a fingerprint and its diff from the preceding assembled prompt.
	pub fn compute(
		previous: Option<&Self>,
		previous_bytes: &[u8],
		bytes: &[u8],
		slots: impl IntoIterator<Item = (Str, Vec<u8>)>,
		cache_key: Option<Str>,
	) -> Self {
		let mut slot_digests = SmallVec::<PromptSlotDigest, 8>::new();
		for (key, value) in slots {
			let digest = truncate_digest(Hash32::sum(&value));
			slot_digests.push(PromptSlotDigest { key, digest });
		}
		let mut hasher = Hash32::hasher();
		hasher.update(b"omp.telemetry.prompt/v1\0");
		for slot in &slot_digests {
			hasher.update(slot.digest);
		}
		let changed = slot_digests
			.iter()
			.filter(|slot| {
				previous.is_none_or(|old| {
					old.slots
						.iter()
						.find(|prior| prior.key == slot.key)
						.is_none_or(|prior| prior.digest != slot.digest)
				})
			})
			.map(|slot| slot.key.clone())
			.collect();
		Self {
			digest: truncate_digest(hasher.finalize()),
			slots: slot_digests,
			changed,
			prefix_stable_bytes: previous_bytes
				.iter()
				.zip(bytes)
				.take_while(|(left, right)| left == right)
				.count(),
			cache_key,
		}
	}
}

fn truncate_digest(hash: Hash32) -> [u8; 16] {
	let mut digest = [0; 16];
	digest.copy_from_slice(&hash.as_bytes()[..16]);
	digest
}

/// Session-start facts, including the exact schema and live registry identity.
#[derive(Clone, Debug, Default)]
pub struct SessionStart {
	/// Shared event metadata.
	pub envelope:      Envelope,
	/// Wire schema revision used for this session.
	pub schema_rev:    u32,
	/// Hex `Registry::live_hash()` at session start.
	pub registry_hash: Str,
}

/// First provider-dispatch latency for one constructed session.
#[derive(Clone, Debug, Default)]
pub struct SessionDispatch {
	/// Shared event metadata.
	pub envelope:   Envelope,
	/// Milliseconds from session construction to first provider dispatch.
	pub latency_ms: u64,
}

/// Session-end facts.
#[derive(Clone, Debug, Default)]
pub struct SessionEnd {
	/// Shared event metadata.
	pub envelope: Envelope,
	/// Classified end reason, when supplied by the caller.
	pub reason:   Option<Str>,
}

/// Admission of a logical turn.
#[derive(Clone, Debug, Default)]
pub struct TurnStart {
	/// Shared event metadata.
	pub envelope: Envelope,
	/// Monotonic turn ordinal.
	pub turn:     u64,
}

/// Settlement of a logical turn.
#[derive(Clone, Debug, Default)]
pub struct TurnEnd {
	/// Shared event metadata.
	pub envelope: Envelope,
	/// Monotonic turn ordinal.
	pub turn:     u64,
	/// Structured turn outcome, never a rendered projection.
	pub outcome:  Option<Value>,
}

/// Settled model request facts.
#[derive(Clone, Debug, Default)]
pub struct ModelRequest {
	/// Shared event metadata.
	pub envelope:        Envelope,
	/// Requested model name.
	pub requested_model: Str,
	/// Model that actually served the request.
	pub served_model:    Str,
	/// Selected provider.
	pub provider:        Str,
	/// Full-fidelity inference wire usage; this is the in-process truth.
	pub usage:           v1::Usage,
	/// Provider or catalog cost in nano-USD.
	pub cost:            Option<v1::Cost>,
	/// Prompt-cache identity from the assembler.
	pub prompt:          PromptFingerprint,
	/// Whether the accepted result was replayed.
	pub replayed:        bool,
}

/// An abandoned retryable model attempt.
#[derive(Clone, Debug, Default)]
pub struct ModelAttempt {
	/// Shared event metadata.
	pub envelope: Envelope,
	/// One-based route attempt number.
	pub attempt:  u32,
	/// Portable classification code.
	pub code:     Str,
}

/// A terminal provider request failure.
#[derive(Clone, Debug, Default)]
pub struct ProviderError {
	/// Shared event metadata.
	pub envelope: Envelope,
	/// Portable error classification.
	pub code:     Str,
	/// Safe classified detail.
	pub detail:   Option<Str>,
}

/// One charitable argument repair.
#[derive(Clone, Debug)]
pub struct Repair {
	/// Pulled argument path.
	pub path:   Str,
	/// Repair applied at that path.
	pub kind:   RepairKind,
	/// Safe explanation of the repair.
	pub detail: Str,
}

/// Settlement of one core, extension, or MCP invocation.
#[derive(Clone, Debug, Default)]
pub struct ToolCall {
	/// Shared event metadata.
	pub envelope:         Envelope,
	/// Tool or device name shown to the model.
	pub tool:             Str,
	/// Committed tool revision, when the target has one.
	pub rev:              Option<Str>,
	/// Raw emitted arguments, materialized only for a content-granted
	/// subscriber.
	pub args_raw:         Option<Str>,
	/// Charitable repairs applied before execution.
	pub repairs:          SmallVec<Repair, 2>,
	/// Number of parameter pulls performed.
	pub pulls:            u32,
	/// Byte size of the model-facing result projection; never its text.
	pub projection_bytes: usize,
	/// Structured verdict, never a rendered result string.
	pub outcome:          Option<Value>,
	/// Metrics-facing terminal status derived structurally from the outcome.
	pub status:           Option<ToolStatus>,
	/// Executor-owned abort detail; this never contains policy denial.
	pub executor_abort:   Option<omp_tool::Abort>,
	/// Core-admission policy denial, which never crossed the toolhost wire.
	pub policy_denied:    Option<PolicyDenied>,
}

/// A retained capability intent that could not be fulfilled natively.
#[derive(Clone, Debug, Default)]
pub struct CapabilityDegraded {
	/// Shared event metadata.
	pub envelope: Envelope,
	/// Whether the retained intent was ultimately granted.
	pub granted:  Option<bool>,
	/// Requested capability intent.
	pub intent:   Str,
	/// Resolution action.
	pub action:   Option<DegradeAction>,
}

/// Settlement of a context compaction.
#[derive(Clone, Debug, Default)]
pub struct Compaction {
	/// Shared event metadata.
	pub envelope:      Envelope,
	/// Why compaction occurred.
	pub reason:        Option<CompactionReason>,
	/// Number of structured outcomes retained.
	pub outcomes_kept: u32,
}

/// A branch-tree mutation that references durable journal entries by index.
#[derive(Clone, Debug, Default)]
pub struct Branch {
	/// Shared event metadata.
	pub envelope:   Envelope,
	/// Branch mutation operation.
	pub op:         Option<BranchOp>,
	/// Source journal entry index, never a duplicated journal body.
	pub from_entry: Option<u64>,
	/// Destination journal entry index, never a duplicated journal body.
	pub to_entry:   Option<u64>,
}

/// A payload stored out of line as an artifact.
#[derive(Clone, Debug, Default)]
pub struct ArtifactSpill {
	/// Shared event metadata.
	pub envelope:    Envelope,
	/// Artifact identity.
	pub artifact_id: Str,
	/// Spill source layer.
	pub reason:      Option<SpillReason>,
}

/// A model-filed `AutoQA` report.
#[derive(Clone, Debug, Default)]
pub struct IssueReport {
	/// Shared event metadata.
	pub envelope: Envelope,
	/// Durable issue identifier.
	pub issue_id: Str,
	/// Device that produced the inconsistent result.
	pub device:   Str,
	/// Revision observed by the model.
	pub rev:      Option<Str>,
	/// Raw device arguments, subject to the content grant.
	pub args_raw: Option<Str>,
	/// Structured device outcome, never a string projection.
	pub outcome:  Option<Value>,
	/// User disposition for external sharing.
	pub consent:  Option<Consent>,
}

/// A non-fatal host, sink, or exporter problem.
#[derive(Clone, Debug, Default)]
pub struct HostWarning {
	/// Shared event metadata.
	pub envelope: Envelope,
	/// Stable protocol error code (`sink_error`, `sink_overflow`,
	/// `export_failure`, or `cardinality`).
	pub code:     Str,
	/// Safe classified detail.
	pub detail:   Option<Str>,
}

/// One typed post-hoc observation.
#[derive(Clone, Debug)]
#[non_exhaustive]
pub enum Event {
	/// A session begins or resumes.
	SessionStart(Box<SessionStart>),
	/// The session reaches its first provider dispatch.
	SessionDispatch(SessionDispatch),
	/// A session ends.
	SessionEnd(Box<SessionEnd>),
	/// A turn is admitted.
	TurnStart(TurnStart),
	/// A turn settles.
	TurnEnd(Box<TurnEnd>),
	/// A model request settles.
	ModelRequest(Box<ModelRequest>),
	/// A retryable model attempt is abandoned.
	ModelAttempt(ModelAttempt),
	/// A model request fails terminally.
	ProviderError(Box<ProviderError>),
	/// A tool invocation settles.
	ToolCall(Box<ToolCall>),
	/// A capability is degraded.
	CapabilityDegraded(CapabilityDegraded),
	/// A compaction settles.
	Compaction(Box<Compaction>),
	/// The session tree changes shape.
	Branch(Branch),
	/// A payload spills to an artifact.
	ArtifactSpill(ArtifactSpill),
	/// An `AutoQA` issue is filed.
	IssueReport(Box<IssueReport>),
	/// A non-fatal telemetry failure occurs.
	HostWarning(HostWarning),
}

impl Event {
	/// Returns this event's subscription kind.
	pub const fn kind(&self) -> Kind {
		match self {
			Self::SessionStart(_) => Kind::SessionStart,
			Self::SessionDispatch(_) => Kind::SessionDispatch,
			Self::SessionEnd(_) => Kind::SessionEnd,
			Self::TurnStart(_) => Kind::TurnStart,
			Self::TurnEnd(_) => Kind::TurnEnd,
			Self::ModelRequest(_) => Kind::ModelRequest,
			Self::ModelAttempt(_) => Kind::ModelAttempt,
			Self::ProviderError(_) => Kind::ProviderError,
			Self::ToolCall(_) => Kind::ToolCall,
			Self::CapabilityDegraded(_) => Kind::CapabilityDegraded,
			Self::Compaction(_) => Kind::Compaction,
			Self::Branch(_) => Kind::Branch,
			Self::ArtifactSpill(_) => Kind::ArtifactSpill,
			Self::IssueReport(_) => Kind::IssueReport,
			Self::HostWarning(_) => Kind::HostWarning,
		}
	}

	/// Materializes an event for a subscriber after the turn has published it.
	///
	/// This deliberately runs outside [`Firehose::publish`]: the hot path shares
	/// one `Arc<Event>`, while CONTROL delivery receives a field-classed copy.
	/// `None` means the subscription's effective capture level is disabled.
	pub fn materialize_for(&self, grant: CaptureGrant) -> Option<Self> {
		let level = grant.effective();
		if level == Capture::None {
			return None;
		}
		let mut event = self.clone();
		match &mut event {
			Self::ModelRequest(request) => {
				if level == Capture::Usage {
					request.prompt = PromptFingerprint::default();
				}
				if !grant.vendor_detail {
					request.usage.detail = None;
				}
			},
			Self::TurnEnd(turn) if level == Capture::Usage => turn.outcome = None,
			Self::ToolCall(call) => {
				if level == Capture::Usage {
					call.outcome = None;
					call.repairs.clear();
				}
				if level != Capture::Content {
					call.args_raw = None;
				} else if let Some(raw) = &call.args_raw {
					call.args_raw = Some(Str::from(redact::redact_sensitive_credentials(raw.as_str())));
				}
			},
			Self::IssueReport(issue) => {
				if level == Capture::Usage {
					issue.outcome = None;
				}
				if level != Capture::Content {
					issue.args_raw = None;
				} else if let Some(raw) = &issue.args_raw {
					issue.args_raw = Some(Str::from(redact::redact_sensitive_credentials(raw.as_str())));
				}
			},
			_ => {},
		}
		Some(event)
	}
}

struct Subscription {
	id:       u64,
	kinds:    SmallVec<Kind, 2>,
	sender:   Sender<Arc<Event>>,
	counters: Arc<DropCounters>,
}

impl Subscription {
	fn wants(&self, kind: Kind) -> bool {
		self.kinds.contains(&kind)
	}

	fn offer(&self, event: &Arc<Event>) {
		match self.sender.try_send(Arc::clone(event)) {
			Ok(()) => {},
			Err(TrySendError::Full(_)) => {
				self.counters.dropped.fetch_add(1, Ordering::Relaxed);
			},
			Err(TrySendError::Disconnected(_)) => {
				self.counters.disconnected.fetch_add(1, Ordering::Relaxed);
			},
		}
	}
}

struct Inner {
	subs:              RwLock<SmallVec<Subscription, 4>>,
	next_subscription: AtomicU64,
}

/// Post-hoc event fan-out with bounded, independently-droppable rings.
#[derive(Clone, Default)]
pub struct Firehose {
	inner: Arc<Inner>,
}

impl Default for Inner {
	fn default() -> Self {
		Self { subs: RwLock::new(SmallVec::new()), next_subscription: AtomicU64::new(1) }
	}
}

impl Firehose {
	/// Creates an empty firehose.
	pub fn new() -> Self {
		Self::default()
	}

	/// Publishes an event to every matching bounded ring.
	///
	/// This is intentionally a plain synchronous function. It creates one
	/// shared [`Arc`] and performs only non-blocking `try_send` calls.
	pub fn publish(&self, event: Event) {
		let event = Arc::new(event);
		let kind = event.kind();
		for subscription in self.inner.subs.read().iter() {
			if subscription.wants(kind) {
				subscription.offer(&event);
			}
		}
	}

	/// Registers a live subscription.
	///
	/// # Errors
	/// Returns [`SubscriptionError`] for an invalid bounded-ring declaration.
	pub fn subscribe(
		&self,
		options: SubscriptionOptions,
	) -> Result<SubscriptionHandle, SubscriptionError> {
		self.subscribe_replay(options, &[], 0)
	}

	/// Registers a subscription after delivering a chronological replay suffix.
	///
	/// `replay` must be a snapshot taken at its watermark. Holding the
	/// subscription write lock while queueing the suffix and inserting the live
	/// ring makes the transition atomic: publish observes either no subscription
	/// or the fully replayed, live subscription, never a gap or duplicate.
	///
	/// # Errors
	/// Returns [`SubscriptionError`] for an invalid bounded-ring declaration.
	pub fn subscribe_replay(
		&self,
		options: SubscriptionOptions,
		replay: &[Arc<Event>],
		replay_limit: usize,
	) -> Result<SubscriptionHandle, SubscriptionError> {
		if options.kinds.is_empty() {
			return Err(SubscriptionError::EmptyKinds);
		}
		if !(1..=QUEUE_MAX).contains(&options.queue) {
			return Err(SubscriptionError::InvalidQueue);
		}
		let id = self.inner.next_subscription.fetch_add(1, Ordering::Relaxed);
		let (sender, receiver) = flume::bounded(options.queue);
		let counters = Arc::new(DropCounters::default());
		let subscription =
			Subscription { id, kinds: options.kinds, sender, counters: Arc::clone(&counters) };
		let matching = replay
			.iter()
			.filter(|event| subscription.wants(event.kind()))
			.count();
		let replay_count = matching.min(replay_limit).min(options.queue);
		let skipped = matching.saturating_sub(replay_count);
		counters
			.replay_skipped
			.store(skipped as u64, Ordering::Relaxed);
		let mut remaining_skip = skipped;
		let mut subscriptions = self.inner.subs.write();
		for event in replay {
			if !subscription.wants(event.kind()) {
				continue;
			}
			if remaining_skip > 0 {
				remaining_skip -= 1;
				continue;
			}
			subscription.offer(event);
		}
		subscriptions.push(subscription);
		drop(subscriptions);
		Ok(SubscriptionHandle { inner: Arc::downgrade(&self.inner), id, receiver, counters })
	}
}

/// Receiving side of one bounded telemetry subscription.
#[must_use]
pub struct SubscriptionHandle {
	inner:    Weak<Inner>,
	id:       u64,
	receiver: Receiver<Arc<Event>>,
	counters: Arc<DropCounters>,
}

impl SubscriptionHandle {
	/// Waits for the next retained event or reports that the firehose closed.
	pub async fn recv(&self) -> Result<Arc<Event>, flume::RecvError> {
		self.receiver.recv_async().await
	}

	/// Attempts to receive one event without waiting.
	pub fn try_recv(&self) -> Result<Arc<Event>, TryRecvError> {
		self.receiver.try_recv()
	}

	/// Snapshots loss accounting for this subscription.
	pub fn drop_stats(&self) -> DropStats {
		self.counters.snapshot()
	}
}

impl Drop for SubscriptionHandle {
	fn drop(&mut self) {
		let Some(inner) = self.inner.upgrade() else {
			return;
		};
		inner
			.subs
			.write()
			.retain(|subscription| subscription.id != self.id);
	}
}

#[cfg(test)]
mod tests {
	use std::iter;

	use omp_core::sf;

	use super::*;

	fn event(turn: u64) -> Arc<Event> {
		Arc::new(Event::TurnStart(TurnStart { turn, ..TurnStart::default() }))
	}

	#[test]
	fn bounded_ring_counts_overflow_without_blocking() {
		let firehose = Firehose::new();
		let subscription = firehose
			.subscribe(SubscriptionOptions::new([Kind::TurnStart], 1).unwrap())
			.unwrap();
		firehose.publish(Event::TurnStart(TurnStart { turn: 1, ..TurnStart::default() }));
		firehose.publish(Event::TurnStart(TurnStart { turn: 2, ..TurnStart::default() }));
		assert_eq!(subscription.drop_stats().dropped, 1);
		assert!(
			matches!(subscription.try_recv(), Ok(event) if matches!(&*event, Event::TurnStart(TurnStart { turn: 1, .. })))
		);
	}

	#[test]
	fn replay_is_chronological_then_switches_to_live_without_duplicate_boundary() {
		let firehose = Firehose::new();
		let replay = [event(1), event(2)];
		let subscription = firehose
			.subscribe_replay(SubscriptionOptions::new([Kind::TurnStart], 4).unwrap(), &replay, 4)
			.unwrap();
		firehose.publish(Event::TurnStart(TurnStart { turn: 3, ..TurnStart::default() }));
		let turns = iter::from_fn(|| subscription.try_recv().ok())
			.map(|event| match &*event {
				Event::TurnStart(turn) => turn.turn,
				_ => unreachable!("kind filter admits only turn starts"),
			})
			.collect::<Vec<_>>();
		assert_eq!(turns, [1, 2, 3]);
		assert_eq!(subscription.drop_stats().replay_skipped, 0);
	}

	#[test]
	fn fingerprint_reports_slot_diff_and_stable_prefix() {
		let previous = PromptFingerprint::compute(
			None,
			b"system\nuser",
			b"system\nuser",
			[(sf!("system"), b"system".to_vec()), (sf!("user"), b"user".to_vec())],
			None,
		);
		let current = PromptFingerprint::compute(
			Some(&previous),
			b"system\nuser",
			b"system\nassistant",
			[(sf!("system"), b"system".to_vec()), (sf!("user"), b"assistant".to_vec())],
			None,
		);
		assert_eq!(current.changed.as_slice(), [sf!("user")]);
		assert_eq!(current.prefix_stable_bytes, b"system\n".len());
	}
}
