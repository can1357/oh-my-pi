//! Identity-fenced UI, telemetry, and job CONTROL domain owners.

use std::{mem, sync::Arc};

use async_trait::async_trait;
use omp_core::{InvocationPhase, LifecyclePhase, Str};
use omp_observability::authority::{
	DurableTelemetryQuery, SpanEvent, SpanFault, TelemetryAuthority, TelemetryAuthorityError,
	TelemetryAuthorityIdentity, TelemetryCallContext,
};
use serde_json::{Map, Value, json};

use super::control::{
	ControlAuthority, ControlConnectionIdentity, ControlEffect, ControlProtocolError,
	ControlRequestContext,
};

/// Data-only UI request routed to the app-owned presentation compositor.
#[derive(Clone, Debug)]
pub enum UiControlRequest {
	/// Current presentation facts.
	Presentation,
	/// Current invokable command roster.
	Commands,
	/// Icon catalog prefix lookup.
	Icons {
		/// Optional name prefix supplied by the extension to filter the app-owned
		/// catalog.
		prefix: Str,
	},
	/// Current composer text.
	EditorText,
	/// Installed theme names.
	Themes,
	/// Switch the session's live theme, optionally through normal settings
	/// persistence.
	SetAppearance {
		/// Installed theme name.
		theme:   Str,
		/// Whether to persist through the settings owner.
		persist: bool,
	},
	/// Current transcript tool-card disclosure state.
	ToolsExpanded,
	/// Set every transcript tool card's disclosure state.
	SetToolsExpanded {
		/// Desired expansion state.
		expanded: bool,
	},
	/// Set the placeholder shown for hidden reasoning.
	SetHiddenThinkingLabel {
		/// Replacement label, or `None` to clear it.
		label: Option<Str>,
	},
	/// Total dialog request.
	Dialog {
		/// Dialog operation name decoded from the extension's CONTROL request.
		kind:   Str,
		/// Operation-specific dialog arguments transferred to the app compositor.
		fields: Map<String, Value>,
	},
	/// Open a retained overlay.
	Overlay {
		/// Overlay declaration and initial values transferred from the extension.
		fields: Map<String, Value>,
	},
	/// Read a retained overlay's values.
	OverlayValues {
		/// App-issued identifier of the retained overlay to inspect.
		id: Str,
	},
	/// Wait for overlay settlement.
	OverlayWait {
		/// App-issued identifier whose retained overlay remains owned by the
		/// compositor while waiting.
		id: Str,
	},
	/// Read watched overlay events.
	OverlayEvents {
		/// App-issued identifier of the retained overlay whose events are
		/// requested.
		id: Str,
	},
	/// Idempotently close an overlay.
	OverlayClose {
		/// App-issued identifier of the compositor-owned overlay to release.
		id: Str,
	},
	/// Publish or invalidate a manifest-verified static UI roster.
	DynamicMount {
		/// Exact verified host generation whose roster should be installed.
		generation: u64,
	},
}

/// Typed response from the real app presentation owner.
#[derive(Clone, Debug)]
pub enum UiControlResult {
	/// Structured result body.
	Value(Value),
	/// Successful unit result.
	Ack,
}

/// App-owned UI authority. Implementations expose structured compositor
/// operations only; no terminal handle crosses this boundary.
#[async_trait]
pub trait UiControlOwner: Send + Sync + 'static {
	/// Executes a request using Core-authored identity and invocation scope.
	async fn request(
		&self,
		context: ControlRequestContext,
		request: UiControlRequest,
	) -> Result<UiControlResult, ControlProtocolError>;

	/// Applies one retained, data-only presentation effect.
	async fn effect(
		&self,
		context: ControlRequestContext,
		effect: Value,
	) -> Result<(), ControlProtocolError>;
}

/// Identity-fenced CONTROL adapter for the app-owned UI compositor.
pub struct UiControlAuthority {
	identity: Arc<ControlConnectionIdentity>,
	owner:    Arc<dyn UiControlOwner>,
}

impl UiControlAuthority {
	/// Binds one UI owner to one authenticated connection incarnation.
	pub fn new(identity: Arc<ControlConnectionIdentity>, owner: Arc<dyn UiControlOwner>) -> Self {
		Self { identity, owner }
	}
}

