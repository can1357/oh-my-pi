//! OpenTelemetry instrumentation for the agent loop, ported 1:1 from the
//! previous TypeScript implementation.
//!
//! Wire compatibility is the contract: span names, attribute keys, metric
//! instruments, log-record shapes, and environment-variable knobs remain
//! stable so existing dashboards, collectors, and alerts keep working.
//! OMP-specific OpenTelemetry `GenAI` semantic-convention extensions use the
//! `omp.gen_ai.*` / `omp.*` prefixes.
//!
//! Layering mirrors the original split:
//! - [`attrs`] / [`semconv`] — the constant vocabulary (attribute keys, span
//!   names, enum values, provider normalization).
//! - [`span`] / [`content`] — span lifecycle and policy-bounded, always-masked
//!   content capture.
//! - [`metrics`] / [`collector`] — instruments and per-run aggregation.
//! - [`logging`] — process-wide tracing, rotating JSON logs, timing output, and
//!   the tracing-to-OTLP bridge.
//! - [`export`] / [`redact`] — OTLP bootstrap, configuration, and scrubbing.

pub mod attrs;
pub mod autoqa;
pub mod collector;
pub mod config;
pub mod content;
pub mod export;
pub mod firehose;
pub mod logging;
pub mod metrics;
pub mod redact;
pub mod semconv;
pub mod semconv_gen;
pub mod sentiment;
pub mod span;
pub mod stats;
/// Host-owned CONTROL authority for extension telemetry.
///
/// The owner keeps extension observations in bounded per-subscription rings,
/// delegates historical queries to the durable index, owns exporter handles,
/// and retains real OpenTelemetry spans until their matching close request.
pub mod authority {
	use std::{
		collections::{BTreeMap, BTreeSet, VecDeque},
		sync::{
			Arc,
			atomic::{AtomicU64, Ordering},
		},
		time::{SystemTime, UNIX_EPOCH},
	};

	use omp_core::Str;
	use opentelemetry::{
		KeyValue, global,
		trace::{Span as _, SpanKind, Status, Tracer as _},
	};
	use parking_lot::{Condvar, Mutex};
	use serde::{Deserialize, Serialize};
	use serde_json::Value;
	use thiserror::Error;

	use super::{export, semconv};

	/// Default number of canonical events retained for one extension sink.
	pub const SUBSCRIPTION_RETENTION_DEFAULT: usize = 4_096;
	/// Hard ceiling for a single extension telemetry ring.
	pub const SUBSCRIPTION_RETENTION_MAX: usize = 65_536;

	/// Authenticated extension incarnation allowed to use one telemetry owner.
	#[derive(Clone, Debug, Eq, PartialEq)]
	pub struct TelemetryAuthorityIdentity {
		/// Stable authenticated principal spelling.
		pub principal:          Str,
		/// Verified extension artifact digest.
		pub artifact_digest:    Str,
		/// Active child incarnation.
		pub host_generation:    u64,
		/// Active session incarnation.
		pub session_generation: u64,
		/// Earliest durable telemetry timestamp visible to this installation.
		pub installed_at_ms:    u64,
		/// Durable, exact capability grants.
		pub capabilities:       Arc<BTreeSet<Str>>,
	}

