//! Extension hook CONTROL owner and provider-hook projection.

use std::{
	collections::{BTreeMap, BTreeSet, VecDeque},
	future::Future,
	sync::{
		Arc,
		atomic::{AtomicBool, AtomicU64, Ordering},
	},
	time,
};

use omp_ai::{
	BeforeRequestDenied, BeforeRequestDraft, BeforeRequestMutation, CredentialDisabledObservation,
	ModelsDiscoverHookPage, ModelsDiscoverHookRequest, ProviderHookCredential, ProviderHookError,
	ProviderHookObserver, ProviderLoginHookRequest, ProviderRefreshHookRequest,
	ProviderResponseObservation, ProviderResponseObserver, ProviderSignHookRequest,
	ProviderSignature,
	answer::{
		UsageAccountMetadata, UsageAmount, UsageQuantity, UsageUnit, UsageWindow, UsageWindowKind,
	},
	operation::usage::{
		ConsoleUsageFetcher, ConsoleUsageObservation, UsageCredentialRequirement, UsageFetchError,
		UsageFetcherRegistry,
	},
	receipt::UsageSource,
};
use omp_cache::telemetry_cache::TelemetryIndex;
use omp_catalog::ProviderId;
use omp_contract::{
	GateDecision, GateEvent, GateOutcome, HookDispatch as AgentHookDispatch, HookGate, HookPatch,
	HookPhase, OBSERVE_HANDLER_CAP,
};
use omp_core::{ExposeSecret as _, InvocationPhase, LifecyclePhase, SecretString, Str, Ulid, sf};
use omp_proto::{prost::Message as _, toolhost::v1::HookEventId};
use parking_lot::{Mutex, RwLock};
use serde_json::{Map as JsonMap, Value as JsonValue, json};

use super::{
	continuation::ContinuationBook,
	registry::{
		ControlConnectionKey, RegistryControlFactory, connection_key, require_active_invocation,
		required_string, required_u16, same_connection, stale_connection,
	},
};
use crate::{
	exthost::{
		CallbackConcurrency,
		control::{
			ControlAuthority, ControlAuthorityFactory, ControlCompositionError,
			ControlConnectionIdentity, ControlDispatch, ControlEffect, ControlInvocationAuthority,
			ControlProtocolError, ControlRequestContext,
		},
		dispatch::{CallbackDispatcher, EventDeadline, NestedCallbackDispatcher},
	},
	mcp::manager::{McpHookNotification, McpNotificationSink},
};

/// Failure behavior for one subscribed hook callback.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HookFailurePolicy {
	/// Ignore an unavailable or failed callback.
	Defer,
	/// Convert callback failure into a composed denial.
	Deny,
}

/// Composition rule for one mutable event field.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum HookFieldComposition {
	/// Later ordered values replace earlier values.
	Replace,
	/// Ordered arrays concatenate.
	Append,
	/// Ordered arrays retain only common values.
	Intersect,
}

/// Host-owned behavior for one revisioned hook event.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct HookEventPolicy {
	/// Exact payload/decision schema revision.
	pub revision:    u16,
	/// Deadline used when a subscription has no narrower timeout.
	pub timeout:     time::Duration,
	/// Event-level failure default.
	pub on_failure:  HookFailurePolicy,
	/// Decision returned when every subscription defers.
	pub default:     JsonValue,
	/// Per-field mutation composition.
	pub composition: BTreeMap<Str, HookFieldComposition>,
}

/// One exact frozen Python subscription callback.
#[derive(Clone)]
pub struct HookSubscription {
	/// Authenticated child generation owning the callback.
	pub identity:     Arc<ControlConnectionIdentity>,
	/// Authenticated durable session owning this callback.
	pub session:      Str,
	/// Stable event name.
	pub event:        Str,
	/// Frozen phase spelling.
	pub phase:        Str,
	/// Stable callback name selected inside Python.
	pub name:         Str,
	/// Deterministic order within a phase.
	pub order:        i32,
	/// Per-subscription failure override.
	pub on_failure:   Option<HookFailurePolicy>,
	/// Per-subscription deadline override.
	pub timeout:      Option<time::Duration>,
	/// Declared callback overlap policy.
	pub concurrency:  CallbackConcurrency,
	/// Provider ids admitted by this callback, when provider-scoped.
	pub providers:    Option<Box<[Str]>>,
	/// Exact raw MCP mount names admitted by this callback.
	pub servers:      Option<Box<[Str]>>,
	/// Anchored MCP JSON-RPC method globs admitted by this callback.
	pub method_globs: Box<[Str]>,
	/// Event policy frozen with the Python registry declaration.
	pub event_policy: HookEventPolicy,
}
#[derive(Clone)]
struct ExtensionUsageFetcher {
	provider:    ProviderId,
	settings:    JsonMap<String, JsonValue>,
	identity:    Arc<ControlConnectionIdentity>,
	session:     Str,
	dispatcher:  Arc<dyn CallbackDispatcher>,
	callback:    Str,
	concurrency: CallbackConcurrency,
	timeout:     time::Duration,
	next_id:     Arc<AtomicU64>,
}

impl ConsoleUsageFetcher for ExtensionUsageFetcher {
	fn provider(&self) -> &ProviderId<str> {
		&self.provider
	}

	fn credential_requirement(&self) -> UsageCredentialRequirement {
		UsageCredentialRequirement::Optional
	}

	fn fetch<'a>(
		&'a self,
		credential: Option<&'a omp_core::SecretString>,
		now: time::SystemTime,
		deadline: Option<time::Instant>,
	) -> futures::future::BoxFuture<'a, Result<ConsoleUsageObservation, UsageFetchError>> {
		Box::pin(async move {
			let id = self.next_id.fetch_add(1, Ordering::Relaxed).max(1);
			let mut payload = JsonMap::new();
			payload.insert("provider".to_owned(), JsonValue::String(self.provider.to_string()));
			payload.insert("identity".to_owned(), JsonValue::Null);
			payload.insert("scope".to_owned(), JsonValue::String("all".to_owned()));
			payload.insert("allow_stale".to_owned(), JsonValue::Bool(true));
			if let Some(credential) = credential {
				payload.insert(
					"api_key".to_owned(),
					json!({"$bytes": omp_core::base64::encode(credential.expose_secret().as_bytes())}),
				);
			}
			let mut arguments = JsonMap::new();
			arguments.insert("event".to_owned(), JsonValue::String("provider_usage".to_owned()));
			arguments.insert("phase".to_owned(), JsonValue::String("domain".to_owned()));
			arguments.insert("name".to_owned(), JsonValue::String(self.callback.to_string()));
			arguments.insert("payload".to_owned(), JsonValue::Object(payload));
			let timeout_at = deadline.unwrap_or_else(|| time::Instant::now() + self.timeout);
			let result = self
				.dispatcher
				.dispatch(Arc::clone(&self.identity), ControlDispatch {
					operation: sf!("omp.hooks.dispatch"),
					arguments,
					authority: ControlInvocationAuthority {
						invocation:        sf!("provider-usage:{}:{id}", self.identity.host_generation),
						phase:             InvocationPhase::EffectsAuthorized,
						session:           self.session.clone(),
						turn:              None,
						event:             Some(sf!("provider_usage")),
						call:              None,
						device:            None,
						effects:           Box::new([]),
						place_kind:        sf!("host"),
						lifecycle:         LifecyclePhase::Active,
						roots:             Box::new([]),
						remote:            false,
						has_ui:            false,
						headless:          true,
						settings:          self.settings.clone(),
						secret_settings:   Box::new([]),
						data:              None,
						direct_filesystem: None,
					},
					policy: self.concurrency,
					deadline: EventDeadline { at: timeout_at },
				})
				.await
				.map_err(|error| {
					if error.code.as_str().contains("Auth") {
						UsageFetchError::AuthRejected
					} else {
						UsageFetchError::Unavailable
					}
				})?;
			decode_extension_usage(result, now)
		})
	}
}

fn decode_extension_usage(
	value: JsonValue,
	observed_at: time::SystemTime,
) -> Result<ConsoleUsageObservation, UsageFetchError> {
	let report = value.as_object().ok_or(UsageFetchError::Protocol)?;
	let windows = report
		.get("windows")
		.and_then(JsonValue::as_array)
		.ok_or(UsageFetchError::Protocol)?
		.iter()
		.map(|window| decode_extension_usage_window(window, observed_at))
		.collect::<Result<Vec<_>, _>>()?;
	Ok(ConsoleUsageObservation {
		account_meta: UsageAccountMetadata::default(),
		plan: report
			.get("plan")
			.and_then(JsonValue::as_str)
			.map(Str::from),
		source_label: Some(sf!("extension")),
		notes: Box::new([]),
		reset_credits: None,
		windows,
	})
}

fn decode_extension_usage_window(
	value: &JsonValue,
	observed_at: time::SystemTime,
) -> Result<UsageWindow, UsageFetchError> {
	let window = value.as_object().ok_or(UsageFetchError::Protocol)?;
	let unit = match window.get("unit").and_then(JsonValue::as_str) {
		Some("requests") => UsageUnit::Requests,
		Some("tokens") => UsageUnit::Tokens,
		Some("premium_units") => UsageUnit::Unknown,
		Some("nanos_usd") => UsageUnit::Usd,
		_ => return Err(UsageFetchError::Protocol),
	};
	let exponent = u8::from(unit == UsageUnit::Usd) * 9;
	let consumed = window
		.get("used")
		.and_then(JsonValue::as_u64)
		.map(|units| UsageQuantity::new(units, exponent));
	let limit = window
		.get("limit")
		.and_then(JsonValue::as_u64)
		.map(|units| UsageQuantity::new(units, exponent));
	let remaining = match (consumed, limit) {
		(Some(consumed), Some(limit)) => {
			Some(UsageQuantity::new(limit.units.saturating_sub(consumed.units), exponent))
		},
		_ => None,
	};
	let resets_at = window
		.get("resets_at_ms")
		.and_then(JsonValue::as_u64)
		.map(|millis| time::UNIX_EPOCH + time::Duration::from_millis(millis));
	Ok(UsageWindow {
		id: window
			.get("id")
			.and_then(JsonValue::as_str)
			.map(Str::from)
			.ok_or(UsageFetchError::Protocol)?,
		kind: UsageWindowKind::Quota,
		dimension: Str::from(
			window
				.get("unit")
				.and_then(JsonValue::as_str)
				.unwrap_or("usage"),
		),
		label: None,
		scope: None,
		amount: UsageAmount { unit, consumed, remaining, limit },
		status: None,
		duration: None,
		resets_at,
		reset_label: None,
		notes: Box::new([]),
		source: UsageSource::Provider,
		observed_at,
	})
}

fn usage_registration_id(subscription: &HookSubscription) -> Str {
	sf!(
		"{}:{}:{}:{}",
		subscription.identity.extension,
		subscription.identity.host_generation,
		subscription.identity.session_generation,
		subscription.name
	)
}

#[derive(Clone)]
struct McpQueuedDelivery {
	notification:  McpHookNotification,
	subscriptions: Vec<HookSubscription>,
}

struct McpDeliveryQueue {
	pending:         VecDeque<McpQueuedDelivery>,
	running_servers: BTreeSet<Str>,
	dropped:         u64,
}

impl McpDeliveryQueue {
	fn push(&mut self, delivery: McpQueuedDelivery) -> bool {
		let dropped = self.pending.len() == MCP_HOOK_QUEUE_CAPACITY;
		if dropped {
			self.pending.pop_front();
			self.dropped = self.dropped.saturating_add(1);
		}
		self.pending.push_back(delivery);
		dropped
	}
}

/// Per-session MCP notification queue capacity.
pub const MCP_HOOK_QUEUE_CAPACITY: usize = 100;