#[async_trait]
impl ControlAuthority for UiControlAuthority {
	fn handles(&self, operation: &str) -> bool {
		matches!(
			operation,
			"omp.ui.presentation"
				| "omp.ui.commands"
				| "omp.ui.icons"
				| "omp.ui.editor_text"
				| "omp.ui.themes"
				| "omp.ui.set_appearance"
				| "omp.ui.tools_expanded"
				| "omp.ui.set_tools_expanded"
				| "omp.ui.set_hidden_thinking_label"
				| "omp.ui.confirm"
				| "omp.ui.select"
				| "omp.ui.multi_select"
				| "omp.ui.input"
				| "omp.ui.editor"
				| "omp.ui.form"
				| "omp.ui.ask_user"
				| "omp.ui.overlay"
				| "omp.ui.overlay_values"
				| "omp.ui.overlay_wait"
				| "omp.ui.overlay_events"
				| "omp.ui.overlay_close"
				| "omp.ui.dynamic_mount"
		)
	}

	fn authorize(
		&self,
		context: &ControlRequestContext,
		operation: &str,
		_arguments: &Map<String, Value>,
	) -> Result<(), ControlProtocolError> {
		authorize_identity(&self.identity, context)?;
		if matches!(
			operation,
			"omp.ui.set_appearance" | "omp.ui.set_tools_expanded" | "omp.ui.set_hidden_thinking_label"
		) {
			authorize_interactive_command(context)?;
		}
		let (minimum, capability) = match operation {
			"omp.ui.confirm"
			| "omp.ui.select"
			| "omp.ui.multi_select"
			| "omp.ui.input"
			| "omp.ui.editor"
			| "omp.ui.form"
			| "omp.ui.ask_user"
			| "omp.ui.overlay"
			| "omp.ui.overlay_wait" => (InvocationPhase::EffectsAuthorized, Some("ui.dialogs")),
			"omp.ui.dynamic_mount" => (InvocationPhase::Open, Some("ui.commands")),
			_ => (InvocationPhase::Open, None),
		};
		authorize_invocation(context, minimum)?;
		if let Some(capability) = capability {
			require_capability(context, capability)?;
		}
		Ok(())
	}

	async fn request(
		&self,
		context: ControlRequestContext,
		operation: Str,
		mut arguments: Map<String, Value>,
	) -> Result<Value, ControlProtocolError> {
		let request = decode_ui_request(operation.as_str(), &mut arguments)?;
		match self.owner.request(context, request).await? {
			UiControlResult::Value(value) => Ok(value),
			UiControlResult::Ack => Ok(Value::Null),
		}
	}

	async fn effect(
		&self,
		context: ControlRequestContext,
		effect: ControlEffect,
	) -> Result<(), ControlProtocolError> {
		authorize_identity(&self.identity, &context)?;
		let ControlEffect::Ui(effect) = effect else {
			return Err(protocol("wrong_domain", "UI authority received a non-UI effect"));
		};
		validate_working_indicator(&effect)?;
		let kind = effect
			.get("kind")
			.and_then(Value::as_str)
			.ok_or_else(|| protocol("invalid_ui_effect", "UI effect kind is missing"))?;
		let (minimum, capability) = match kind {
			"notify" => (InvocationPhase::EffectsAuthorized, Some("ui.notify")),
			"open_url" | "set_title" | "set_progress" => {
				(InvocationPhase::EffectsAuthorized, Some("ui.title"))
			},
			"submit" | "image" => (InvocationPhase::EffectsAuthorized, None),
			"set_ghost" => (InvocationPhase::Open, Some("ui.ghost")),
			"mount" | "unmount" | "patch" | "focus_slot" | "blur_slot" => {
				(InvocationPhase::Open, Some("ui.slots"))
			},
			_ => (InvocationPhase::Open, None),
		};
		authorize_invocation(&context, minimum)?;
		if let Some(capability) = capability {
			require_capability(&context, capability)?;
		}
		self.owner.effect(context, effect).await
	}
}

