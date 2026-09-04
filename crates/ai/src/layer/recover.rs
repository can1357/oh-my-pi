//! Canonical response recovery before semantic output gating.

use std::{
	fmt, mem, str,
	sync::Arc,
	task::{Context, Poll},
	time::SystemTime,
};

use futures::StreamExt;
use omp_catalog::{PriceUnit, id::WirePolicyId, pricing::UsageDimensions};
use omp_core::Str;
use tower::{Layer, Service};

use crate::{
	answer::{AnswerBody, ModelDiscoveryPage},
	body::AttemptBodyEvidence,
	call::{Call, DiscoveryRequest, OperationCall, Setting, StructuredOutput, ToolDefinition},
	codec::{
		HandshakeMeta, HandshakenResponse, RawCompletion, RawEvent, RawEventStream,
		UnvalidatedToolCall,
	},
	error::{Error, ErrorDetail, ErrorKind, ErrorPhase, RetryAction},
	event::{BlockKind, ChatEvent, Completion, FinishReason},
	layer::{ExecutionContext, LayerCall},
	plan::{ExecutionPlan, NegotiationDecision},
	receipt::{
		Adjustment, AttemptOutcome, AttemptReceipt, Cost, ProviderEvidence, ReasonId, RecoveryRecord,
		ServingModelAttribution,
	},
	recovery::{
		Stage,
		empty::{EmptyCompletionKind, EmptyCompletionStage, EmptyEvent, EmptyInput},
		harmony::normalize_attempt as normalize_harmony_attempt,
		json::{JsonEnforcement, JsonRepairLimits, JsonRepairStage},
		projection::{
			DialectRecoveryConfig, DialectRecoveryPipeline, ProjectionBatch, ProjectionFailure,
		},
		reasoning::{ReasoningLimits, ReasoningObservation, ReasoningStallGuard},
		repetition::{
			AttemptRepetitionGuard, LoopSignal, OutputVisibility, RepetitionLimits, recovery_record,
		},
		tools::{
			ToolAssembler, ToolAssemblyEvent, ToolAssemblyLimits, ToolFragment, validate_schema,
		},
	},
};

/// Route-scoped conservative normalization for provider discovery rows.
pub trait DiscoveryProjector: Send + Sync + 'static {
	/// Normalizes one provider page without mutating the bundled catalog.
	fn project(
		&self,
		request: &DiscoveryRequest,
		rows: Vec<omp_catalog::DiscoveredModel>,
		next_cursor: Option<Str>,
	) -> Result<ModelDiscoveryPage, Error>;
}

/// Applies catalog-selected deterministic recovery before semantic validation.
#[derive(Clone, Default)]
pub struct RecoveryLayer {
	discovery: Option<Arc<dyn DiscoveryProjector>>,
}
impl RecoveryLayer {
	/// Creates recovery with the exact route-scoped discovery projector.
	pub fn new(discovery: Arc<dyn DiscoveryProjector>) -> Self {
		Self { discovery: Some(discovery) }
	}

	/// Creates recovery for a route that does not advertise runtime discovery.
	pub const fn without_discovery() -> Self {
		Self { discovery: None }
	}
}
impl fmt::Debug for RecoveryLayer {
	fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
		formatter
			.debug_struct("RecoveryLayer")
			.field("discovery", &self.discovery.is_some())
			.finish()
	}
}

/// Response-recovery service retaining route-scoped immutable projectors.
#[derive(Clone)]
pub struct RecoveryService<S> {
	inner:     S,
	discovery: Option<Arc<dyn DiscoveryProjector>>,
}

impl<S> Layer<S> for RecoveryLayer {
	type Service = RecoveryService<S>;

	fn layer(&self, inner: S) -> Self::Service {
		RecoveryService { inner, discovery: self.discovery.clone() }
	}
}