#[derive(Clone)]
pub struct HookControlFactory {
	registries:                   Arc<RegistryControlFactory>,
	dispatcher:                   Arc<dyn CallbackDispatcher>,
	callbacks:                    Arc<NestedCallbackDispatcher>,
	policies:                     Arc<RwLock<BTreeMap<Str, HookEventPolicy>>>,
	subscriptions:                Arc<RwLock<BTreeMap<ControlConnectionKey, Vec<HookSubscription>>>>,
	usage_fetchers:               UsageFetcherRegistry,
	mcp_queues:                   Arc<Mutex<BTreeMap<u64, McpDeliveryQueue>>>,
	mcp_journal:                  Arc<RwLock<Option<(Arc<TelemetryIndex>, Str)>>>,
	provider_response_subscribed: Arc<AtomicBool>,
	settings:                     Arc<BTreeMap<(Str, Str, Str), JsonMap<String, JsonValue>>>,
	tool_call_timeout:            time::Duration,
	admission_gate:               Arc<HookGate>,
	continuations:                ContinuationBook,
}

fn extension_callback_timeout(
	event: &str,
	configured: time::Duration,
	subscription: Option<time::Duration>,
	event_default: time::Duration,
) -> time::Duration {
	if event == "tool_call" {
		subscription.map_or(configured, |timeout| timeout.min(configured))
	} else {
		subscription.unwrap_or(event_default)
	}
}

impl HookControlFactory {
	/// Creates the composed hook owner over the live callback dispatcher.
	pub fn new(
		registries: Arc<RegistryControlFactory>,
		dispatcher: Arc<dyn CallbackDispatcher>,
		policies: BTreeMap<Str, HookEventPolicy>,
		settings: BTreeMap<(Str, Str, Str), JsonMap<String, JsonValue>>,
		tool_call_timeout: time::Duration,
	) -> Arc<Self> {
		let admission_timeout = tool_call_timeout
			.checked_mul(OBSERVE_HANDLER_CAP as u32)
			.unwrap_or(time::Duration::MAX);
		let (admission_gate, dispatches) =
			HookGate::delegated_channel_with_tool_call_timeout(admission_timeout);
		let owner = Arc::new(Self {
			registries,
			dispatcher: Arc::clone(&dispatcher),
			callbacks: Arc::new(NestedCallbackDispatcher::new(dispatcher)),
			policies: Arc::new(RwLock::new(policies)),
			subscriptions: Arc::new(RwLock::new(BTreeMap::new())),
			usage_fetchers: UsageFetcherRegistry::default(),
			mcp_queues: Arc::new(Mutex::new(BTreeMap::new())),
			mcp_journal: Arc::new(RwLock::new(None)),
			provider_response_subscribed: Arc::new(AtomicBool::new(false)),
			settings: Arc::new(settings),
			tool_call_timeout,
			admission_gate: Arc::new(admission_gate),
			continuations: ContinuationBook::new(),
		});
		let weak = Arc::downgrade(&owner);
		tokio::spawn(async move {
			while let Ok(dispatch) = dispatches.recv_async().await {
				let Some(owner) = weak.upgrade() else {
					break;
				};
				tokio::spawn(async move {
					owner.answer_admission_dispatch(dispatch).await;
				});
			}
		});
		owner
	}

	fn settings_for(&self, identity: &ControlConnectionIdentity) -> JsonMap<String, JsonValue> {
		self
			.settings
			.get(&(identity.layer.clone(), identity.tier.clone(), identity.extension.clone()))
			.cloned()
			.unwrap_or_default()
	}

	fn callback_timeout(
		&self,
		event: &str,
		subscription: &HookSubscription,
		policy: &HookEventPolicy,
	) -> time::Duration {
		extension_callback_timeout(
			event,
			self.tool_call_timeout,
			subscription.timeout,
			policy.timeout,
		)
	}

	async fn answer_admission_dispatch(&self, dispatch: AgentHookDispatch) {
		let event = hook_event_name(dispatch.event);
		let identity = event.as_deref().and_then(|event| {
			self
				.subscriptions
				.read()
				.values()
				.flatten()
				.find(|row| row.event == event)
				.map(|row| (Arc::clone(&row.identity), row.session.clone()))
		});
		let decision = match (event, identity) {
			(Some(event), Some((identity, session))) => {
				let payload = if dispatch.phase == HookPhase::Observe {
					serde_json::from_slice::<JsonValue>(&dispatch.payload).ok()
				} else {
					dispatch
						.payload
						.iter()
						.position(|byte| *byte == b'\n')
						.and_then(|separator| {
							serde_json::from_slice::<JsonValue>(&dispatch.payload[separator + 1..]).ok()
						})
				};
				match payload {
					Some(mut payload) => {
						if event == "tool_call" && !hydrate_tool_call_bash(&mut payload) {
							let _ = self.admission_gate.answer(dispatch.dispatch_id, vec![(
								0,
								GateDecision::Deny(sf!("malformed tool_call Bash IR admission payload")),
							)]);
							return;
						}
						let shutdown_bounded = event == "session_shutdown";
						let event_id = Str::from(event.as_str());
						let mut arguments = JsonMap::new();
						arguments.insert("event".to_owned(), JsonValue::String(event.clone()));
						arguments
							.insert("event_rev".to_owned(), JsonValue::from(u64::from(dispatch.rev)));
						arguments.insert("payload".to_owned(), payload.clone());
						let settings = self.settings_for(&identity);
						let context = ControlRequestContext {
							connection: identity,
							request_id: dispatch.dispatch_id,
							invocation: Some(ControlInvocationAuthority {
								invocation: sf!("hook-admission:{}", dispatch.dispatch_id),
								phase: InvocationPhase::EffectsAuthorized,
								session,
								turn: None,
								event: Some(event_id.clone()),
								call: None,
								device: None,
								effects: Box::new([]),
								place_kind: sf!("host"),
								lifecycle: LifecyclePhase::Active,
								roots: Box::new([]),
								remote: false,
								has_ui: false,
								headless: true,
								settings,
								secret_settings: Box::new([]),
								data: None,
								direct_filesystem: None,
							}),
						};
						if dispatch.phase == HookPhase::Observe {
							self.observe(&context, event_id.as_str(), &payload).await;
							GateDecision::Defer
						} else {
							let composed = if shutdown_bounded {
								match tokio::time::timeout(
									time::Duration::from_secs(2),
									self.compose(&context, &arguments),
								)
								.await
								{
									Ok(result) => result,
									Err(_) => Ok(json!({"kind": "defer"})),
								}
							} else {
								self.compose(&context, &arguments).await
							};
							match composed {
								Ok(value) => gate_decision_from_json(value, payload),
								Err(error) => GateDecision::Deny(error.message),
							}
						}
					},
					None => GateDecision::Deny(sf!("malformed hook admission payload")),
				}
			},
			_ => GateDecision::Deny(sf!("required hook subscription unavailable")),
		};
		let _ = self
			.admission_gate
			.answer(dispatch.dispatch_id, vec![(0, decision)]);
	}

	/// Binds durable accounting for drop-oldest MCP queue overflow.
	pub fn bind_mcp_drop_journal(&self, telemetry: Arc<TelemetryIndex>, session: Str) {
		*self.mcp_journal.write() = Some((telemetry, session));
	}

	/// Returns the per-session admission gate backed by this live composer.
	pub fn admission_gate(&self) -> Arc<HookGate> {
		Arc::clone(&self.admission_gate)
	}

	/// Session-scoped continuation ledger shared with Agents CONTROL.
	#[must_use]
	pub fn continuations(&self) -> ContinuationBook {
		self.continuations.clone()
	}

	/// Returns the shared runtime provider usage registry.
	pub fn usage_fetchers(&self) -> UsageFetcherRegistry {
		self.usage_fetchers.clone()
	}

	/// Installs callback details only for a key proven by the sealed registry
	/// effect. Re-installing the same name replaces its old declaration within
	/// the exact host generation.
	pub fn subscribe(&self, subscription: HookSubscription) -> Result<(), ControlProtocolError> {
		let evidence = self
			.registries
			.evidence(&subscription.identity)
			.ok_or_else(|| {
				ControlProtocolError::new(
					"RegistryUnavailable",
					"hook subscription requires sealed registry evidence",
				)
			})?;
		if !evidence
			.hooks
			.iter()
			.any(|hook| hook.event == subscription.event && hook.phase == subscription.phase)
		{
			return Err(ControlProtocolError::new(
				"RegistryUnauthorized",
				"hook subscription is absent from sealed registry evidence",
			));
		}
		let key = connection_key(&subscription.identity);
		let mut policies = self.policies.write();
		match policies.get(&subscription.event) {
			Some(policy) if policy != &subscription.event_policy => {
				return Err(ControlProtocolError::new(
					"HookContractError",
					"hook registrations disagree on their event policy",
				));
			},
			Some(_) => {},
			None => {
				policies.insert(subscription.event.clone(), subscription.event_policy.clone());
			},
		}
		drop(policies);
		let mut subscriptions = self.subscriptions.write();
		let fetchers = self.usage_fetchers.clone();
		{
			for (candidate, rows) in subscriptions.iter() {
				if candidate.0 == key.0
					&& candidate.1 == key.1
					&& candidate.2 == key.2
					&& *candidate != key
				{
					for row in rows.iter().filter(|row| row.event == "provider_usage") {
						for provider in row.providers.as_deref().unwrap_or_default() {
							let provider = ProviderId::from(provider.clone());
							fetchers.unregister_runtime(&provider, usage_registration_id(row).as_str());
						}
					}
				}
			}
		}
		subscriptions.retain(|candidate, _| {
			candidate.0 != key.0 || candidate.1 != key.1 || candidate.2 != key.2 || *candidate == key
		});
		let rows = subscriptions.entry(key).or_default();
		rows.retain(|row| {
			row.event != subscription.event
				|| row.phase != subscription.phase
				|| row.name != subscription.name
		});
		rows.push(subscription);
		if rows.last().is_some_and(|row| row.event == "provider_usage") {
			let fetchers = self.usage_fetchers.clone();
			let row = rows.last().expect("subscription was just inserted");
			let session = row.session.clone();
			for provider in row.providers.as_deref().unwrap_or_default() {
				fetchers.register_runtime(
					usage_registration_id(row),
					Arc::new(ExtensionUsageFetcher {
						provider:    ProviderId::from(provider.clone()),
						settings:    self.settings_for(&row.identity),
						identity:    Arc::clone(&row.identity),
						session:     session.clone(),
						dispatcher:  Arc::clone(&self.dispatcher),
						callback:    row.name.clone(),
						concurrency: row.concurrency,
						timeout:     row.timeout.unwrap_or(row.event_policy.timeout),
						next_id:     Arc::new(AtomicU64::new(1)),
					}),
				);
			}
		}
		self.provider_response_subscribed.store(
			subscriptions
				.values()
				.flatten()
				.any(|row| row.event == "provider_response" && row.phase == "observe"),
			Ordering::Release,
		);
		let mask = subscriptions
			.values()
			.flatten()
			.filter_map(|row| hook_event_id(row.event.as_str()))
			.fold(0_u128, |mask, event| mask | (1_u128 << event as u32));
		let fail_closed = subscriptions
			.values()
			.flatten()
			.filter(|row| {
				row.on_failure.unwrap_or(row.event_policy.on_failure) == HookFailurePolicy::Deny
			})
			.filter_map(|row| hook_event_id(row.event.as_str()))
			.fold(0_u128, |mask, event| mask | (1_u128 << event as u32));
		self.admission_gate.replace_masks(mask, fail_closed);
		Ok(())
	}