/// CONTROL request class routed to the telemetry owner.
#[derive(Clone, Debug)]
pub enum TelemetryControlRequest {
	/// Flush all live exporters.
	Flush,
	/// Query the durable telemetry index.
	Query(Value),
	/// Read indexed revision metrics.
	RevMetrics {
		/// Extension-supplied tool wire name whose revision metrics are
		/// requested.
		tool:   Str,
		/// Optional revision family filter supplied by the extension.
		family: Option<Str>,
		/// Optional serialized absolute or relative lower time bound supplied by
		/// the extension.
		since:  Option<Value>,
		/// Extension-selected telemetry visibility scope.
		scope:  Str,
	},
	/// Read one exporter worker's counters.
	ExportStats(u64),
	/// Stop one exporter idempotently.
	ExportStop(u64),
	/// Open a real extension span.
	SpanOpen {
		/// Extension-supplied span name recorded by the host telemetry owner.
		name:       Str,
		/// Initial span attributes transferred from the extension.
		attributes: Map<String, Value>,
	},
	/// Close one retained extension span.
	SpanClose {
		/// Opaque host-issued identifier retaining ownership of the live span.
		handle:     Str,
		/// Final attributes supplied by the extension before the host releases
		/// the span.
		attributes: Map<String, Value>,
		/// Ordered span events accumulated by the extension.
		events:     Vec<SpanEvent>,
		/// Optional terminal failure supplied by the extension.
		fault:      Option<SpanFault>,
	},
}

/// Identity-fenced adapter over [`TelemetryAuthority`].
pub struct TelemetryControlAuthority {
	identity:           Arc<ControlConnectionIdentity>,
	telemetry_identity: Arc<TelemetryAuthorityIdentity>,
	owner:              Arc<TelemetryAuthority>,
}

impl TelemetryControlAuthority {
	/// Creates an owner using the authenticated connection and durable query
	/// index. `installed_at_ms` is the privacy floor for historical reads.
	pub fn new(
		identity: Arc<ControlConnectionIdentity>,
		installed_at_ms: u64,
		query: Arc<dyn DurableTelemetryQuery>,
	) -> Self {
		let telemetry_identity = Arc::new(TelemetryAuthorityIdentity {
			principal: Str::new(identity.principal.id()),
			artifact_digest: identity.artifact_digest.clone(),
			host_generation: identity.host_generation,
			session_generation: identity.session_generation,
			installed_at_ms,
			capabilities: identity.capabilities.clone(),
		});
		let owner = Arc::new(TelemetryAuthority::new(telemetry_identity.clone(), query));
		Self { identity, telemetry_identity, owner }
	}

	/// Returns the scoped owner for installing frozen subscriptions/exporters.
	pub fn owner(&self) -> &Arc<TelemetryAuthority> {
		&self.owner
	}

	fn call_context(&self, context: &ControlRequestContext) -> TelemetryCallContext<'_> {
		TelemetryCallContext {
			identity:  self.telemetry_identity.as_ref(),
			cancelled: context
				.invocation
				.as_ref()
				.is_some_and(|invocation| invocation.phase.is_terminal()),
		}
	}
}

#[async_trait]
impl ControlAuthority for TelemetryControlAuthority {
	fn handles(&self, operation: &str) -> bool {
		matches!(
			operation,
			"omp.telemetry.flush"
				| "omp.telemetry.query"
				| "omp.telemetry.rev_metrics"
				| "omp.telemetry.export.stats"
				| "omp.telemetry.export.stop"
				| "omp.telemetry.span.open"
				| "omp.telemetry.span.close"
		)
	}

	fn authorize(
		&self,
		context: &ControlRequestContext,
		_operation: &str,
		_arguments: &Map<String, Value>,
	) -> Result<(), ControlProtocolError> {
		authorize_identity(&self.identity, context)?;
		authorize_invocation(context, InvocationPhase::Open)
	}