impl<S> Service<LayerCall<Call>> for RecoveryService<S>
where
	S: Service<LayerCall<Call>, Response = HandshakenResponse, Error = Error> + Clone,
{
	type Error = Error;
	type Response = HandshakenResponse;

	type Future = impl Future<Output = Result<HandshakenResponse, Error>>;

	fn poll_ready(&mut self, cx: &mut Context<'_>) -> Poll<Result<(), Error>> {
		self.inner.poll_ready(cx)
	}

	fn call(&mut self, request: LayerCall<Call>) -> Self::Future {
		let replacement = self.inner.clone();
		let mut inner = mem::replace(&mut self.inner, replacement);
		let context = request.context.clone();
		let tools = match &request.payload.operation {
			OperationCall::Chat(chat) => chat.tools.clone(),
			OperationCall::Realtime(realtime) => realtime.tools.clone(),
			_ => Default::default(),
		};
		let service_tier = match &request.payload.operation {
			OperationCall::Chat(chat) => match &chat.service_tier {
				Setting::Require(tier) | Setting::Prefer(tier) => Some(tier.name.clone()),
				Setting::Unset => None,
			},
			_ => None,
		};
		let structured = match &request.payload.operation {
			OperationCall::Chat(chat) => match &chat.output {
				Setting::Require(output) => Some((output.clone(), false)),
				Setting::Prefer(output) => Some((output.clone(), true)),
				Setting::Unset => None,
			},
			_ => None,
		};
		let discovery_request = match &request.payload.operation {
			OperationCall::DiscoverModels(request) => Some(request.clone()),
			_ => None,
		};
		let discovery = self.discovery.clone();
		let plan = request.payload.execution.clone();
		async move {
			context.checkpoint(ErrorPhase::Recovery)?;
			let mut response = inner.call(request).await?;
			let structured = structured.and_then(|(output, preferred)| {
				(!preferred || !structured_preference_dropped(plan.as_deref(), &context))
					.then_some(output)
			});
			let evidence = response.body.clone();
			let handshake = response.meta.clone();
			if response.events.is_some() && response.realtime.is_some() {
				return Err(recovery_error("response.events-and-realtime-conflict", &context));
			}
			let Some(mut input) = response.events.take() else {
				if response.realtime.is_some() {
					return Ok(response);
				}
				return Err(recovery_error("response.missing-events-and-realtime", &context));
			};
			let output_context = context.clone();
			let projection_config = plan.as_ref().and_then(|plan| {
				plan.policy_model.as_ref().map(|model| {
					DialectRecoveryConfig::from_wire_policy(
						model.wire_policy.clone(),
						&plan.wire_policy,
						output_context.attempts().saturating_sub(1),
					)
				})
			});
			let harmony_guard = projection_config.as_ref().and_then(|config| {
				config
					.harmony_mitigation
					.then(|| (config.wire_policy.clone(), config.attempt))
			});
			let harmony_structured = harmony_guard.as_ref().and_then(|_| structured.clone());
			let recovery_structured = harmony_guard
				.is_none()
				.then(|| structured.clone())
				.flatten();
			let empty_policy = plan
				.as_ref()
				.and_then(|plan| plan.policy_model.as_ref())
				.map(|model| model.wire_policy.clone());
			let harmony_empty_policy = harmony_guard.as_ref().and_then(|_| empty_policy.clone());
			let mut structured_index = None;
			let mut json = recovery_structured.as_ref().and_then(|output| {
				empty_policy.clone().map(|policy| {
					let enforcement = match output {
						StructuredOutput::JsonSchema { strict: true, .. } => JsonEnforcement::Strict,
						_ => JsonEnforcement::NativeOrRepair,
					};
					JsonRepairStage::new(
						enforcement,
						JsonRepairLimits::default(),
						policy,
						output_context.attempts().saturating_sub(1),
					)
				})
			});
			let guard_reasoning = plan
				.as_ref()
				.is_some_and(|plan| semantic_loop_guard_enabled(&plan.wire_policy));
			response.events = Some(Box::pin(async_stream::stream! {
				let mut completion: Option<RawCompletion> = None;
				let mut empty = empty_policy.map(|policy| EmptyCompletionStage::new(policy, output_context.attempts().saturating_sub(1)));
				let mut reasoning_guard = guard_reasoning.then(|| ReasoningStallGuard::new(ReasoningLimits::default()));
				let mut projection = projection_config.map(|config| DialectRecoveryPipeline::new(&tools, config));
				let mut thinking_repetition = AttemptRepetitionGuard::new(RepetitionLimits::default());
				let mut text_repetition = AttemptRepetitionGuard::new(RepetitionLimits::default());
				while let Some(item) = input.next().await {
					if let Err(error) = output_context.checkpoint(ErrorPhase::Recovery) {
						output_context.cancel();
						yield Err(error);
						return;
					}
					match item {
						Err(mut error) => {
							output_context.finalize_error(&mut error);
							let error = error.committed(output_context.is_committed());
							yield Err(error);
							return;
						}
						Ok(RawEvent::Completion(terminal)) => {
							if completion.is_some() {
								yield Err(recovery_error("response.duplicate-completion", &output_context));
								return;
							}
							if let Some(mut pipeline) = projection.take() {
								let batch = if let Ok(batch) = pipeline.finish() { batch } else {
									yield Err(recovery_error("projection.finish", &output_context));
									return;
								};
								let events = match projection_events(batch, &output_context) {
									Ok(events) => events,
									Err(error) => { yield Err(error); return; },
								};
								for event in events {
									match process_chat_event(
										event,
										&mut reasoning_guard,
										&mut thinking_repetition,
										&mut text_repetition,
										&mut empty,
										&mut json,
										&mut structured_index,
										&output_context,
									) {
										Ok(Some(event)) => yield Ok(RawEvent::Chat(event)),
										Ok(None) => {},
										Err(error) => { yield Err(error); return; },
									}
								}
							}
							if let Some(signal) = thinking_repetition
								.finish_exact_cycle(OutputVisibility::Gated)
								.or_else(|| text_repetition.finish_exact_cycle(OutputVisibility::Gated))
							{
								yield Err(repetition_error(&signal, &output_context));
								return;
							}
							completion = Some(terminal);
						}
						Ok(RawEvent::ToolCallComplete { index, call }) => {
							let events = if let Some(pipeline) = projection.as_mut() {
								match project_native_call(pipeline, index, call, &output_context) {
									Ok(events) => events,
									Err(error) => { yield Err(error); return; },
								}
							} else {
								let event = match recover_tool(index, call, &tools, &output_context) {
									Ok(event) => event,
									Err(error) => { yield Err(error); return; },
								};
								vec![event]
							};
							for event in events {
								match process_chat_event(
									event,
									&mut reasoning_guard,
									&mut thinking_repetition,
									&mut text_repetition,
									&mut empty,
									&mut json,
									&mut structured_index,
									&output_context,
								) {
									Ok(Some(event)) => yield Ok(RawEvent::Chat(event)),
									Ok(None) => {},
									Err(error) => { yield Err(error); return; },
								}
							}
						}
						Ok(RawEvent::ProviderState(state)) => output_context.stage_provider_state(state),
						Ok(RawEvent::Metadata(metadata)) => output_context.observe_provider_metadata(metadata),
						Ok(RawEvent::Telemetry(telemetry)) => output_context.observe_provider_telemetry(telemetry),
						Ok(RawEvent::Failure(mut error)) => {
							output_context.finalize_error(&mut error);
							let error = error.committed(output_context.is_committed());
							yield Err(error);
							return;
						}
						Ok(RawEvent::Chat(ChatEvent::Completed(_))) => {
							yield Err(recovery_error("response.public-completion-before-finalization", &output_context));
							return;
						}
						Ok(RawEvent::Chat(event)) => {
							let events =
								match project_source_chat_event(&mut projection, event, &output_context) {
									Ok(events) => events,
									Err(error) => { yield Err(error); return; },
								};
							for event in events {
								match process_chat_event(
									event,
									&mut reasoning_guard,
									&mut thinking_repetition,
									&mut text_repetition,
									&mut empty,
									&mut json,
									&mut structured_index,
									&output_context,
								) {
									Ok(Some(event)) => yield Ok(RawEvent::Chat(event)),
									Ok(None) => {},
									Err(error) => { yield Err(error); return; },
								}
							}
						}
						Ok(RawEvent::ImageGeneration(event)) => yield Ok(RawEvent::ImageGeneration(event)),
						Ok(RawEvent::VideoGeneration(event)) => yield Ok(RawEvent::VideoGeneration(event)),
						Ok(RawEvent::Audio(chunk)) => yield Ok(RawEvent::Audio(chunk)),
						Ok(RawEvent::Transcript(event)) => yield Ok(RawEvent::Transcript(event)),
						Ok(RawEvent::Answer(body)) => yield Ok(RawEvent::Answer(body)),
						Ok(RawEvent::Control(control)) => yield Ok(RawEvent::Control(control)),
						Ok(RawEvent::NativeChunk(bytes)) => yield Ok(RawEvent::NativeChunk(bytes)),
						Ok(RawEvent::DiscoveredModels { rows, next_cursor }) => {
							match project_discovery(
								discovery.as_ref(),
								discovery_request.as_deref(),
								rows,
								next_cursor,
								&output_context,
							) {
								Ok(event) => yield Ok(event),
								Err(error) => { yield Err(error); return; },
							}
						},
					}
				}
				if let Some(terminal) = completion {
					let finalized = match finalize_completion(terminal, plan.as_deref(), service_tier.as_deref(), &handshake, evidence.evidence(), &output_context) {
						Ok(event) => event,
						Err(error) => { yield Err(error); return; },
					};
					if let Err(error) =
						finish_empty(&mut empty, &finalized, &output_context)
					{
						yield Err(error);
						return;
					}
					if let Some(output) = recovery_structured.as_ref() {
						let repaired = match finish_json(&mut json, &output_context) {
							Ok(text) => text,
							Err(error) => { yield Err(error); return; },
						};
						if let Err(error) = validate_structured_output(output, &repaired, &output_context) {
							yield Err(error);
							return;
						}
						output_context.mark_structured_output_valid();
						yield Ok(RawEvent::Chat(ChatEvent::TextDelta {
							index: structured_index.unwrap_or(0),

							text: repaired.into(),
						}));
					}
					yield Ok(RawEvent::Chat(finalized));
				}
			}));
			if let Some((wire_policy, attempt)) = harmony_guard {
				let events = response
					.events
					.take()
					.expect("recovery stream was installed immediately above");
				response.events = Some(harmony_audit_stream(
					events,
					context,
					wire_policy,
					attempt,
					harmony_structured,
					harmony_empty_policy,
				));
			}
			Ok(response)
		}
	}
}