	fn enqueue_mcp(&self, session_generation: u64, delivery: McpQueuedDelivery) {
		{
			let mut queues = self.mcp_queues.lock();
			let queue = queues
				.entry(session_generation)
				.or_insert_with(|| McpDeliveryQueue {
					pending:         VecDeque::with_capacity(MCP_HOOK_QUEUE_CAPACITY),
					running_servers: BTreeSet::new(),
					dropped:         0,
				});
			if queue.push(delivery) {
				let dropped = queue.dropped;
				tracing::warn!(
					session_generation,
					dropped,
					"journal: dropped oldest MCP hook notification"
				);
				if let Some((telemetry, session)) = self.mcp_journal.read().clone() {
					let encoded = json!({
						"session_generation": session_generation,
						"dropped": dropped,
					})
					.to_string();
					tokio::task::spawn_blocking(move || {
						let occurred_at_ms = time::SystemTime::now()
							.duration_since(time::UNIX_EPOCH)
							.map_or(0, |elapsed| elapsed.as_millis().try_into().unwrap_or(u64::MAX));
						let _ = telemetry.append(
							session.as_str(),
							"mcp_notification_dropped",
							occurred_at_ms,
							encoded.as_bytes(),
						);
					});
				}
			}
		}
		self.schedule_mcp(session_generation);
	}

	fn schedule_mcp(&self, session_generation: u64) {
		loop {
			let delivery = {
				let mut queues = self.mcp_queues.lock();
				let Some(queue) = queues.get_mut(&session_generation) else {
					return;
				};
				let Some(index) = queue.pending.iter().position(|delivery| {
					!queue
						.running_servers
						.contains(&delivery.notification.server)
				}) else {
					return;
				};
				let delivery = queue
					.pending
					.remove(index)
					.expect("selected delivery exists");
				queue
					.running_servers
					.insert(delivery.notification.server.clone());
				delivery
			};
			let owner = self.clone();
			tokio::spawn(async move {
				let server = delivery.notification.server.clone();
				owner
					.clone()
					.deliver_mcp(session_generation, delivery)
					.await;
				{
					let mut queues = owner.mcp_queues.lock();
					if let Some(queue) = queues.get_mut(&session_generation) {
						queue.running_servers.remove(&server);
					}
				}
				owner.schedule_mcp(session_generation);
			});
		}
	}

	async fn deliver_mcp(self, session_generation: u64, delivery: McpQueuedDelivery) {
		for subscription in delivery.subscriptions {
			let notification = &delivery.notification;
			let mut arguments = JsonMap::new();
			arguments
				.insert(String::from("event"), JsonValue::String(String::from("mcp_notification")));
			arguments.insert(String::from("phase"), JsonValue::String(String::from("observe")));
			arguments.insert(String::from("name"), JsonValue::String(subscription.name.to_string()));
			arguments.insert(
				String::from("payload"),
				json!({
					"server": notification.server,
					"method": notification.method,
					"params": notification.params,
					"sequence": notification.sequence,
				}),
			);
			let _ = self
				.dispatcher
				.dispatch(Arc::clone(&subscription.identity), ControlDispatch {
					operation: sf!("omp.hooks.dispatch"),
					arguments,
					authority: ControlInvocationAuthority {
						invocation:        sf!(
							"mcp-notification:{}:{}",
							notification.server,
							notification.sequence
						),
						phase:             InvocationPhase::Open,
						session:           sf!("session-{session_generation}"),
						turn:              None,
						event:             Some(sf!("mcp_notification")),
						call:              None,
						device:            None,
						effects:           Box::new([]),
						place_kind:        sf!("host"),
						lifecycle:         LifecyclePhase::Active,
						roots:             Box::new([]),
						remote:            false,
						has_ui:            false,
						headless:          true,
						settings:          self.settings_for(&subscription.identity),
						secret_settings:   Box::new([]),
						data:              None,
						direct_filesystem: None,
					},
					policy: subscription.concurrency,
					deadline: EventDeadline {
						at: time::Instant::now()
							+ subscription
								.timeout
								.unwrap_or(subscription.event_policy.timeout),
					},
				})
				.await;
		}
	}

	/// Asks the session's Python `agent_settled` domain rows, in order. The
	/// first Continue is pending; later hooks see it as `pending_continuation`
	/// and may veto with Settle. A stale revision, failed call or timeout
	/// never vetoes. Awaited inline: nothing outlives the call.
	pub(crate) async fn dispatch_agent_settled(
		&self,
		session: &Str,
		session_generation: u64,
		payload: &JsonValue,
	) -> omp_contract::NativeReply {
		const EVENT: &str = "agent_settled";
		let rows = {
			let subscriptions = self.subscriptions.read();
			super::settled::settled_rows(
				subscriptions.values().flatten(),
				session.as_str(),
				session_generation,
			)
		};
		let submission_reset = payload
			.get("continuations_used")
			.and_then(JsonValue::as_u64)
			.is_some_and(|used| used == 0);
		super::settled::resolve_settled(
			&rows,
			&self.continuations,
			submission_reset,
			|row, pending| {
				let row = row.clone();
				let pending = pending.cloned();
				async move {
					let expected = <omp_contract::AgentSettledEvent as omp_contract::HookEvent>::REV;
					if u32::from(row.event_policy.revision) != expected {
						tracing::warn!(
							extension = %row.identity.extension,
							hook = %row.name,
							expected,
							declared = row.event_policy.revision,
							"agent_settled hook skipped: event revision mismatch"
						);
						return None;
					}
					let context = ControlRequestContext {
						connection: Arc::clone(&row.identity),
						request_id: 0,
						invocation: Some(ControlInvocationAuthority {
							invocation:        sf!("{EVENT}:{}", Ulid::generate()),
							phase:             InvocationPhase::EffectsAuthorized,
							session:           row.session.clone(),
							turn:              None,
							event:             Some(Str::new_static(EVENT)),
							call:              None,
							device:            None,
							effects:           Box::new([]),
							place_kind:        sf!("host"),
							lifecycle:         LifecyclePhase::Active,
							roots:             Box::new([]),
							remote:            false,
							has_ui:            false,
							headless:          true,
							settings:          self.settings_for(&row.identity),
							secret_settings:   Box::new([]),
							data:              None,
							direct_filesystem: None,
						}),
					};
					let mut callback = JsonMap::new();
					callback.insert("event".to_owned(), JsonValue::String(EVENT.to_owned()));
					callback.insert("phase".to_owned(), JsonValue::String("domain".to_owned()));
					callback.insert("name".to_owned(), JsonValue::String(row.name.to_string()));
					callback.insert("payload".to_owned(), payload.clone());
					if let Some(pending) = pending {
						let mut pending_obj = JsonMap::new();
						pending_obj
							.insert("prompt".to_owned(), JsonValue::String(pending.prompt.to_string()));
						pending_obj.insert(
							"label".to_owned(),
							pending
								.label
								.map(|label| JsonValue::String(label.to_string()))
								.unwrap_or(JsonValue::Null),
						);
						callback
							.insert("pending_continuation".to_owned(), JsonValue::Object(pending_obj));
					}
					self
						.callbacks
						.dispatch_provider_hook(
							Arc::clone(&row.identity),
							&context,
							EVENT,
							callback,
							row.concurrency,
							row.timeout.unwrap_or(row.event_policy.timeout),
						)
						.await
						.ok()
				}
			},
		)
		.await
	}

	async fn dispatch_provider_domain(
		&self,
		event: &'static str,
		provider: &ProviderId<str>,
		payload: JsonValue,
		fail_closed: bool,
	) -> Result<Vec<JsonValue>, ProviderHookError> {
		let mut rows = self
			.subscriptions
			.read()
			.values()
			.flat_map(|rows| rows.iter())
			.filter(|row| {
				row.event == event
					&& row.phase == "domain"
					&& row.providers.as_ref().is_none_or(|providers| {
						providers
							.iter()
							.any(|candidate| candidate.as_str() == provider.as_str())
					})
			})
			.cloned()
			.collect::<Vec<_>>();
		rows.sort_by(|left, right| {
			left
				.identity
				.layer
				.cmp(&right.identity.layer)
				.then_with(|| left.identity.tier.cmp(&right.identity.tier))
				.then_with(|| left.identity.extension.cmp(&right.identity.extension))
				.then_with(|| left.name.cmp(&right.name))
		});
		if rows.is_empty() {
			return Err(ProviderHookError::Unavailable);
		}
		let mut values = Vec::with_capacity(rows.len());
		for row in rows {
			let session = row.session.clone();
			let context = ControlRequestContext {
				connection: Arc::clone(&row.identity),
				request_id: 0,
				invocation: Some(ControlInvocationAuthority {
					invocation: sf!("{event}:{}", Ulid::generate()),
					phase: InvocationPhase::EffectsAuthorized,
					session,
					turn: None,
					event: Some(Str::new_static(event)),
					call: None,
					device: None,
					effects: Box::new([]),
					place_kind: sf!("host"),
					lifecycle: LifecyclePhase::Active,
					roots: Box::new([]),
					remote: false,
					has_ui: event == "provider_login",
					headless: event != "provider_login",
					settings: self.settings_for(&row.identity),
					secret_settings: Box::new([]),
					data: None,
					direct_filesystem: None,
				}),
			};
			let mut callback = JsonMap::new();
			callback.insert("event".to_owned(), JsonValue::String(event.to_owned()));
			callback.insert("phase".to_owned(), JsonValue::String("domain".to_owned()));
			callback.insert("name".to_owned(), JsonValue::String(row.name.to_string()));
			callback.insert("payload".to_owned(), payload.clone());
			match self
				.callbacks
				.dispatch_provider_hook(
					Arc::clone(&row.identity),
					&context,
					event,
					callback,
					row.concurrency,
					row.timeout.unwrap_or(row.event_policy.timeout),
				)
				.await
			{
				Ok(value) => values.push(value),
				Err(_) if fail_closed => return Err(ProviderHookError::Failed),
				Err(_) => {},
			}
		}
		if values.is_empty() {
			Err(if fail_closed {
				ProviderHookError::Failed
			} else {
				ProviderHookError::Unavailable
			})
		} else {
			Ok(values)
		}
	}

	async fn observe(&self, context: &ControlRequestContext, event: &str, payload: &JsonValue) {
		let scoped_provider = payload.get("provider").and_then(JsonValue::as_str);
		let mut rows = self
			.subscriptions
			.read()
			.values()
			.flat_map(|rows| rows.iter())
			.filter(|row| {
				row.event == event
					&& row.phase == "observe"
					&& row.identity.session_generation == context.connection.session_generation
					&& row.providers.as_ref().is_none_or(|providers| {
						scoped_provider.is_none_or(|provider| {
							providers
								.iter()
								.any(|candidate| candidate.as_str() == provider)
						})
					}) && lifecycle_hook_recipient(event, payload, row.identity.extension.as_str())
			})
			.cloned()
			.collect::<Vec<_>>();
		rows.sort_by(|left, right| {
			left
				.identity
				.layer
				.cmp(&right.identity.layer)
				.then_with(|| left.identity.tier.cmp(&right.identity.tier))
				.then_with(|| left.identity.extension.cmp(&right.identity.extension))
				.then_with(|| left.name.cmp(&right.name))
		});
		rows.truncate(OBSERVE_HANDLER_CAP);
		let deliveries = rows.into_iter().map(|row| {
			let mut callback = JsonMap::new();
			callback.insert(String::from("event"), JsonValue::String(event.to_owned()));
			callback.insert(String::from("phase"), JsonValue::String(String::from("observe")));
			callback.insert(String::from("name"), JsonValue::String(row.name.to_string()));
			callback.insert(String::from("payload"), payload.clone());
			async move {
				let _ = self
					.callbacks
					.dispatch(
						Arc::clone(&row.identity),
						context,
						"omp.hooks.dispatch",
						callback,
						row.concurrency,
						row.timeout.unwrap_or(row.event_policy.timeout),
						Some(row.event.clone()),
						None,
					)
					.await;
			}
		});
		let _ = futures::future::join_all(deliveries).await;
	}