	async fn request(
		&self,
		context: ControlRequestContext,
		operation: Str,
		arguments: Map<String, Value>,
	) -> Result<Value, ControlProtocolError> {
		let request = decode_telemetry_request(operation.as_str(), arguments)?;
		let call = self.call_context(&context);
		match request {
			TelemetryControlRequest::Flush => self.owner.flush(call).map(Value::Bool),
			TelemetryControlRequest::Query(query) => self.owner.query(call, &query),
			TelemetryControlRequest::RevMetrics { tool, family, since, scope } => self
				.owner
				.rev_metrics(call, tool.as_str(), family.as_deref(), since.as_ref(), scope.as_str()),
			TelemetryControlRequest::ExportStats(id) => {
				self.owner.exporter_stats(call, id).and_then(|stats| {
					serde_json::to_value(stats)
						.map_err(|error| TelemetryAuthorityError::Owner(Str::new(error.to_string())))
				})
			},
			TelemetryControlRequest::ExportStop(id) => {
				self.owner.stop_exporter(call, id).map(|()| Value::Null)
			},
			TelemetryControlRequest::SpanOpen { name, attributes } => self
				.owner
				.open_span(call, name.as_str(), &attributes)
				.and_then(|span| {
					serde_json::to_value(span)
						.map_err(|error| TelemetryAuthorityError::Owner(Str::new(error.to_string())))
				}),
			TelemetryControlRequest::SpanClose { handle, attributes, events, fault } => self
				.owner
				.close_span(call, handle.as_str(), &attributes, &events, fault.as_ref())
				.map(|()| Value::Null),
		}
		.map_err(telemetry_error)
	}

	async fn effect(
		&self,
		context: ControlRequestContext,
		effect: ControlEffect,
	) -> Result<(), ControlProtocolError> {
		authorize_identity(&self.identity, &context)?;
		let ControlEffect::Instrument(event) = effect else {
			return Err(protocol(
				"wrong_domain",
				"telemetry authority received a non-instrument effect",
			));
		};
		self
			.owner
			.publish(self.call_context(&context), event)
			.map(|_| ())
			.map_err(telemetry_error)
	}
}

/// Driver-owned job supervision boundary.
#[async_trait]
pub trait JobsControlOwner: Send + Sync + 'static {
	/// Registers and supervises one scoped detached job.
	async fn register_job(
		&self,
		context: ControlRequestContext,
		arguments: Map<String, Value>,
	) -> Result<Value, ControlProtocolError>;
}

/// Identity-fenced adapter for job supervision operations.
pub struct JobsControlAuthority {
	identity: Arc<ControlConnectionIdentity>,
	owner:    Arc<dyn JobsControlOwner>,
}

impl JobsControlAuthority {
	/// Binds the durable job owner to one authenticated connection.
	pub fn new(identity: Arc<ControlConnectionIdentity>, owner: Arc<dyn JobsControlOwner>) -> Self {
		Self { identity, owner }
	}
}

#[async_trait]
impl ControlAuthority for JobsControlAuthority {
	fn handles(&self, operation: &str) -> bool {
		operation == "omp.jobs.register"
	}

	fn authorize(
		&self,
		context: &ControlRequestContext,
		_operation: &str,
		_arguments: &Map<String, Value>,
	) -> Result<(), ControlProtocolError> {
		authorize_identity(&self.identity, context)?;
		if context.invocation.is_none() {
			return Err(protocol(
				"InvalidPhase",
				"detached job registration requires a live invocation",
			));
		}
		authorize_invocation(context, InvocationPhase::EffectsAuthorized)
	}

	async fn request(
		&self,
		context: ControlRequestContext,
		operation: Str,
		arguments: Map<String, Value>,
	) -> Result<Value, ControlProtocolError> {
		if operation.as_str() != "omp.jobs.register" {
			return Err(protocol("unknown_operation", "jobs owner does not handle operation"));
		}
		self.owner.register_job(context, arguments).await
	}

	async fn effect(
		&self,
		_context: ControlRequestContext,
		_effect: ControlEffect,
	) -> Result<(), ControlProtocolError> {
		Err(protocol("wrong_domain", "jobs authority does not accept effects"))
	}
}