fn harmony_audit_stream(
	mut input: RawEventStream,
	context: ExecutionContext,
	wire_policy: WirePolicyId,
	attempt: u32,
	structured: Option<StructuredOutput>,
	empty_policy: Option<WirePolicyId>,
) -> RawEventStream {
	Box::pin(async_stream::stream! {
		let mut held = Vec::new();
		let mut held_bytes = 0_u64;
		let limit = context.budget().max_provisional_bytes;
		while let Some(item) = input.next().await {
			match item {
				Ok(RawEvent::Chat(event)) => {
					if event.is_workflow_control() {
						yield Err(recovery_error("harmony.workflow-control-incompatible", &context));
						return;
					}
					held_bytes = held_bytes.saturating_add(harmony_event_bytes(&event));
					if held_bytes > limit {
						yield Err(recovery_error("harmony.provisional-output-limit", &context));
						return;
					}
					let terminal = matches!(event, ChatEvent::Completed(_));
					held.push(event);
					if !terminal {
						continue;
					}
					let (mut normalized, recoveries) =
						match normalize_harmony_attempt(held, &wire_policy, attempt) {
							Ok(normalized) => normalized,
							Err(leak) => {
								record_recovery(&context, leak.recovery);
								yield Err(recovery_error("harmony.provable-leak", &context));
								return;
							},
						};
					record_recoveries(&context, recoveries);
					if let Some(policy) = empty_policy.as_ref() {
						normalized =
							match validate_harmony_empty(normalized, policy.clone(), attempt, &context) {
								Ok(events) => events,
								Err(error) => {
									yield Err(error);
									return;
								},
							};
					}
					if let Some(output) = structured.as_ref() {
						let text = harmony_structured_text(&normalized);
						if let Err(error) = validate_structured_output(output, &text, &context) {
							yield Err(error);
							return;
						}
						context.mark_structured_output_valid();
					}
					for event in &mut normalized {
						if let ChatEvent::Completed(completion) = event {
							*completion.receipt = context.receipt();
						}
					}
					for event in normalized {
						yield Ok(RawEvent::Chat(event));
					}
					return;
				},
				Ok(_) => {
					yield Err(recovery_error("harmony.non-chat-event", &context));
					return;
				},
				Err(error) => {
					match normalize_harmony_attempt(held, &wire_policy, attempt) {
						Err(leak) => {
							record_recovery(&context, leak.recovery);
							yield Err(recovery_error("harmony.provable-leak", &context));
						},
						Ok((_, recoveries)) if !recoveries.is_empty() => {
							record_recoveries(&context, recoveries);
							yield Err(recovery_error("harmony.upstream-failed-after-repair", &context));
						},
						Ok(_) => yield Err(error),
					}
					return;
				},
			}
		}
		yield Err(recovery_error("harmony.missing-completion", &context));
	})
}

fn validate_harmony_empty(
	events: Vec<ChatEvent>,
	policy: WirePolicyId,
	attempt: u32,
	context: &ExecutionContext,
) -> Result<Vec<ChatEvent>, Error> {
	let mut stage = Some(EmptyCompletionStage::new(policy, attempt));
	let mut output = Vec::with_capacity(events.len());
	let mut completion = None;
	for event in events {
		if matches!(event, ChatEvent::Completed(_)) {
			completion = Some(event);
			continue;
		}
		output.push(observe_empty(&mut stage, event, context)?);
	}
	let completion =
		completion.ok_or_else(|| recovery_error("harmony.missing-completion", context))?;
	finish_empty(&mut stage, &completion, context)?;
	output.push(completion);
	Ok(output)
}

fn harmony_structured_text(events: &[ChatEvent]) -> String {
	let bytes = events.iter().fold(0_usize, |total, event| {
		total.saturating_add(match event {
			ChatEvent::TextDelta { text, .. } => text.len(),
			_ => 0,
		})
	});
	let mut output = String::with_capacity(bytes);
	for event in events {
		if let ChatEvent::TextDelta { text, .. } = event {
			output.push_str(text.as_str());
		}
	}
	output
}

fn harmony_event_bytes(event: &ChatEvent) -> u64 {
	let bytes = match event {
		ChatEvent::TextDelta { text, .. } | ChatEvent::ThinkingDelta { text, .. } => text.len(),
		ChatEvent::ToolArgumentsDelta { bytes, .. } => bytes.len(),
		ChatEvent::ToolCallReady { call, .. } => call.name.len(),
		ChatEvent::ToolCallStarted { name, .. } => name.len(),
		ChatEvent::Started(_)
		| ChatEvent::BlockStarted { .. }
		| ChatEvent::Artifact { .. }
		| ChatEvent::Usage(_)
		| ChatEvent::WorkflowAction(_)
		| ChatEvent::WorkflowResume(_)
		| ChatEvent::WorkflowCancelled { .. }
		| ChatEvent::Completed(_) => 0,
	};
	u64::try_from(bytes).unwrap_or(u64::MAX)
}

fn structured_preference_dropped(plan: Option<&ExecutionPlan>, context: &ExecutionContext) -> bool {
	let decision_dropped = plan.is_some_and(|plan| {
		plan.decisions.iter().any(|decision| {
			matches!(
				decision,
				NegotiationDecision::Dropped { feature, .. }
					if feature.0.as_str() == "chat.structured_output"
			)
		})
	});
	decision_dropped
		|| context.receipt().adjustments.iter().any(|adjustment| {
			matches!(
				adjustment,
				Adjustment::Dropped { feature, .. }
					if matches!(
						feature.0.as_str(),
						"chat.structured_output" | "response_format.grammar"
					)
			)
		})
}