	async fn compose(
		&self,
		context: &ControlRequestContext,
		arguments: &JsonMap<String, JsonValue>,
	) -> Result<JsonValue, ControlProtocolError> {
		require_active_invocation(context)?;
		let event = required_string(arguments, "event")?;
		let event_rev = required_u16(arguments, "event_rev")?;
		let policy = self.policies.read().get(&event).cloned().ok_or_else(|| {
			ControlProtocolError::new("UnknownEvent", format!("unknown hook event {event}"))
		})?;
		check_hook_event_revision(&event, event_rev, &policy)?;
		let mut payload = arguments.get("payload").cloned().unwrap_or(JsonValue::Null);
		let scoped_provider = payload.get("provider").and_then(JsonValue::as_str);
		let mut rows = self
			.subscriptions
			.read()
			.values()
			.flat_map(|rows| rows.iter())
			.filter(|row| {
				row.event == event
					&& row.phase != "observe"
					&& row.identity.session_generation == context.connection.session_generation
					&& row.providers.as_ref().is_none_or(|providers| {
						scoped_provider.is_none_or(|provider| {
							providers
								.iter()
								.any(|candidate| candidate.as_str() == provider)
						})
					}) && lifecycle_hook_recipient(
					event.as_str(),
					&payload,
					row.identity.extension.as_str(),
				)
			})
			.cloned()
			.collect::<Vec<_>>();
		rows.sort_by(|left, right| {
			hook_phase_rank(&left.phase)
				.cmp(&hook_phase_rank(&right.phase))
				.then_with(|| left.order.cmp(&right.order))
				.then_with(|| left.identity.layer.cmp(&right.identity.layer))
				.then_with(|| left.identity.tier.cmp(&right.identity.tier))
				.then_with(|| left.identity.extension.cmp(&right.identity.extension))
				.then_with(|| left.name.cmp(&right.name))
		});
		let mut modification: Option<JsonMap<String, JsonValue>> = None;
		let mut approvals = Vec::new();
		for row in rows {
			let mut callback = JsonMap::new();
			callback.insert(String::from("event"), JsonValue::String(event.to_string()));
			callback.insert(String::from("phase"), JsonValue::String(row.phase.to_string()));
			callback.insert(String::from("name"), JsonValue::String(row.name.to_string()));
			callback.insert(String::from("payload"), payload.clone());
			let result = self
				.callbacks
				.dispatch(
					Arc::clone(&row.identity),
					context,
					"omp.hooks.dispatch",
					callback,
					row.concurrency,
					self.callback_timeout(event.as_str(), &row, &policy),
					Some(event.clone()),
					None,
				)
				.await;
			let result = match result {
				Ok(result) => result,
				Err(error) => {
					match hook_callback_failure(row.on_failure.unwrap_or(policy.on_failure), error) {
						None => continue,
						Some(decision) => return Ok(decision),
					}
				},
			};
			let result = if row.phase == "domain" {
				match domain_reply_decision(result)? {
					Some(decision) => decision,
					None => continue,
				}
			} else {
				result
			};
			let Some(decision) = result.as_object() else {
				let error = ControlProtocolError::new(
					"HookContractError",
					"hook callback returned a non-object decision",
				);
				match hook_callback_failure(row.on_failure.unwrap_or(policy.on_failure), error) {
					None => continue,
					Some(decision) => return Ok(decision),
				}
			};
			let kind = decision.get("kind").and_then(JsonValue::as_str);
			if !hook_decision_is_legal(row.phase.as_str(), kind) {
				let error = ControlProtocolError::new(
					"HookContractError",
					"hook callback returned a decision illegal in its phase",
				);
				match hook_callback_failure(row.on_failure.unwrap_or(policy.on_failure), error) {
					None => continue,
					Some(decision) => return Ok(decision),
				}
			}
			match kind {
				Some("deny") => return Ok(result),
				Some("require_approval") => {
					let Some(spec) = decision.get("spec").cloned() else {
						let error = ControlProtocolError::new(
							"HookContractError",
							"approval decision omitted its specification",
						);
						match hook_callback_failure(row.on_failure.unwrap_or(policy.on_failure), error) {
							None => continue,
							Some(decision) => return Ok(decision),
						}
					};
					approvals.push(approval_spec_with_provenance(
						spec,
						row.name.as_str(),
						row.identity.extension.as_str(),
						row.identity.host_generation,
						row.identity.session_generation,
					));
				},
				Some("allow" | "defer") => {},
				Some("modify") => {
					if let Err(error) = compose_hook_modify(
						event.as_str(),
						&policy,
						&mut payload,
						&mut modification,
						decision,
					) {
						match hook_callback_failure(row.on_failure.unwrap_or(policy.on_failure), error) {
							None => continue,
							Some(decision) => return Ok(decision),
						}
					}
				},
				_ => unreachable!("phase legality checked the closed decision vocabulary"),
			}
		}
		if approvals.is_empty() {
			Ok(modification.map_or_else(|| policy.default.clone(), JsonValue::Object))
		} else {
			Ok(json!({
				"kind": "require_approvals",
				"specs": approvals,
				"effective": payload,
			}))
		}
	}
}

fn hook_event_id(event: &str) -> Option<HookEventId> {
	let mut name = String::with_capacity("HOOK_EVENT_".len() + event.len());
	name.push_str("HOOK_EVENT_");
	name.extend(
		event
			.chars()
			.map(|character| character.to_ascii_uppercase()),
	);
	HookEventId::from_str_name(&name)
}

fn hook_event_name(event: HookEventId) -> Option<String> {
	event
		.as_str_name()
		.strip_prefix("HOOK_EVENT_")
		.map(str::to_ascii_lowercase)
}

fn hydrate_tool_call_bash(payload: &mut JsonValue) -> bool {
	let Some(object) = payload.as_object_mut() else {
		return false;
	};
	let Some(wire) = object.remove("__omp_bash_proto") else {
		return true;
	};
	if wire.is_null() {
		return true;
	}
	let Some(encoded) = wire
		.as_object()
		.and_then(|wire| wire.get("$bytes"))
		.and_then(JsonValue::as_str)
	else {
		return false;
	};
	let Ok(bytes) = omp_core::base64::decode(encoded).into_vec() else {
		return false;
	};
	let Ok(ir) = omp_proto::policy::v1::BashIr::decode(bytes.as_slice()) else {
		return false;
	};
	let source = ir.source.clone();
	object.insert(String::from("bash"), crate::policy::bash_ir_json(&ir, &source));
	true
}

/// Admits a hook decision only when the dispatched event revision equals the
/// revision the event policy was declared with.
fn check_hook_event_revision(
	event: &str,
	event_rev: u16,
	policy: &HookEventPolicy,
) -> Result<(), ControlProtocolError> {
	if event_rev == policy.revision {
		return Ok(());
	}
	tracing::warn!(
		event = %event,
		event_rev,
		policy_rev = policy.revision,
		"hook decision rejected: event revision mismatch"
	);
	Err(ControlProtocolError::new(
		"HookContractError",
		format!("hook event revision mismatch: expected {}, got {event_rev}", policy.revision),
	))
}

fn gate_decision_from_json(value: JsonValue, mut payload: JsonValue) -> GateDecision {
	let Some(decision) = value.as_object() else {
		return GateDecision::Deny(sf!("hook composer returned a non-object decision"));
	};
	match decision.get("kind").and_then(JsonValue::as_str) {
		Some("allow") => GateDecision::Allow,
		Some("defer") => GateDecision::Defer,
		Some("modify") => {
			let Some(effective) = payload.as_object_mut() else {
				return GateDecision::Deny(sf!("hook modification requires an object payload"));
			};
			for (field, value) in decision
				.get("patch")
				.and_then(JsonValue::as_object)
				.into_iter()
				.flatten()
			{
				effective.insert(field.clone(), value.clone());
			}
			for field in decision
				.get("unset")
				.and_then(JsonValue::as_array)
				.into_iter()
				.flatten()
				.filter_map(JsonValue::as_str)
			{
				effective.remove(field);
			}
			match serde_json::to_vec(&payload) {
				Ok(args) => GateDecision::Modify(HookPatch {
					target: None,
					args:   Some(bytes::Bytes::from(args)),
				}),
				Err(error) => deny_payload_encode(error),
			}
		},
		Some("deny") => {
			let reason = decision
				.get("reason")
				.and_then(JsonValue::as_str)
				.map_or_else(|| sf!("hook policy denied operation"), Str::from);
			let code = decision
				.get("code")
				.and_then(JsonValue::as_str)
				.map(Str::from);
			let decision_id = decision
				.get("decision_id")
				.and_then(JsonValue::as_str)
				.map_or_else(|| Str::from(Ulid::generate().to_string()), Str::from);
			let rules = decision
				.get("rules")
				.and_then(JsonValue::as_array)
				.into_iter()
				.flatten()
				.filter_map(|rule| {
					rule
						.as_object()
						.and_then(|rule| rule.get("id"))
						.and_then(JsonValue::as_str)
						.map(Str::from)
				})
				.collect::<Vec<_>>();
			GateDecision::DenyPolicy(Arc::new(omp_tool::PolicyDenied {
				reason,
				code,
				decision_id,
				rules: rules.into(),
			}))
		},
		Some("require_approval") => {
			match decision
				.get("spec")
				.cloned()
				.ok_or_else(|| {
					ControlProtocolError::new(
						"HookContractError",
						"approval decision omitted its specification",
					)
				})
				.and_then(crate::policy::approval_spec)
			{
				Ok(spec) => GateDecision::RequireApproval(spec),
				Err(error) => GateDecision::Deny(error.message),
			}
		},
		Some("require_approvals") => {
			let specs = decision
				.get("specs")
				.and_then(JsonValue::as_array)
				.ok_or_else(|| {
					ControlProtocolError::new(
						"HookContractError",
						"composed approval decision omitted its specifications",
					)
				})
				.and_then(|specs| {
					specs
						.iter()
						.cloned()
						.map(crate::policy::approval_spec)
						.collect::<Result<Vec<_>, _>>()
				});
			match specs {
				Ok(specs) if !specs.is_empty() => {
					let patch = decision
						.get("effective")
						.map(serde_json::to_vec)
						.transpose()
						.map(|args| args.map(bytes::Bytes::from))
						.map(|args| args.map(|args| HookPatch { target: None, args: Some(args) }));
					match patch {
						Ok(patch) => GateDecision::RequireApprovals { specs, patch },
						Err(error) => deny_payload_encode(error),
					}
				},
				Ok(_) => GateDecision::Deny(sf!("composed approval decision was empty")),
				Err(error) => GateDecision::Deny(error.message),
			}
		},
		_ => GateDecision::Deny(sf!("hook composer returned an illegal admission decision")),
	}
}

/// Creates a deny decision, rendering the encode failure once at this
/// model-facing fault boundary.
fn deny_payload_encode(cause: impl std::fmt::Display) -> GateDecision {
	GateDecision::Deny(sf!("could not encode effective hook payload: {cause}"))
}

impl McpNotificationSink for HookControlFactory {
	fn interested(&self, server: &str, method: &str) -> bool {
		self
			.subscriptions
			.read()
			.values()
			.flat_map(|rows| rows.iter())
			.any(|row| {
				row.event == "mcp_notification"
					&& row.phase == "observe"
					&& mcp_subscription_matches(row, server, method)
			})
	}

	fn offer(&self, notification: McpHookNotification) {
		let rows = self
			.subscriptions
			.read()
			.values()
			.flat_map(|rows| rows.iter())
			.filter(|row| {
				row.event == "mcp_notification"
					&& row.phase == "observe"
					&& mcp_subscription_matches(
						row,
						notification.server.as_str(),
						notification.method.as_str(),
					)
			})
			.cloned()
			.collect::<Vec<_>>();
		if rows.is_empty() {
			return;
		}
		let mut by_session = BTreeMap::<u64, Vec<HookSubscription>>::new();
		for row in rows {
			by_session
				.entry(row.identity.session_generation)
				.or_default()
				.push(row);
		}
		for (session_generation, subscriptions) in by_session {
			self.enqueue_mcp(session_generation, McpQueuedDelivery {
				notification: notification.clone(),
				subscriptions,
			});
		}
	}
}