fn decode_ui_request(
	operation: &str,
	arguments: &mut Map<String, Value>,
) -> Result<UiControlRequest, ControlProtocolError> {
	let request = match operation {
		"omp.ui.presentation" => UiControlRequest::Presentation,
		"omp.ui.commands" => UiControlRequest::Commands,
		"omp.ui.icons" => UiControlRequest::Icons {
			prefix: optional_string(arguments, "prefix")?.unwrap_or_default(),
		},
		"omp.ui.editor_text" => UiControlRequest::EditorText,
		"omp.ui.themes" => UiControlRequest::Themes,
		"omp.ui.set_appearance" => UiControlRequest::SetAppearance {
			theme:   required_string(arguments, "theme")?,
			persist: required_bool(arguments, "persist")?,
		},
		"omp.ui.tools_expanded" => UiControlRequest::ToolsExpanded,
		"omp.ui.set_tools_expanded" => {
			UiControlRequest::SetToolsExpanded { expanded: required_bool(arguments, "expanded")? }
		},
		"omp.ui.set_hidden_thinking_label" => {
			UiControlRequest::SetHiddenThinkingLabel { label: nullable_string(arguments, "label")? }
		},
		"omp.ui.confirm"
		| "omp.ui.select"
		| "omp.ui.multi_select"
		| "omp.ui.input"
		| "omp.ui.editor"
		| "omp.ui.form"
		| "omp.ui.ask_user" => UiControlRequest::Dialog {
			kind:   Str::new(operation.trim_start_matches("omp.ui.")),
			fields: mem::take(arguments),
		},
		"omp.ui.overlay" => UiControlRequest::Overlay { fields: mem::take(arguments) },
		"omp.ui.overlay_values" => {
			UiControlRequest::OverlayValues { id: required_string(arguments, "id")? }
		},
		"omp.ui.overlay_wait" => {
			UiControlRequest::OverlayWait { id: required_string(arguments, "id")? }
		},
		"omp.ui.overlay_events" => {
			UiControlRequest::OverlayEvents { id: required_string(arguments, "id")? }
		},
		"omp.ui.overlay_close" => {
			UiControlRequest::OverlayClose { id: required_string(arguments, "id")? }
		},
		"omp.ui.dynamic_mount" => {
			UiControlRequest::DynamicMount { generation: required_u64(arguments, "generation")? }
		},
		_ => return Err(protocol("unknown_operation", "unknown UI operation")),
	};
	Ok(request)
}

fn decode_telemetry_request(
	operation: &str,
	mut arguments: Map<String, Value>,
) -> Result<TelemetryControlRequest, ControlProtocolError> {
	match operation {
		"omp.telemetry.flush" => Ok(TelemetryControlRequest::Flush),
		"omp.telemetry.query" => Ok(TelemetryControlRequest::Query(
			arguments
				.remove("query")
				.ok_or_else(|| protocol("invalid_telemetry_request", "query is missing"))?,
		)),
		"omp.telemetry.rev_metrics" => Ok(TelemetryControlRequest::RevMetrics {
			tool:   required_string(&mut arguments, "tool")?,
			family: optional_string(&mut arguments, "family")?,
			since:  arguments.remove("since").filter(|value| !value.is_null()),
			scope:  required_string(&mut arguments, "scope")?,
		}),
		"omp.telemetry.export.stats" => {
			Ok(TelemetryControlRequest::ExportStats(required_u64(&mut arguments, "export_id")?))
		},
		"omp.telemetry.export.stop" => {
			Ok(TelemetryControlRequest::ExportStop(required_u64(&mut arguments, "export_id")?))
		},
		"omp.telemetry.span.open" => Ok(TelemetryControlRequest::SpanOpen {
			name:       required_string(&mut arguments, "name")?,
			attributes: required_object(&mut arguments, "attributes")?,
		}),
		"omp.telemetry.span.close" => {
			let handle = required_string(&mut arguments, "handle")?;
			let attributes = required_object(&mut arguments, "attributes")?;
			let events = serde_json::from_value(Value::Array(
				arguments
					.remove("events")
					.and_then(|value| value.as_array().cloned())
					.unwrap_or_default(),
			))
			.map_err(|error| protocol("invalid_telemetry_request", error.to_string()))?;
			let fault = match arguments.remove("fault") {
				None | Some(Value::Null) => None,
				Some(Value::Array(values)) if values.len() == 2 => Some(SpanFault {
					kind:    values[0].as_str().map(Str::new).ok_or_else(|| {
						protocol("invalid_telemetry_request", "fault kind must be a string")
					})?,
					message: values[1].as_str().map(Str::new).ok_or_else(|| {
						protocol("invalid_telemetry_request", "fault message must be a string")
					})?,
				}),
				Some(value) => Some(
					serde_json::from_value(value)
						.map_err(|error| protocol("invalid_telemetry_request", error.to_string()))?,
				),
			};
			Ok(TelemetryControlRequest::SpanClose { handle, attributes, events, fault })
		},
		_ => Err(protocol("unknown_operation", "unknown telemetry operation")),
	}
}