fn project_discovery(
	projector: Option<&Arc<dyn DiscoveryProjector>>,
	request: Option<&DiscoveryRequest>,
	rows: Vec<omp_catalog::DiscoveredModel>,
	next_cursor: Option<Str>,
	context: &ExecutionContext,
) -> Result<RawEvent, Error> {
	let result = match (projector, request) {
		(Some(projector), Some(request)) => projector
			.project(request, rows, next_cursor)
			.map(|page| RawEvent::Answer(AnswerBody::Models(page))),
		(None, _) => Err(recovery_error("discovery.projector-missing", context)),
		(Some(_), None) => Err(recovery_error("discovery.request-missing", context)),
	};
	result.map_err(|mut error| {
		context.finalize_error(&mut error);
		error
	})
}
const fn semantic_loop_guard_enabled(policy: &omp_catalog::WirePolicy) -> bool {
	policy.reasoning.loop_guard_profile.is_some()
}

fn projection_events(
	batch: ProjectionBatch,
	context: &ExecutionContext,
) -> Result<Vec<ChatEvent>, Error> {
	record_recoveries(context, batch.evidence);
	if let Some(failure) = batch.failure {
		let reason = match failure {
			ProjectionFailure::ToolAssemblyRejected => "tool.assembly-rejected",
			ProjectionFailure::FabricatedToolResult => "projection.fabricated-tool-result",
			ProjectionFailure::UnpairedToolResult => "projection.unpaired-tool-result",
			ProjectionFailure::InvalidUtf8 => "projection.invalid-utf8",
			ProjectionFailure::ToolRegistrationRejected => "projection.tool-registration-rejected",
		};
		return Err(recovery_error(reason, context));
	}
	Ok(batch.events)
}

fn project_source_chat_event(
	projection: &mut Option<DialectRecoveryPipeline<'_>>,
	event: ChatEvent,
	context: &ExecutionContext,
) -> Result<Vec<ChatEvent>, Error> {
	let Some(pipeline) = projection.as_mut() else {
		return Ok(vec![event]);
	};
	let batch = match event {
		ChatEvent::TextDelta { text, .. } => pipeline
			.push_text(bytes::Bytes::copy_from_slice(text.as_bytes()))
			.map_err(|_| recovery_error("projection.text", context))?,
		ChatEvent::BlockStarted { kind: BlockKind::Text | BlockKind::ToolCall, .. }
		| ChatEvent::ToolCallStarted { .. }
		| ChatEvent::ToolArgumentsDelta { .. }
		| ChatEvent::ToolCallReady { .. } => ProjectionBatch::default(),
		event => pipeline.push_passthrough(event),
	};
	projection_events(batch, context)
}

fn project_native_call(
	projection: &mut DialectRecoveryPipeline<'_>,
	index: u32,
	call: UnvalidatedToolCall,
	context: &ExecutionContext,
) -> Result<Vec<ChatEvent>, Error> {
	let name = bytes::Bytes::copy_from_slice(call.name.as_bytes());
	let batches = [
		projection.push_native(ToolFragment::Start {
			source_index: index,
			id: Some(call.id),
			name,
			input_kind: call.input_kind,
		}),
		projection.push_native(ToolFragment::ArgumentsDelta {
			source_index: index,
			bytes:        call.arguments,
		}),
		projection.push_native(ToolFragment::End { source_index: index }),
	];
	let mut events = Vec::new();
	for batch in batches {
		events.extend(projection_events(batch, context)?);
	}
	if !events
		.iter()
		.any(|event| matches!(event, ChatEvent::ToolCallReady { .. }))
	{
		return Err(recovery_error("tool.assembly-rejected", context));
	}
	Ok(events)
}

fn process_chat_event(
	event: ChatEvent,
	reasoning_guard: &mut Option<ReasoningStallGuard>,
	thinking_repetition: &mut AttemptRepetitionGuard,
	text_repetition: &mut AttemptRepetitionGuard,
	empty: &mut Option<EmptyCompletionStage>,
	json: &mut Option<JsonRepairStage>,
	structured_index: &mut Option<u32>,
	context: &ExecutionContext,
) -> Result<Option<ChatEvent>, Error> {
	observe_reasoning(reasoning_guard, thinking_repetition, text_repetition, &event, context)?;
	let event = observe_empty(empty, event, context)?;
	if let ChatEvent::TextDelta { index, text } = &event
		&& let Some(stage) = json.as_mut()
	{
		structured_index.get_or_insert(*index);
		stage
			.push(bytes::Bytes::copy_from_slice(text.as_bytes()), &mut |_| {})
			.map_err(|_| structured_error("structured-output.repair-input", context))?;
		return Ok(None);
	}
	Ok(Some(event))
}

fn observe_reasoning(
	guard: &mut Option<ReasoningStallGuard>,
	thinking_repetition: &mut AttemptRepetitionGuard,
	text_repetition: &mut AttemptRepetitionGuard,
	event: &ChatEvent,
	context: &ExecutionContext,
) -> Result<(), Error> {
	let exact = match event {
		ChatEvent::ThinkingDelta { text, .. } => {
			thinking_repetition.observe_exact_cycle(text, OutputVisibility::Gated)
		},
		ChatEvent::TextDelta { text, .. } => {
			text_repetition.observe_exact_cycle(text, OutputVisibility::Gated)
		},
		_ => None,
	};
	if let Some(signal) = exact {
		return Err(repetition_error(&signal, context));
	}
	let Some(guard) = guard.as_mut() else {
		return Ok(());
	};
	let observation = match event {
		ChatEvent::ThinkingDelta { text, .. } => ReasoningObservation {
			delta:             text,
			semantic_progress: false,
			visibility:        OutputVisibility::Gated,
		},
		ChatEvent::TextDelta { .. }
		| ChatEvent::ToolCallReady { .. }
		| ChatEvent::Artifact { .. } => ReasoningObservation {
			delta:             "",
			semantic_progress: true,
			visibility:        OutputVisibility::Gated,
		},
		_ => return Ok(()),
	};
	let Some(signal) = guard.observe(observation) else {
		return Ok(());
	};
	Err(repetition_error(&signal, context))
}

fn repetition_error(signal: &LoopSignal, context: &ExecutionContext) -> Error {
	context.with_receipt(|receipt| {
		receipt
			.recoveries
			.push(recovery_record(context.attempts().saturating_sub(1), signal));
	});
	Error::new(
		ErrorKind::RepeatedReasoning,
		ErrorPhase::Recovery,
		RetryAction::SemanticRetry,
		context.receipt(),
	)
	.committed(context.is_committed())
	.detail(ErrorDetail::protocol(ReasonId::new_static("reasoning.loop-detected")))
}

fn observe_empty(
	stage: &mut Option<EmptyCompletionStage>,
	event: ChatEvent,
	context: &ExecutionContext,
) -> Result<ChatEvent, Error> {
	let Some(stage) = stage.as_mut() else {
		return Ok(event);
	};
	let mut output = None;
	stage
		.push(EmptyInput::Event(Box::new(event)), &mut |event| output = Some(event))
		.map_err(|_| recovery_error("empty-completion.observer", context))?;
	match output {
		Some(EmptyEvent::Event(event)) => Ok(*event),
		Some(EmptyEvent::Empty(_)) | None => {
			Err(recovery_error("empty-completion.invalid-observer-output", context))
		},
	}
}