impl ProviderHookObserver for HookControlFactory {
	fn provider_login_subscribed(&self, provider: &ProviderId<str>) -> bool {
		provider_hook_subscribed(self, "provider_login", provider)
	}

	fn provider_login<'a>(
		&'a self,
		request: ProviderLoginHookRequest,
	) -> std::pin::Pin<
		Box<dyn Future<Output = Result<ProviderHookCredential, ProviderHookError>> + Send + 'a>,
	> {
		Box::pin(async move {
			let method: &'static str = request.method.into();
			let mut values = self
				.dispatch_provider_domain(
					"provider_login",
					&request.provider,
					json!({
						"provider": request.provider,
						"method": method.replace('-', "_"),
						"ui": {},
					}),
					true,
				)
				.await?;
			parse_provider_credential(values.pop().ok_or(ProviderHookError::Failed)?)
		})
	}

	fn provider_refresh_subscribed(&self, provider: &ProviderId<str>) -> bool {
		provider_hook_subscribed(self, "provider_refresh", provider)
	}

	fn provider_refresh<'a>(
		&'a self,
		request: ProviderRefreshHookRequest,
	) -> std::pin::Pin<
		Box<dyn Future<Output = Result<ProviderHookCredential, ProviderHookError>> + Send + 'a>,
	> {
		Box::pin(async move {
			let mut values = self
				.dispatch_provider_domain(
					"provider_refresh",
					&request.provider,
					json!({
						"provider": request.provider,
						"identity": request.identity,
						"refresh_token": {
							"$bytes": omp_core::base64::encode(
								request.refresh_token.expose_secret().as_bytes()
							),
						},
						"expires_at_ms": request.expires_at_ms,
						"props": request.props,
						"reason": request.reason.to_string(),
					}),
					true,
				)
				.await?;
			parse_provider_credential(values.pop().ok_or(ProviderHookError::Failed)?)
		})
	}

	fn provider_sign_subscribed(&self, provider: &ProviderId<str>) -> bool {
		provider_hook_subscribed(self, "provider_sign", provider)
	}

	fn provider_sign<'a>(
		&'a self,
		request: ProviderSignHookRequest,
	) -> std::pin::Pin<
		Box<dyn Future<Output = Result<ProviderSignature, ProviderHookError>> + Send + 'a>,
	> {
		Box::pin(async move {
			let provider = request.provider.clone();
			let headers = request
				.headers
				.iter()
				.map(|header| (header.name.to_string(), JsonValue::String(header.value.to_string())))
				.collect::<JsonMap<_, _>>();
			let mut values = self
				.dispatch_provider_domain(
					"provider_sign",
					&provider,
					json!({
						"provider": request.provider,
						"route": request.route,
						"method": request.method,
						"url": request.url,
						"headers": headers,
						"body_sha256": {
							"$bytes": omp_core::base64::encode(&request.body_sha256),
						},
						"signer": {},
					}),
					true,
				)
				.await?;
			parse_provider_signature(values.pop().ok_or(ProviderHookError::Failed)?)
		})
	}

	fn models_discover_subscribed(&self, provider: &ProviderId<str>) -> bool {
		provider_hook_subscribed(self, "models_discover", provider)
	}

	fn models_discover<'a>(
		&'a self,
		request: ModelsDiscoverHookRequest,
	) -> std::pin::Pin<
		Box<dyn Future<Output = Result<ModelsDiscoverHookPage, ProviderHookError>> + Send + 'a>,
	> {
		Box::pin(async move {
			let values = self
				.dispatch_provider_domain(
					"models_discover",
					&request.provider,
					json!({
						"provider": request.provider,
						"route": request.route,
						"cursor": request.cursor,
						"page_size": request.page_size,
						"trigger": request.trigger,
					}),
					false,
				)
				.await?;
			let mut pages = values
				.into_iter()
				.map(parse_discovery_page)
				.collect::<Result<Vec<_>, _>>()?;
			let Some(mut page) = pages.pop() else {
				return Err(ProviderHookError::Unavailable);
			};
			for prior in pages {
				let ids = page
					.models
					.iter()
					.filter_map(|model| model.get("id").and_then(JsonValue::as_str))
					.map(Str::new)
					.collect::<BTreeSet<_>>();
				let retained = prior
					.models
					.into_vec()
					.into_iter()
					.filter(|model| {
						model
							.get("id")
							.and_then(JsonValue::as_str)
							.is_some_and(|id| ids.contains(id))
					})
					.collect::<Vec<_>>();
				page.models = retained.into_boxed_slice();
				page.authoritative |= prior.authoritative;
			}
			Ok(page)
		})
	}
}

fn provider_hook_subscribed(
	owner: &HookControlFactory,
	event: &str,
	provider: &ProviderId<str>,
) -> bool {
	owner.subscriptions.read().values().flatten().any(|row| {
		row.event == event
			&& row.phase == "domain"
			&& row.providers.as_ref().is_none_or(|providers| {
				providers
					.iter()
					.any(|candidate| candidate.as_str() == provider.as_str())
			})
	})
}

fn parse_provider_credential(
	value: JsonValue,
) -> Result<ProviderHookCredential, ProviderHookError> {
	let object = value.as_object().ok_or(ProviderHookError::InvalidResult)?;
	let kind = object
		.get("kind")
		.and_then(JsonValue::as_str)
		.filter(|kind| matches!(*kind, "api_key" | "bearer" | "oauth" | "aws" | "session"))
		.ok_or(ProviderHookError::InvalidResult)?;
	let secret = parse_hook_secret(
		object
			.get("secret")
			.ok_or(ProviderHookError::InvalidResult)?,
	)?;
	let refresh_token = object
		.get("refresh_token")
		.filter(|value| !value.is_null())
		.map(parse_hook_secret)
		.transpose()?;
	let props = object
		.get("props")
		.and_then(JsonValue::as_object)
		.cloned()
		.unwrap_or_default();
	if props.values().any(|value| {
		!matches!(value, JsonValue::Bool(_) | JsonValue::Number(_) | JsonValue::String(_))
	}) {
		return Err(ProviderHookError::InvalidResult);
	}
	Ok(ProviderHookCredential {
		kind: Str::new(kind),
		secret,
		refresh_token,
		expires_at_ms: object.get("expires_at_ms").and_then(JsonValue::as_u64),
		identity: object
			.get("identity")
			.and_then(JsonValue::as_str)
			.map(Str::new),
		props,
	})
}

fn parse_hook_secret(value: &JsonValue) -> Result<SecretString, ProviderHookError> {
	let encoded = value
		.as_object()
		.and_then(|object| object.get("$bytes"))
		.and_then(JsonValue::as_str)
		.ok_or(ProviderHookError::InvalidResult)?;
	let bytes = omp_core::base64::decode(encoded)
		.into_vec()
		.map_err(|_| ProviderHookError::InvalidResult)?;
	let value = String::from_utf8(bytes).map_err(|_| ProviderHookError::InvalidResult)?;
	if value.is_empty() {
		return Err(ProviderHookError::InvalidResult);
	}
	Ok(SecretString::from(value))
}

fn parse_provider_signature(value: JsonValue) -> Result<ProviderSignature, ProviderHookError> {
	let object = value.as_object().ok_or(ProviderHookError::InvalidResult)?;
	let parse = |field: &str| {
		object
			.get(field)
			.and_then(JsonValue::as_object)
			.into_iter()
			.flatten()
			.map(|(name, value)| {
				let value = value
					.as_str()
					.filter(|value| !value.is_empty())
					.ok_or(ProviderHookError::InvalidResult)?;
				Ok((Str::new(name), SecretString::from(value)))
			})
			.collect::<Result<Vec<_>, ProviderHookError>>()
			.map(Vec::into_boxed_slice)
	};
	Ok(ProviderSignature { headers: parse("headers")?, query: parse("query")? })
}

fn parse_discovery_page(value: JsonValue) -> Result<ModelsDiscoverHookPage, ProviderHookError> {
	if let JsonValue::Array(models) = value {
		return Ok(ModelsDiscoverHookPage {
			models:        models.into_boxed_slice(),
			next_cursor:   None,
			authoritative: false,
		});
	}
	let object = value.as_object().ok_or(ProviderHookError::InvalidResult)?;
	let models = object
		.get("models")
		.and_then(JsonValue::as_array)
		.cloned()
		.ok_or(ProviderHookError::InvalidResult)?;
	if models
		.iter()
		.any(|model| model.get("id").and_then(JsonValue::as_str).is_none())
	{
		return Err(ProviderHookError::InvalidResult);
	}
	Ok(ModelsDiscoverHookPage {
		models:        models.into_boxed_slice(),
		next_cursor:   object
			.get("next_cursor")
			.and_then(JsonValue::as_str)
			.map(Str::new),
		authoritative: object
			.get("authoritative")
			.and_then(JsonValue::as_bool)
			.unwrap_or(false),
	})
}

impl ProviderResponseObserver for HookControlFactory {
	fn before_request_subscribed(&self) -> bool {
		self
			.admission_gate
			.subscribed(HookEventId::HookEventBeforeRequest)
	}