fn authorize_identity(
	expected: &Arc<ControlConnectionIdentity>,
	context: &ControlRequestContext,
) -> Result<(), ControlProtocolError> {
	let actual = &context.connection;
	if expected.extension != actual.extension
		|| expected.principal != actual.principal
		|| expected.artifact_digest != actual.artifact_digest
		|| expected.layer != actual.layer
		|| expected.tier != actual.tier
		|| expected.trust != actual.trust
		|| expected.host_generation != actual.host_generation
		|| expected.session_generation != actual.session_generation
		|| expected.capabilities != actual.capabilities
	{
		return Err(protocol(
			"StaleGeneration",
			"request belongs to a stale or foreign CONTROL connection",
		));
	}
	Ok(())
}

fn authorize_invocation(
	context: &ControlRequestContext,
	minimum: InvocationPhase,
) -> Result<(), ControlProtocolError> {
	let Some(invocation) = context.invocation.as_ref() else {
		return Ok(());
	};
	if invocation.lifecycle != LifecyclePhase::Active {
		return Err(protocol("ExtensionInactive", "extension is not active"));
	}
	if !invocation.phase.allows_operation(minimum) {
		return Err(protocol(
			"InvalidPhase",
			format!("operation requires {minimum}, current phase is {}", invocation.phase),
		));
	}
	Ok(())
}

fn authorize_interactive_command(
	context: &ControlRequestContext,
) -> Result<(), ControlProtocolError> {
	let Some(invocation) = context.invocation.as_ref() else {
		return Err(protocol(
			"UiMutationDenied",
			"UI appearance and disclosure mutations require an interactive command",
		));
	};
	if invocation.phase != InvocationPhase::EffectsAuthorized
		|| !invocation.has_ui
		|| invocation.headless
		|| invocation.turn.is_some()
		|| invocation.event.is_some()
		|| invocation.call.is_some()
		|| invocation.device.is_some()
	{
		return Err(protocol(
			"UiMutationDenied",
			"UI appearance and disclosure mutations are restricted to user-initiated interactive \
			 commands",
		));
	}
	Ok(())
}

fn require_capability(
	context: &ControlRequestContext,
	capability: &str,
) -> Result<(), ControlProtocolError> {
	if context
		.connection
		.capabilities
		.iter()
		.any(|granted| granted.as_str() == capability)
	{
		Ok(())
	} else {
		Err(protocol("CapabilityDenied", format!("capability `{capability}` is not granted")))
	}
}

fn required_string(
	arguments: &mut Map<String, Value>,
	name: &'static str,
) -> Result<Str, ControlProtocolError> {
	optional_string(arguments, name)?
		.filter(|value| !value.is_empty())
		.ok_or_else(|| protocol("invalid_request", format!("{name} must be a non-empty string")))
}

fn optional_string(
	arguments: &mut Map<String, Value>,
	name: &'static str,
) -> Result<Option<Str>, ControlProtocolError> {
	match arguments.remove(name) {
		None | Some(Value::Null) => Ok(None),
		Some(Value::String(value)) => Ok(Some(Str::new(value))),
		Some(_) => Err(protocol("invalid_request", format!("{name} must be a string"))),
	}
}

fn nullable_string(
	arguments: &mut Map<String, Value>,
	name: &'static str,
) -> Result<Option<Str>, ControlProtocolError> {
	optional_string(arguments, name)
}

fn required_bool(
	arguments: &mut Map<String, Value>,
	name: &'static str,
) -> Result<bool, ControlProtocolError> {
	arguments
		.remove(name)
		.and_then(|value| value.as_bool())
		.ok_or_else(|| protocol("invalid_request", format!("{name} must be a boolean")))
}