fn finish_empty(
	stage: &mut Option<EmptyCompletionStage>,
	completion: &ChatEvent,
	context: &ExecutionContext,
) -> Result<(), Error> {
	let Some(stage) = stage.as_mut() else {
		return Ok(());
	};
	let mut empty = None;
	stage
		.push(EmptyInput::Completed, &mut |event| {
			if let EmptyEvent::Empty(classification) = event {
				empty = Some(classification);
			}
		})
		.map_err(|_| recovery_error("empty-completion.classification", context))?;
	stage
		.finish(&mut |_| {})
		.map_err(|_| recovery_error("empty-completion.finish", context))?;
	let Some(classification) = empty else {
		return Ok(());
	};
	if matches!(
		completion,
		ChatEvent::Completed(Completion { reason: FinishReason::Other(reason), .. })
			if reason.as_str() == "pause_turn"
	) {
		return Ok(());
	}
	context.with_receipt(|receipt| receipt.recoveries.push(classification.recovery));
	let (kind, action, reason) = match classification.kind {
		EmptyCompletionKind::ThinkingOnly => {
			(ErrorKind::EmptyOutput, RetryAction::Never, "empty-completion.thought-only")
		},
		EmptyCompletionKind::NoContent
		| EmptyCompletionKind::WhitespaceOnly
		| EmptyCompletionKind::EmptyBlocks => {
			(ErrorKind::EmptyCompletion, RetryAction::SemanticRetry, "empty-completion.classified")
		},
	};
	Err(
		Error::new(kind, ErrorPhase::Recovery, action, context.receipt())
			.committed(context.is_committed())
			.detail(ErrorDetail::protocol(ReasonId::new(reason))),
	)
}

fn finish_json(
	stage: &mut Option<JsonRepairStage>,
	context: &ExecutionContext,
) -> Result<String, Error> {
	let Some(stage) = stage.as_mut() else {
		return Err(structured_error("structured-output.repair-policy-missing", context));
	};
	let mut document = None;
	stage
		.finish(&mut |value| document = Some(value))
		.map_err(|_| structured_error("structured-output.invalid-json", context))?;
	let document =
		document.ok_or_else(|| structured_error("structured-output.missing-document", context))?;
	if let Some(recovery) = document.recovery {
		record_recovery(context, recovery);
	}
	String::from_utf8(document.bytes.to_vec())
		.map_err(|_| structured_error("structured-output.invalid-utf8", context))
}

fn validate_structured_output(
	output: &StructuredOutput,
	text: &str,
	context: &ExecutionContext,
) -> Result<(), Error> {
	let value = serde_json::from_str::<serde_json::Value>(text)
		.map_err(|_| structured_error("structured-output.invalid-json", context))?;
	match output {
		StructuredOutput::JsonObject if value.is_object() => Ok(()),
		StructuredOutput::JsonObject => {
			Err(structured_error("structured-output.not-object", context))
		},
		StructuredOutput::JsonSchema { schema, strict, .. } => {
			validate_schema(schema.as_value(), &value, *strict, ToolAssemblyLimits::default())
				.map_err(|_| structured_error("structured-output.schema-violation", context))
		},
		StructuredOutput::Regex(_) | StructuredOutput::Lark(_) | StructuredOutput::Ebnf(_) => {
			Err(structured_error("structured-output.validator-unavailable", context))
		},
	}
}

fn structured_error(reason: &'static str, context: &ExecutionContext) -> Error {
	Error::new(
		ErrorKind::StructuredOutputFailure,
		ErrorPhase::Recovery,
		RetryAction::SemanticRetry,
		context.receipt(),
	)
	.committed(context.is_committed())
	.detail(ErrorDetail::protocol(ReasonId::new(reason)))
}
fn finalize_completion(
	terminal: RawCompletion,
	plan: Option<&ExecutionPlan>,
	service_tier: Option<&str>,
	handshake: &HandshakeMeta,
	body: AttemptBodyEvidence,
	context: &ExecutionContext,
) -> Result<ChatEvent, Error> {
	let plan = plan.ok_or_else(|| recovery_error("completion.missing-execution-plan", context))?;
	let serving_model = plan
		.model
		.clone()
		.ok_or_else(|| recovery_error("completion.missing-serving-model", context))?;
	let model = plan
		.policy_model
		.as_ref()
		.ok_or_else(|| recovery_error("completion.missing-pricing-model", context))?;
	if model
		.pricing
		.components
		.iter()
		.any(|component| component.unit == PriceUnit::McharInput)
		|| model.pricing.tiers.iter().any(|tier| {
			tier
				.components
				.iter()
				.any(|component| component.unit == PriceUnit::McharInput)
		}) {
		return Err(recovery_error("completion.character-usage-unavailable", context));
	}
	let mut usage = terminal.usage;
	usage.premium_requests_millionths = context.premium_requests_millionths();
	let dimensions = billable_dimensions(&usage);
	let nanos = price_usage(&model.pricing, dimensions, service_tier)
		.map_err(|_| recovery_error("completion.pricing-overflow", context))?
		.as_nanos();
	let micro_usd = i128::from(nanos.div_ceil(1_000));
	let cost = Cost::from_micro_usd(micro_usd);
	context.charge_tokens(usage.input_tokens, usage.output_tokens)?;
	context.charge_cost(cost)?;
	let index = context.attempts().saturating_sub(1);
	let routing = context.account_routing().unwrap_or_default();
	context.with_receipt(|receipt| {
		if !receipt
			.attempts
			.iter()
			.any(|attempt| attempt.index == index)
		{
			receipt.record_attempt(AttemptReceipt {
				index,
				hidden: false,
				provider: Some(plan.provider.clone()),
				route: Some(plan.route.clone()),
				account: routing.account,
				principal: routing.principal,
				body,
				outcome: AttemptOutcome::Succeeded,
				usage,
				cost,
				provider_evidence: ProviderEvidence {
					request_id: handshake
						.provider_request_id
						.clone()
						.or_else(|| context.provider_response_id()),
					status:     handshake.status,
					code:       None,
					summary:    None,
				},
				elapsed: context.attempt_elapsed(index),
			});
		}
		let _ = receipt.settle_serving_model(ServingModelAttribution {
			provider: plan.provider.clone(),
			model:    serving_model,
			attempt:  index,
		});
		receipt.timings.total = context.elapsed();
		receipt.timings.completed_at = Some(SystemTime::now());
	});
	let receipt = context.receipt();
	Ok(ChatEvent::Completed(Completion {
		reason: terminal.reason,
		blocks: terminal.blocks,
		usage,
		receipt: receipt.into(),
	}))
}

fn price_usage(
	pricing: &omp_catalog::Pricing,
	dimensions: UsageDimensions,
	service_tier: Option<&str>,
) -> Result<omp_catalog::NanoUsd, omp_catalog::CostError> {
	let multiplier = service_tier.and_then(|tier| pricing.service_tier_multiplier(tier));
	pricing.cost_with_multiplier(dimensions, multiplier)
}