	fn before_request<'a>(
		&'a self,
		draft: &'a BeforeRequestDraft,
	) -> std::pin::Pin<
		Box<dyn Future<Output = Result<BeforeRequestMutation, BeforeRequestDenied>> + Send + 'a>,
	> {
		let owner = self.clone();
		Box::pin(async move {
			let headers = draft
				.headers
				.iter()
				.map(|header| (header.name.to_string(), JsonValue::String(header.value.to_string())))
				.collect::<JsonMap<_, _>>();
			let payload = json!({
				"provider": draft.provider,
				"route": draft.route,
				"model": draft.model,
				"operation": draft.operation.to_string(),
				"scalars": draft.scalars,
				"headers": headers,
				"intents": draft.intents,
				"message_count": draft.message_count,
				"approx_prompt_tokens": draft.approx_prompt_tokens,
			});
			let requested = serde_json::to_vec(&payload)
				.map(bytes::Bytes::from)
				.map_err(|_| BeforeRequestDenied {
					reason: sf!("provider request hook payload could not be encoded"),
					code:   Some(sf!("HookContractError")),
				})?;
			let effective = match owner
				.admission_gate
				.gate(
					HookEventId::HookEventBeforeRequest,
					GateEvent::new(sf!("before_request"), requested.clone()),
				)
				.await
			{
				GateOutcome::Allow { event, .. } => {
					if event.effective_args == requested {
						return Ok(BeforeRequestMutation::default());
					}
					serde_json::from_slice::<JsonValue>(&event.effective_args).map_err(|_| {
						BeforeRequestDenied {
							reason: sf!("provider request hook payload could not be decoded"),
							code:   Some(sf!("HookContractError")),
						}
					})?
				},
				GateOutcome::Deny { reason, .. } => {
					return Err(BeforeRequestDenied { reason, code: None });
				},
				GateOutcome::Approval { .. } => {
					return Err(BeforeRequestDenied {
						reason: sf!("provider request hook requested unsupported approval"),
						code:   Some(sf!("HookContractError")),
					});
				},
			};
			let effective = effective.as_object().ok_or_else(|| BeforeRequestDenied {
				reason: sf!("provider request hook returned a non-object payload"),
				code:   Some(sf!("HookContractError")),
			})?;
			let body = effective
				.get("body")
				.and_then(JsonValue::as_object)
				.cloned()
				.unwrap_or_default();
			let headers = effective
				.get("headers")
				.and_then(JsonValue::as_object)
				.map(|headers| {
					headers
						.iter()
						.filter_map(|(name, value)| {
							(value.is_null() || value.is_string())
								.then(|| (Str::new(name), value.as_str().map(Str::new)))
						})
						.collect::<Vec<_>>()
						.into_boxed_slice()
				})
				.unwrap_or_default();
			let intents = effective
				.get("intents")
				.and_then(JsonValue::as_array)
				.map(|values| values.clone().into_boxed_slice());
			let timeout = effective
				.get("timeout")
				.and_then(|value| {
					value
						.as_str()
						.or_else(|| value.get("$duration").and_then(JsonValue::as_str))
				})
				.and_then(|value| value.parse::<omp_core::Duration>().ok())
				.and_then(|value| value.to_std().ok());
			Ok(BeforeRequestMutation { body, headers, intents, timeout })
		})
	}

	fn credential_disabled_subscribed(&self) -> bool {
		self
			.admission_gate
			.subscribed(HookEventId::HookEventCredentialDisabled)
	}

	fn observe_credential_disabled(&self, observation: CredentialDisabledObservation) {
		let subscriptions = self
			.subscriptions
			.read()
			.values()
			.flatten()
			.filter(|row| {
				row.event == "credential_disabled"
					&& row.phase == "observe"
					&& row.providers.as_ref().is_none_or(|providers| {
						providers
							.iter()
							.any(|provider| provider == observation.provider.as_str())
					})
			})
			.cloned()
			.collect::<Vec<_>>();
		if subscriptions.is_empty() {
			return;
		}
		let owner = self.clone();
		tokio::spawn(async move {
			for subscription in subscriptions {
				let mut arguments = JsonMap::new();
				arguments.insert(
					String::from("event"),
					JsonValue::String(String::from("credential_disabled")),
				);
				arguments.insert(String::from("phase"), JsonValue::String(String::from("observe")));
				arguments
					.insert(String::from("name"), JsonValue::String(subscription.name.to_string()));
				arguments.insert(
					String::from("payload"),
					json!({
						"provider": observation.provider,
						"account": observation.account.as_ref().map(ToString::to_string),
						"cause": observation.cause,
					}),
				);
				let session_generation = subscription.identity.session_generation;
				let _ = owner
					.dispatcher
					.dispatch(Arc::clone(&subscription.identity), ControlDispatch {
						operation: sf!("omp.hooks.dispatch"),
						arguments,
						authority: ControlInvocationAuthority {
							invocation:        sf!("credential-disabled:{}", observation.provider),
							phase:             InvocationPhase::Open,
							session:           sf!("session-{session_generation}"),
							turn:              None,
							event:             Some(sf!("credential_disabled")),
							call:              None,
							device:            None,
							effects:           Box::new([]),
							place_kind:        sf!("host"),
							lifecycle:         LifecyclePhase::Active,
							roots:             Box::new([]),
							remote:            false,
							has_ui:            false,
							headless:          true,
							settings:          owner.settings_for(&subscription.identity),
							secret_settings:   Box::new([]),
							data:              None,
							direct_filesystem: None,
						},
						policy: subscription.concurrency,
						deadline: EventDeadline {
							at: time::Instant::now()
								+ subscription
									.timeout
									.unwrap_or(subscription.event_policy.timeout),
						},
					})
					.await;
			}
		});
	}

	fn subscribed(&self) -> bool {
		self.provider_response_subscribed.load(Ordering::Relaxed)
	}

	fn observe(&self, observation: ProviderResponseObservation) {
		let subscriptions = self
			.subscriptions
			.read()
			.values()
			.flatten()
			.filter(|row| {
				row.event == "provider_response"
					&& row.phase == "observe"
					&& row.providers.as_ref().is_none_or(|providers| {
						providers
							.iter()
							.any(|provider| provider == observation.provider.as_str())
					})
			})
			.cloned()
			.collect::<Vec<_>>();
		if subscriptions.is_empty() {
			return;
		}
		let owner = self.clone();
		tokio::spawn(async move {
			for subscription in subscriptions {
				let headers = observation
					.headers
					.iter()
					.map(|(name, value)| (name.to_string(), JsonValue::String(value.to_string())))
					.collect::<JsonMap<_, _>>();
				let mut arguments = JsonMap::new();
				arguments
					.insert(String::from("event"), JsonValue::String(String::from("provider_response")));
				arguments.insert(String::from("phase"), JsonValue::String(String::from("observe")));
				arguments
					.insert(String::from("name"), JsonValue::String(subscription.name.to_string()));
				arguments.insert(
					String::from("payload"),
					json!({
						"provider": observation.provider,
						"model": {
							"provider": observation.provider,
							"api": observation.api,
							"model": observation.model,
						},
						"status": observation.status,
						"headers": headers,
						"request_id": observation.request_id,
					}),
				);
				let _ = owner
					.dispatcher
					.dispatch(Arc::clone(&subscription.identity), ControlDispatch {
						operation: sf!("omp.hooks.dispatch"),
						arguments,
						authority: ControlInvocationAuthority {
							invocation:        sf!(
								"provider-response:{}:{}",
								observation.provider,
								observation.status
							),
							phase:             InvocationPhase::Open,
							session:           sf!("session-{}", subscription.identity.session_generation),
							turn:              None,
							event:             Some(sf!("provider_response")),
							call:              None,
							device:            None,
							effects:           Box::new([]),
							place_kind:        sf!("host"),
							lifecycle:         LifecyclePhase::Active,
							roots:             Box::new([]),
							remote:            false,
							has_ui:            false,
							headless:          true,
							settings:          owner.settings_for(&subscription.identity),
							secret_settings:   Box::new([]),
							data:              None,
							direct_filesystem: None,
						},
						policy: subscription.concurrency,
						deadline: EventDeadline {
							at: time::Instant::now()
								+ subscription
									.timeout
									.unwrap_or(subscription.event_policy.timeout),
						},
					})
					.await;
			}
		});
	}
}

fn mcp_subscription_matches(subscription: &HookSubscription, server: &str, method: &str) -> bool {
	mcp_filter_matches(subscription.servers.as_deref(), &subscription.method_globs, server, method)
}

fn mcp_filter_matches(
	servers: Option<&[Str]>,
	method_globs: &[Str],
	server: &str,
	method: &str,
) -> bool {
	let server_matches =
		servers.is_none_or(|servers| servers.iter().any(|candidate| candidate == server));
	let method_matches = method_globs.is_empty()
		|| method_globs
			.iter()
			.any(|pattern| anchored_glob_matches(pattern, method));
	server_matches && method_matches
}

fn anchored_glob_matches(pattern: &str, value: &str) -> bool {
	let pattern = pattern.as_bytes();
	let value = value.as_bytes();
	let mut pattern_index = 0;
	let mut value_index = 0;
	let mut star = None;
	let mut retry_value = 0;
	while value_index < value.len() {
		if pattern_index < pattern.len()
			&& (pattern[pattern_index] == b'?' || pattern[pattern_index] == value[value_index])
		{
			pattern_index += 1;
			value_index += 1;
		} else if pattern_index < pattern.len() && pattern[pattern_index] == b'*' {
			star = Some(pattern_index);
			pattern_index += 1;
			retry_value = value_index;
		} else if let Some(star_index) = star {
			pattern_index = star_index + 1;
			retry_value += 1;
			value_index = retry_value;
		} else {
			return false;
		}
	}
	while pattern_index < pattern.len() && pattern[pattern_index] == b'*' {
		pattern_index += 1;
	}
	pattern_index == pattern.len()
}

fn hook_callback_failure(
	policy: HookFailurePolicy,
	error: ControlProtocolError,
) -> Option<JsonValue> {
	(policy == HookFailurePolicy::Deny).then(|| {
		json!({
			"kind": "deny",
			"reason": error.message.as_str(),
			"fatal": false,
			"code": error.code.as_str(),
		})
	})
}

fn hook_decision_is_legal(phase: &str, kind: Option<&str>) -> bool {
	matches!(
		(phase, kind),
		("precheck", Some("deny" | "defer"))
			| ("transform", Some("modify" | "defer"))
			| ("review", Some("allow" | "deny" | "defer"))
			| ("approval", Some("allow" | "deny" | "defer" | "require_approval"))
			| ("domain", Some("allow" | "deny" | "defer" | "modify"))
	)
}

fn approval_spec_with_provenance(
	mut spec: JsonValue,
	hook: &str,
	extension: &str,
	host_generation: u64,
	session_generation: u64,
) -> JsonValue {
	if let Some(object) = spec.as_object_mut() {
		let evidence = object
			.entry(String::from("evidence"))
			.or_insert_with(|| JsonValue::Array(Vec::new()));
		if !evidence.is_array() {
			*evidence = JsonValue::Array(Vec::new());
		}
		let evidence = evidence.as_array_mut().expect("normalized to array");
		evidence.push(JsonValue::String(format!(
			"hook={hook} extension={extension} host_generation={host_generation} \
			 session_generation={session_generation}",
		)));
	}
	spec
}

/// Lifts a domain handler's raw return (Python returns the dataclass itself:
/// `ContextPatch`, `CustomSummary`, … or `None`) into the five-arm decision
/// vocabulary the composer folds: `None` contributes nothing, a bare object
/// is a transform whose fields patch the effective payload, and an object
/// already spelled as a decision passes through.
fn domain_reply_decision(result: JsonValue) -> Result<Option<JsonValue>, ControlProtocolError> {
	match result {
		JsonValue::Null => Ok(None),
		JsonValue::Object(object) if object.get("kind").is_some_and(JsonValue::is_string) => {
			Ok(Some(JsonValue::Object(object)))
		},
		JsonValue::Object(object) => Ok(Some(json!({"kind": "modify", "patch": object}))),
		_ => Err(ControlProtocolError::new(
			"HookContractError",
			"domain hook callback returned neither an object nor None",
		)),
	}
}

fn hook_phase_rank(phase: &str) -> u8 {
	match phase {
		"precheck" => 0,
		"transform" => 1,
		"review" => 2,
		"approval" => 3,
		"observe" => 4,
		_ => 5,
	}
}

fn lifecycle_hook_recipient(event: &str, payload: &JsonValue, extension: &str) -> bool {
	!matches!(event, "extension_load" | "extension_unload")
		|| payload
			.get("extension")
			.and_then(JsonValue::as_str)
			.is_none_or(|subject| subject != extension)
}