fn required_u64(
	arguments: &mut Map<String, Value>,
	name: &'static str,
) -> Result<u64, ControlProtocolError> {
	arguments
		.remove(name)
		.and_then(|value| value.as_u64())
		.ok_or_else(|| protocol("invalid_request", format!("{name} must be an unsigned integer")))
}

fn required_object(
	arguments: &mut Map<String, Value>,
	name: &'static str,
) -> Result<Map<String, Value>, ControlProtocolError> {
	arguments
		.remove(name)
		.and_then(|value| value.as_object().cloned())
		.ok_or_else(|| protocol("invalid_request", format!("{name} must be an object")))
}

fn validate_working_indicator(effect: &Value) -> Result<(), ControlProtocolError> {
	if effect.get("kind").and_then(Value::as_str) != Some("set_working_indicator") {
		return Ok(());
	}
	let body = effect
		.get("body")
		.and_then(Value::as_object)
		.ok_or_else(|| protocol("InvalidWorkingIndicator", "working indicator body is missing"))?;
	let frames = body
		.get("frames")
		.and_then(Value::as_array)
		.ok_or_else(|| protocol("InvalidWorkingIndicator", "frames must be an array"))?;
	if frames.len() > 8 {
		return Err(protocol(
			"InvalidWorkingIndicator",
			"working indicator requires at most eight frames",
		));
	}
	for frame in frames {
		let frame = frame.as_str().ok_or_else(|| {
			protocol("InvalidWorkingIndicator", "every working indicator frame must be a string")
		})?;
		if xutf::width_str(frame) > 8 {
			return Err(protocol(
				"InvalidWorkingIndicator",
				"working indicator frames must be at most eight display columns",
			));
		}
	}
	if let Some(interval) = body.get("interval_ms").filter(|value| !value.is_null())
		&& interval.as_u64().is_none_or(|value| value == 0)
	{
		return Err(protocol(
			"InvalidWorkingIndicator",
			"working indicator interval_ms must be a positive integer",
		));
	}
	Ok(())
}

fn telemetry_error(error: TelemetryAuthorityError) -> ControlProtocolError {
	let code = match &error {
		TelemetryAuthorityError::Identity => "StaleGeneration",
		TelemetryAuthorityError::Cancelled => "Cancelled",
		TelemetryAuthorityError::Capability(_) => "CapabilityDenied",
		TelemetryAuthorityError::Invalid(_) => "InvalidTelemetryRequest",
		TelemetryAuthorityError::NotFound(_) => "TelemetryResourceNotFound",
		TelemetryAuthorityError::Owner(_) => "TelemetryOwnerFailed",
	};
	protocol(code, error.to_string())
}

fn protocol(code: impl Into<Str>, message: impl Into<Str>) -> ControlProtocolError {
	ControlProtocolError::new(code, message).with_details(json!({}))
}

#[cfg(test)]
mod tests {
	use super::*;

	fn indicator(frames: Value, interval_ms: Value) -> Value {
		json!({
			"kind": "set_working_indicator",
			"body": {"frames": frames, "interval_ms": interval_ms},
		})
	}

	#[test]
	fn command_roster_request_decodes() {
		let request = decode_ui_request("omp.ui.commands", &mut Map::new());
		assert!(matches!(request, Ok(UiControlRequest::Commands)));
	}

	#[test]
	fn working_indicator_validates_count_width_and_interval() {
		assert!(validate_working_indicator(&indicator(json!(["◐", "◓"]), json!(80))).is_ok());
		assert!(validate_working_indicator(&indicator(json!([]), Value::Null)).is_ok());
		for invalid in [indicator(json!(["123456789"]), json!(80)), indicator(json!(["a"]), json!(0))]
		{
			assert!(validate_working_indicator(&invalid).is_err());
		}
	}
}

#[allow(dead_code)]
fn _assert_send_sync() {
	fn assert_owner<T: Send + Sync>() {}
	assert_owner::<UiControlAuthority>();
	assert_owner::<TelemetryControlAuthority>();
	assert_owner::<JobsControlAuthority>();
}