fn billable_dimensions(usage: &crate::receipt::Usage) -> UsageDimensions {
	UsageDimensions {
		input_tokens:          usage.input_tokens,
		output_tokens:         usage.output_tokens,
		cache_read_tokens:     usage.cache_read_tokens,
		cache_write_tokens:    usage.cache_write_tokens,
		cache_write_1h_tokens: usage.cache_write_1h_tokens,
		images:                u64::from(usage.images),
		video_seconds:         usage.video_ms.div_ceil(1_000),
		audio_seconds:         usage
			.audio_input_ms
			.saturating_add(usage.audio_output_ms)
			.div_ceil(1_000),
		input_characters:      0,
		requests:              1,
	}
}

fn recover_tool(
	index: u32,
	call: UnvalidatedToolCall,
	definitions: &[ToolDefinition],
	context: &ExecutionContext,
) -> Result<ChatEvent, Error> {
	if !definitions
		.iter()
		.any(|definition| definition.name == call.name)
	{
		return Err(recovery_error("tool.not-declared", context));
	}
	let mut assembler = ToolAssembler::new(
		definitions,
		ToolAssemblyLimits::default(),
		context.attempts().saturating_sub(1),
	);
	let mut ready = None;
	for fragment in [
		ToolFragment::Start {
			source_index: index,
			id:           Some(call.id),
			name:         bytes::Bytes::copy_from_slice(call.name.as_bytes()),
			input_kind:   call.input_kind,
		},
		ToolFragment::ArgumentsDelta { source_index: index, bytes: call.arguments },
		ToolFragment::End { source_index: index },
	] {
		for event in assembler.push(fragment) {
			match event {
				ToolAssemblyEvent::Ready { call, .. } => ready = Some(call),
				ToolAssemblyEvent::Rejected { .. } => {
					record_recoveries(context, assembler.take_evidence());
					return Err(recovery_error("tool.assembly-rejected", context));
				},
				ToolAssemblyEvent::Started { .. } | ToolAssemblyEvent::ArgumentsDelta { .. } => {},
			}
		}
	}
	record_recoveries(context, assembler.take_evidence());
	let call = ready.ok_or_else(|| recovery_error("tool.assembly-incomplete", context))?;
	Ok(ChatEvent::ToolCallReady { index, call })
}

fn record_recoveries(
	context: &ExecutionContext,
	recoveries: impl IntoIterator<Item = RecoveryRecord>,
) {
	for recovery in recoveries {
		record_recovery(context, recovery);
	}
}

fn record_recovery(context: &ExecutionContext, recovery: RecoveryRecord) {
	if !matches!(
		recovery.rule.0.as_str(),
		"tool.complete-schema-valid" | "tool.complete-freeform-valid"
	) {
		tracing::warn!(
			recovery_kind = recovery.kind.as_str(),
			recovery_rule = recovery.rule.0.as_str(),
			repair_steps = recovery.steps,
			"provider output required bounded repair"
		);
	}
	context.with_receipt(|receipt| receipt.recoveries.push(recovery));
}

fn recovery_error(reason: &'static str, context: &ExecutionContext) -> Error {
	Error::new(
		ErrorKind::MalformedModelOutput,
		ErrorPhase::Recovery,
		RetryAction::SemanticRetry,
		context.receipt(),
	)
	.committed(context.is_committed())
	.detail(ErrorDetail::protocol(ReasonId::new(reason)))
}

#[cfg(test)]
mod tests {

	use omp_catalog::id::WirePolicyId;
	use omp_core::sf;

	use super::*;
	use crate::{
		call::DiscoveryRequest,
		layer::{ExecutionBudget, ExecutionContext},
	};

	struct TestProjector {
		fail: bool,
	}
	fn edit_grammar_definition() -> ToolDefinition {
		ToolDefinition {
			name:        sf!("edit"),
			description: None,
			input:       crate::call::ToolInputConstraint::Grammar {
				grammar:  crate::call::ToolGrammar {
					syntax:     crate::call::ToolGrammarSyntax::Lark,
					definition: sf!("start: LF"),
				},
				fallback: crate::call::OpaqueJson::new(serde_json::json!({
					"type": "object",
					"properties": {"input": {"type": "string"}},
					"required": ["input"],
				})),
			},
		}
	}

	#[tokio::test]
	async fn harmony_leak_rejection_is_transactional_and_retryable() {
		let context =
			ExecutionContext::new(ExecutionBudget { max_attempts: 3, ..ExecutionBudget::default() });
		let completion = ChatEvent::Completed(Completion {
			reason:  FinishReason::Stop,
			blocks:  1,
			usage:   Default::default(),
			receipt: Default::default(),
		});
		let source: RawEventStream = Box::pin(futures::stream::iter(vec![
			Ok(RawEvent::Chat(ChatEvent::BlockStarted { index: 0, kind: BlockKind::Text })),
			Ok(RawEvent::Chat(ChatEvent::TextDelta {
				index: 0,
				text:  sf!("safe prefix analysis to=functions.edit code contaminated"),
			})),
			Ok(RawEvent::Chat(completion)),
		]));
		let mut audited =
			harmony_audit_stream(source, context, WirePolicyId::new("codex"), 1, None, None);
		let error = match audited.next().await.expect("terminal error") {
			Err(error) => error,
			Ok(_) => panic!("provable leak must reject the provisional attempt"),
		};
		assert_eq!(error.action, RetryAction::SemanticRetry);
		assert!(!error.committed);
		assert!(matches!(error.receipt().recoveries.as_slice(), [RecoveryRecord {
			attempt: 1,
			kind: crate::receipt::RecoveryKind::HarmonyLeakDetection,
			..
		}]));
		assert!(audited.next().await.is_none(), "no contaminated event becomes visible");
	}

	#[tokio::test]
	async fn harmony_analysis_only_completion_remains_empty_output() {
		let context = ExecutionContext::new(ExecutionBudget::default());
		let leaked = concat!("<", "|channel|>analysis<|message|>private only<|end|>");
		let source: RawEventStream = Box::pin(futures::stream::iter(vec![
			Ok(RawEvent::Chat(ChatEvent::BlockStarted { index: 0, kind: BlockKind::Text })),
			Ok(RawEvent::Chat(ChatEvent::TextDelta { index: 0, text: Str::new(leaked) })),
			Ok(RawEvent::Chat(ChatEvent::Completed(Completion {
				reason:  FinishReason::Stop,
				blocks:  1,
				usage:   Default::default(),
				receipt: Default::default(),
			}))),
		]));
		let mut audited = harmony_audit_stream(
			source,
			context,
			WirePolicyId::new("codex"),
			0,
			None,
			Some(WirePolicyId::new("codex")),
		);
		let error = match audited.next().await.expect("terminal error") {
			Err(error) => error,
			Ok(_) => panic!("thinking-only output must stay terminal"),
		};
		assert_eq!(error.kind, ErrorKind::EmptyOutput);
		assert_eq!(error.action, RetryAction::Never);
		assert!(
			error
				.receipt()
				.recoveries
				.iter()
				.any(|record| record.kind == crate::receipt::RecoveryKind::HarmonyLeakRepair)
		);
	}