fn compose_hook_modify(
	event: &str,
	policy: &HookEventPolicy,
	payload: &mut JsonValue,
	modification: &mut Option<JsonMap<String, JsonValue>>,
	decision: &JsonMap<String, JsonValue>,
) -> Result<(), ControlProtocolError> {
	let output = modification.get_or_insert_with(|| {
		JsonMap::from_iter([(String::from("kind"), JsonValue::String(String::from("modify")))])
	});
	if let Some(reason) = decision.get("reason").filter(|value| !value.is_null()) {
		output.insert(String::from("reason"), reason.clone());
	}
	let mut patch = decision
		.get("patch")
		.and_then(JsonValue::as_object)
		.cloned()
		.unwrap_or_default();
	let mut unset = decision
		.get("unset")
		.and_then(JsonValue::as_array)
		.cloned()
		.unwrap_or_default();
	let payload_object = payload.as_object_mut().ok_or_else(|| {
		ControlProtocolError::new("HookContractError", "hook modification requires an object payload")
	})?;
	if event == "tool_call" {
		let mut args = decision
			.get("args")
			.and_then(JsonValue::as_object)
			.cloned()
			.or_else(|| {
				payload_object
					.get("args")
					.and_then(JsonValue::as_object)
					.cloned()
			})
			.unwrap_or_default();
		let mut args_changed = decision.get("args").is_some_and(JsonValue::is_object);
		patch.retain(|field, value| {
			if policy.composition.contains_key(field.as_str()) {
				true
			} else {
				args.insert(field.clone(), value.clone());
				args_changed = true;
				false
			}
		});
		unset.retain(|field| {
			let Some(field) = field.as_str() else {
				return true;
			};
			if policy.composition.contains_key(field) {
				true
			} else {
				args.remove(field);
				args_changed = true;
				false
			}
		});
		if args_changed {
			patch.insert(String::from("args"), JsonValue::Object(args));
		}
	} else if let Some(args) = decision.get("args").filter(|value| !value.is_null()) {
		patch.insert(String::from("args"), args.clone());
	}
	if let Some(target) = decision.get("target").filter(|value| !value.is_null()) {
		patch.insert(String::from("target"), target.clone());
	}
	let output_patch = output
		.entry(String::from("patch"))
		.or_insert_with(|| JsonValue::Object(JsonMap::new()))
		.as_object_mut()
		.expect("host-created hook patch is an object");
	for (field, value) in patch {
		let composed = match policy
			.composition
			.get(field.as_str())
			.copied()
			.unwrap_or(HookFieldComposition::Replace)
		{
			HookFieldComposition::Replace => value,
			HookFieldComposition::Append => {
				let mut current = payload_object
					.get(&field)
					.and_then(JsonValue::as_array)
					.cloned()
					.unwrap_or_default();
				let appended = value.as_array().ok_or_else(|| {
					ControlProtocolError::new(
						"HookContractError",
						format!("append-composed hook field {field} must be an array"),
					)
				})?;
				current.extend(appended.iter().cloned());
				JsonValue::Array(current)
			},
			HookFieldComposition::Intersect => {
				let current = payload_object
					.get(&field)
					.and_then(JsonValue::as_array)
					.cloned()
					.unwrap_or_default();
				let requested = value.as_array().ok_or_else(|| {
					ControlProtocolError::new(
						"HookContractError",
						format!("intersect-composed hook field {field} must be an array"),
					)
				})?;
				JsonValue::Array(if payload_object.get(&field).is_none_or(JsonValue::is_null) {
					requested.clone()
				} else {
					current
						.into_iter()
						.filter(|item| requested.contains(item))
						.collect()
				})
			},
		};
		payload_object.insert(field.clone(), composed.clone());
		output_patch.insert(field, composed);
	}
	for field in unset {
		let field = field.as_str().ok_or_else(|| {
			ControlProtocolError::new("HookContractError", "hook unset fields must be strings")
		})?;
		payload_object.remove(field);
		output_patch.remove(field);
	}
	Ok(())
}

impl ControlAuthorityFactory for HookControlFactory {
	fn bind(
		&self,
		identity: Arc<ControlConnectionIdentity>,
	) -> Result<Arc<dyn ControlAuthority>, ControlCompositionError> {
		if !self.registries.admits(&identity) {
			return Err(ControlCompositionError::unavailable(
				"hooks",
				"authenticated extension has no deployment manifest",
			));
		}
		Ok(Arc::new(BoundHookControl { identity, owner: self.clone() }))
	}
}

struct BoundHookControl {
	identity: Arc<ControlConnectionIdentity>,
	owner:    HookControlFactory,
}

#[async_trait::async_trait]
impl ControlAuthority for BoundHookControl {
	fn handles(&self, operation: &str) -> bool {
		operation == "omp.hooks.dispatch"
	}

	fn authorize(
		&self,
		context: &ControlRequestContext,
		operation: &str,
		_arguments: &JsonMap<String, JsonValue>,
	) -> Result<(), ControlProtocolError> {
		if !same_connection(&self.identity, &context.connection) {
			return Err(stale_connection());
		}
		if !self.handles(operation) {
			return Err(ControlProtocolError::new(
				"InvalidOperation",
				"hook owner does not handle this operation",
			));
		}
		require_active_invocation(context)
	}

	async fn request(
		&self,
		context: ControlRequestContext,
		operation: Str,
		arguments: JsonMap<String, JsonValue>,
	) -> Result<JsonValue, ControlProtocolError> {
		self.authorize(&context, operation.as_str(), &arguments)?;
		self.owner.compose(&context, &arguments).await
	}

	async fn effect(
		&self,
		context: ControlRequestContext,
		_effect: ControlEffect,
	) -> Result<(), ControlProtocolError> {
		if same_connection(&self.identity, &context.connection) {
			Err(ControlProtocolError::new("InvalidEffect", "hook owner accepts requests only"))
		} else {
			Err(stale_connection())
		}
	}
}

#[cfg(test)]
mod tests {
	use omp_contract::{AgentSettledEvent, HookEvent as _};

	use super::*;

	#[test]
	fn extension_tool_call_timeout_caps_only_tool_call_handlers() {
		let configured = time::Duration::from_millis(125);
		let short = time::Duration::from_millis(25);
		let long = time::Duration::from_secs(5);
		assert_eq!(extension_callback_timeout("tool_call", configured, None, long), configured);
		assert_eq!(extension_callback_timeout("tool_call", configured, Some(short), long), short);
		assert_eq!(extension_callback_timeout("tool_call", configured, Some(long), long), configured);
		assert_eq!(extension_callback_timeout("tool_result", configured, None, long), long);
	}

	#[test]
	fn tool_call_bash_wire_expands_to_public_hook_shape() {
		let ir = omp_proto::policy::v1::BashIr {
			source: String::from("touch marker"),
			rev: String::from("bashir@3"),
			parser_rev: String::from("qa"),
			parse_ok: true,
			commands: vec![omp_proto::policy::v1::BashCommand {
				name: Some(String::from("touch")),
				..omp_proto::policy::v1::BashCommand::default()
			}],
			..omp_proto::policy::v1::BashIr::default()
		};
		let mut payload = json!({
			"bash": null,
			"__omp_bash_proto": {
				"$bytes": omp_core::base64::encode(&ir.encode_to_vec()),
			},
		});
		assert!(hydrate_tool_call_bash(&mut payload), "hydrate Bash IR");
		assert!(payload.get("__omp_bash_proto").is_none());
		assert_eq!(payload["bash"]["source"], "touch marker");
		assert_eq!(payload["bash"]["commands"][0]["name"], "touch");
	}

	#[test]
	fn lifecycle_observe_excludes_subject_and_reaches_second_active_extension() {
		let payload = json!({"extension": "publisher.subject"});
		let active = ["publisher.subject", "publisher.observer"];
		let recipients = active
			.into_iter()
			.filter(|extension| lifecycle_hook_recipient("extension_load", &payload, extension))
			.collect::<Vec<_>>();
		assert_eq!(recipients, ["publisher.observer"]);
		assert!(!lifecycle_hook_recipient("extension_unload", &payload, "publisher.subject",));
		assert!(lifecycle_hook_recipient("extension_unload", &payload, "publisher.observer",));
	}

	#[test]
	fn lifecycle_phase_vocabulary_is_closed_and_observe_cannot_authorize() {
		for kind in ["deny", "defer"] {
			assert!(hook_decision_is_legal("precheck", Some(kind)));
		}
		assert!(hook_decision_is_legal("transform", Some("modify")));
		assert!(hook_decision_is_legal("review", Some("allow")));
		assert!(hook_decision_is_legal("approval", Some("require_approval")));
		assert!(!hook_decision_is_legal("observe", Some("allow")));
		assert!(!hook_decision_is_legal("precheck", Some("require_approval")));
		assert!(!hook_decision_is_legal("review", Some("modify")));
	}

	#[test]
	fn approval_requirement_retains_authenticated_generation_evidence() {
		let spec = approval_spec_with_provenance(
			json!({
				"title": "Approve",
				"body": "Policy requires approval",
				"subject": "bash",
				"evidence": ["rule=destructive"],
			}),
			"publisher.guard",
			"publisher.extension",
			11,
			19,
		);
		assert_eq!(
			spec["evidence"],
			json!([
				"rule=destructive",
				"hook=publisher.guard extension=publisher.extension host_generation=11 \
				 session_generation=19",
			]),
		);
	}

	#[test]
	fn delegated_composer_decodes_every_merged_approval_requirement() {
		let decision = json!({
			"kind": "require_approvals",
			"specs": [
				{
					"title": "Hook approval",
					"body": "extension policy",
					"subject": "bash",
					"kind": "exec",
					"evidence": ["host_generation=4"],
				},
				{
					"title": "Capability approval",
					"body": "native policy",
					"subject": "network",
					"kind": "network",
				},
			],
			"effective": {"args": {"value": 2}},
		});
		let GateDecision::RequireApprovals { specs, patch } =
			gate_decision_from_json(decision, json!({"args": {}}))
		else {
			panic!("merged approval decision");
		};
		assert_eq!(specs.len(), 2);
		let patch = patch.expect("effective transform");
		assert_eq!(
			serde_json::from_slice::<JsonValue>(patch.args.as_deref().expect("argument patch"))
				.expect("effective JSON"),
			json!({"args": {"value": 2}}),
		);
		assert_eq!(specs[0].evidence, [sf!("host_generation=4")]);
		assert_eq!(specs[1].subject, "network");
	}

	#[test]
	fn session_branch_transform_composes_summarize() {
		let policy = HookEventPolicy {
			revision:    1,
			timeout:     time::Duration::from_secs(1),
			on_failure:  HookFailurePolicy::Defer,
			default:     json!({"kind": "allow"}),
			composition: BTreeMap::from([(sf!("summarize"), HookFieldComposition::Replace)]),
		};
		let mut payload = json!({
			"at_event": 9,
			"keep_event": 9,
			"reason": "user",
			"summarize": false,
		});
		let mut modification = None;
		let decision = json!({"kind": "modify", "patch": {"summarize": true}});
		compose_hook_modify(
			"session_branch",
			&policy,
			&mut payload,
			&mut modification,
			decision.as_object().expect("modify object"),
		)
		.expect("compose branch summarize");
		assert_eq!(payload["summarize"], true);
		assert_eq!(
			modification
				.as_ref()
				.and_then(|value| value.get("patch"))
				.and_then(JsonValue::as_object)
				.and_then(|patch| patch.get("summarize")),
			Some(&JsonValue::Bool(true)),
		);
	}

	#[test]
	fn tool_call_transform_patches_effective_arguments() {
		let policy = HookEventPolicy {
			revision:    1,
			timeout:     time::Duration::from_secs(1),
			on_failure:  HookFailurePolicy::Deny,
			default:     json!({"kind": "allow"}),
			composition: BTreeMap::from([
				(sf!("target"), HookFieldComposition::Replace),
				(sf!("args"), HookFieldComposition::Replace),
				(sf!("cwd"), HookFieldComposition::Replace),
				(sf!("deadline"), HookFieldComposition::Replace),
			]),
		};
		let mut payload = json!({
			"target": {"kind": "core", "name": "bash", "rev": "core.1", "args": {
				"command": "printf original"
			}},
			"args": {"command": "printf original"},
			"cwd": ".",
			"deadline": null,
		});
		let mut modification = None;
		let decision = json!({"kind": "modify", "patch": {"command": "printf modified"}});
		compose_hook_modify(
			"tool_call",
			&policy,
			&mut payload,
			&mut modification,
			decision.as_object().expect("modify object"),
		)
		.expect("compose tool arguments");
		assert_eq!(payload["args"]["command"], "printf modified");
		assert_eq!(
			modification
				.as_ref()
				.and_then(|value| value.get("patch"))
				.and_then(JsonValue::as_object)
				.and_then(|patch| patch.get("args"))
				.and_then(JsonValue::as_object)
				.and_then(|args| args.get("command")),
			Some(&JsonValue::String(String::from("printf modified"))),
		);
	}

	#[test]
	fn domain_replies_compose_as_transforms_or_nothing() {
		assert_eq!(domain_reply_decision(JsonValue::Null).expect("none"), None);
		assert_eq!(
			domain_reply_decision(json!({"prune": [{"ids": ["3"]}], "note": "trim"})).expect("patch"),
			Some(json!({"kind": "modify", "patch": {"prune": [{"ids": ["3"]}], "note": "trim"}}))
		);
		assert_eq!(
			domain_reply_decision(json!({"kind": "deny", "reason": "no"})).expect("decision"),
			Some(json!({"kind": "deny", "reason": "no"}))
		);
		assert!(domain_reply_decision(json!("continue")).is_err());
	}