	/// Per-call authority supplied by Core rather than by the extension.
	#[derive(Clone, Copy, Debug)]
	pub struct TelemetryCallContext<'a> {
		/// Authenticated connection identity.
		pub identity:  &'a TelemetryAuthorityIdentity,
		/// Whether the owning invocation has been cancelled or settled.
		pub cancelled: bool,
	}

	/// Typed telemetry authority failure.
	#[derive(Clone, Debug, Error, Eq, PartialEq)]
	pub enum TelemetryAuthorityError {
		/// The request belongs to another connection incarnation.
		#[error("telemetry request belongs to a stale or foreign connection")]
		Identity,
		/// The owning callback is no longer live.
		#[error("telemetry request was cancelled")]
		Cancelled,
		/// A durable capability does not cover the requested resource.
		#[error("telemetry capability `{0}` is not granted")]
		Capability(Str),
		/// The request is malformed.
		#[error("invalid telemetry request: {0}")]
		Invalid(Str),
		/// The named host resource does not exist.
		#[error("telemetry resource `{0}` does not exist")]
		NotFound(Str),
		/// The authoritative durable index or exporter rejected the operation.
		#[error("telemetry owner failed: {0}")]
		Owner(Str),
	}

	/// One canonical event retained in a subscription ring.
	#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
	pub struct RetainedTelemetryEvent {
		/// Owner-issued monotonic event sequence.
		pub sequence: u64,
		/// Host observation time.
		pub at_ms:    u64,
		/// Canonical event body.
		pub event:    Value,
	}

	/// Truthful counters for a bounded subscription.
	#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize)]
	pub struct SubscriptionStats {
		/// Events delivered into the ring.
		pub delivered:      u64,
		/// Events evicted because the ring was full.
		pub dropped:        u64,
		/// Older equivalent events replaced before delivery.
		pub coalesced:      u64,
		/// Current retained event count.
		pub queue_depth:    usize,
		/// First sequence lost to bounded retention.
		pub first_drop_seq: Option<u64>,
	}

	/// Historical query boundary owned by the durable telemetry index.
	#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
	pub struct DurableTelemetryRow {
		/// Durable session containing the indexed frame.
		pub session:        Str,
		/// Durable turn carried by the event, or zero for session-level events.
		pub turn:           u64,
		/// Exact byte offset in that session's append-only telemetry file.
		pub offset:         u64,
		/// Canonical indexed event kind.
		pub kind:           Str,
		/// Event observation time in Unix milliseconds.
		pub occurred_at_ms: u64,
		/// Whether transcript replay supplied this row.
		pub backfilled:     bool,
		/// Canonical payload decoded from the durable side file.
		pub events:         Vec<Value>,
		/// Named match binding, when the query step declared one.
		pub bindings:       BTreeMap<Str, Value>,
		/// Selected indexed or payload values.
		pub values:         BTreeMap<Str, Value>,
	}

	/// Authoritative result envelope shared by durable query implementations.
	#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
	pub struct DurableTelemetryRows {
		/// Selected rows in durable offset order.
		pub rows:             Vec<DurableTelemetryRow>,
		/// Rows matching before the caller's limit was applied.
		pub total:            usize,
		/// Opaque next offset, when more rows remain.
		pub cursor:           Option<Str>,
		/// Whether the result was bounded by its limit.
		pub truncated:        bool,
		/// Number of durable sessions inspected.
		pub scanned_sessions: usize,
		/// Number of indexed event rows inspected.
		pub scanned_events:   usize,
		/// Whether any selected row came from transcript replay.
		pub backfilled:       bool,
		/// Whether the installation-time visibility floor removed rows.
		pub floored:          bool,
		/// Host-side query elapsed time in whole milliseconds.
		pub elapsed_ms:       u64,
	}

	impl DurableTelemetryRows {
		/// Serializes the canonical CONTROL result without a second schema.
		pub fn into_value(self) -> Result<Value, TelemetryAuthorityError> {
			serde_json::to_value(self).map_err(|error| {
				TelemetryAuthorityError::Owner(Str::new(format!(
					"telemetry result serialization failed: {error}"
				)))
			})
		}
	}

	/// Historical query boundary owned by the durable telemetry index.
	pub trait DurableTelemetryQuery: Send + Sync + 'static {
		/// Executes a canonical query, respecting the supplied install floor.
		fn query(
			&self,
			identity: &TelemetryAuthorityIdentity,
			query: &Value,
		) -> Result<Value, TelemetryAuthorityError>;

		/// Computes indexed newest-first metrics for exact tool revisions.
		fn rev_metrics(
			&self,
			identity: &TelemetryAuthorityIdentity,
			tool: &str,
			family: Option<&str>,
			since: Option<&Value>,
			scope: &str,
		) -> Result<Value, TelemetryAuthorityError>;
	}

	/// Complete exporter health returned without inventing delivery counts.
	#[derive(Clone, Debug, Default, Eq, PartialEq, Serialize)]
	pub struct ControlExportStats {
		/// Successfully sent records.
		pub sent:          u64,
		/// Records discarded by bounded retention.
		pub dropped:       u64,
		/// Terminal or retryable send failures.
		pub failures:      u64,
		/// Records waiting for delivery.
		pub queue_depth:   u64,
		/// Last successful flush timestamp.
		pub last_flush_ms: u64,
		/// Most recent exporter diagnostic.
		pub last_error:    Option<Str>,
		/// Current retry delay.
		pub backoff_ms:    u64,
	}

	/// Host-side exporter installed from a frozen manifest declaration.
	pub trait TelemetryExporter: Send + Sync + 'static {
		/// Flushes all records accepted before this call.
		fn flush(&self) -> Result<(), TelemetryAuthorityError>;
		/// Stops the worker after a final flush.
		fn stop(&self) -> Result<(), TelemetryAuthorityError>;
		/// Reads counters from the real exporter worker.
		fn stats(&self) -> ControlExportStats;
	}

	struct Subscription {
		capacity:       usize,
		coalesce_field: Option<Str>,
		queue:          VecDeque<RetainedTelemetryEvent>,
		stats:          SubscriptionStats,
	}

	#[derive(Clone, Copy, Eq, PartialEq)]
	enum ExportLifecycle {
		Live,
		Stopping,
		Stopped,
	}

	struct ExportSlot {
		exporter:  Arc<dyn TelemetryExporter>,
		lifecycle: ExportLifecycle,
	}

	struct OpenSpan {
		span: opentelemetry::global::BoxedSpan,
	}

	#[derive(Default)]
	struct State {
		subscriptions: BTreeMap<Str, Subscription>,
		exporters:     BTreeMap<u64, ExportSlot>,
		spans:         BTreeMap<Str, OpenSpan>,
	}

	/// Identity-fenced owner for telemetry subscriptions, queries, exporters,
	/// and extension spans.
	pub struct TelemetryAuthority {
		identity:      Arc<TelemetryAuthorityIdentity>,
		query:         Arc<dyn DurableTelemetryQuery>,
		next_seq:      AtomicU64,
		next_span:     AtomicU64,
		state:         Mutex<State>,
		export_change: Condvar,
	}

	impl TelemetryAuthority {
		/// Creates one owner for one authenticated connection incarnation.
		pub fn new(
			identity: Arc<TelemetryAuthorityIdentity>,
			query: Arc<dyn DurableTelemetryQuery>,
		) -> Self {
			Self {
				identity,
				query,
				next_seq: AtomicU64::new(1),
				next_span: AtomicU64::new(1),
				state: Mutex::new(State::default()),
				export_change: Condvar::new(),
			}
		}

		fn authorize(
			&self,
			context: TelemetryCallContext<'_>,
		) -> Result<(), TelemetryAuthorityError> {
			if context.identity != self.identity.as_ref() {
				return Err(TelemetryAuthorityError::Identity);
			}
			if context.cancelled {
				return Err(TelemetryAuthorityError::Cancelled);
			}
			Ok(())
		}

		/// Installs a frozen subscription declaration and its bounded ring.
		pub fn install_subscription(
			&self,
			context: TelemetryCallContext<'_>,
			id: impl Into<Str>,
			capacity: usize,
			coalesce_field: Option<Str>,
		) -> Result<(), TelemetryAuthorityError> {
			self.authorize(context)?;
			if capacity == 0 || capacity > SUBSCRIPTION_RETENTION_MAX {
				return Err(TelemetryAuthorityError::Invalid(Str::new(format!(
					"subscription capacity must be in 1..={SUBSCRIPTION_RETENTION_MAX}"
				))));
			}
			let id = id.into();
			let mut state = self.state.lock();
			if state.subscriptions.contains_key(id.as_str()) {
				return Err(TelemetryAuthorityError::Invalid(Str::new(format!(
					"duplicate telemetry subscription `{id}`"
				))));
			}
			state.subscriptions.insert(id, Subscription {
				capacity,
				coalesce_field,
				queue: VecDeque::with_capacity(capacity),
				stats: SubscriptionStats::default(),
			});
			Ok(())
		}

		/// Publishes a canonical post-hoc event to every installed bounded ring.
		pub fn publish(
			&self,
			context: TelemetryCallContext<'_>,
			event: Value,
		) -> Result<u64, TelemetryAuthorityError> {
			self.authorize(context)?;
			if !event.is_object() {
				return Err(TelemetryAuthorityError::Invalid(Str::new_static(
					"telemetry event must be an object",
				)));
			}
			let sequence = self.next_seq.fetch_add(1, Ordering::Relaxed);
			let retained = RetainedTelemetryEvent { sequence, at_ms: now_ms(), event };
			for subscription in self.state.lock().subscriptions.values_mut() {
				let coalesce = subscription.coalesce_field.as_ref().and_then(|field| {
					retained
						.event
						.get(field.as_str())
						.map(|key| (field.clone(), key.clone()))
				});
				if let Some((field, key)) = coalesce
					&& let Some(existing) = subscription
						.queue
						.iter_mut()
						.rev()
						.find(|existing| existing.event.get(field.as_str()) == Some(&key))
				{
					*existing = retained.clone();
					subscription.stats.coalesced = subscription.stats.coalesced.saturating_add(1);
					subscription.stats.queue_depth = subscription.queue.len();
					continue;
				}
				if subscription.queue.len() == subscription.capacity
					&& let Some(dropped) = subscription.queue.pop_front()
				{
					subscription.stats.dropped = subscription.stats.dropped.saturating_add(1);
					subscription
						.stats
						.first_drop_seq
						.get_or_insert(dropped.sequence);
				}
				subscription.queue.push_back(retained.clone());
				subscription.stats.delivered = subscription.stats.delivered.saturating_add(1);
				subscription.stats.queue_depth = subscription.queue.len();
			}
			Ok(sequence)
		}

		/// Drains up to `limit` retained events in sequence order.
		pub fn drain_subscription(
			&self,
			context: TelemetryCallContext<'_>,
			id: &str,
			limit: usize,
		) -> Result<(Vec<RetainedTelemetryEvent>, SubscriptionStats), TelemetryAuthorityError> {
			self.authorize(context)?;
			if limit == 0 {
				return Err(TelemetryAuthorityError::Invalid(Str::new_static(
					"subscription drain limit must be positive",
				)));
			}
			let mut state = self.state.lock();
			let subscription = state
				.subscriptions
				.get_mut(id)
				.ok_or_else(|| TelemetryAuthorityError::NotFound(Str::new(id)))?;
			let count = limit.min(subscription.queue.len());
			let events = subscription.queue.drain(..count).collect();
			subscription.stats.queue_depth = subscription.queue.len();
			Ok((events, subscription.stats))
		}

		/// Installs one host-constructed exporter at its frozen declaration id.
		pub fn install_exporter(
			&self,
			context: TelemetryCallContext<'_>,
			id: u64,
			exporter: Arc<dyn TelemetryExporter>,
		) -> Result<(), TelemetryAuthorityError> {
			self.authorize(context)?;
			let mut state = self.state.lock();
			if state.exporters.contains_key(&id) {
				return Err(TelemetryAuthorityError::Invalid(Str::new(format!(
					"duplicate telemetry exporter `{id}`"
				))));
			}
			state
				.exporters
				.insert(id, ExportSlot { exporter, lifecycle: ExportLifecycle::Live });
			Ok(())
		}

		/// Returns counters from the actual exporter worker.
		pub fn exporter_stats(
			&self,
			context: TelemetryCallContext<'_>,
			id: u64,
		) -> Result<ControlExportStats, TelemetryAuthorityError> {
			self.authorize(context)?;
			self
				.state
				.lock()
				.exporters
				.get(&id)
				.map(|slot| slot.exporter.stats())
				.ok_or_else(|| TelemetryAuthorityError::NotFound(Str::new(format!("export:{id}"))))
		}

		/// Idempotently stops an installed exporter after its final flush.
		pub fn stop_exporter(
			&self,
			context: TelemetryCallContext<'_>,
			id: u64,
		) -> Result<(), TelemetryAuthorityError> {
			self.authorize(context)?;
			let exporter = {
				let mut state = self.state.lock();
				loop {
					let slot = state.exporters.get_mut(&id).ok_or_else(|| {
						TelemetryAuthorityError::NotFound(Str::new(format!("export:{id}")))
					})?;
					match slot.lifecycle {
						ExportLifecycle::Stopped => return Ok(()),
						ExportLifecycle::Stopping => self.export_change.wait(&mut state),
						ExportLifecycle::Live => {
							slot.lifecycle = ExportLifecycle::Stopping;
							break slot.exporter.clone();
						},
					}
				}
			};
			let result = exporter.flush().and_then(|()| exporter.stop());
			let mut state = self.state.lock();
			if let Some(slot) = state.exporters.get_mut(&id) {
				slot.lifecycle = if result.is_ok() {
					ExportLifecycle::Stopped
				} else {
					ExportLifecycle::Live
				};
			}
			self.export_change.notify_all();
			result
		}

		/// Flushes every live exporter and the process-global OTLP providers.
		pub fn flush(
			&self,
			context: TelemetryCallContext<'_>,
		) -> Result<bool, TelemetryAuthorityError> {
			self.authorize(context)?;
			let exporters: Vec<_> = self
				.state
				.lock()
				.exporters
				.values()
				.filter(|slot| slot.lifecycle == ExportLifecycle::Live)
				.map(|slot| slot.exporter.clone())
				.collect();
			let mut attempted = !exporters.is_empty();
			for exporter in exporters {
				exporter.flush()?;
			}
			if export::is_enabled() {
				attempted = true;
				export::flush();
			}
			Ok(attempted)
		}

		/// Runs a historical query against the authoritative durable index.
		pub fn query(
			&self,
			context: TelemetryCallContext<'_>,
			query: &Value,
		) -> Result<Value, TelemetryAuthorityError> {
			self.authorize(context)?;
			let result = self.query.query(self.identity.as_ref(), query)?;
			let body = result.as_object().ok_or_else(|| {
				TelemetryAuthorityError::Owner(Str::new_static(
					"durable query owner returned a non-object result",
				))
			})?;
			if !body.get("rows").is_some_and(Value::is_array)
				|| !body.get("total").is_some_and(Value::is_u64)
			{
				return Err(TelemetryAuthorityError::Owner(Str::new_static(
					"durable query owner returned an invalid result",
				)));
			}
			Ok(result)
		}

		/// Reads revision metrics from the authoritative durable index.
		pub fn rev_metrics(
			&self,
			context: TelemetryCallContext<'_>,
			tool: &str,
			family: Option<&str>,
			since: Option<&Value>,
			scope: &str,
		) -> Result<Value, TelemetryAuthorityError> {
			self.authorize(context)?;
			if tool.is_empty() {
				return Err(TelemetryAuthorityError::Invalid(Str::new_static(
					"tool must not be empty",
				)));
			}
			let result = self
				.query
				.rev_metrics(self.identity.as_ref(), tool, family, since, scope)?;
			if !result.is_array() {
				return Err(TelemetryAuthorityError::Owner(Str::new_static(
					"durable revision metrics owner returned a non-array result",
				)));
			}
			Ok(result)
		}

		/// Opens a real process-global OpenTelemetry span and retains its handle.
		pub fn open_span(
			&self,
			context: TelemetryCallContext<'_>,
			name: &str,
			attributes: &serde_json::Map<String, Value>,
		) -> Result<OpenedSpan, TelemetryAuthorityError> {
			self.authorize(context)?;
			if name.is_empty() {
				return Err(TelemetryAuthorityError::Invalid(Str::new_static(
					"span name must not be empty",
				)));
			}
			let attributes = scalar_attributes(attributes)?;
			let tracer = global::tracer(semconv::TRACER_NAME);
			let builder = tracer
				.span_builder(name.to_owned())
				.with_kind(SpanKind::Internal)
				.with_attributes(attributes);
			let span = tracer.build(builder);
			let trace = TraceIdentity {
				trace_id: span.span_context().trace_id().to_string().into(),
				span_id:  span.span_context().span_id().to_string().into(),
				sampled:  span.span_context().is_sampled(),
			};
			let handle = Str::new(format!("span-{}", self.next_span.fetch_add(1, Ordering::Relaxed)));
			self
				.state
				.lock()
				.spans
				.insert(handle.clone(), OpenSpan { span });
			Ok(OpenedSpan { handle, trace })
		}

		/// Closes exactly one retained span, recording final attributes, events,
		/// and an optional typed fault.
		pub fn close_span(
			&self,
			context: TelemetryCallContext<'_>,
			handle: &str,
			attributes: &serde_json::Map<String, Value>,
			events: &[SpanEvent],
			fault: Option<&SpanFault>,
		) -> Result<(), TelemetryAuthorityError> {
			self.authorize(context)?;
			let attributes = scalar_attributes(attributes)?;
			let mut validated_events = Vec::with_capacity(events.len());
			for event in events {
				if event.name.is_empty() {
					return Err(TelemetryAuthorityError::Invalid(Str::new_static(
						"span event name must not be empty",
					)));
				}
				validated_events.push((event.name.to_string(), scalar_attributes(&event.attributes)?));
			}
			let mut open = self
				.state
				.lock()
				.spans
				.remove(handle)
				.ok_or_else(|| TelemetryAuthorityError::NotFound(Str::new(handle)))?;
			for attribute in attributes {
				open.span.set_attribute(attribute);
			}
			for (name, attributes) in validated_events {
				open.span.add_event(name, attributes);
			}
			if let Some(fault) = fault {
				open
					.span
					.set_status(Status::error(format!("{}: {}", fault.kind, fault.message)));
			}
			open.span.end();
			Ok(())
		}
	}

	/// Open-span response returned to the extension.
	#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
	pub struct OpenedSpan {
		/// Opaque owner-issued span handle.
		pub handle: Str,
		/// Trace identity derived from the real OpenTelemetry span.
		pub trace:  TraceIdentity,
	}

	/// W3C trace identity for an open span.
	#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
	pub struct TraceIdentity {
		/// 128-bit lower-case trace id.
		pub trace_id: Str,
		/// 64-bit lower-case span id.
		pub span_id:  Str,
		/// Whether the provider sampled the span.
		pub sampled:  bool,
	}

	/// One extension-authored event recorded at span close.
	#[derive(Clone, Debug, Deserialize)]
	pub struct SpanEvent {
		/// Non-empty event name.
		pub name:       Str,
		/// Scalar event attributes.
		#[serde(default)]
		pub attributes: serde_json::Map<String, Value>,
	}

	/// Typed fault applied to a closing span.
	#[derive(Clone, Debug, Deserialize)]
	pub struct SpanFault {
		/// Error classification.
		pub kind:    Str,
		/// Redacted diagnostic.
		pub message: Str,
	}

	fn scalar_attributes(
		attributes: &serde_json::Map<String, Value>,
	) -> Result<Vec<KeyValue>, TelemetryAuthorityError> {
		attributes
			.iter()
			.map(|(key, value)| {
				let value = match value {
					Value::String(value) => opentelemetry::Value::from(value.clone()),
					Value::Bool(value) => opentelemetry::Value::from(*value),
					Value::Number(value) if value.is_i64() => {
						opentelemetry::Value::from(value.as_i64().expect("checked"))
					},
					Value::Number(value) if value.is_u64() => {
						let value = value.as_u64().expect("checked");
						let value = i64::try_from(value).map_err(|_| {
							TelemetryAuthorityError::Invalid(Str::new(format!(
								"attribute `{key}` exceeds signed 64-bit range"
							)))
						})?;
						opentelemetry::Value::from(value)
					},
					Value::Number(value) => {
						opentelemetry::Value::from(value.as_f64().ok_or_else(|| {
							TelemetryAuthorityError::Invalid(Str::new(format!(
								"attribute `{key}` is not finite"
							)))
						})?)
					},
					_ => {
						return Err(TelemetryAuthorityError::Invalid(Str::new(format!(
							"attribute `{key}` must be scalar"
						))));
					},
				};
				Ok(KeyValue::new(key.clone(), value))
			})
			.collect()
	}

	fn now_ms() -> u64 {
		SystemTime::now()
			.duration_since(UNIX_EPOCH)
			.unwrap_or_default()
			.as_millis() as u64
	}
}