	#[test]
	fn billable_dimensions_do_not_double_charge_cached_or_reasoning_subsets() {
		let usage = crate::receipt::Usage {
			input_tokens: 70,
			output_tokens: 30,
			reasoning_tokens: 20,
			cache_read_tokens: 40,
			..Default::default()
		};
		let dimensions = billable_dimensions(&usage);
		assert_eq!(dimensions.input_tokens, 70);
		assert_eq!(dimensions.cache_read_tokens, 40);
		assert_eq!(dimensions.output_tokens, 30);
	}

	#[test]
	fn selected_service_tier_multiplier_applies_without_provider_branching() {
		let pricing = omp_catalog::Pricing::new(
			vec![omp_catalog::Price { unit: omp_catalog::PriceUnit::Request, nanos_usd: 1_000 }],
			Vec::new(),
		)
		.expect("valid pricing")
		.with_service_tiers(vec![omp_catalog::ServiceTierPrice {
			tier:       sf!("priority"),
			multiplier: omp_catalog::PremiumMultiplier::from_millionths(2_000_000),
		}]);
		let dimensions = UsageDimensions { requests: 1, ..UsageDimensions::default() };
		assert_eq!(
			price_usage(&pricing, dimensions, Some("priority"))
				.expect("tier cost")
				.as_nanos(),
			2_000
		);
		assert_eq!(
			price_usage(&pricing, dimensions, Some("unpriced-tier"))
				.expect("base cost")
				.as_nanos(),
			1_000
		);
	}