	#[test]
	fn hook_deny_policy_fails_closed_on_callback_error() {
		let decision = hook_callback_failure(
			HookFailurePolicy::Deny,
			ControlProtocolError::new("CallbackUnavailable", "extension callback failed"),
		)
		.expect("DENY policy must produce a terminal denial");
		assert_eq!(
			decision,
			serde_json::json!({
				"kind": "deny",
				"reason": "extension callback failed",
				"fatal": false,
				"code": "CallbackUnavailable",
			})
		);
		assert!(
			hook_callback_failure(
				HookFailurePolicy::Defer,
				ControlProtocolError::new("CallbackUnavailable", "extension callback failed"),
			)
			.is_none()
		);
	}

	/// Revision `agent_settled` declares in `crates/py/python/omp/events.py`;
	/// envd builds the extension's event policy from that declaration.
	const PYTHON_AGENT_SETTLED_REVISION: u16 = 2;

	fn agent_settled_policy() -> HookEventPolicy {
		HookEventPolicy {
			revision:    PYTHON_AGENT_SETTLED_REVISION,
			timeout:     time::Duration::from_secs(1),
			on_failure:  HookFailurePolicy::Defer,
			default:     json!({"kind": "defer"}),
			composition: BTreeMap::new(),
		}
	}

	fn agent_settled_event() -> String {
		hook_event_name(AgentSettledEvent::ID).expect("agent_settled hook event name")
	}

	#[test]
	fn agent_settled_policy_admits_hook_gate_revision() {
		let event = agent_settled_event();
		assert_eq!(event, "agent_settled");
		let event_rev =
			u16::try_from(AgentSettledEvent::REV).expect("agent_settled revision fits the wire field");
		check_hook_event_revision(&event, event_rev, &agent_settled_policy())
			.expect("the declared agent_settled policy admits the HookGate revision");
	}

	#[test]
	fn agent_settled_policy_rejects_stale_revision_one() {
		let event = agent_settled_event();
		let error = check_hook_event_revision(&event, 1, &agent_settled_policy())
			.expect_err("a revision-1 dispatch must not reach the revision-2 policy");
		assert_eq!(&*error.code, "HookContractError");
		assert_eq!(&*error.message, "hook event revision mismatch: expected 2, got 1");
	}

	#[test]
	fn mcp_filter_is_anchored_and_queue_drops_oldest() {
		let servers = [sf!("github")];
		let methods = [sf!("notifications/*"), sf!("acme/*")];
		assert!(mcp_filter_matches(
			Some(&servers),
			&methods,
			"github",
			"notifications/tools/list_changed",
		));
		assert!(mcp_filter_matches(Some(&servers), &methods, "github", "acme/custom"));
		assert!(!mcp_filter_matches(
			Some(&servers),
			&methods,
			"linear",
			"notifications/tools/list_changed",
		));
		assert!(!mcp_filter_matches(Some(&servers), &methods, "github", "other/update",));
		assert!(anchored_glob_matches("notifications/*", "notifications/tools/list_changed"));
		assert!(anchored_glob_matches("acme/??", "acme/ok"));
		assert!(!anchored_glob_matches("notifications/*", "prefix/notifications/update"));
		assert!(!anchored_glob_matches("acme/??", "acme/long"));

		let mut queue = McpDeliveryQueue {
			pending:         VecDeque::new(),
			running_servers: BTreeSet::new(),
			dropped:         0,
		};
		for sequence in 1..=102 {
			queue.push(McpQueuedDelivery {
				notification:  McpHookNotification {
					server: sf!("github"),
					method: sf!("notifications/update"),
					params: JsonValue::Null,
					sequence,
				},
				subscriptions: Vec::new(),
			});
		}
		assert_eq!(queue.pending.len(), MCP_HOOK_QUEUE_CAPACITY);
		assert_eq!(queue.dropped, 2);
		assert_eq!(
			queue
				.pending
				.front()
				.map(|delivery| delivery.notification.sequence),
			Some(3)
		);
		assert_eq!(
			queue
				.pending
				.back()
				.map(|delivery| delivery.notification.sequence),
			Some(102)
		);
	}

	#[test]
	fn extension_usage_projection_is_typed_and_rejects_malformed_reports() {
		let observed = time::UNIX_EPOCH + time::Duration::from_secs(10);
		let report = decode_extension_usage(
			json!({
				"plan": "extension",
				"windows": [{
					"id": "requests",
					"used": 2,
					"limit": 10,
					"unit": "requests",
					"resets_at_ms": 20_000,
				}],
			}),
			observed,
		)
		.expect("typed extension usage report");
		assert_eq!(report.plan.as_deref(), Some("extension"));
		assert_eq!(report.windows[0].amount.consumed.map(|value| value.units), Some(2));
		assert_eq!(report.windows[0].amount.remaining.map(|value| value.units), Some(8));
		assert!(matches!(
			decode_extension_usage(json!({"windows": [{"id": "bad", "unit": "secret"}]}), observed),
			Err(UsageFetchError::Protocol),
		));
	}

	struct SettledDispatcher {
		calls:   AtomicU64,
		reply:   JsonValue,
		/// Extension names whose callback fails with a protocol error.
		failing: BTreeSet<&'static str>,
		/// Callback arguments of every dispatch, in call order.
		seen:    parking_lot::Mutex<Vec<serde_json::Map<String, JsonValue>>>,
	}

	#[async_trait::async_trait]
	impl CallbackDispatcher for SettledDispatcher {
		async fn dispatch(
			&self,
			target: Arc<ControlConnectionIdentity>,
			dispatch: ControlDispatch,
		) -> Result<JsonValue, ControlProtocolError> {
			self.calls.fetch_add(1, Ordering::SeqCst);
			self.seen.lock().push(dispatch.arguments);
			if self.failing.contains(target.extension.as_str()) {
				return Err(ControlProtocolError::new("CallbackFailed", "scripted failure"));
			}
			Ok(self.reply.clone())
		}
	}

	fn settled_factory(reply: JsonValue) -> (Arc<HookControlFactory>, Arc<SettledDispatcher>) {
		let dispatcher = Arc::new(SettledDispatcher {
			calls: AtomicU64::new(0),
			seen: parking_lot::Mutex::new(Vec::new()),
			reply,
			failing: BTreeSet::from(["a-fail"]),
		});
		let hooks = HookControlFactory::new(
			RegistryControlFactory::new(BTreeMap::new()),
			Arc::clone(&dispatcher) as Arc<dyn CallbackDispatcher>,
			BTreeMap::new(),
			BTreeMap::new(),
			time::Duration::from_secs(1),
		);
		(hooks, dispatcher)
	}

	fn settled_row(revision: u16) -> HookSubscription {
		settled_named("ext", revision)
	}

	fn settled_named(ext: &str, revision: u16) -> HookSubscription {
		let identity = Arc::new(ControlConnectionIdentity {
			extension:          Str::from(ext),
			principal:          omp_core::Principal::new(sf!("test"), sf!("Test")),
			artifact_digest:    sf!("sha256:test"),
			layer:              sf!("project"),
			tier:               sf!("trusted"),
			trust:              sf!("trusted"),
			host_generation:    1,
			session_generation: 1,
			capabilities:       Arc::new(BTreeSet::new()),
		});
		HookSubscription {
			identity,
			session: sf!("s1"),
			event: sf!("agent_settled"),
			phase: sf!("domain"),
			name: sf!("{ext}/0"),
			order: 0,
			on_failure: None,
			timeout: None,
			concurrency: CallbackConcurrency::Serialized,
			providers: None,
			servers: None,
			method_globs: Box::new([]),
			event_policy: HookEventPolicy {
				revision,
				timeout: time::Duration::from_secs(1),
				on_failure: HookFailurePolicy::Defer,
				default: json!({}),
				composition: BTreeMap::new(),
			},
		}
	}

	fn install(hooks: &HookControlFactory, row: HookSubscription) {
		let key = connection_key(&row.identity);
		hooks.subscriptions.write().insert(key, vec![row]);
	}

	fn install_all(hooks: &HookControlFactory, rows: Vec<HookSubscription>) {
		for row in rows {
			let key = connection_key(&row.identity);
			hooks.subscriptions.write().insert(key, vec![row]);
		}
	}

	fn current_revision() -> u16 {
		u16::try_from(<omp_contract::AgentSettledEvent as omp_contract::HookEvent>::REV).unwrap()
	}

	#[tokio::test]
	async fn no_python_rows_defers() {
		let (hooks, dispatcher) = settled_factory(json!({"prompt": "x"}));
		let reply = hooks
			.dispatch_agent_settled(&sf!("s1"), 1, &json!({}))
			.await;
		assert_eq!(reply, omp_contract::NativeReply::default());
		assert_eq!(dispatcher.calls.load(Ordering::SeqCst), 0);
	}

	#[tokio::test]
	async fn stale_revision_row_is_skipped() {
		let (hooks, dispatcher) = settled_factory(json!({"prompt": "x"}));
		install(&hooks, settled_row(current_revision() + 1));
		let reply = hooks
			.dispatch_agent_settled(&sf!("s1"), 1, &json!({}))
			.await;
		assert_eq!(reply, omp_contract::NativeReply::default());
		assert_eq!(dispatcher.calls.load(Ordering::SeqCst), 0);
	}

	#[tokio::test]
	async fn session_gate_has_the_settled_host() {
		let (hooks, dispatcher) = settled_factory(json!({"prompt": "x"}));
		install(&hooks, settled_row(current_revision()));
		super::super::settled::AgentSettledHost::attach(&hooks, sf!("s1"), 1);
		let settled = omp_contract::LifecycleHooks::new(hooks.admission_gate())
			.agent_settled(json!({}))
			.await;
		assert_eq!(settled.decision, omp_contract::AgentSettled::Continue);
		assert_eq!(settled.context.len(), 1);
		assert_eq!(settled.context[0].body, "x");
		assert_eq!(dispatcher.calls.load(Ordering::SeqCst), 1);
	}

	#[tokio::test]
	async fn failed_call_defers_and_a_following_continue_wins() {
		let (hooks, dispatcher) = settled_factory(json!({"prompt": "x"}));
		install_all(&hooks, vec![
			settled_named("a-fail", current_revision()),
			settled_named("b-ok", current_revision()),
		]);
		let reply = hooks
			.dispatch_agent_settled(&sf!("s1"), 1, &json!({}))
			.await;
		assert_eq!(reply.verdict, omp_contract::NativeVerdict::Continue);
		assert_eq!(reply.context[0].body, "x");
		assert_eq!(dispatcher.calls.load(Ordering::SeqCst), 2);
	}

	#[tokio::test]
	async fn failed_call_alone_defers() {
		let (hooks, dispatcher) = settled_factory(json!({"prompt": "x"}));
		install(&hooks, settled_named("a-fail", current_revision()));
		let reply = hooks
			.dispatch_agent_settled(&sf!("s1"), 1, &json!({}))
			.await;
		assert_eq!(reply, omp_contract::NativeReply::default());
		assert_eq!(dispatcher.calls.load(Ordering::SeqCst), 1);
	}

	#[tokio::test]
	async fn payload_reaches_the_callback_unchanged() {
		let (hooks, dispatcher) = settled_factory(json!({}));
		install(&hooks, settled_row(current_revision()));
		let payload = json!({"reason": "idle", "nested": {"n": [1, 2]}});
		hooks.dispatch_agent_settled(&sf!("s1"), 1, &payload).await;
		let seen = dispatcher.seen.lock();
		assert_eq!(seen.len(), 1);
		assert_eq!(seen[0]["payload"], payload);
		assert_eq!(seen[0]["phase"], "domain");
		assert_eq!(seen[0]["name"], "ext/0");
		assert_eq!(seen[0]["event"], "agent_settled");
	}
}