	#[test]
	fn live_dialect_projection_suppresses_source_text_blocks_and_avoids_index_collisions() {
		let mut policy = omp_catalog::WirePolicy::baseline();
		policy.streaming.markup_healing_pattern = Some(omp_catalog::StreamMarkupHealingPattern::Qwen);
		let definitions = [edit_grammar_definition()];
		let config =
			DialectRecoveryConfig::from_wire_policy(WirePolicyId::new("qwen-wire"), &policy, 0);
		let mut projection = Some(DialectRecoveryPipeline::new(&definitions, config));
		let context = ExecutionContext::new(ExecutionBudget::default());
		let thinking = project_source_chat_event(
			&mut projection,
			ChatEvent::BlockStarted { index: 0, kind: BlockKind::Thinking },
			&context,
		)
		.expect("thinking projects");
		assert!(matches!(thinking.as_slice(), [ChatEvent::BlockStarted {
			index: 0,
			kind:  BlockKind::Thinking,
		}]));
		let source_text_start = project_source_chat_event(
			&mut projection,
			ChatEvent::BlockStarted { index: 1, kind: BlockKind::Text },
			&context,
		)
		.expect("source text start is handled");
		assert!(source_text_start.is_empty());
		let mut recovered = project_source_chat_event(
			&mut projection,
			ChatEvent::TextDelta {
				index: 1,
				text:  sf!(r#"<tool_calls><edit input="x" /></tool_calls>"#),
			},
			&context,
		)
		.expect("configured dialect projects");
		let terminal = projection
			.as_mut()
			.expect("pipeline")
			.finish()
			.expect("projection finishes");
		recovered.extend(projection_events(terminal, &context).expect("terminal batch"));
		assert!(recovered.iter().any(
			|event| matches!(event, ChatEvent::ToolCallReady { index: 1, call } if call.name == "edit")
		));
		assert!(
			context
				.receipt()
				.recoveries
				.iter()
				.any(|record| record.rule.0.as_str() == "dialect/qwen-wire/qwen-xml")
		);
	}

	#[test]
	fn native_complete_call_runs_through_the_shared_projector() {
		let definitions = [edit_grammar_definition()];
		let config = DialectRecoveryConfig::from_wire_policy(
			WirePolicyId::new("plain-wire"),
			&omp_catalog::WirePolicy::baseline(),
			0,
		);
		let mut projection = DialectRecoveryPipeline::new(&definitions, config);
		let context = ExecutionContext::new(ExecutionBudget::default());
		let events = project_native_call(
			&mut projection,
			4,
			UnvalidatedToolCall {
				id:         crate::id::ToolCallId::new("call-edit"),
				name:       sf!("edit"),
				input_kind: crate::codec::ToolInputKind::Json,
				arguments:  bytes::Bytes::from_static(br#"{"input":"x"}"#),
			},
			&context,
		)
		.expect("native call projects");
		assert!(matches!(
			events.as_slice(),
			[
				ChatEvent::BlockStarted { index: 0, kind: BlockKind::ToolCall },
				ChatEvent::ToolCallStarted { index: 0, .. },
				ChatEvent::ToolArgumentsDelta { index: 0, .. },
				ChatEvent::ToolCallReady { index: 0, call }
			] if call.arguments.as_value() == &serde_json::json!({"input": "x"})
		));
		assert!(
			context
				.receipt()
				.recoveries
				.iter()
				.any(|record| record.rule.0.as_str() == "tool.complete-schema-valid")
		);
	}

	#[test]
	fn thinking_loop_guard_matches_pi_behavior() {
		let mut policy = omp_catalog::WirePolicy::baseline();
		policy.reasoning.loop_guard_profile = None;
		assert!(!semantic_loop_guard_enabled(&policy));

		policy.reasoning.loop_guard_profile = Some(omp_catalog::ThinkingLoopGuardProfile::Gemini);
		assert!(semantic_loop_guard_enabled(&policy));
		policy.reasoning.loop_guard_profile = Some(omp_catalog::ThinkingLoopGuardProfile::DeepSeek);
		assert!(semantic_loop_guard_enabled(&policy));
		policy.reasoning.loop_guard_profile = Some(omp_catalog::ThinkingLoopGuardProfile::Xai);
		assert!(semantic_loop_guard_enabled(&policy));
	}

	#[test]
	fn grammar_tool_recovers_the_schema_lowered_json_wire_form() {
		let context = ExecutionContext::new(ExecutionBudget::default());
		let call = UnvalidatedToolCall {
			id:         crate::id::ToolCallId::new("call-edit"),
			name:       sf!("edit"),
			input_kind: crate::codec::ToolInputKind::Json,
			arguments:  bytes::Bytes::from_static(br#"{"input":"PUT 1.=1:"}"#),
		};
		let event = recover_tool(3, call, &[edit_grammar_definition()], &context)
			.expect("fallback JSON wire form must recover");
		let ChatEvent::ToolCallReady { index: 3, call } = event else {
			panic!("expected a ready call: {event:?}");
		};
		assert_eq!(call.arguments.as_value(), &serde_json::json!({"input": "PUT 1.=1:"}));
	}

	#[test]
	fn grammar_tool_recovers_the_freeform_wire_form_into_the_canonical_object() {
		let context = ExecutionContext::new(ExecutionBudget::default());
		let text = "[src/a.rs#1A2B]\nPUT 1.=1:\n+replacement";
		let call = UnvalidatedToolCall {
			id:         crate::id::ToolCallId::new("call-edit"),
			name:       sf!("edit"),
			input_kind: crate::codec::ToolInputKind::Freeform,
			arguments:  bytes::Bytes::copy_from_slice(text.as_bytes()),
		};
		let event = recover_tool(0, call, &[edit_grammar_definition()], &context)
			.expect("freeform wire form must recover");
		let ChatEvent::ToolCallReady { call, .. } = event else {
			panic!("expected a ready call: {event:?}");
		};
		assert_eq!(call.arguments.as_value(), &serde_json::json!({"input": text}));
	}
	#[test]
	fn dropped_preferred_structured_output_disables_repair() {
		let context = ExecutionContext::new(ExecutionBudget::default());
		context.with_receipt(|receipt| {
			receipt.adjustments.push(Adjustment::Dropped {
				feature: crate::receipt::FeatureId(sf!("chat.structured_output")),
				reason:  ReasonId(sf!("provider-dropped-preference")),
			});
		});
		assert!(structured_preference_dropped(None, &context));
	}

	impl DiscoveryProjector for TestProjector {
		fn project(
			&self,
			_: &DiscoveryRequest,
			_: Vec<omp_catalog::DiscoveredModel>,
			next_cursor: Option<Str>,
		) -> Result<ModelDiscoveryPage, Error> {
			if self.fail {
				return Err(Error::new(
					ErrorKind::MalformedModelOutput,
					ErrorPhase::Recovery,
					RetryAction::Never,
					Default::default(),
				));
			}
			Ok(ModelDiscoveryPage { models: Vec::new(), next_cursor })
		}
	}

	fn request() -> DiscoveryRequest {
		DiscoveryRequest {
			provider:  None,
			route:     None,
			cursor:    None,
			page_size: 10,
			operation: None,
		}
	}

	fn finish_empty_error(event: Option<ChatEvent>) -> Error {
		let context = ExecutionContext::new(ExecutionBudget::default());
		let mut stage = Some(EmptyCompletionStage::new(WirePolicyId::new("wire"), 0));
		if let Some(event) = event {
			observe_empty(&mut stage, event, &context).expect("empty observer accepts chat event");
		}
		let completion = ChatEvent::Completed(Completion {
			reason:  FinishReason::Stop,
			blocks:  0,
			usage:   Default::default(),
			receipt: Default::default(),
		});
		finish_empty(&mut stage, &completion, &context)
			.expect_err("empty completion must fail recovery")
	}

	#[test]
	fn pause_turn_accepts_an_empty_completion() {
		let context = ExecutionContext::new(ExecutionBudget::default());
		let mut stage = Some(EmptyCompletionStage::new(WirePolicyId::new("wire"), 0));
		let completion = ChatEvent::Completed(Completion {
			reason:  FinishReason::Other(sf!("pause_turn")),
			blocks:  0,
			usage:   Default::default(),
			receipt: Default::default(),
		});
		assert!(finish_empty(&mut stage, &completion, &context).is_ok());
	}

	#[test]
	fn thought_only_completion_requires_session_continuation_without_replay() {
		let error =
			finish_empty_error(Some(ChatEvent::ThinkingDelta { index: 0, text: "reasoning".into() }));

		assert_eq!(error.kind, ErrorKind::EmptyOutput);
		assert_eq!(error.action, RetryAction::Never);
		assert!(matches!(
			error.detail_ref(),
			Some(ErrorDetail::Protocol { reason })
				if reason.0.as_str() == "empty-completion.thought-only"
		));
	}

	#[test]
	fn eventless_completion_remains_semantically_retryable() {
		let error = finish_empty_error(None);

		assert_eq!(error.kind, ErrorKind::EmptyCompletion);
		assert_eq!(error.action, RetryAction::SemanticRetry);
		assert!(matches!(
			error.detail_ref(),
			Some(ErrorDetail::Protocol { reason })
				if reason.0.as_str() == "empty-completion.classified"
		));
	}

	#[test]
	fn exact_text_cycles_are_guarded_without_provider_opt_in() {
		let cycle = "shipped delivered verified validated approved accepted merged deployed live \
		             operational successful excellent perfect final absolute total whole full \
		             entire complete done finished";
		let runaway = cycle.repeat(8);
		let context =
			ExecutionContext::new(ExecutionBudget { max_attempts: 3, ..ExecutionBudget::default() });
		let mut reasoning = None;
		let mut thinking_repetition = AttemptRepetitionGuard::new(RepetitionLimits::default());
		let mut text_repetition = AttemptRepetitionGuard::new(RepetitionLimits::default());
		let mut failure = None;
		for chunk in runaway.as_bytes().chunks(23) {
			let event = ChatEvent::TextDelta {
				index: 0,
				text:  str::from_utf8(chunk).expect("ASCII fixture").into(),
			};
			if let Err(error) = observe_reasoning(
				&mut reasoning,
				&mut thinking_repetition,
				&mut text_repetition,
				&event,
				&context,
			) {
				failure = Some(error);
				break;
			}
		}
		let error = failure.expect("provider-independent exact cycle guard");
		assert_eq!(error.kind, ErrorKind::RepeatedReasoning);
		assert_eq!(error.action, RetryAction::SemanticRetry);
	}

	#[test]
	fn discovery_page_is_emitted_only_after_projection_succeeds() {
		let context = ExecutionContext::new(ExecutionBudget::default());
		let projector: Arc<dyn DiscoveryProjector> = Arc::new(TestProjector { fail: false });
		let projected = project_discovery(
			Some(&projector),
			Some(&request()),
			Vec::new(),
			Some("next".into()),
			&context,
		);
		assert!(matches!(
			projected,
			Ok(RawEvent::Answer(AnswerBody::Models(ModelDiscoveryPage { next_cursor: Some(cursor), .. })))
				if cursor.as_str() == "next"
		));
	}

	#[test]
	fn corrupt_or_unconfigured_discovery_page_is_terminal_without_output() {
		let context = ExecutionContext::new(ExecutionBudget::default());
		let corrupt: Arc<dyn DiscoveryProjector> = Arc::new(TestProjector { fail: true });
		assert!(
			project_discovery(Some(&corrupt), Some(&request()), Vec::new(), None, &context).is_err()
		);
		assert!(project_discovery(None, Some(&request()), Vec::new(), None, &context).is_err());
		assert!(project_discovery(Some(&corrupt), None, Vec::new(), None, &context).is_err());
	}
}
