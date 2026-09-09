//! Typed `OpenAI` Chat Completions request and incremental response codec.

use std::{
	borrow::Cow,
	collections::{BTreeMap, btree_map::Entry},
	str,
	time::Duration,
};

use bytes::{Bytes, BytesMut};
use omp_catalog::{
	OperationKind, ReasoningEffort, ServiceTier, ThinkingEffort,
	policy::{
		self, ImageEncodingFormat, MaxTokensField as CatalogMaxTokensField,
		ReasoningDisableMode as CatalogReasoningDisableMode,
		ReasoningWireFormat as CatalogReasoningWireFormat, ThinkingFormat as CatalogThinkingFormat,
		ThinkingToolChoiceConflict, ToolCallIdProfile as CatalogToolCallIdProfile, ToolStrictMode,
		VeniceParameters,
	},
};
use omp_core::{IntoStr, Str, encoding::base64, sf};
use serde::{Deserialize, Serialize};
use serde_json::{Value, value::RawValue};
use strum::EnumString;

use crate::{
	body::BodySource,
	call::{
		ChatRequest, ContentPart, HostedTool, MediaInput, Message, OperationCall, ReasoningRequest,
		ReasoningVisibility, Role, Setting, StructuredOutput, ToolChoice, ToolDefinition,
		ToolResultContent,
	},
	codec::{
		Codec, DecodeContext, Decoder, DecoderState, EncodeContext, EncodedRequest,
		ProviderStateEvent, RawCompletion, RawEvent, RequestHeader, RequestMethod, SizeBounds,
		ToolInputKind, UnvalidatedToolCall,
		schema::{SchemaDialect, normalize_schema},
	},
	error::{
		Error, ErrorDetail, ErrorKind, ErrorPhase, RetryAction, classify_provider_rejection,
		is_transient_generation_fault,
	},
	event::{BlockKind, ChatEvent, FinishReason, UsageUpdate},
	id::ToolCallId,
	receipt::{Adjustment, ExecutionReceipt, FeatureId, ReasonId, Usage, UsageSource},
	transport::{Frame, FramingProtocol},
};

/// Output-token ceiling assumed when a route clamps to the model maximum but
/// the catalog does not know the model's output limit.
const OPENAI_MAX_OUTPUT_TOKENS: u64 = 64_000;

/// Name of the output-token field accepted by a Chat Completions endpoint.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum MaxTokensField {
	/// Legacy `max_tokens`.
	MaxTokens,
	/// Current `OpenAI` `max_completion_tokens`.
	#[default]
	MaxCompletionTokens,
	/// Compatibility endpoint `max_output_tokens`.
	MaxOutputTokens,
	/// Do not send an output-token field.
	Omit,
}

/// Reasoning request shape accepted by an OpenAI-compatible endpoint.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum ReasoningWireFormat {
	/// `OpenAI` `reasoning_effort` string.
	#[default]
	OpenAiEffort,
	/// `OpenRouter` `reasoning` object.
	OpenRouter,
	/// Z.ai `thinking` object.
	Zai,
	/// Qwen `enable_thinking` boolean.
	Qwen,
	/// NVIDIA `chat_template_kwargs.enable_thinking` boolean.
	Nvidia,
	/// Generic `chat_template_kwargs.thinking` boolean.
	ChatTemplate,
	/// Endpoint has no reasoning request shape.
	Unsupported,
}
/// Historical reasoning text field accepted by a Chat Completions endpoint.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum ReasoningHistoryField {
	/// `reasoning_content`.
	#[default]
	ReasoningContent,
	/// `reasoning_text`.
	ReasoningText,
	/// Historical reasoning cannot be replayed.
	Unsupported,
}
/// Tool strictness emitted by this route.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum ToolStrictWire {
	/// Honor each canonical tool declaration.
	#[default]
	Mixed,
	/// Force strict mode and strict-schema normalization.
	All,
	/// Endpoint rejects the strict field.
	Unsupported,
}

/// Tool-call identifier constraint imposed by the route.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum ToolIdWireProfile {
	/// Preserve canonical identifiers.
	#[default]
	Preserve,
	/// At most forty OpenAI-compatible characters.
	OpenAi40,
	/// Exactly nine ASCII alphanumeric characters.
	Mistral9,
}

/// Hosted-tool vocabulary accepted by this concrete endpoint.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum HostedToolWireFormat {
	/// Hosted tools are unavailable.
	#[default]
	Unsupported,
	/// Current OpenAI-compatible hosted-tool type tags.
	OpenAi,
}

/// Data-driven wire axes for one Chat Completions route.
#[derive(Clone, Debug)]
pub struct OpenAiChatProfile {
	/// Relative request path.
	pub path: Str,
	/// Role used for canonical system instructions.
	pub system_role: WireRole,
	/// Whether multiple system/developer messages are accepted.
	pub multiple_system_messages: bool,
	/// Whether sampling controls are accepted.
	pub sampling: bool,
	/// Whether presence and frequency penalties are accepted.
	pub penalties: bool,
	/// Whether stop sequences are accepted.
	pub stop_sequences: bool,
	/// Output-token field selection.
	pub max_tokens_field: MaxTokensField,
	/// Whether streaming usage is requested.
	pub streaming_usage: bool,
	/// Whether `store:false` is required.
	pub disable_store: bool,
	/// Whether tool choice is accepted.
	pub tool_choice: bool,
	/// Whether named tool choice is accepted.
	pub named_tool_choice: bool,
	/// Whether required/named forcing is accepted.
	pub forced_tool_choice: bool,
	/// Resolution when reasoning controls conflict with tool choice.
	pub thinking_tool_choice_conflict: ThinkingToolChoiceConflict,
	/// Whether this route disables reasoning when a tool choice is present
	/// (census `disable_reasoning_on_tool_choice`).
	pub disable_reasoning_on_tool_choice: bool,
	/// Whether forced and named tool choices disable reasoning for the turn.
	pub disable_reasoning_on_forced_choice: bool,
	/// Whether tool results must carry the originating function name.
	pub requires_tool_result_name: bool,
	/// Whether user input after tool results needs an assistant bridge.
	pub requires_assistant_after_tool_result: bool,
	/// Tool strictness projection.
	pub tool_strict: ToolStrictWire,
	/// Whether object-root tool-parameter unions are flattened or withheld.
	pub flatten_root_unions: bool,
	/// Tool-call identifier projection.
	pub tool_id: ToolIdWireProfile,
	/// Reasoning request shape.
	pub reasoning: ReasoningWireFormat,
	/// Whether native reasoning request parameters are accepted.
	pub supports_reasoning_params: bool,
	/// Whether Qwen templates preserve historical thinking.
	pub qwen_preserve_thinking: bool,
	/// Whether Kimi's thinking object retains all thinking.
	pub thinking_keep: bool,
	/// Whether historical reasoning content is replayed.
	pub replay_reasoning_content: bool,
	/// Whether reasoning history is demoted into assistant text.
	pub requires_thinking_as_text: bool,
	/// Explicit reasoning-off operation.
	pub reasoning_disable: Option<CatalogReasoningDisableMode>,
	/// Static Venice request controls merged with turn-specific controls.
	pub venice_parameters: Option<VeniceParameters>,
	/// Whether canonical image parts may be emitted as `image_url`.
	pub supports_images: bool,
	/// Whether Qwen-style template dialects route the selected effort onto the
	/// chat template's `reasoning_effort` kwarg.
	pub template_reasoning_effort: bool,
	/// Attempt-scoped adaptation: the endpoint rejected the
	/// `chat_template_kwargs.reasoning_effort` spelling (strict kwargs
	/// whitelists such as `NInfer`), so the template effort rides the standard
	/// top-level field only. Set by [`Codec::encode`] from prior-attempt
	/// evidence, never by catalog policy.
	pub template_effort_top_level_only: bool,
	/// Request-scoped output-token ceiling: the caller's limit is lowered to
	/// `min(limit, ceiling)`. Set by [`Codec::encode`] from the catalog model
	/// maximum when the route policy clamps output to the model maximum
	/// (`context.clamp_output_to_model_max`); `None` forwards the caller's
	/// limit unchanged.
	pub output_token_ceiling: Option<u64>,
	/// Historical reasoning text field.
	pub reasoning_history: ReasoningHistoryField,
	/// Whether provider-scoped continuation proofs may be replayed.
	pub reasoning_proofs: bool,
	/// Whether cumulative reasoning snapshots are converted to deltas.
	pub reasoning_deltas_cumulative: bool,
	/// Whether an empty length finish is a context exhaustion error.
	pub empty_length_finish_is_context_error: bool,
	/// Whether `DeepSeek` chat-template markers are stripped from text.
	pub strip_deepseek_special_tokens: bool,
	/// Hosted-tool shape.
	pub hosted_tools: HostedToolWireFormat,
	/// Request body size bound.
	pub max_request_bytes: u64,
	/// Individual response-frame bound.
	pub max_frame_bytes: u64,
	/// Aggregate response bound.
	pub max_response_bytes: u64,
}

impl Default for OpenAiChatProfile {
	fn default() -> Self {
		Self {
			path: sf!("/chat/completions"),
			system_role: WireRole::System,
			multiple_system_messages: true,
			sampling: true,
			penalties: true,
			stop_sequences: true,
			max_tokens_field: MaxTokensField::MaxCompletionTokens,
			streaming_usage: true,
			disable_store: false,
			tool_choice: true,
			named_tool_choice: true,
			forced_tool_choice: true,
			thinking_tool_choice_conflict: ThinkingToolChoiceConflict::None,
			disable_reasoning_on_tool_choice: false,
			disable_reasoning_on_forced_choice: false,
			requires_tool_result_name: false,
			requires_assistant_after_tool_result: false,
			tool_strict: ToolStrictWire::Mixed,
			flatten_root_unions: false,
			tool_id: ToolIdWireProfile::Preserve,
			reasoning: ReasoningWireFormat::OpenAiEffort,
			supports_reasoning_params: true,
			qwen_preserve_thinking: false,
			thinking_keep: false,
			replay_reasoning_content: true,
			requires_thinking_as_text: false,
			reasoning_disable: None,
			venice_parameters: None,
			supports_images: true,
			template_reasoning_effort: false,
			template_effort_top_level_only: false,
			output_token_ceiling: None,
			reasoning_history: ReasoningHistoryField::ReasoningContent,
			reasoning_proofs: false,
			reasoning_deltas_cumulative: false,
			empty_length_finish_is_context_error: false,
			strip_deepseek_special_tokens: false,
			hosted_tools: HostedToolWireFormat::Unsupported,
			max_request_bytes: 16 * 1024 * 1024,
			max_frame_bytes: 16 * 1024 * 1024,
			max_response_bytes: 256 * 1024 * 1024,
		}
	}
}
impl OpenAiChatProfile {
	const fn apply_policy(&mut self, policy: &policy::WirePolicy) {
		if let Some(value) = policy.role.supports_developer_role {
			self.system_role = if value {
				WireRole::Developer
			} else {
				WireRole::System
			};
		}
		if let Some(value) = policy.role.multiple_system_messages {
			self.multiple_system_messages = value;
		}
		if let Some(value) = policy.structured.sampling_params {
			self.sampling = value;
		}
		if let Some(value) = policy.structured.penalties {
			self.penalties = value;
		}
		if let Some(value) = policy.structured.stop_sequences {
			self.stop_sequences = value;
		}
		if let Some(value) = policy.structured.penalty_and_stop_params {
			self.penalties = value;
			self.stop_sequences = value;
		}
		if let Some(value) = policy.usage.in_streaming {
			self.streaming_usage = value;
		}
		if let Some(value) = policy.context.supports_store {
			self.disable_store = value;
		}
		if let Some(value) = policy.tool.supports_tool_choice {
			self.tool_choice = value;
		}
		if let Some(value) = policy.tool.named_choice {
			self.named_tool_choice = value;
		}
		if let Some(value) = policy.tool.forced_choice {
			self.forced_tool_choice = value;
		}
		if let Some(value) = policy.tool.thinking_conflict {
			self.thinking_tool_choice_conflict = value;
		}
		if let Some(value) = policy.tool.disable_reasoning_on_choice {
			self.disable_reasoning_on_tool_choice = value;
		}
		if let Some(value) = policy.tool.disable_reasoning_on_forced_choice {
			self.disable_reasoning_on_forced_choice = value;
		}
		if let Some(value) = policy.tool.requires_result_name {
			self.requires_tool_result_name = value;
		}
		if let Some(value) = policy.tool.requires_assistant_after_result {
			self.requires_assistant_after_tool_result = value;
		}
		if let Some(value) = policy.context.max_tokens_field {
			self.max_tokens_field = match value {
				CatalogMaxTokensField::MaxTokens => MaxTokensField::MaxTokens,
				CatalogMaxTokensField::MaxCompletionTokens => MaxTokensField::MaxCompletionTokens,
				CatalogMaxTokensField::MaxOutputTokens => MaxTokensField::MaxOutputTokens,
			};
		}
		if let Some(value) = policy.tool.strict_mode {
			self.tool_strict = match value {
				ToolStrictMode::AllStrict => ToolStrictWire::All,
				ToolStrictMode::Mixed => ToolStrictWire::Mixed,
				ToolStrictMode::None => ToolStrictWire::Unsupported,
			};
		}
		// ADR 0017: unknown is not support. Only an affirmative compiled
		// capability may put the strict field on the wire.
		if !matches!(policy.tool.supports_strict_mode, Some(true)) {
			self.tool_strict = ToolStrictWire::Unsupported;
		}
		if let Some(value) = policy.tool.flatten_root_unions {
			self.flatten_root_unions = value;
		}
		if let Some(value) = policy.tool.reject_root_object_union {
			self.flatten_root_unions = value;
		}
		if let Some(value) = policy.tool.id_profile {
			self.tool_id = match value {
				CatalogToolCallIdProfile::Unconstrained => ToolIdWireProfile::Preserve,
				CatalogToolCallIdProfile::OpenAi40 => ToolIdWireProfile::OpenAi40,
				CatalogToolCallIdProfile::Mistral9Alnum => ToolIdWireProfile::Mistral9,
			};
		}
		if matches!(policy.tool.uses_openai_id_limit, Some(true)) {
			self.tool_id = ToolIdWireProfile::OpenAi40;
		}
		if matches!(policy.tool.requires_mistral_ids, Some(true)) {
			self.tool_id = ToolIdWireProfile::Mistral9;
		}
		if let Some(value) = policy.reasoning.wire_format {
			self.reasoning = match value {
				CatalogReasoningWireFormat::OpenAi => ReasoningWireFormat::OpenAiEffort,
				CatalogReasoningWireFormat::OpenRouter => ReasoningWireFormat::OpenRouter,
				CatalogReasoningWireFormat::Zai => ReasoningWireFormat::Zai,
				CatalogReasoningWireFormat::QwenEnableThinking => ReasoningWireFormat::Qwen,
				CatalogReasoningWireFormat::NvidiaChatTemplateKwargs => ReasoningWireFormat::Nvidia,
				_ => ReasoningWireFormat::Unsupported,
			};
		}
		if matches!(policy.reasoning.thinking_format, Some(CatalogThinkingFormat::ChatTemplate)) {
			self.reasoning = ReasoningWireFormat::ChatTemplate;
		}
		self.reasoning_disable = policy.reasoning.disable_mode;
		self.venice_parameters = match policy.reasoning.extra_body {
			Some(body) => body.venice_parameters,
			None => None,
		};
		if let Some(encoding) = policy.image.encoding {
			self.supports_images = !matches!(encoding, ImageEncodingFormat::None);
		}
		if let Some(value) = policy.reasoning.template_reasoning_effort {
			self.template_reasoning_effort = value;
		}
		if let Some(value) = policy.reasoning.supports_params {
			self.supports_reasoning_params = value;
		}
		if let Some(value) = policy.reasoning.qwen_preserve_thinking {
			self.qwen_preserve_thinking = value;
		}
		if let Some(value) = policy.reasoning.keep {
			self.thinking_keep = value;
		}
		if let Some(value) = policy.reasoning.replay_content {
			self.replay_reasoning_content = value;
		}
		if let Some(value) = policy.reasoning.requires_thinking_as_text {
			self.requires_thinking_as_text = value;
		}
		if let Some(value) = policy.reasoning.include_encrypted {
			self.reasoning_proofs = value;
		}
		if let Some(value) = policy.streaming.reasoning_deltas_cumulative {
			self.reasoning_deltas_cumulative = value;
		}
		if let Some(value) = policy.streaming.empty_length_finish_is_context_error {
			self.empty_length_finish_is_context_error = value;
		}
		if let Some(value) = policy.streaming.strip_deepseek_special_tokens {
			self.strip_deepseek_special_tokens = value;
		}
		if let Some(value) = policy.image.strip_input {
			self.supports_images = !value;
		}
	}
}

/// Explicit `OpenAI` request extensions.
#[derive(Clone, Debug, Default)]
pub struct OpenAiOptions {
	/// Stable prompt-cache identity.
	pub prompt_cache_key:       Option<Str>,
	/// Prompt-cache retention sent by compatible endpoints.
	pub prompt_cache_retention: Option<Str>,
	/// Request streaming tool-call fragments from compatible endpoints.
	pub tool_stream:            Option<bool>,
}

/// Explicit `OpenRouter` routing extensions.
#[derive(Clone, Debug, Default)]
pub struct OpenRouterOptions {
	/// Ordered upstream provider slugs.
	pub provider_order:  Box<[Str]>,
	/// Permit fallbacks between the explicitly ordered upstreams.
	pub allow_fallbacks: Option<bool>,
}

/// Explicit Vercel AI Gateway extensions.
#[derive(Clone, Debug, Default)]
pub struct VercelGatewayOptions {
	/// Enable gateway caching.
	pub cache: Option<bool>,
}

/// Typed adapter extension selected at registry construction.
#[derive(Clone, Debug)]
pub enum OpenAiChatAdapterOptions {
	/// Direct OpenAI-compatible request extensions.
	OpenAi(OpenAiOptions),
	/// `OpenRouter` routing extensions.
	OpenRouter(OpenRouterOptions),
	/// Vercel AI Gateway extensions.
	Vercel(VercelGatewayOptions),
}

/// Typed codec for `/v1/chat/completions` and structurally compatible routes.
#[derive(Clone, Debug, Default)]
pub struct OpenAiChatCodec {
	profile: OpenAiChatProfile,
	adapter: Option<OpenAiChatAdapterOptions>,
}

impl OpenAiChatCodec {
	/// Constructs a route-specific codec without provider-name or model-name
	/// inspection.
	pub const fn new(profile: OpenAiChatProfile, adapter: Option<OpenAiChatAdapterOptions>) -> Self {
		Self { profile, adapter }
	}

	/// Encodes a chat request to exact JSON bytes for fixture and cassette
	/// assertions.
	pub fn encode_chat(&self, model: &str, request: &ChatRequest) -> Result<Bytes, Error> {
		self
			.encode_chat_adjusted(model, request)
			.map(|(body, _)| body)
	}

	fn encode_chat_adjusted(
		&self,
		model: &str,
		request: &ChatRequest,
	) -> Result<(Bytes, Vec<Adjustment>), Error> {
		let (wire, adjustments) = self.lower_request(model, request)?;
		let body = serde_json::to_vec(&wire)
			.map(Bytes::from)
			.map_err(|_| encoding_error(ErrorKind::InternalInvariant))?;
		Ok((body, adjustments))
	}

	/// Creates a fresh sans-I/O decoder for one Chat Completions response.
	pub fn chat_decoder(&self) -> OpenAiChatDecoder {
		OpenAiChatDecoder::from_profile(&self.profile)
	}

	/// Returns the exact route-policy-adjusted response frame bound.
	pub(crate) fn maximum_frame_bytes(&self, policy: &policy::WirePolicy) -> u64 {
		let mut profile = self.profile.clone();
		profile.apply_policy(policy);
		profile.max_frame_bytes
	}

	fn lower_request(
		&self,
		model: &str,
		request: &ChatRequest,
	) -> Result<(WireRequest, Vec<Adjustment>), Error> {
		let mut adjustments = Vec::new();
		let messages = lower_messages(&self.profile, &request.messages)?;
		let (mut tools, withheld) = lower_tools(&self.profile, &request.tools, &mut adjustments)?;
		tools.extend(lower_hosted_tools(&self.profile, &request.hosted_tools)?);
		let mut tool_choice =
			lower_tool_choice(&self.profile, &mut tools, &request.tool_choice, &withheld)?;
		let response_format = lower_output(&self.profile, &request.output, &mut adjustments)?;
		if !self.profile.supports_reasoning_params && !matches!(request.reasoning, Setting::Unset) {
			return Err(capability_error());
		}
		let forced_choice = matches!(
			tool_choice,
			Some(WireToolChoice::Mode(ToolChoiceMode::Required) | WireToolChoice::Named { .. })
		);
		let reasoning = if self.profile.disable_reasoning_on_forced_choice && forced_choice {
			lower_reasoning(&self.profile, &Setting::Unset)?
		} else {
			lower_reasoning(&self.profile, &request.reasoning)?
		};
		// The gateway disables thinking whenever a tool-choice selector is
		// present. `auto` is the provider default and can be omitted without
		// changing tool semantics, so reasoning survives; forced and named
		// selectors remain authoritative.
		if self.profile.disable_reasoning_on_tool_choice
			&& matches!(&request.reasoning, Setting::Require(_) | Setting::Prefer(_))
			&& matches!(&tool_choice, Some(WireToolChoice::Mode(ToolChoiceMode::Auto)))
		{
			tool_choice = None;
		}
		let sampling = &request.sampling;
		if !request.safety.is_empty() || !matches!(&request.verbosity, Setting::Unset) {
			return Err(capability_error());
		}
		if !self.profile.sampling
			&& (sampling.temperature.is_some()
				|| sampling.top_p.is_some()
				|| sampling.top_k.is_some()
				|| sampling.min_p.is_some())
		{
			return Err(capability_error());
		}
		if !self.profile.penalties
			&& (sampling.presence_penalty.is_some()
				|| sampling.frequency_penalty.is_some()
				|| sampling.repetition_penalty.is_some())
		{
			return Err(capability_error());
		}
		if !self.profile.stop_sequences && !sampling.stop.is_empty() {
			return Err(capability_error());
		}
		// A caller limit is lowered to the route's output clamp; an absent limit
		// stays absent.
		let output_limit = request.max_output_tokens.map(|requested| {
			self
				.profile
				.output_token_ceiling
				.map_or(requested, |ceiling| requested.min(ceiling))
		});
		let (max_tokens, max_completion_tokens, max_output_tokens) =
			match self.profile.max_tokens_field {
				MaxTokensField::MaxTokens => (output_limit, None, None),
				MaxTokensField::MaxCompletionTokens => (None, output_limit, None),
				MaxTokensField::MaxOutputTokens => (None, None, output_limit),
				MaxTokensField::Omit if output_limit.is_some() => {
					return Err(capability_error());
				},
				MaxTokensField::Omit => (None, None, None),
			};
		let (prompt_cache_key, prompt_cache_options, provider, provider_options, tool_stream) =
			lower_adapter(self.adapter.as_ref());
		let service_tier = lower_service_tier(&request.service_tier);
		let cache_requested = !matches!(&request.cache_retention, Setting::Unset);
		if cache_requested && prompt_cache_key.is_none() && prompt_cache_options.is_none() {
			return Err(capability_error());
		}
		Ok((
			WireRequest {
				model: Str::new(model),
				messages,
				stream: true,
				stream_options: self
					.profile
					.streaming_usage
					.then_some(StreamOptions { include_usage: true }),
				store: self.profile.disable_store.then_some(false),
				temperature: self
					.profile
					.sampling
					.then_some(sampling.temperature)
					.flatten(),
				top_p: self.profile.sampling.then_some(sampling.top_p).flatten(),
				top_k: self.profile.sampling.then_some(sampling.top_k).flatten(),
				min_p: self.profile.sampling.then_some(sampling.min_p).flatten(),
				presence_penalty: self
					.profile
					.penalties
					.then_some(sampling.presence_penalty)
					.flatten(),
				frequency_penalty: self
					.profile
					.penalties
					.then_some(sampling.frequency_penalty)
					.flatten(),
				repetition_penalty: self
					.profile
					.penalties
					.then_some(sampling.repetition_penalty)
					.flatten(),
				stop: (!sampling.stop.is_empty()).then(|| sampling.stop.to_vec()),
				seed: sampling.seed,
				max_tokens,
				max_completion_tokens,
				logprobs: request.top_logprobs.map(|_| true),
				top_logprobs: request.top_logprobs,
				max_output_tokens,
				tools: (!tools.is_empty()).then_some(tools),
				tool_choice,
				response_format,
				reasoning_effort: reasoning.effort,
				reasoning: reasoning.openrouter,
				thinking: reasoning.zai,
				enable_thinking: reasoning.qwen,
				preserve_thinking: (self.profile.qwen_preserve_thinking
					&& self.profile.reasoning == ReasoningWireFormat::Qwen)
					.then_some(true),
				chat_template_kwargs: reasoning.chat_template,
				venice_parameters: reasoning.venice,
				service_tier,
				prompt_cache_key,
				prompt_cache_options,
				provider,
				provider_options,
				tool_stream,
			},
			adjustments,
		))
	}
}

impl Codec for OpenAiChatCodec {
	fn encode(
		&self,
		context: &EncodeContext<'_>,
		operation: &OperationCall,
	) -> Result<EncodedRequest, Error> {
		let OperationCall::Chat(request) = operation else {
			return Err(capability_error());
		};
		let target = context
			.target
			.filter(|_| context.policy_model.is_some())
			.ok_or_else(|| encoding_error(ErrorKind::InvalidRequest))?;
		validate_thinking_selection(request, context.thinking_selection)?;
		let mut selected = self.clone();
		selected.profile.apply_policy(context.policy);
		if !context.route.capability_limits.disable_prompt_caching
			&& let Some(key) = context.affinity.prompt_cache.as_ref()
			&& let Some(OpenAiChatAdapterOptions::OpenAi(options)) = selected.adapter.as_mut()
		{
			options.prompt_cache_key = Some(key.clone());
		}
		selected.profile.template_effort_top_level_only =
			context.attempt.is_template_effort_rejected();
		selected.profile.output_token_ceiling =
			(context.policy.context.clamp_output_to_model_max == Some(true)).then(|| {
				context
					.policy_model
					.and_then(|model| model.limits.maximum_output_tokens)
					.unwrap_or(OPENAI_MAX_OUTPUT_TOKENS)
			});
		let wire_model = context
			.thinking_selection
			.map_or(&target.wire_model, |selection| &selection.wire_model);
		let (body, adjustments) = selected.encode_chat_adjusted(wire_model.as_str(), request)?;
		if body.len() as u64 > selected.profile.max_request_bytes {
			return Err(encoding_error(ErrorKind::InvalidRequest));
		}
		let uri = join_uri(target.endpoint.base_url.as_str(), selected.profile.path.as_str());
		Ok(EncodedRequest {
			operation: OperationKind::Chat,
			method: RequestMethod::Post,
			uri,
			headers: vec![RequestHeader {
				name:  sf!("content-type"),
				value: sf!("application/json"),
			}]
			.into_boxed_slice(),
			body: BodySource::Bytes(body),
			framing: FramingProtocol::Sse,
			bounds: SizeBounds {
				request_body: selected.profile.max_request_bytes,
				frame:        selected.profile.max_frame_bytes,
				response:     selected.profile.max_response_bytes,
			},
			sealed_body: None,
			adjustments,
		})
	}

	fn decoder(&self, context: &DecodeContext<'_>) -> Result<DecoderState, Error> {
		if context.operation != OperationKind::Chat
			|| context.operation_call.kind() != OperationKind::Chat
			|| context.target.is_none()
			|| context.policy_model.is_none()
		{
			return Err(encoding_error(ErrorKind::InvalidRequest));
		}
		let mut selected = self.clone();
		selected.profile.apply_policy(context.policy);
		Ok(Box::new(selected.chat_decoder()))
	}
}

pub(crate) fn join_uri(base: &str, path: &str) -> Str {
	let mut uri = String::with_capacity(base.len() + path.len() + 1);
	uri.push_str(base.trim_end_matches('/'));
	if !path.starts_with('/') {
		uri.push('/');
	}
	uri.push_str(path);
	Str::new(uri)
}

#[derive(Clone, Copy, Debug, Default, Eq, PartialEq, Serialize)]
#[serde(rename_all = "lowercase")]
/// Role vocabulary serialized in Chat Completions messages.
pub enum WireRole {
	/// System instruction message.
	#[default]
	System,
	/// Developer instruction message.
	Developer,
	/// End-user input message.
	User,
	/// Assistant response message.
	Assistant,
	/// Tool result message.
	Tool,
}

#[derive(Serialize)]
struct WireRequest {
	model:                 Str,
	messages:              Vec<WireMessage>,
	stream:                bool,
	#[serde(skip_serializing_if = "Option::is_none")]
	stream_options:        Option<StreamOptions>,
	#[serde(skip_serializing_if = "Option::is_none")]
	store:                 Option<bool>,
	#[serde(skip_serializing_if = "Option::is_none")]
	temperature:           Option<f32>,
	#[serde(skip_serializing_if = "Option::is_none")]
	top_p:                 Option<f32>,
	#[serde(skip_serializing_if = "Option::is_none")]
	top_k:                 Option<u32>,
	#[serde(skip_serializing_if = "Option::is_none")]
	min_p:                 Option<f32>,
	#[serde(skip_serializing_if = "Option::is_none")]
	presence_penalty:      Option<f32>,
	#[serde(skip_serializing_if = "Option::is_none")]
	frequency_penalty:     Option<f32>,
	#[serde(skip_serializing_if = "Option::is_none")]
	repetition_penalty:    Option<f32>,
	#[serde(skip_serializing_if = "Option::is_none")]
	stop:                  Option<Vec<Str>>,
	#[serde(skip_serializing_if = "Option::is_none")]
	seed:                  Option<u64>,
	#[serde(skip_serializing_if = "Option::is_none")]
	max_tokens:            Option<u64>,
	#[serde(skip_serializing_if = "Option::is_none")]
	max_completion_tokens: Option<u64>,
	#[serde(skip_serializing_if = "Option::is_none")]
	max_output_tokens:     Option<u64>,
	#[serde(skip_serializing_if = "Option::is_none")]
	tools:                 Option<Vec<WireTool>>,
	#[serde(skip_serializing_if = "Option::is_none")]
	tool_choice:           Option<WireToolChoice>,
	#[serde(skip_serializing_if = "Option::is_none")]
	response_format:       Option<ResponseFormat>,
	#[serde(skip_serializing_if = "Option::is_none")]
	reasoning_effort:      Option<WireEffort>,
	#[serde(skip_serializing_if = "Option::is_none")]
	reasoning:             Option<OpenRouterReasoning>,
	#[serde(skip_serializing_if = "Option::is_none")]
	logprobs:              Option<bool>,
	#[serde(skip_serializing_if = "Option::is_none")]
	top_logprobs:          Option<u8>,
	#[serde(skip_serializing_if = "Option::is_none")]
	thinking:              Option<ZaiThinking>,
	#[serde(skip_serializing_if = "Option::is_none")]
	enable_thinking:       Option<bool>,
	#[serde(skip_serializing_if = "Option::is_none")]
	preserve_thinking:     Option<bool>,
	#[serde(skip_serializing_if = "Option::is_none")]
	chat_template_kwargs:  Option<ChatTemplateKwargs>,
	#[serde(skip_serializing_if = "Option::is_none")]
	venice_parameters:     Option<WireVeniceParameters>,
	#[serde(skip_serializing_if = "Option::is_none")]
	service_tier:          Option<Str>,
	#[serde(skip_serializing_if = "Option::is_none")]
	prompt_cache_key:      Option<Str>,
	#[serde(skip_serializing_if = "Option::is_none")]
	prompt_cache_options:  Option<PromptCacheOptions>,
	#[serde(skip_serializing_if = "Option::is_none")]
	provider:              Option<ProviderRouting>,
	#[serde(rename = "providerOptions", skip_serializing_if = "Option::is_none")]
	provider_options:      Option<GatewayProviderOptions>,
	#[serde(skip_serializing_if = "Option::is_none")]
	tool_stream:           Option<bool>,
}

#[derive(Serialize)]
struct StreamOptions {
	include_usage: bool,
}

#[derive(Serialize)]
struct WireMessage {
	role:              WireRole,
	#[serde(skip_serializing_if = "Option::is_none")]
	content:           Option<NullableContent>,
	#[serde(skip_serializing_if = "Option::is_none")]
	name:              Option<Str>,
	#[serde(skip_serializing_if = "Option::is_none")]
	tool_call_id:      Option<Str>,
	#[serde(skip_serializing_if = "Option::is_none")]
	tool_calls:        Option<Vec<WireAssistantToolCall>>,
	#[serde(skip_serializing_if = "Option::is_none")]
	reasoning_content: Option<Str>,
	#[serde(skip_serializing_if = "Option::is_none")]
	reasoning_text:    Option<Str>,
	#[serde(skip_serializing_if = "Option::is_none")]
	reasoning_details: Option<Vec<WireReasoningReplay>>,
}

#[derive(Serialize)]
#[serde(untagged)]
enum NullableContent {
	Text(Str),
	Parts(Vec<WireContentPart>),
	Null(()),
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum WireContentPart {
	Text { text: Str },
	ImageUrl { image_url: ImageUrl },
}

#[derive(Serialize)]
struct ImageUrl {
	url: String,
}
#[derive(Serialize)]
struct WireAssistantToolCall {
	id:       Str,
	#[serde(rename = "type")]
	kind:     FunctionTag,
	function: WireAssistantFunction,
}

#[derive(Serialize)]
struct WireAssistantFunction {
	name:      Str,
	arguments: String,
}
#[derive(Serialize)]
#[serde(untagged)]
enum WireReasoningReplay {
	Opaque(Box<RawValue>),
	Encrypted {
		#[serde(rename = "type")]
		kind: ReasoningEncryptedTag,
		#[serde(skip_serializing_if = "Option::is_none")]
		id:   Option<Str>,
		data: String,
	},
}

#[derive(Serialize)]
enum ReasoningEncryptedTag {
	#[serde(rename = "reasoning.encrypted")]
	Encrypted,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum WireTool {
	Function {
		function: WireFunction,
	},
	WebSearch {
		#[serde(skip_serializing_if = "Option::is_none")]
		web_search: Option<WebSearchOptions>,
	},
	CodeInterpreter,
	FileSearch {
		file_search: FileSearchOptions,
	},
}

#[derive(Serialize)]
struct WireFunction {
	name:        Str,
	#[serde(skip_serializing_if = "Option::is_none")]
	description: Option<Str>,
	parameters:  Value,
	#[serde(skip_serializing_if = "Option::is_none")]
	strict:      Option<bool>,
}

#[derive(Serialize)]
struct WebSearchOptions {
	#[serde(skip_serializing_if = "Vec::is_empty")]
	allowed_domains: Vec<Str>,
	#[serde(skip_serializing_if = "Vec::is_empty")]
	blocked_domains: Vec<Str>,
	#[serde(skip_serializing_if = "Option::is_none")]
	recency_days:    Option<u32>,
}

#[derive(Serialize)]
struct FileSearchOptions {
	vector_store_ids: Vec<Str>,
}

#[derive(Serialize)]
#[serde(untagged)]
enum WireToolChoice {
	Mode(ToolChoiceMode),
	Named { r#type: FunctionTag, function: NamedFunction },
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum ToolChoiceMode {
	Auto,
	None,
	Required,
}

#[derive(Serialize)]
#[serde(rename_all = "snake_case")]
enum FunctionTag {
	Function,
}

#[derive(Serialize)]
struct NamedFunction {
	name: Str,
}

#[derive(Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum ResponseFormat {
	JsonObject,
	JsonSchema { json_schema: JsonSchemaFormat },
}

#[derive(Serialize)]
struct JsonSchemaFormat {
	name:   Str,
	schema: Value,
	strict: bool,
}

#[derive(Clone, Copy, Serialize)]
#[serde(rename_all = "lowercase")]
enum WireEffort {
	None,
	Minimal,
	Low,
	Medium,
	High,
	Xhigh,
	Max,
}

#[derive(Serialize)]
struct OpenRouterReasoning {
	#[serde(skip_serializing_if = "Option::is_none")]
	effort:     Option<WireEffort>,
	exclude:    bool,
	#[serde(skip_serializing_if = "Option::is_none")]
	max_tokens: Option<u64>,
}

#[derive(Serialize)]
struct ZaiThinking {
	r#type: ThinkingType,
	#[serde(skip_serializing_if = "Option::is_none")]
	effort: Option<WireEffort>,
	#[serde(skip_serializing_if = "Option::is_none")]
	keep:   Option<ThinkingKeep>,
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
enum ThinkingKeep {
	All,
}

#[derive(Serialize)]
#[serde(rename_all = "lowercase")]
enum ThinkingType {
	Enabled,
}

#[derive(Serialize)]
struct ChatTemplateKwargs {
	#[serde(skip_serializing_if = "Option::is_none")]
	enable_thinking:   Option<bool>,
	#[serde(skip_serializing_if = "Option::is_none")]
	thinking:          Option<bool>,
	#[serde(skip_serializing_if = "Option::is_none")]
	reasoning_effort:  Option<WireEffort>,
	#[serde(skip_serializing_if = "Option::is_none")]
	preserve_thinking: Option<bool>,
}
#[derive(Clone, Copy, Serialize)]
struct WireVeniceParameters {
	#[serde(skip_serializing_if = "Option::is_none")]
	disable_thinking:             Option<bool>,
	#[serde(skip_serializing_if = "Option::is_none")]
	include_venice_system_prompt: Option<bool>,
}

#[derive(Serialize)]
struct PromptCacheOptions {
	retention: Str,
}

#[derive(Serialize)]
struct ProviderRouting {
	order:           Vec<Str>,
	#[serde(skip_serializing_if = "Option::is_none")]
	allow_fallbacks: Option<bool>,
}

#[derive(Serialize)]
struct GatewayProviderOptions {
	gateway: GatewayOptions,
}

#[derive(Serialize)]
struct GatewayOptions {
	cache: bool,
}

struct ReasoningFields {
	effort:        Option<WireEffort>,
	openrouter:    Option<OpenRouterReasoning>,
	zai:           Option<ZaiThinking>,
	qwen:          Option<bool>,
	chat_template: Option<ChatTemplateKwargs>,
	venice:        Option<WireVeniceParameters>,
}

fn lower_messages(
	profile: &OpenAiChatProfile,
	messages: &[Message],
) -> Result<Vec<WireMessage>, Error> {
	let messages = merge_assistant_runs(messages);
	let mut lowered = Vec::new();
	for message in messages.iter() {
		if profile.requires_assistant_after_tool_result
			&& matches!(message.role, Role::User | Role::Developer)
			&& lowered
				.last()
				.is_some_and(|message: &WireMessage| message.role == WireRole::Tool)
		{
			lowered.push(WireMessage {
				role:              WireRole::Assistant,
				content:           Some(NullableContent::Text(sf!(
					"I have processed the tool results."
				))),
				name:              None,
				tool_call_id:      None,
				tool_calls:        None,
				reasoning_content: None,
				reasoning_text:    None,
				reasoning_details: None,
			});
		}
		let role = match message.role {
			Role::System => profile.system_role,
			Role::Developer if profile.system_role == WireRole::Developer => WireRole::Developer,
			Role::Developer => WireRole::System,
			Role::User => WireRole::User,
			Role::Assistant => WireRole::Assistant,
			Role::Tool => WireRole::Tool,
		};
		if message.role == Role::Tool {
			for part in message.content.iter() {
				let ContentPart::ToolResult { call, name, content, .. } = part else {
					return Err(encoding_error(ErrorKind::InvalidRequest));
				};
				lowered.push(WireMessage {
					role,
					content: Some(NullableContent::Text(lower_tool_result_content(
						content,
						profile.supports_images,
					)?)),
					name: profile
						.requires_tool_result_name
						.then(|| name.clone().or_else(|| message.name.clone()))
						.flatten(),
					tool_call_id: Some(project_call_id(profile.tool_id, call.as_str())),
					tool_calls: None,
					reasoning_content: None,
					reasoning_text: None,
					reasoning_details: None,
				});
			}
			continue;
		}
		let mut ordinary = Vec::new();
		let mut reasoning = String::new();
		let mut calls = Vec::new();
		let mut details = Vec::new();
		for part in message.content.iter() {
			match part {
				ContentPart::Text { text, proof } => {
					if let Some(proof) = proof {
						if !profile.reasoning_proofs {
							return Err(capability_error());
						}
						details.push(proof_detail(&proof.value, None));
					}
					ordinary.push(ContentPart::Text { text: text.clone(), proof: None });
				},
				ContentPart::Reasoning { text, proof } if message.role == Role::Assistant => {
					if let Some(proof) = proof {
						if !profile.reasoning_proofs {
							return Err(capability_error());
						}
						details.push(proof_detail(&proof.value, None));
					}
					reasoning.push_str(text.as_str());
				},
				ContentPart::ToolCall { call, name, arguments, proof }
					if message.role == Role::Assistant =>
				{
					let wire_id = project_call_id(profile.tool_id, call.as_str());
					if let Some(proof) = proof {
						if !profile.reasoning_proofs {
							return Err(capability_error());
						}
						details.push(proof_detail(&proof.value, Some(wire_id.clone())));
					}
					calls.push(WireAssistantToolCall {
						id:       wire_id,
						kind:     FunctionTag::Function,
						function: WireAssistantFunction {
							name:      name.clone(),
							arguments: serde_json::to_string(arguments.as_value())
								.map_err(|_| encoding_error(ErrorKind::InvalidRequest))?,
						},
					});
				},
				ContentPart::Reasoning { .. } | ContentPart::ToolCall { .. } => {
					return Err(encoding_error(ErrorKind::InvalidRequest));
				},
				other => ordinary.push(other.clone()),
			}
		}
		let (reasoning_content, reasoning_text) = if reasoning.is_empty()
			|| !profile.replay_reasoning_content
			|| profile.requires_thinking_as_text
		{
			if profile.requires_thinking_as_text && !reasoning.is_empty() {
				let prefix = sf!("<think>{reasoning}</think> ");
				if let Some(ContentPart::Text { text, .. }) = ordinary.first_mut() {
					*text = sf!("{prefix}{text}");
				} else {
					ordinary.insert(0, ContentPart::Text { text: prefix, proof: None });
				}
			}
			(None, None)
		} else {
			match profile.reasoning_history {
				ReasoningHistoryField::ReasoningContent => (Some(Str::new(reasoning)), None),
				ReasoningHistoryField::ReasoningText => (None, Some(Str::new(reasoning))),
				ReasoningHistoryField::Unsupported => return Err(capability_error()),
			}
		};
		let content = lower_content(&ordinary, profile.supports_images)?;
		lowered.push(WireMessage {
			role,
			content: Some(content),
			name: message.name.clone(),
			tool_call_id: None,
			tool_calls: (!calls.is_empty()).then_some(calls),
			reasoning_content,
			reasoning_text,
			reasoning_details: (!details.is_empty()).then_some(details),
		});
	}
	if !profile.multiple_system_messages {
		coalesce_system_messages(&mut lowered, profile.system_role)?;
	}
	Ok(lowered)
}

fn lower_content(parts: &[ContentPart], supports_images: bool) -> Result<NullableContent, Error> {
	if let [ContentPart::Text { text, .. }] = parts {
		return Ok(NullableContent::Text(text.clone()));
	}
	if parts.is_empty() {
		return Ok(NullableContent::Null(()));
	}
	let mut wire = Vec::with_capacity(parts.len());
	let mut omitted_image = false;
	for part in parts {
		match part {
			ContentPart::Text { text, .. } => wire.push(WireContentPart::Text { text: text.clone() }),
			ContentPart::Image(_) if !supports_images => omitted_image = true,
			ContentPart::Image(MediaInput::Bytes { media_type, data }) => {
				let encoded = base64::encode(data).into_string();
				let mut url = String::with_capacity(media_type.len() + encoded.len() + 13);
				url.push_str("data:");
				url.push_str(media_type.as_str());
				url.push_str(";base64,");
				url.push_str(&encoded);
				wire.push(WireContentPart::ImageUrl { image_url: ImageUrl { url } });
			},
			ContentPart::Image(MediaInput::Remote { uri, .. }) => {
				wire.push(WireContentPart::ImageUrl { image_url: ImageUrl { url: uri.to_string() } });
			},
			ContentPart::Image(MediaInput::Stored(_) | MediaInput::Body { .. })
			| ContentPart::Reasoning { .. }
			| ContentPart::Audio(_)
			| ContentPart::Document(_)
			| ContentPart::ToolCall { .. }
			| ContentPart::ToolResult { .. }
			| ContentPart::CachePoint(_) => return Err(capability_error()),
		}
	}
	if omitted_image {
		wire.push(WireContentPart::Text {
			text: Str::new_static("[image omitted: model does not support vision]"),
		});
	}
	Ok(NullableContent::Parts(wire))
}

fn lower_tool_result_content(
	content: &[ToolResultContent],
	supports_images: bool,
) -> Result<Str, Error> {
	let mut output = String::new();
	let mut omitted_image = false;
	for part in content {
		match part {
			ToolResultContent::Text(text) => {
				if !output.is_empty() {
					output.push('\n');
				}
				output.push_str(text.as_str());
			},
			ToolResultContent::Json(value) => {
				if !output.is_empty() {
					output.push('\n');
				}
				output.push_str(
					&serde_json::to_string(value.as_value())
						.map_err(|_| encoding_error(ErrorKind::InvalidRequest))?,
				);
			},
			ToolResultContent::Image(_) if !supports_images => omitted_image = true,
			ToolResultContent::Image(_) | ToolResultContent::Document(_) => {
				return Err(capability_error());
			},
		}
	}
	if omitted_image {
		if !output.is_empty() {
			output.push('\n');
		}
		output.push_str("[image omitted: model does not support vision]");
	}
	Ok(Str::new(output))
}

fn validate_thinking_selection(
	request: &ChatRequest,
	selection: Option<&omp_catalog::ThinkingSelection>,
) -> Result<(), Error> {
	let reasoning = match &request.reasoning {
		Setting::Unset => return Ok(()),
		Setting::Require(reasoning) | Setting::Prefer(reasoning) => reasoning,
	};
	let selection = selection.ok_or_else(capability_error)?;
	if reasoning.max_tokens != selection.budget {
		return Err(capability_error());
	}
	if let Some(effort) = reasoning.effort
		&& ThinkingEffort::from(effort) != selection.effort
	{
		return Err(capability_error());
	}
	Ok(())
}

fn proof_detail(value: &[u8], id: Option<Str>) -> WireReasoningReplay {
	if let Ok(raw) = serde_json::from_slice::<Box<RawValue>>(value) {
		return WireReasoningReplay::Opaque(raw);
	}
	let data =
		str::from_utf8(value).map_or_else(|_| base64::encode(value).into_string(), str::to_owned);
	WireReasoningReplay::Encrypted { kind: ReasoningEncryptedTag::Encrypted, id, data }
}

/// Merges runs of consecutive assistant messages into one canonical message.
///
/// The durable thread stores one item per message, so one assistant turn with
/// parallel tool calls arrives as a text message followed by single-call
/// assistant messages. Strict OpenAI-compatible validators (kimi-code,
/// vLLM-style gateways) reject an assistant `tool_calls` message that is not
/// immediately followed by its tool responses, so each run must collapse into
/// one wire message before lowering.
fn merge_assistant_runs(messages: &[Message]) -> Cow<'_, [Message]> {
	if !messages
		.windows(2)
		.any(|pair| pair[0].role == Role::Assistant && pair[1].role == Role::Assistant)
	{
		return Cow::Borrowed(messages);
	}
	let mut merged: Vec<Message> = Vec::with_capacity(messages.len());
	for message in messages {
		match merged.last_mut() {
			Some(previous) if previous.role == Role::Assistant && message.role == Role::Assistant => {
				previous.content = previous
					.content
					.iter()
					.chain(message.content.iter())
					.cloned()
					.collect();
				if previous.name.is_none() {
					previous.name.clone_from(&message.name);
				}
			},
			_ => merged.push(message.clone()),
		}
	}
	Cow::Owned(merged)
}

fn project_call_id(profile: ToolIdWireProfile, value: &str) -> Str {
	match profile {
		ToolIdWireProfile::Preserve => Str::new(value),
		ToolIdWireProfile::OpenAi40 => {
			let projected: String = value
				.chars()
				.filter(|character| character.is_ascii_alphanumeric() || matches!(character, '_' | '-'))
				.take(40)
				.collect();
			Str::new(projected)
		},
		ToolIdWireProfile::Mistral9 => {
			let mut hash = 0xcbf2_9ce4_8422_2325_u64;
			for byte in value.bytes() {
				hash ^= u64::from(byte);
				hash = hash.wrapping_mul(0x0000_0100_0000_01b3);
			}
			let mut output = [b'0'; 9];
			for slot in output.iter_mut().rev() {
				let digit = (hash % 36) as u8;
				*slot = if digit < 10 {
					b'0' + digit
				} else {
					b'a' + digit - 10
				};
				hash /= 36;
			}
			Str::new(str::from_utf8(&output).expect("ASCII identifier"))
		},
	}
}

fn coalesce_system_messages(messages: &mut Vec<WireMessage>, role: WireRole) -> Result<(), Error> {
	let mut first = None;
	let mut text = String::new();
	let mut remove = Vec::new();
	for (index, message) in messages.iter().enumerate() {
		if message.role != role {
			continue;
		}
		let Some(NullableContent::Text(content)) = &message.content else {
			return Err(capability_error());
		};
		if first.is_none() {
			first = Some(index);
		} else {
			text.push_str("\n\n");
		}
		text.push_str(content.as_str());
		if first != Some(index) {
			remove.push(index);
		}
	}
	if let Some(index) = first {
		messages[index].content = Some(NullableContent::Text(Str::new(text)));
		for index in remove.into_iter().rev() {
			messages.remove(index);
		}
	}
	Ok(())
}

fn lower_tools(
	profile: &OpenAiChatProfile,
	tools: &[ToolDefinition],
	adjustments: &mut Vec<Adjustment>,
) -> Result<(Vec<WireTool>, Vec<Str>), Error> {
	let mut lowered = Vec::with_capacity(tools.len());
	let mut withheld = Vec::new();
	for tool in tools {
		let (parameters, declared_strict) = tool.input.wire_schema();
		let requested_strict = match profile.tool_strict {
			ToolStrictWire::Mixed => declared_strict,
			ToolStrictWire::All => true,
			ToolStrictWire::Unsupported => declared_strict,
		};
		let strict_capability = (profile.tool_strict != ToolStrictWire::Unsupported).then_some(true);
		let flattened = if profile.flatten_root_unions {
			flatten_exclusive_required_root_union(parameters.as_value())
		} else {
			None
		};
		let schema = flattened.as_ref().unwrap_or_else(|| parameters.as_value());
		let projection =
			normalize_schema(schema, requested_strict, strict_capability, SchemaDialect::OpenAiChat);
		if let Some(reason) = projection.fallback {
			adjustments.push(Adjustment::Dropped {
				feature: FeatureId::new_static("chat.tool.strict"),
				reason:  ReasonId::new_static(reason.reason_id()),
			});
		}
		let parameters = projection.schema;
		let strict = projection.strict;
		if profile.flatten_root_unions && leftover_root_object_union(&parameters) {
			// xAI rejects the entire request over one leftover object-root
			// union ("tool parameter root must be an object type"); withhold
			// just the offending tool so the other tools stay usable.
			withheld.push(tool.name.clone());
			continue;
		}
		lowered.push(WireTool::Function {
			function: WireFunction {
				name: tool.name.clone(),
				description: tool.description.clone(),
				parameters,
				strict,
			},
		});
	}
	Ok((lowered, withheld))
}

/// Returns a copy of an object-root schema with its `anyOf`/`oneOf` union
/// removed when every branch is a typeless exclusive-`required` fragment.
/// Returns `None` — leave the schema untouched — for every other shape: away
/// from providers that reject object-root unions, the union is a real
/// model-facing constraint.
pub(crate) fn flatten_exclusive_required_root_union(schema: &Value) -> Option<Value> {
	let object = schema.as_object()?;
	let union_key = ["anyOf", "oneOf"]
		.into_iter()
		.find(|key| object.get(*key).is_some_and(Value::is_array))?;
	let branches = object.get(union_key).and_then(Value::as_array)?;
	if branches.is_empty()
		|| !declares_object_root(object)
		|| !branches.iter().all(exclusive_required_branch)
	{
		return None;
	}
	let mut flattened = object.clone();
	flattened.remove(union_key);
	Some(Value::Object(flattened))
}

/// True when an object-root schema still carries an `anyOf`/`oneOf` with a
/// typeless or non-object branch; xAI rejects the whole request for one such
/// tool ("tool parameter root must be an object type"). Nested unions and
/// pure (untyped) root unions are not this error.
pub(crate) fn leftover_root_object_union(schema: &Value) -> bool {
	let Some(object) = schema.as_object() else {
		return false;
	};
	if !declares_object_root(object) {
		return false;
	}
	["anyOf", "oneOf"].into_iter().any(|key| {
		object
			.get(key)
			.and_then(Value::as_array)
			.is_some_and(|branches| {
				!branches.is_empty()
					&& branches
						.iter()
						.any(|branch| !branch.as_object().is_some_and(declares_object_type))
			})
	})
}

/// Whether the node's declared `type` names or includes `object`.
fn declares_object_type(object: &serde_json::Map<String, Value>) -> bool {
	match object.get("type") {
		Some(Value::String(kind)) => kind == "object",
		Some(Value::Array(kinds)) => kinds.iter().any(|kind| kind.as_str() == Some("object")),
		_ => false,
	}
}

/// Whether the schema root is object-shaped: object-typed or property-bearing.
fn declares_object_root(object: &serde_json::Map<String, Value>) -> bool {
	declares_object_type(object) || object.get("properties").is_some_and(Value::is_object)
}

/// One branch of an exclusive-required union: a typeless fragment carrying
/// only a non-empty `required` list plus optional `description`/`title`.
fn exclusive_required_branch(branch: &Value) -> bool {
	let Some(object) = branch.as_object() else {
		return false;
	};
	if object.contains_key("type") {
		return false;
	}
	let Some(required) = object.get("required").and_then(Value::as_array) else {
		return false;
	};
	if required.is_empty()
		|| !required
			.iter()
			.all(|name| name.as_str().is_some_and(|name| !name.is_empty()))
	{
		return false;
	}
	object
		.keys()
		.all(|key| matches!(key.as_str(), "required" | "description" | "title"))
}

fn lower_hosted_tools(
	profile: &OpenAiChatProfile,
	tools: &[HostedTool],
) -> Result<Vec<WireTool>, Error> {
	if tools.is_empty() {
		return Ok(Vec::new());
	}
	if profile.hosted_tools == HostedToolWireFormat::Unsupported {
		return Err(capability_error());
	}
	Ok(tools
		.iter()
		.map(|tool| match tool {
			HostedTool::WebSearch { allowed_domains, blocked_domains, recency_days } => {
				WireTool::WebSearch {
					web_search: Some(WebSearchOptions {
						allowed_domains: allowed_domains.to_vec(),
						blocked_domains: blocked_domains.to_vec(),
						recency_days:    *recency_days,
					}),
				}
			},
			HostedTool::CodeExecution => WireTool::CodeInterpreter,
			HostedTool::Retrieval { stores } => WireTool::FileSearch {
				file_search: FileSearchOptions { vector_store_ids: stores.to_vec() },
			},
		})
		.collect())
}

fn lower_tool_choice(
	profile: &OpenAiChatProfile,
	tools: &mut Vec<WireTool>,
	choice: &Setting<ToolChoice>,
	withheld: &[Str],
) -> Result<Option<WireToolChoice>, Error> {
	let choice = match choice {
		Setting::Unset => return Ok(None),
		Setting::Require(value) | Setting::Prefer(value) => value,
	};
	if !profile.tool_choice {
		return Err(capability_error());
	}
	// A force naming a withheld tool — or a bare `required` once withholding
	// emptied the list — would 400 exactly like the schema it was withheld
	// for; drop the force and let the model choose.
	match choice {
		ToolChoice::Named(name)
			if withheld
				.iter()
				.any(|withheld| withheld.as_str() == name.as_str()) =>
		{
			return Ok(None);
		},
		ToolChoice::Required if tools.is_empty() && !withheld.is_empty() => {
			return Ok(None);
		},
		_ => {},
	}
	Ok(Some(match choice {
		ToolChoice::Disabled => WireToolChoice::Mode(ToolChoiceMode::None),
		ToolChoice::Auto => WireToolChoice::Mode(ToolChoiceMode::Auto),
		ToolChoice::Required if profile.forced_tool_choice => {
			WireToolChoice::Mode(ToolChoiceMode::Required)
		},
		ToolChoice::Required => return Err(capability_error()),
		ToolChoice::Named(name) if profile.named_tool_choice && profile.forced_tool_choice => {
			WireToolChoice::Named {
				r#type:   FunctionTag::Function,
				function: NamedFunction { name: name.clone() },
			}
		},
		ToolChoice::Named(name) if profile.forced_tool_choice => {
			let before = tools.len();
			tools.retain(|tool| matches!(tool, WireTool::Function { function } if function.name.as_str() == name.as_str()));
			if tools.len() != 1 || before == 0 {
				return Err(encoding_error(ErrorKind::InvalidRequest));
			}
			WireToolChoice::Mode(ToolChoiceMode::Required)
		},
		ToolChoice::Named(_) => return Err(capability_error()),
	}))
}

fn lower_output(
	profile: &OpenAiChatProfile,
	output: &Setting<StructuredOutput>,
	adjustments: &mut Vec<Adjustment>,
) -> Result<Option<ResponseFormat>, Error> {
	let output = match output {
		Setting::Unset => return Ok(None),
		Setting::Require(value) | Setting::Prefer(value) => value,
	};
	Ok(Some(match output {
		StructuredOutput::JsonObject => ResponseFormat::JsonObject,
		StructuredOutput::JsonSchema { name, schema, strict } => {
			let projection = normalize_schema(
				schema.as_value(),
				*strict,
				(profile.tool_strict != ToolStrictWire::Unsupported).then_some(true),
				SchemaDialect::OpenAiChat,
			);
			if let Some(reason) = projection.fallback {
				adjustments.push(Adjustment::Dropped {
					feature: FeatureId::new_static("chat.structured_output.strict"),
					reason:  ReasonId::new_static(reason.reason_id()),
				});
			}
			ResponseFormat::JsonSchema {
				json_schema: JsonSchemaFormat {
					name:   name.clone(),
					schema: projection.schema,
					strict: projection.strict.unwrap_or(false),
				},
			}
		},
		StructuredOutput::Regex(_) | StructuredOutput::Lark(_) | StructuredOutput::Ebnf(_) => {
			return Err(capability_error());
		},
	}))
}

fn lower_reasoning(
	profile: &OpenAiChatProfile,
	reasoning: &Setting<ReasoningRequest>,
) -> Result<ReasoningFields, Error> {
	let reasoning = match reasoning {
		Setting::Unset => {
			return Ok(ReasoningFields {
				effort:        None,
				openrouter:    None,
				zai:           None,
				qwen:          None,
				chat_template: profile
					.qwen_preserve_thinking
					.then_some(ChatTemplateKwargs {
						enable_thinking:   None,
						thinking:          None,
						reasoning_effort:  None,
						preserve_thinking: Some(true),
					}),
				venice:        lower_venice_parameters(profile, false),
			});
		},
		Setting::Require(value) | Setting::Prefer(value) => value,
	};
	let explicit_venice_off = reasoning.effort == Some(ReasoningEffort::Off)
		&& profile.reasoning_disable == Some(CatalogReasoningDisableMode::VeniceDisableThinking);
	if explicit_venice_off {
		return Ok(ReasoningFields {
			effort:        None,
			openrouter:    None,
			zai:           None,
			qwen:          None,
			chat_template: None,
			venice:        lower_venice_parameters(profile, true),
		});
	}
	let effort = reasoning.effort.map(lower_effort);
	let venice = lower_venice_parameters(profile, false);
	let fields = match profile.reasoning {
		ReasoningWireFormat::OpenAiEffort if reasoning.max_tokens.is_some() => {
			return Err(capability_error());
		},
		ReasoningWireFormat::OpenAiEffort => ReasoningFields {
			effort,
			openrouter: None,
			zai: None,
			qwen: None,
			chat_template: None,
			venice,
		},
		ReasoningWireFormat::OpenRouter => ReasoningFields {
			effort: None,
			openrouter: Some(OpenRouterReasoning {
				effort,
				exclude: reasoning.visibility == ReasoningVisibility::Hidden,
				max_tokens: reasoning.max_tokens,
			}),
			zai: None,
			qwen: None,
			chat_template: None,
			venice,
		},
		ReasoningWireFormat::Zai => ReasoningFields {
			effort: None,
			openrouter: None,
			zai: Some(ZaiThinking {
				r#type: ThinkingType::Enabled,
				effort,
				keep: profile.thinking_keep.then_some(ThinkingKeep::All),
			}),
			qwen: None,
			chat_template: None,
			venice,
		},
		ReasoningWireFormat::Qwen => {
			let template_effort = profile
				.template_reasoning_effort
				.then_some(effort)
				.flatten();
			ReasoningFields {
				effort: template_effort,
				openrouter: None,
				zai: None,
				qwen: Some(true),
				chat_template: (!profile.template_effort_top_level_only)
					.then_some(template_effort)
					.flatten()
					.map(|effort| ChatTemplateKwargs {
						enable_thinking:   None,
						thinking:          None,
						reasoning_effort:  Some(effort),
						preserve_thinking: profile.qwen_preserve_thinking.then_some(true),
					}),
				venice,
			}
		},
		ReasoningWireFormat::Nvidia if profile.template_effort_top_level_only => ReasoningFields {
			effort: profile
				.template_reasoning_effort
				.then_some(effort)
				.flatten(),
			openrouter: None,
			zai: None,
			qwen: None,
			chat_template: Some(ChatTemplateKwargs {
				enable_thinking:   Some(true),
				thinking:          None,
				reasoning_effort:  None,
				preserve_thinking: profile.qwen_preserve_thinking.then_some(true),
			}),
			venice,
		},
		ReasoningWireFormat::Nvidia => ReasoningFields {
			effort: None,
			openrouter: None,
			zai: None,
			qwen: None,
			chat_template: Some(ChatTemplateKwargs {
				enable_thinking:   Some(true),
				thinking:          None,
				reasoning_effort:  profile
					.template_reasoning_effort
					.then_some(effort)
					.flatten(),
				preserve_thinking: profile.qwen_preserve_thinking.then_some(true),
			}),
			venice,
		},
		ReasoningWireFormat::ChatTemplate => ReasoningFields {
			effort: None,
			openrouter: None,
			zai: None,
			qwen: None,
			chat_template: Some(ChatTemplateKwargs {
				enable_thinking:   None,
				thinking:          Some(reasoning.effort != Some(ReasoningEffort::Off)),
				reasoning_effort:  (reasoning.effort != Some(ReasoningEffort::Off))
					.then_some(effort)
					.flatten(),
				preserve_thinking: profile.qwen_preserve_thinking.then_some(true),
			}),
			venice,
		},
		ReasoningWireFormat::Unsupported => return Err(capability_error()),
	};
	Ok(fields)
}

const fn lower_venice_parameters(
	profile: &OpenAiChatProfile,
	disable_thinking: bool,
) -> Option<WireVeniceParameters> {
	let configured = profile.venice_parameters;
	let disable_thinking = if disable_thinking {
		Some(true)
	} else {
		match configured {
			Some(parameters) => parameters.disable_thinking,
			None => None,
		}
	};
	let include_venice_system_prompt = match configured {
		Some(parameters) => parameters.include_venice_system_prompt,
		None => None,
	};
	if disable_thinking.is_none() && include_venice_system_prompt.is_none() {
		None
	} else {
		Some(WireVeniceParameters { disable_thinking, include_venice_system_prompt })
	}
}

const fn lower_effort(effort: ReasoningEffort) -> WireEffort {
	match effort {
		ReasoningEffort::Off => WireEffort::None,
		ReasoningEffort::Minimal => WireEffort::Minimal,
		ReasoningEffort::Low => WireEffort::Low,
		ReasoningEffort::Medium => WireEffort::Medium,
		ReasoningEffort::High => WireEffort::High,
		ReasoningEffort::Xhigh => WireEffort::Xhigh,
		ReasoningEffort::Max => WireEffort::Max,
	}
}

fn lower_service_tier(tier: &Setting<ServiceTier>) -> Option<Str> {
	match tier {
		Setting::Unset => None,
		Setting::Require(tier) | Setting::Prefer(tier) => Some(tier.name.clone()),
	}
}

#[allow(
	clippy::type_complexity,
	reason = "typed adapter fields map one-to-one to separate wire objects"
)]
fn lower_adapter(
	adapter: Option<&OpenAiChatAdapterOptions>,
) -> (
	Option<Str>,
	Option<PromptCacheOptions>,
	Option<ProviderRouting>,
	Option<GatewayProviderOptions>,
	Option<bool>,
) {
	match adapter {
		Some(OpenAiChatAdapterOptions::OpenAi(options)) => (
			options.prompt_cache_key.clone(),
			options
				.prompt_cache_retention
				.clone()
				.map(|retention| PromptCacheOptions { retention }),
			None,
			None,
			options.tool_stream,
		),
		Some(OpenAiChatAdapterOptions::OpenRouter(options)) => (
			None,
			None,
			Some(ProviderRouting {
				order:           options.provider_order.to_vec(),
				allow_fallbacks: options.allow_fallbacks,
			}),
			None,
			None,
		),
		Some(OpenAiChatAdapterOptions::Vercel(options)) => (
			None,
			None,
			None,
			options
				.cache
				.map(|cache| GatewayProviderOptions { gateway: GatewayOptions { cache } }),
			None,
		),
		None => (None, None, None, None, None),
	}
}

/// Incremental typed Chat Completions decoder.
#[derive(Default)]
pub struct OpenAiChatDecoder {
	choices: BTreeMap<u32, ChoiceState>,
	next_block: u32,
	usage: Usage,
	done: bool,
	committed: bool,
	reasoning_deltas_cumulative: bool,
	empty_length_finish_is_context_error: bool,
	strip_deepseek_special_tokens: bool,
}

#[derive(Default)]
struct ChoiceState {
	text_block:              Option<u32>,
	thinking_block:          Option<u32>,
	tools:                   BTreeMap<u32, PendingTool>,
	finish:                  Option<FinishReason>,
	last_reasoning_snapshot: Str,
}

struct PendingTool {
	block:            u32,
	id:               ToolCallId,
	name:             Str,
	arguments:        BytesMut,
	object_arguments: Option<serde_json::Map<String, Value>>,
	started:          bool,
	completed:        bool,
}

impl Decoder for OpenAiChatDecoder {
	fn push(&mut self, frame: Frame, emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		if self.done {
			return Ok(());
		}
		let Frame::Sse(event) = frame else {
			return Err(self.decode_error(None));
		};
		if event.data.as_ref() == b"[DONE]" {
			return self.complete(emit, true);
		}
		let chunk: WireChunk =
			serde_json::from_slice(&event.data).map_err(|_| self.decode_error(None))?;
		if let Some(error) = chunk
			.error
			.or_else(|| chunk.message.map(WireStreamError::Text))
		{
			self.done = true;
			emit(RawEvent::Failure(classify_stream_error(error, self.committed)));
			return Ok(());
		}
		let final_usage = chunk.choices.is_empty();
		for choice in chunk.choices {
			self.decode_choice(choice, emit);
		}
		if let Some(usage) = chunk.usage {
			merge_usage(&mut self.usage, usage.canonical());
			emit(RawEvent::Chat(ChatEvent::Usage(UsageUpdate {
				usage:        self.usage,
				final_update: final_usage,
			})));
		}
		Ok(())
	}

	fn finish(&mut self, emit: &mut dyn FnMut(RawEvent)) -> Result<(), Error> {
		if self.done {
			return Ok(());
		}
		self.complete(emit, false)
	}
}

impl OpenAiChatDecoder {
	fn from_profile(profile: &OpenAiChatProfile) -> Self {
		Self {
			reasoning_deltas_cumulative: profile.reasoning_deltas_cumulative,
			empty_length_finish_is_context_error: profile.empty_length_finish_is_context_error,
			strip_deepseek_special_tokens: profile.strip_deepseek_special_tokens,
			..Self::default()
		}
	}

	fn decode_choice(&mut self, choice: WireChoice, emit: &mut dyn FnMut(RawEvent)) {
		let index = choice.index;
		let mut state = self.choices.remove(&index).unwrap_or_default();
		if let Some(reason) = choice.finish_reason {
			if matches!(reason, WireFinishReason::InsufficientSystemResource) {
				self.done = true;
				emit(RawEvent::Failure(resource_finish_error(self.committed)));
				return;
			}
			state.finish = Some(reason.normalize());
		}
		let payload = choice.delta.or(choice.message).unwrap_or_default();
		if let Some(error) = payload.error {
			self.done = true;
			emit(RawEvent::Failure(classify_stream_error(error, self.committed)));
			return;
		}
		let reasoning = payload
			.reasoning_content
			.or(payload.reasoning_text)
			.or(payload.reasoning);
		if let Some(mut reasoning) = reasoning.filter(|text| !text.is_empty()) {
			if self.reasoning_deltas_cumulative {
				let previous = state.last_reasoning_snapshot.as_str();
				if reasoning.starts_with(previous) {
					let delta = reasoning.as_str()[previous.len()..].to_owned();
					state.last_reasoning_snapshot = reasoning;
					reasoning = Str::new(delta);
				} else {
					state.last_reasoning_snapshot = reasoning.clone();
				}
			}
			if !reasoning.is_empty() {
				let block = *state
					.thinking_block
					.get_or_insert_with(|| self.start_block(BlockKind::Thinking, emit));
				emit(RawEvent::Chat(ChatEvent::ThinkingDelta { index: block, text: reasoning }));
				self.committed = true;
			}
		}
		if let Some(mut content) = payload
			.content
			.map(WireDeltaContent::into_text)
			.or(payload.text)
			&& !content.is_empty()
		{
			if self.strip_deepseek_special_tokens {
				content = strip_deepseek_tokens(content.as_str());
			}
			if !content.is_empty() {
				let block = *state
					.text_block
					.get_or_insert_with(|| self.start_block(BlockKind::Text, emit));
				emit(RawEvent::Chat(ChatEvent::TextDelta { index: block, text: content }));
				self.committed = true;
			}
		}
		if let Some(refusal) = payload.refusal.filter(|text| !text.is_empty()) {
			let block = *state
				.text_block
				.get_or_insert_with(|| self.start_block(BlockKind::Text, emit));
			emit(RawEvent::Chat(ChatEvent::TextDelta { index: block, text: refusal }));
			self.committed = true;
		}
		for detail in payload.reasoning_details {
			if let Some(signature) = detail.data {
				let block = state.thinking_block.unwrap_or(0);
				emit(RawEvent::ProviderState(ProviderStateEvent::ReasoningSignature {
					index:     block,
					signature: Bytes::from(signature.into_bytes()),
				}));
			}
		}
		for (position, call) in payload.tool_calls.into_iter().enumerate() {
			let wire_index = call.index.unwrap_or(position as u32);
			if let Entry::Vacant(e) = state.tools.entry(wire_index) {
				let block = self.next_block;
				self.next_block = self.next_block.saturating_add(1);
				let id = call
					.id
					.clone()
					.unwrap_or_else(|| sf!("tool-{index}-{wire_index}"));
				e.insert(PendingTool {
					block,
					id: ToolCallId::from(id.as_str()),
					name: Str::default(),
					arguments: BytesMut::new(),
					object_arguments: None,
					started: false,
					completed: false,
				});
			}
			let tool = state
				.tools
				.get_mut(&wire_index)
				.expect("tool inserted above");
			if let Some(id) = call.id {
				tool.id = ToolCallId::from(id.as_str());
			}
			if let Some(name) = call.function.name {
				tool.name = name;
			}
			if !tool.started && !tool.name.is_empty() {
				tool.started = true;
				emit(RawEvent::Chat(ChatEvent::BlockStarted {
					index: tool.block,
					kind:  BlockKind::ToolCall,
				}));
				emit(RawEvent::Chat(ChatEvent::ToolCallStarted {
					index: tool.block,
					id:    tool.id.clone(),
					name:  tool.name.clone(),
				}));
				if !tool.arguments.is_empty() {
					emit(RawEvent::Chat(ChatEvent::ToolArgumentsDelta {
						index: tool.block,
						bytes: Bytes::copy_from_slice(&tool.arguments),
					}));
				}
				self.committed = true;
			}
			if let Some(arguments) = call.function.arguments {
				match arguments {
					WireFunctionArguments::Text(arguments) if !arguments.is_empty() => {
						tool.arguments.extend_from_slice(arguments.as_bytes());
						if tool.started {
							emit(RawEvent::Chat(ChatEvent::ToolArgumentsDelta {
								index: tool.block,
								bytes: Bytes::copy_from_slice(arguments.as_bytes()),
							}));
							self.committed = true;
						}
					},
					WireFunctionArguments::Object(fragment) => {
						let accumulated = tool.object_arguments.get_or_insert_with(Default::default);
						merge_streaming_argument_objects(accumulated, fragment);
					},
					WireFunctionArguments::Text(_) => {},
				}
			}
		}
		self.choices.insert(index, state);
	}

	fn start_block(&mut self, kind: BlockKind, emit: &mut dyn FnMut(RawEvent)) -> u32 {
		let index = self.next_block;
		self.next_block = self.next_block.saturating_add(1);
		emit(RawEvent::Chat(ChatEvent::BlockStarted { index, kind }));
		index
	}

	fn complete(
		&mut self,
		emit: &mut dyn FnMut(RawEvent),
		authoritative_terminal: bool,
	) -> Result<(), Error> {
		if self.done {
			return Ok(());
		}
		if self.committed
			&& !authoritative_terminal
			&& !self.choices.values().any(|state| state.finish.is_some())
		{
			self.done = true;
			return Err(incomplete_stream_error());
		}
		if self.empty_length_finish_is_context_error
			&& !self.committed
			&& self
				.choices
				.values()
				.any(|state| state.finish == Some(FinishReason::Length))
		{
			self.done = true;
			return Err(Error::new(
				ErrorKind::ContextOverflow,
				ErrorPhase::Streaming,
				RetryAction::Never,
				ExecutionReceipt::default(),
			));
		}
		let mut finish = FinishReason::Stop;
		let committed = self.committed;
		for state in self.choices.values_mut() {
			let has_tools = !state.tools.is_empty();
			let choice_finish = if has_tools {
				FinishReason::ToolCalls
			} else {
				state.finish.clone().unwrap_or(FinishReason::Stop)
			};
			finish = merge_finish(finish, choice_finish);
			for tool in state.tools.values_mut() {
				if tool.completed {
					continue;
				}
				if !tool.started || tool.name.is_empty() {
					return Err(protocol_error(committed, None));
				}
				if let Some(arguments) = tool.object_arguments.take() {
					let bytes =
						serde_json::to_vec(&arguments).map_err(|_| protocol_error(committed, None))?;
					tool.arguments.clear();
					tool.arguments.extend_from_slice(&bytes);
					emit(RawEvent::Chat(ChatEvent::ToolArgumentsDelta {
						index: tool.block,
						bytes: Bytes::from(bytes),
					}));
				}
				tool.completed = true;
				emit(RawEvent::ToolCallComplete {
					index: tool.block,
					call:  UnvalidatedToolCall {
						id:         tool.id.clone(),
						name:       tool.name.clone(),
						input_kind: ToolInputKind::Json,
						arguments:  tool.arguments.clone().freeze(),
					},
				});
			}
		}
		self.done = true;
		emit(RawEvent::Completion(RawCompletion {
			reason: finish,
			blocks: self.next_block,
			usage:  self.usage,
		}));
		Ok(())
	}

	fn decode_error(&self, code: Option<Str>) -> Error {
		Error::new(
			ErrorKind::Protocol,
			if self.committed {
				ErrorPhase::Streaming
			} else {
				ErrorPhase::Handshake
			},
			RetryAction::Never,
			ExecutionReceipt::default(),
		)
		.optional_code(code)
		.committed(self.committed)
	}
}

#[derive(Deserialize)]
struct WireChunk {
	#[serde(default)]
	choices: Vec<WireChoice>,
	#[serde(default)]
	usage:   Option<WireUsage>,
	#[serde(default)]
	error:   Option<WireStreamError>,
	#[serde(default)]
	message: Option<Str>,
}

#[derive(Deserialize)]
struct WireChoice {
	index:         u32,
	#[serde(default)]
	delta:         Option<WirePayload>,
	#[serde(default)]
	message:       Option<WirePayload>,
	#[serde(default)]
	finish_reason: Option<WireFinishReason>,
}

#[derive(Default, Deserialize)]
struct WirePayload {
	#[serde(default)]
	content:           Option<WireDeltaContent>,
	#[serde(default, rename = "text")]
	text:              Option<Str>,
	#[serde(default)]
	reasoning_content: Option<Str>,
	#[serde(default)]
	reasoning_text:    Option<Str>,
	#[serde(default)]
	reasoning:         Option<Str>,
	#[serde(default)]
	refusal:           Option<Str>,
	#[serde(default)]
	tool_calls:        Vec<WireToolCallDelta>,
	#[serde(default)]
	reasoning_details: Vec<WireReasoningDetail>,
	#[serde(default)]
	error:             Option<WireStreamError>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum WireDeltaContent {
	Text(Str),
	Parts(Vec<WireTextPart>),
}

impl WireDeltaContent {
	fn into_text(self) -> Str {
		match self {
			Self::Text(text) => text,
			Self::Parts(parts) => {
				let mut output = String::new();
				for part in parts {
					output.push_str(part.text.as_str());
				}
				Str::new(output)
			},
		}
	}
}

#[derive(Deserialize)]
struct WireTextPart {
	#[serde(rename = "type", default)]
	_kind: Option<TextPartKind>,
	text:  Str,
}

#[derive(Deserialize)]
#[serde(rename_all = "snake_case")]
enum TextPartKind {
	Text,
	OutputText,
}
#[derive(Deserialize)]
struct WireToolCallDelta {
	#[serde(default)]
	index:    Option<u32>,
	#[serde(default)]
	id:       Option<Str>,
	function: WireFunctionDelta,
}

#[derive(Deserialize)]
struct WireFunctionDelta {
	#[serde(default)]
	name:      Option<Str>,
	#[serde(default)]
	arguments: Option<WireFunctionArguments>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum WireFunctionArguments {
	Text(Str),
	Object(serde_json::Map<String, Value>),
}
fn strip_deepseek_tokens(text: &str) -> Str {
	let mut output = String::with_capacity(text.len());
	let mut rest = text;
	while let Some(start) = rest.find('<') {
		output.push_str(&rest[..start]);
		let candidate = &rest[start..];
		let opening = candidate.starts_with("<|") || candidate.starts_with("<｜");
		let ending = candidate
			.find("|>")
			.map(|end| (end, "|>".len()))
			.or_else(|| candidate.find("｜>").map(|end| (end, "｜>".len())));
		if opening
			&& let Some((end, ending_len)) = ending
			&& end <= 68
		{
			rest = &candidate[end + ending_len..];
			continue;
		}
		output.push('<');
		rest = &candidate[1..];
	}
	output.push_str(rest);
	Str::new(output)
}

fn merge_streaming_argument_objects(
	accumulated: &mut serde_json::Map<String, Value>,
	fragment: serde_json::Map<String, Value>,
) {
	for (key, value) in fragment {
		if matches!(key.as_str(), "__proto__" | "constructor" | "prototype") {
			continue;
		}
		if let Some(previous) = accumulated.get_mut(&key) {
			merge_streaming_argument_value(previous, value);
		} else {
			accumulated.insert(key, value);
		}
	}
}

fn merge_streaming_argument_value(previous: &mut Value, fragment: Value) {
	match (previous, fragment) {
		(Value::String(previous), Value::String(fragment)) => {
			if fragment.starts_with(previous.as_str()) {
				*previous = fragment;
			} else {
				previous.push_str(&fragment);
			}
		},
		(Value::Array(previous), Value::Array(fragment)) => {
			if fragment.starts_with(previous) {
				*previous = fragment;
			} else if !previous.starts_with(&fragment) {
				previous.extend(fragment);
			}
		},
		(Value::Object(previous), Value::Object(fragment)) => {
			merge_streaming_argument_objects(previous, fragment);
		},
		(previous, fragment) => *previous = fragment,
	}
}

#[derive(Deserialize)]
struct WireReasoningDetail {
	#[serde(default, rename = "id")]
	_id:  Option<Str>,
	#[serde(default)]
	data: Option<String>,
}

#[derive(Deserialize)]
struct WireUsage {
	#[serde(default)]
	prompt_tokens:              u64,
	#[serde(default)]
	completion_tokens:          u64,
	#[serde(default)]
	cached_tokens:              u64,
	#[serde(default)]
	prompt_cache_hit_tokens:    u64,
	#[serde(default, rename = "cachedContentTokenCount")]
	cached_content_token_count: u64,
	#[serde(default)]
	prompt_cache_miss_tokens:   u64,
	#[serde(default)]
	prompt_tokens_details:      WirePromptDetails,
	#[serde(default)]
	completion_tokens_details:  WireCompletionDetails,
}

impl WireUsage {
	fn canonical(self) -> Usage {
		let cache_read = self
			.prompt_tokens_details
			.cached_tokens
			.max(self.cached_tokens)
			.max(self.prompt_cache_hit_tokens)
			.max(self.cached_content_token_count);
		let cache_write =
			self
				.prompt_tokens_details
				.cache_write_tokens
				.max(if self.prompt_cache_hit_tokens > 0 {
					self.prompt_cache_miss_tokens
				} else {
					0
				});
		Usage {
			input_tokens: self.prompt_tokens.saturating_sub(cache_read),
			output_tokens: self.completion_tokens,
			reasoning_tokens: self.completion_tokens_details.reasoning_tokens,
			cache_read_tokens: cache_read,
			cache_write_tokens: cache_write,
			source: UsageSource::Provider,
			..Usage::default()
		}
	}
}

#[derive(Default, Deserialize)]
struct WirePromptDetails {
	#[serde(default)]
	cached_tokens:      u64,
	#[serde(default)]
	cache_write_tokens: u64,
}

#[derive(Default, Deserialize)]
struct WireCompletionDetails {
	#[serde(default)]
	reasoning_tokens: u64,
}

#[derive(EnumString)]
#[strum(serialize_all = "snake_case", ascii_case_insensitive)]
enum WireFinishReason {
	Stop,
	End,
	EndTurn,
	ToolCalls,
	FunctionCall,
	ToolUse,
	Length,
	MaxTokens,
	MaxOutputTokens,
	ContentFilter,
	Safety,
	InsufficientSystemResource,
}

impl<'de> Deserialize<'de> for WireFinishReason {
	fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
	where
		D: serde::Deserializer<'de>,
	{
		Str::deserialize(deserializer)?
			.parse()
			.map_err(serde::de::Error::custom)
	}
}

impl WireFinishReason {
	fn normalize(self) -> FinishReason {
		match self {
			Self::Stop | Self::End | Self::EndTurn => FinishReason::Stop,
			Self::ToolCalls | Self::FunctionCall | Self::ToolUse => FinishReason::ToolCalls,
			Self::Length | Self::MaxTokens | Self::MaxOutputTokens => FinishReason::Length,
			Self::ContentFilter | Self::Safety => FinishReason::ContentFilter,
			Self::InsufficientSystemResource => {
				unreachable!("resource finish is handled before normalization")
			},
		}
	}
}

#[derive(Deserialize)]
#[serde(untagged)]
enum WireStreamError {
	Structured(WireError),
	Text(Str),
}

#[derive(Deserialize)]
struct WireError {
	#[serde(default)]
	code:            Option<ErrorCode>,
	#[serde(default)]
	message:         Option<Str>,
	#[serde(default, rename = "type")]
	kind:            Option<Str>,
	#[serde(default)]
	param:           Option<Str>,
	#[serde(default)]
	metadata:        Option<ErrorMetadata>,
	/// `LiteLLM`'s structured limiter discriminator, e.g.
	/// `max_parallel_requests` for a proxy concurrency-admission 429.
	#[serde(default)]
	rate_limit_type: Option<Str>,
}

#[derive(Deserialize)]
#[serde(untagged)]
enum ErrorCode {
	Text(Str),
	Number(i64),
}

impl ErrorCode {
	fn text(&self) -> Str {
		match self {
			Self::Text(value) => value.clone(),
			Self::Number(value) => value.to_str(),
		}
	}
}

#[derive(Deserialize)]
struct ErrorMetadata {
	#[serde(default)]
	raw: Option<Str>,
}

fn classify_stream_error(error: WireStreamError, committed: bool) -> Error {
	match error {
		WireStreamError::Structured(error) => classify_error(error, committed),
		WireStreamError::Text(message) => Error::new(
			ErrorKind::Protocol,
			if committed {
				ErrorPhase::Streaming
			} else {
				ErrorPhase::Handshake
			},
			RetryAction::Never,
			ExecutionReceipt::default(),
		)
		.detail(ErrorDetail::provider(message))
		.committed(committed),
	}
}

fn classify_error(error: WireError, committed: bool) -> Error {
	let status = match error.code.as_ref() {
		Some(ErrorCode::Number(value)) => u16::try_from(*value).ok(),
		Some(ErrorCode::Text(value)) => value.as_str().parse().ok(),
		None => error.kind.as_deref().and_then(|kind| {
			let kind = kind.trim();
			if kind.eq_ignore_ascii_case("SERVICE_UNAVAILABLE") {
				Some(503)
			} else if kind.eq_ignore_ascii_case("TOO_MANY_REQUESTS") {
				Some(429)
			} else if kind.eq_ignore_ascii_case("REQUEST_TIMEOUT") {
				Some(408)
			} else {
				None
			}
		}),
	};
	let code = error
		.code
		.as_ref()
		.map(ErrorCode::text)
		.or_else(|| error.kind.clone());
	let code_text = code.as_ref().map(Str::as_str).unwrap_or_default();
	let message = error.message.as_ref().map(Str::as_str).unwrap_or_default();
	let provider_message = error.message.clone().filter(|message| !message.is_empty());
	// DashScope / Bailian reports its per-minute TPM/TPS throttle (429
	// `Throttling.AllocationQuota`, type `insufficient_quota`) with
	// OpenAI-compatible billing wording, but links the error-code doc's
	// `token-limit` anchor. That doc anchor also covers permanent errors such
	// as "Free allocated quota exceeded", so BOTH the anchor and the exact
	// throttle wording are required. The identical wording WITHOUT the anchor
	// is OpenAI's real account-quota error and stays quota-exhausted.
	let dashscope_token_limit = code_text == "insufficient_quota"
		&& dashscope_token_limit_anchor(message.as_bytes())
		&& contains_ascii_case_insensitive(
			message.as_bytes(),
			b"you exceeded your current quota, please check your plan and billing details",
		);
	// llama.cpp reports deterministic tool-call JSON parse failures as HTTP
	// 500; replaying the same prompt produces the same malformed output, so
	// they never enter the transient lane.
	let deterministic_parse_failure =
		contains_ascii_case_insensitive(
			message.as_bytes(),
			b"failed to parse tool call arguments as json",
		) || contains_ascii_case_insensitive(message.as_bytes(), b"[json.exception.parse_error.101]");
	let transient_server_error = !deterministic_parse_failure
		&& (matches!(status, Some(500 | 502 | 503 | 529))
			|| matches!(code_text, "server_error" | "internal_server_error" | "overloaded_error"));
	// LiteLLM (and compatible proxies) shed over-concurrency requests *before*
	// dispatching to the model backend, marking the immediate 429 with
	// `rate_limit_type: max_parallel_requests`. That is an admission failure,
	// not an upstream RPM/TPM throttle: the request never reached a model, and
	// sleeping on the same route (honoring the proxy's ~60s hint) duplicates
	// the backoff and model fallback the router already owns, stalling one
	// turn for minutes. Genuine quota 429s carry no marker.
	let concurrency_admission = error
		.rate_limit_type
		.as_ref()
		.is_some_and(|value| value.as_str().trim() == "max_parallel_requests");
	// Strict `chat_template_kwargs` whitelists (e.g. NInfer) reject the
	// effort's kwargs spelling itself with a deterministic 400. The rejection
	// is adaptable, not terminal: the retry re-encodes with the effort routed
	// onto the standard top-level field only (`template_effort_rejected` in
	// `EncodeAttempt`), keyed off this classification's canonical error code
	// in the attempt receipt.
	let template_effort_rejection = template_kwarg_effort_rejection(&error, message);
	let rejection_kind = classify_provider_rejection(status, Some(message), None, None);
	let generation_fault =
		matches!(status, Some(400)) || matches!(code_text, "400" | "invalid_request_error");
	let generation_fault = generation_fault && is_transient_generation_fault(message);
	let (kind, action) = if let Some(kind) = rejection_kind {
		(kind, RetryAction::Never)
	} else if generation_fault {
		(ErrorKind::ResourceExhausted, RetryAction::SameRoute { after: Duration::ZERO })
	} else if status == Some(401) || matches!(code_text, "invalid_api_key" | "authentication_error")
	{
		(
			ErrorKind::Authentication,
			if committed {
				RetryAction::Never
			} else {
				RetryAction::RefreshCredential
			},
		)
	} else if status == Some(403) || code_text == "permission_denied" {
		(
			ErrorKind::Authorization,
			if committed {
				RetryAction::Never
			} else {
				RetryAction::RotateAccount
			},
		)
	} else if concurrency_admission {
		// Concurrency-admission shed: surface immediately so the fallback walk
		// owns retry instead of the transport's same-route sleep.
		(ErrorKind::RateLimited, RetryAction::ReselectRoute)
	} else if status == Some(429) || code_text == "rate_limit_exceeded" {
		// Transient rate throttle: short backoff on the same credential.
		(ErrorKind::RateLimited, RetryAction::SameRoute { after: Duration::from_secs(30) })
	} else if status == Some(408) {
		(
			ErrorKind::DeadlineExceeded,
			if committed {
				RetryAction::Never
			} else {
				RetryAction::SameRoute { after: Duration::ZERO }
			},
		)
	} else if code_text == "insufficient_quota" && dashscope_token_limit {
		(ErrorKind::RateLimited, RetryAction::SameRoute { after: Duration::from_secs(30) })
	} else if code_text == "insufficient_quota" {
		(ErrorKind::QuotaExhausted, RetryAction::Never)
	} else if matches!(code_text, "content_filter" | "safety") {
		(ErrorKind::ContentFilter, RetryAction::Never)
	} else if code_text == "context_length_exceeded" || message.contains("context length") {
		(ErrorKind::ContextOverflow, RetryAction::Never)
	} else if transient_server_error {
		// A oneshot blip (HTTP 500/502/503/529, provider overload) replays
		// safely pre-commit; the retry layer bounds attempts and refuses once
		// output committed.
		(ErrorKind::ResourceExhausted, RetryAction::SameRoute { after: Duration::from_millis(500) })
	} else if status == Some(402) || code_text == "payment_required" {
		(ErrorKind::PaymentRequired, RetryAction::Never)
	} else if template_effort_rejection {
		(ErrorKind::InvalidRequest, RetryAction::SameRoute { after: Duration::ZERO })
	} else if status == Some(400) || code_text == "invalid_request_error" {
		(ErrorKind::InvalidRequest, RetryAction::Never)
	} else {
		(ErrorKind::ProviderContractMismatch, RetryAction::Never)
	};
	let classified = Error::new(
		kind,
		if committed {
			ErrorPhase::Streaming
		} else {
			ErrorPhase::Handshake
		},
		action,
		ExecutionReceipt::default(),
	)
	.status(status)
	.optional_code(
		template_effort_rejection
			.then(|| sf!(TEMPLATE_EFFORT_REJECTED_CODE))
			.or_else(|| error.metadata.and_then(|metadata| metadata.raw))
			.or(code),
	)
	.committed(committed);
	match provider_message {
		Some(message) => classified.detail(ErrorDetail::provider(message)),
		None => classified,
	}
}

/// Canonical structured code for a rejected kwargs effort spelling.
///
/// Recorded when an endpoint rejects `chat_template_kwargs.reasoning_effort`;
/// the route encoder reads it back from attempt evidence to hoist the effort
/// onto the top-level field.
pub const TEMPLATE_EFFORT_REJECTED_CODE: &str = "openai_chat.template_effort_rejected";

/// True when the error names the `chat_template_kwargs` spelling of
/// `reasoning_effort` in its message or `param` (`NInfer`:
/// `chat_template_kwargs.reasoning_effort is not supported`; pydantic-style
/// validators name the field in `param` alone).
fn template_kwarg_effort_rejection(error: &WireError, message: &str) -> bool {
	let names_kwarg = |text: &str| {
		contains_ascii_case_insensitive(text.as_bytes(), b"chat_template_kwargs")
			&& contains_ascii_case_insensitive(text.as_bytes(), b"reasoning_effort")
	};
	names_kwarg(message)
		|| error
			.param
			.as_ref()
			.is_some_and(|param| names_kwarg(param.as_str()))
}

/// True when `error-code` and `#token-limit` occur inside one URL-like token,
/// mirroring `DashScope`'s documented `error-code…#token-limit` doc anchor.
fn dashscope_token_limit_anchor(message: &[u8]) -> bool {
	const PREFIX: &[u8] = b"error-code";
	const ANCHOR: &[u8] = b"#token-limit";
	let mut offset = 0;
	while offset + PREFIX.len() <= message.len() {
		let window = &message[offset..];
		if !window[..PREFIX.len()].eq_ignore_ascii_case(PREFIX) {
			offset += 1;
			continue;
		}
		let token = &window[PREFIX.len()..];
		let token_end = token
			.iter()
			.position(|&byte| byte.is_ascii_whitespace() || matches!(byte, b'(' | b')'))
			.unwrap_or(token.len());
		if contains_ascii_case_insensitive(&token[..token_end], ANCHOR) {
			return true;
		}
		offset += 1;
	}
	false
}
fn contains_ascii_case_insensitive(haystack: &[u8], needle: &[u8]) -> bool {
	haystack
		.windows(needle.len())
		.any(|window| window.eq_ignore_ascii_case(needle))
}

fn incomplete_stream_error() -> Error {
	Error::new(
		ErrorKind::StreamCorruption,
		ErrorPhase::Streaming,
		RetryAction::SemanticRetry,
		ExecutionReceipt::default(),
	)
	.code(sf!("openai_chat.incomplete_stream"))
	.committed(true)
}

fn resource_finish_error(committed: bool) -> Error {
	Error::new(
		ErrorKind::ResourceExhausted,
		if committed {
			ErrorPhase::Streaming
		} else {
			ErrorPhase::Handshake
		},
		RetryAction::SemanticRetry,
		ExecutionReceipt::default(),
	)
	.code(sf!("insufficient_system_resource"))
	.committed(committed)
}

fn protocol_error(committed: bool, code: Option<Str>) -> Error {
	Error::new(
		ErrorKind::Protocol,
		if committed {
			ErrorPhase::Streaming
		} else {
			ErrorPhase::Handshake
		},
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
	.optional_code(code)
	.committed(committed)
}

const fn merge_usage(current: &mut Usage, update: Usage) {
	if update.input_tokens != 0 {
		current.input_tokens = update.input_tokens;
	}
	if update.output_tokens != 0 {
		current.output_tokens = update.output_tokens;
	}
	if update.reasoning_tokens != 0 {
		current.reasoning_tokens = update.reasoning_tokens;
	}
	if update.cache_read_tokens != 0 {
		current.cache_read_tokens = update.cache_read_tokens;
	}
	if update.cache_write_tokens != 0 {
		current.cache_write_tokens = update.cache_write_tokens;
	}
	current.source = UsageSource::Provider;
}

fn merge_finish(current: FinishReason, incoming: FinishReason) -> FinishReason {
	const fn rank(reason: &FinishReason) -> u8 {
		match reason {
			FinishReason::ContentFilter => 4,
			FinishReason::ToolCalls => 3,
			FinishReason::Length => 2,
			FinishReason::Stop => 1,
			_ => 0,
		}
	}
	if rank(&incoming) > rank(&current) {
		incoming
	} else {
		current
	}
}

fn capability_error() -> Error {
	Error::new(
		ErrorKind::CapabilityMismatch,
		ErrorPhase::Encoding,
		RetryAction::Never,
		ExecutionReceipt::default(),
	)
}

fn encoding_error(kind: ErrorKind) -> Error {
	Error::new(kind, ErrorPhase::Encoding, RetryAction::Never, ExecutionReceipt::default())
}

#[cfg(test)]
mod tests {
	use std::{sync::Arc, time::Duration};

	use bytes::Bytes;
	use omp_catalog::{Catalog, PolicyModel, WireTarget, policy};
	use serde::Deserialize;

	use super::{
		ErrorCode, OpenAiChatAdapterOptions, OpenAiChatCodec, OpenAiChatDecoder, OpenAiChatProfile,
		OpenAiOptions, ReasoningWireFormat, ToolIdWireProfile, WireError, WireFinishReason,
		WireUsage, classify_error, flatten_exclusive_required_root_union,
	};
	use crate::{
		body::BodySource,
		call::{
			CallAffinity, ChatRequest, ContentPart, MediaInput, Message, NegotiationPolicy,
			OpaqueJson, OperationCall, ReasoningRequest, ReasoningVisibility, Role, Sampling, Setting,
			ToolChoice, ToolDefinition, ToolInputConstraint, ToolResultContent,
		},
		catalog::ReasoningEffort,
		codec::{Codec, Decoder, EncodeContext, RawEvent},
		error::{Error, ErrorDetail, ErrorKind, RetryAction},
		event::{ChatEvent, FinishReason},
		id::RequestId,
		receipt::Adjustment,
		transport::{Frame, SseDecoder, SseEvent},
	};

	fn request(messages: Arc<[Message]>) -> ChatRequest {
		ChatRequest {
			messages,
			tools: Arc::from([]),
			hosted_tools: Arc::from([]),
			tool_choice: Setting::Unset,
			output: Setting::Unset,
			reasoning: Setting::Unset,
			verbosity: Setting::Unset,
			cache_retention: Setting::Unset,
			service_tier: Setting::Unset,
			sampling: Sampling::default(),
			max_output_tokens: None,
			top_logprobs: None,
			safety: Arc::from([]),
			negotiation: NegotiationPolicy::default(),
			forced_call: None,
		}
	}

	fn text_message(text: &str) -> Message {
		Message {
			role:    Role::User,
			content: Arc::from([ContentPart::Text { text: text.into(), proof: None }]),
			name:    None,
		}
	}

	fn decode_fixture(source: &str) -> Result<Vec<RawEvent>, Error> {
		let mut framer = SseDecoder::new();
		let mut decoder = OpenAiChatDecoder::default();
		let mut events = Vec::new();
		let mut done_sent = false;
		for chunk in source.as_bytes().chunks(7) {
			for event in framer
				.push(Bytes::copy_from_slice(chunk))
				.expect("valid SSE fixture")
			{
				decoder.push(Frame::Sse(event), &mut |event| events.push(event))?;
			}
			if framer.is_done() && !done_sent {
				decoder.push(
					Frame::Sse(SseEvent { name: None, data: Bytes::from_static(b"[DONE]") }),
					&mut |event| events.push(event),
				)?;
				done_sent = true;
			}
		}
		for event in framer.finish().expect("complete SSE fixture") {
			decoder.push(Frame::Sse(event), &mut |event| events.push(event))?;
		}
		decoder.finish(&mut |event| events.push(event))?;
		Ok(events)
	}

	#[test]
	fn plain_request_matches_exact_wire_bytes() {
		let codec = OpenAiChatCodec::default();
		let request = request(Arc::from([text_message("Say hello.")]));
		let bytes = codec
			.encode_chat("gpt-4.1", &request)
			.expect("request encodes");
		assert_eq!(
			bytes.as_ref(),
			br#"{"model":"gpt-4.1","messages":[{"role":"user","content":"Say hello."}],"stream":true,"stream_options":{"include_usage":true}}"#,
		);
	}

	#[derive(Deserialize)]
	struct StrictEnvelope {
		tools: Vec<StrictTool>,
	}

	#[derive(Deserialize)]
	struct StrictTool {
		function: StrictFunction,
	}

	#[derive(Deserialize)]
	struct StrictFunction {
		strict:     bool,
		parameters: StrictObject,
	}

	#[derive(Deserialize)]
	#[serde(rename_all = "camelCase")]
	struct StrictObject {
		required:              Vec<String>,
		additional_properties: bool,
		properties:            serde_json::Map<String, serde_json::Value>,
	}

	#[test]
	fn strict_tools_close_objects_and_require_every_property() {
		let mut request = request(Arc::from([text_message("lookup")]));
		request.tools = Arc::from([ToolDefinition {
			name:        "lookup".into(),
			description: None,
			input:       ToolInputConstraint::JsonSchema {
				parameters: OpaqueJson::new(
					serde_json::from_str(r#"{"type":"object","properties":{"q":{"type":"string"}}}"#)
						.expect("schema fixture"),
				),
				strict:     true,
			},
		}]);
		let bytes = OpenAiChatCodec::default()
			.encode_chat("gpt", &request)
			.expect("request encodes");
		let decoded: StrictEnvelope = serde_json::from_slice(&bytes).expect("typed wire request");
		let function = &decoded.tools[0].function;
		assert!(function.strict);
		assert_eq!(function.parameters.required, ["q"]);
		assert!(!function.parameters.additional_properties);
		assert!(function.parameters.properties.contains_key("q"));
	}

	#[derive(Deserialize)]
	struct UnionEnvelope {
		#[serde(default)]
		tools:       Vec<UnionTool>,
		#[serde(default)]
		tool_choice: Option<serde_json::Value>,
	}

	#[derive(Deserialize)]
	struct UnionTool {
		function: UnionFunction,
	}

	#[derive(Deserialize)]
	struct UnionFunction {
		name:       String,
		parameters: serde_json::Value,
	}

	fn json_tool(name: &str, parameters: serde_json::Value) -> ToolDefinition {
		ToolDefinition {
			name:        name.into(),
			description: None,
			input:       ToolInputConstraint::JsonSchema {
				parameters: OpaqueJson::new(parameters),
				strict:     false,
			},
		}
	}

	/// Exclusive-required MCP shape for the xAI 400 class.
	fn coverage_tool() -> ToolDefinition {
		json_tool(
			"mcp__codebase_memory_check_index_coverage",
			serde_json::json!({
				"type": "object",
				"properties": {
					"project": {"type": "string"},
					"paths": {"type": "array", "items": {"type": "string"}},
					"scopes": {"type": "array", "items": {"type": "string"}}
				},
				"required": ["project"],
				"anyOf": [{"required": ["paths"]}, {"required": ["scopes"]}]
			}),
		)
	}

	/// A root union whose branches carry real constraints and must survive.
	fn leftover_tool() -> ToolDefinition {
		json_tool(
			"mcp__leftover_union",
			serde_json::json!({
				"type": "object",
				"properties": {"kind": {"type": "string"}},
				"anyOf": [
					{"required": ["kind"], "minProperties": 1},
					{"required": ["kind"], "minProperties": 2}
				]
			}),
		)
	}

	fn good_tool() -> ToolDefinition {
		json_tool(
			"read_file",
			serde_json::json!({
				"type": "object",
				"properties": {"path": {"type": "string"}},
				"required": ["path"]
			}),
		)
	}

	fn flatten_codec() -> OpenAiChatCodec {
		OpenAiChatCodec::new(
			OpenAiChatProfile { flatten_root_unions: true, ..OpenAiChatProfile::default() },
			None,
		)
	}

	fn encode_union_request(
		codec: &OpenAiChatCodec,
		tools: Arc<[ToolDefinition]>,
		tool_choice: Setting<ToolChoice>,
	) -> UnionEnvelope {
		let mut request = request(Arc::from([text_message("check coverage")]));
		request.tools = tools;
		request.tool_choice = tool_choice;
		let bytes = codec
			.encode_chat("grok-4", &request)
			.expect("request encodes");
		serde_json::from_slice(&bytes).expect("typed wire request")
	}

	fn tool_names(envelope: &UnionEnvelope) -> Vec<&str> {
		envelope
			.tools
			.iter()
			.map(|tool| tool.function.name.as_str())
			.collect()
	}

	#[test]
	fn reject_root_object_union_matches_pi_request_shape() {
		let mut policy = policy::WirePolicy::overrides();
		policy.tool.reject_root_object_union = Some(true);
		let mut profile = OpenAiChatProfile::default();
		profile.apply_policy(&policy);
		let codec = OpenAiChatCodec::new(profile, None);
		let envelope =
			encode_union_request(&codec, Arc::from([coverage_tool(), good_tool()]), Setting::Unset);
		assert_eq!(tool_names(&envelope), ["mcp__codebase_memory_check_index_coverage", "read_file"]);
		assert!(envelope.tools[0].function.parameters.get("anyOf").is_none());
		assert!(
			envelope.tools[0]
				.function
				.parameters
				.get("required")
				.is_some()
		);
	}

	#[test]
	fn default_profile_preserves_exclusive_required_root_union() {
		let envelope = encode_union_request(
			&OpenAiChatCodec::default(),
			Arc::from([coverage_tool(), good_tool()]),
			Setting::Unset,
		);
		assert_eq!(tool_names(&envelope), ["mcp__codebase_memory_check_index_coverage", "read_file"]);
		assert_eq!(
			envelope.tools[0]
				.function
				.parameters
				.get("anyOf")
				.and_then(serde_json::Value::as_array)
				.map(Vec::len),
			Some(2)
		);
	}

	#[test]
	fn default_profile_keeps_leftover_object_root_union() {
		let envelope = encode_union_request(
			&OpenAiChatCodec::default(),
			Arc::from([leftover_tool(), good_tool()]),
			Setting::Unset,
		);
		assert_eq!(tool_names(&envelope), ["mcp__leftover_union", "read_file"]);
		assert_eq!(
			envelope.tools[0]
				.function
				.parameters
				.get("anyOf")
				.and_then(serde_json::Value::as_array)
				.map(Vec::len),
			Some(2)
		);
	}

	#[test]
	fn flatten_profile_withholds_leftover_object_root_union() {
		let envelope = encode_union_request(
			&flatten_codec(),
			Arc::from([leftover_tool(), good_tool()]),
			Setting::Unset,
		);
		assert_eq!(tool_names(&envelope), ["read_file"]);
	}

	#[test]
	fn forced_choice_naming_a_withheld_tool_is_dropped() {
		let envelope = encode_union_request(
			&flatten_codec(),
			Arc::from([leftover_tool(), good_tool()]),
			Setting::Require(ToolChoice::Named("mcp__leftover_union".into())),
		);
		assert_eq!(tool_names(&envelope), ["read_file"]);
		assert!(envelope.tool_choice.is_none());
	}

	#[test]
	fn required_choice_is_dropped_once_withholding_empties_the_tools() {
		let envelope = encode_union_request(
			&flatten_codec(),
			Arc::from([leftover_tool()]),
			Setting::Require(ToolChoice::Required),
		);
		assert!(envelope.tools.is_empty());
		assert!(envelope.tool_choice.is_none());
	}

	#[test]
	fn root_union_flattening_is_scoped_to_the_tool_root() {
		// Nested exclusive-required unions are real constraints; only the tool
		// root 400s xAI.
		let nested = serde_json::json!({
			"type": "object",
			"properties": {
				"outputSchema": {
					"type": "object",
					"properties": {
						"paths": {"type": "array", "items": {"type": "string"}},
						"scopes": {"type": "array", "items": {"type": "string"}}
					},
					"anyOf": [{"required": ["paths"]}, {"required": ["scopes"]}]
				}
			},
			"required": ["outputSchema"]
		});
		assert_eq!(flatten_exclusive_required_root_union(&nested), None);
		assert!(!super::leftover_root_object_union(&nested));

		let flattened = flatten_exclusive_required_root_union(
			coverage_tool()
				.input
				.json_schema()
				.expect("json schema")
				.0
				.as_value(),
		)
		.expect("exclusive-required root union flattens");
		assert!(flattened.get("anyOf").is_none());
		assert_eq!(flattened.get("required"), Some(&serde_json::json!(["project"])));
	}

	#[test]
	fn root_union_constraining_properties_is_not_flattened_but_is_withheld() {
		let constraining = serde_json::json!({
			"type": "object",
			"properties": {"kind": {"type": "string"}},
			"anyOf": [
				{"properties": {"kind": {"const": "a"}}},
				{"properties": {"kind": {"const": "b"}}}
			]
		});
		assert_eq!(flatten_exclusive_required_root_union(&constraining), None);
		assert!(super::leftover_root_object_union(&constraining));
	}

	#[test]
	fn pure_and_object_branch_root_unions_are_not_leftover_violations() {
		// A pure (untyped, property-less) root union is not this error class.
		let pure = serde_json::json!({
			"anyOf": [{"type": "string"}, {"type": "number"}]
		});
		assert!(!super::leftover_root_object_union(&pure));
		// All-object branches are valid object-root unions everywhere.
		let object_branches = serde_json::json!({
			"type": "object",
			"properties": {"kind": {"type": "string"}},
			"oneOf": [
				{"type": "object", "required": ["kind"]},
				{"type": "object", "properties": {"extra": {"type": "string"}}}
			]
		});
		assert!(!super::leftover_root_object_union(&object_branches));
	}

	#[test]
	fn fragmented_tool_arguments_remain_byte_exact_and_unvalidated() {
		let events = decode_fixture(include_str!(
			"../../../../fixtures/llm-oracle/openai/chat/stream.tool_reasoning_usage.sse"
		))
		.expect("fixture decodes");
		let mut arguments = Vec::new();
		let mut complete = None;
		let mut finish = None;
		for event in events {
			match event {
				RawEvent::Chat(ChatEvent::ToolArgumentsDelta { bytes, .. }) => {
					arguments.extend_from_slice(&bytes);
				},
				RawEvent::ToolCallComplete { call, .. } => complete = Some(call),
				RawEvent::Completion(completion) => finish = Some(completion.reason),
				_ => {},
			}
		}
		assert_eq!(arguments, r#"{"city":"Zürich"}"#.as_bytes());
		let complete = complete.expect("complete tool input");
		assert_eq!(complete.name.as_str(), "lookup_weather");
		assert_eq!(complete.arguments.as_ref(), arguments);
		assert_eq!(finish, Some(FinishReason::ToolCalls));
	}

	#[test]
	fn uppercase_finish_reasons_and_vertex_cache_usage_decode() {
		let stop: WireFinishReason = serde_json::from_str(r#""STOP""#).expect("uppercase stop");
		let length: WireFinishReason =
			serde_json::from_str(r#""MAX_TOKENS""#).expect("uppercase token limit");
		assert_eq!(stop.normalize(), FinishReason::Stop);
		assert_eq!(length.normalize(), FinishReason::Length);

		let usage: WireUsage = serde_json::from_value(serde_json::json!({
			"prompt_tokens": 33_006,
			"completion_tokens": 110,
			"cachedContentTokenCount": 28_639
		}))
		.expect("Vertex usage decodes");
		let usage = usage.canonical();
		assert_eq!(usage.input_tokens, 4_367);
		assert_eq!(usage.output_tokens, 110);
		assert_eq!(usage.cache_read_tokens, 28_639);
	}

	#[test]
	fn parity_fixture_preserves_usage_and_finish_precedence() {
		let events = decode_fixture(include_str!(
			"../../../../fixtures/llm-oracle/openai/chat/stream.parity.sse"
		))
		.expect("fixture decodes");
		let usage = events
			.iter()
			.filter_map(|event| match event {
				RawEvent::Chat(ChatEvent::Usage(update)) => Some(update.usage),
				_ => None,
			})
			.last()
			.expect("usage event");
		assert_eq!(usage.input_tokens, 10);
		assert_eq!(usage.output_tokens, 4);
		assert_eq!(usage.reasoning_tokens, 2);
		assert_eq!(usage.cache_read_tokens, 6);
		assert_eq!(usage.cache_write_tokens, 2);
		let finish = events
			.iter()
			.find_map(|event| match event {
				RawEvent::Completion(completion) => Some(&completion.reason),
				_ => None,
			})
			.expect("completion");
		assert_eq!(finish, &FinishReason::ContentFilter);
	}

	#[test]
	fn partial_usage_chunks_without_reasoning_details_keep_earlier_reasoning_tokens() {
		// Hosts that stream usage per chunk omit `completion_tokens_details`
		// on most chunks; a zero there is absence, not a reset.
		let events = decode_fixture(concat!(
			"data: {\"id\":\"c\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"m\",",
			"\"choices\":[{\"index\":0,\"delta\":{\"content\":\"a\"},\"finish_reason\":null}],",
			"\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":3,",
			"\"completion_tokens_details\":{\"reasoning_tokens\":2}}}\n\n",
			"data: {\"id\":\"c\",\"object\":\"chat.completion.chunk\",\"created\":1,\"model\":\"m\",",
			"\"choices\":[{\"index\":0,\"delta\":{\"content\":\"b\"},\"finish_reason\":\"stop\"}],",
			"\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":4}}\n\n",
			"data: [DONE]\n\n",
		))
		.expect("stream decodes");
		let usage = events
			.iter()
			.filter_map(|event| match event {
				RawEvent::Chat(ChatEvent::Usage(update)) => Some(update.usage),
				_ => None,
			})
			.collect::<Vec<_>>();
		assert_eq!(usage.len(), 2);
		assert_eq!(usage[0].reasoning_tokens, 2);
		assert_eq!(usage[1].output_tokens, 4);
		assert_eq!(
			usage[1].reasoning_tokens, 2,
			"later chunk without details must not zero reasoning"
		);
	}

	#[test]
	fn typed_error_envelopes_preserve_classification_evidence() {
		// The OpenRouter fixture is a gateway 502 for an upstream model failure
		// (metadata.raw carries the upstream detail). Gateway upstream failures
		// are transient (429/500/502/503/529), so the 502 classifies as a retryable
		// capacity failure rather than a terminal provider-contract mismatch.
		for (fixture, kind, code) in [
			(
				include_bytes!("../../../../fixtures/llm-oracle/openai/chat/error.azure.json")
					.as_slice(),
				ErrorKind::ContentFilter,
				"content_filter",
			),
			(
				include_bytes!("../../../../fixtures/llm-oracle/openai/chat/error.openrouter.json")
					.as_slice(),
				ErrorKind::ResourceExhausted,
				"MALFORMED_FUNCTION_CALL",
			),
			(
				br#"{"error":{"code":429,"message":"rate limited"}}"#.as_slice(),
				ErrorKind::RateLimited,
				"429",
			),
		] {
			let mut decoder = OpenAiChatDecoder::default();
			let mut events = Vec::new();
			decoder
				.push(
					Frame::Sse(SseEvent { name: None, data: Bytes::copy_from_slice(fixture) }),
					&mut |event| events.push(event),
				)
				.expect("typed provider error decodes");
			let error = events
				.into_iter()
				.find_map(|event| match event {
					RawEvent::Failure(error) => Some(error),
					_ => None,
				})
				.expect("terminal error");
			assert_eq!(error.kind, kind);
			assert_eq!(error.code.as_ref().map(|value| value.as_str()), Some(code));
			assert!(!error.committed);
		}
	}

	#[test]
	fn in_band_stream_errors_decode_nested_and_flat_envelopes() {
		let cases = [
			(
				br#"{"error":{"message":"queue full","type":"SERVICE_UNAVAILABLE"}}"#.as_slice(),
				ErrorKind::ResourceExhausted,
				Some(503),
				Some("queue full"),
			),
			(
				br#"{"error":"rate limit exceeded"}"#.as_slice(),
				ErrorKind::Protocol,
				None,
				Some("rate limit exceeded"),
			),
			(
				br#"{"message":"provider temporarily unavailable"}"#.as_slice(),
				ErrorKind::Protocol,
				None,
				Some("provider temporarily unavailable"),
			),
		];
		for (fixture, kind, status, detail) in cases {
			let mut decoder = OpenAiChatDecoder::default();
			let mut events = Vec::new();
			decoder
				.push(
					Frame::Sse(SseEvent { name: None, data: Bytes::copy_from_slice(fixture) }),
					&mut |event| events.push(event),
				)
				.expect("in-band stream error decodes");
			let error = events
				.into_iter()
				.find_map(|event| match event {
					RawEvent::Failure(error) => Some(error),
					_ => None,
				})
				.expect("typed stream failure");
			assert_eq!(error.kind, kind);
			assert_eq!(error.status, status);
			assert_eq!(
				error.detail_ref().and_then(|detail| match detail {
					ErrorDetail::Provider { sanitized_message } => Some(sanitized_message.as_str()),
					_ => None,
				}),
				detail,
			);
		}

		let mut decoder = OpenAiChatDecoder::default();
		let mut events = Vec::new();
		for data in [
			br#"{"choices":[{"index":0,"delta":{"content":"partial"}}]}"#.as_slice(),
			br#"{"error":"stream failed"}"#.as_slice(),
		] {
			decoder
				.push(
					Frame::Sse(SseEvent { name: None, data: Bytes::copy_from_slice(data) }),
					&mut |event| events.push(event),
				)
				.expect("mid-stream error decodes");
		}
		let failure = events
			.into_iter()
			.find_map(|event| match event {
				RawEvent::Failure(error) => Some(error),
				_ => None,
			})
			.expect("mid-stream typed failure");
		assert!(failure.committed);
		assert_eq!(failure.phase, crate::error::ErrorPhase::Streaming);
		assert_eq!(failure.action, RetryAction::Never);
	}

	#[test]
	fn dashscope_token_limit_requires_anchor_and_exact_billing_wording() {
		let classify = |message: &str| {
			classify_error(
				WireError {
					code:            Some(ErrorCode::Text("insufficient_quota".into())),
					message:         Some(message.into()),
					kind:            None,
					param:           None,
					metadata:        None,
					rate_limit_type: None,
				},
				false,
			)
		};
		// Documented Bailian TPM/TPS throttle: billing wording plus doc anchor.
		let throttle = classify(
			"You exceeded your current quota, please check your plan and billing details. See \
			 https://help.aliyun.com/zh/model-studio/error-code#token-limit \
			 (type=insufficient_quota param=insufficient_quota)",
		);
		assert_eq!(throttle.kind, ErrorKind::RateLimited);
		assert!(matches!(throttle.action, RetryAction::SameRoute { .. }));

		// OpenAI's real account-quota error: identical wording, no doc anchor.
		let openai_quota = classify(
			"You exceeded your current quota, please check your plan and billing details. See \
			 https://platform.openai.com/account/usage",
		);
		assert_eq!(openai_quota.kind, ErrorKind::QuotaExhausted);
		assert_eq!(openai_quota.action, RetryAction::Never);

		// Same doc anchor with permanent wording ("Free allocated quota
		// exceeded") must stay quota-exhausted: the anchor alone is not a
		// throttle signature.
		let free_quota = classify(
			"Free allocated quota exceeded. See \
			 https://help.aliyun.com/zh/model-studio/error-code#token-limit",
		);
		assert_eq!(free_quota.kind, ErrorKind::QuotaExhausted);
		assert_eq!(free_quota.action, RetryAction::Never);

		// Anchor split across separate tokens is not the documented signature.
		let split_anchor = classify(
			"You exceeded your current quota, please check your plan and billing details. See \
			 error-code docs (#token-limit)",
		);
		assert_eq!(split_anchor.kind, ErrorKind::QuotaExhausted);
		assert_eq!(split_anchor.action, RetryAction::Never);
	}

	#[test]
	fn transient_provider_blips_retry_same_route_and_deterministic_denials_do_not() {
		let classify = |code: &str, message: &str| {
			classify_error(
				WireError {
					code:            Some(ErrorCode::Text(code.into())),
					message:         Some(message.into()),
					kind:            None,
					param:           None,
					metadata:        None,
					rate_limit_type: None,
				},
				false,
			)
		};
		// The oneshot transient set: HTTP 429/500/502/503/529 and overload.
		for code in ["429", "rate_limit_exceeded"] {
			let error = classify(code, "slow down");
			assert_eq!(error.kind, ErrorKind::RateLimited, "{code}");
			assert!(matches!(error.action, RetryAction::SameRoute { .. }), "{code}");
		}
		for code in ["500", "502", "503", "529", "server_error", "overloaded_error"] {
			let error = classify(code, "upstream blip");
			assert_eq!(error.kind, ErrorKind::ResourceExhausted, "{code}");
			assert!(matches!(error.action, RetryAction::SameRoute { .. }), "{code}");
		}
		// Deterministic denials never enter the transient lane.
		for (code, kind, action) in [
			("invalid_api_key", ErrorKind::Authentication, RetryAction::RefreshCredential),
			("permission_denied", ErrorKind::Authorization, RetryAction::RotateAccount),
			("content_filter", ErrorKind::ContentFilter, RetryAction::Never),
			("invalid_request_error", ErrorKind::InvalidRequest, RetryAction::Never),
		] {
			let error = classify(code, "denied");
			assert_eq!(error.kind, kind, "{code}");
			assert_eq!(error.action, action, "{code}");
		}
		for code in ["invalid_api_key", "permission_denied"] {
			let error = classify_error(
				WireError {
					code:            Some(ErrorCode::Text(code.into())),
					message:         Some("denied".into()),
					kind:            None,
					param:           None,
					metadata:        None,
					rate_limit_type: None,
				},
				true,
			);
			assert_eq!(error.action, RetryAction::Never, "{code}");
		}
		let generation_nan = classify(
			"invalid_request_error",
			"Floating point NaN (not-a-number) is detected in generation",
		);
		assert_eq!(generation_nan.kind, ErrorKind::ResourceExhausted);
		assert_eq!(generation_nan.action, RetryAction::SameRoute { after: Duration::ZERO },);

		// llama.cpp deterministic tool-call parse failures arrive as HTTP 500
		// but replay identically: never transient.
		let parse_failure = classify(
			"500",
			"Failed to parse tool call arguments as JSON: [json.exception.parse_error.101]",
		);
		assert_eq!(parse_failure.action, RetryAction::Never);
	}

	#[test]
	fn litellm_concurrency_admission_429_reselects_route_without_backoff() {
		// LiteLLM (and compatible proxies) shed over-concurrency requests
		// before dispatching upstream, marking the immediate 429 with
		// `rate_limit_type: max_parallel_requests`. The admission failure must
		// skip the transport's same-route sleep so the router's fallback walk
		// owns retry/fallback immediately.
		let classify = |code: Option<&str>, rate_limit_type: Option<&str>| {
			classify_error(
				WireError {
					code:            code.map(|value| ErrorCode::Text(value.into())),
					message:         Some("Max parallel request limit reached".into()),
					kind:            None,
					param:           None,
					metadata:        None,
					rate_limit_type: rate_limit_type.map(Into::into),
				},
				false,
			)
		};
		// Structured body marker alongside LiteLLM's stringly HTTP code.
		let marked = classify(Some("429"), Some("max_parallel_requests"));
		assert_eq!(marked.kind, ErrorKind::RateLimited);
		assert_eq!(marked.action, RetryAction::ReselectRoute);
		assert!(!marked.committed);
		// The marker is decisive even when the envelope carries no error code.
		let uncoded = classify(None, Some("max_parallel_requests"));
		assert_eq!(uncoded.kind, ErrorKind::RateLimited);
		assert_eq!(uncoded.action, RetryAction::ReselectRoute);
		// Scope guards: a plain 429 without the marker keeps the same-route
		// backoff, and a different limiter discriminator is not the admission
		// marker.
		let plain = classify(Some("429"), None);
		assert_eq!(plain.kind, ErrorKind::RateLimited);
		assert!(matches!(plain.action, RetryAction::SameRoute { .. }));
		let other_limiter = classify(Some("429"), Some("tokens_per_minute"));
		assert_eq!(other_limiter.kind, ErrorKind::RateLimited);
		assert!(matches!(other_limiter.action, RetryAction::SameRoute { .. }));
	}

	#[test]
	fn litellm_concurrency_admission_envelope_decodes_from_the_error_body() {
		// Serde-capture guard: the marker rides inside the `error` object of
		// LiteLLM's structured 429 body and must survive envelope decoding.
		let mut decoder = OpenAiChatDecoder::default();
		let mut events = Vec::new();
		decoder
			.push(
				Frame::Sse(SseEvent {
					name: None,
					data: Bytes::from_static(
						br#"{"error":{"message":"Max parallel request limit reached","type":"rate_limit_error","rate_limit_type":"max_parallel_requests","code":"429"}}"#,
					),
				}),
				&mut |event| events.push(event),
			)
			.expect("typed provider error decodes");
		let error = events
			.into_iter()
			.find_map(|event| match event {
				RawEvent::Failure(error) => Some(error),
				_ => None,
			})
			.expect("terminal error");
		assert_eq!(error.kind, ErrorKind::RateLimited);
		assert_eq!(error.action, RetryAction::ReselectRoute);
		assert!(!error.committed);
	}

	#[test]
	fn context_overflow_classifies_as_never_retried() {
		// A deterministic overflow replays identically: the summarizer (or any
		// caller) must see a fail-fast `ContextOverflow` rather than a transient
		// classification that burns the attempt budget on identical calls.
		let classify = |code: &str, message: &str| {
			classify_error(
				WireError {
					code:            Some(ErrorCode::Text(code.into())),
					message:         Some(message.into()),
					kind:            None,
					param:           None,
					metadata:        None,
					rate_limit_type: None,
				},
				false,
			)
		};
		let coded = classify("context_length_exceeded", "input exceeds the model window");
		assert_eq!(coded.kind, ErrorKind::ContextOverflow);
		assert_eq!(coded.action, RetryAction::Never);

		let textual = classify(
			"400",
			"This model's maximum context length is 200000 tokens, however you requested 3031925 \
			 tokens",
		);
		assert_eq!(textual.kind, ErrorKind::ContextOverflow);
		assert_eq!(textual.action, RetryAction::Never);
	}
	#[test]
	fn payload_rejections_never_same_route_retry_and_token_evidence_wins() {
		let classify = |code: ErrorCode, message: Option<&str>| {
			classify_error(
				WireError {
					code:            Some(code),
					message:         message.map(Into::into),
					kind:            None,
					param:           None,
					metadata:        None,
					rate_limit_type: None,
				},
				false,
			)
		};
		let bare = classify(ErrorCode::Number(413), None);
		assert_eq!(bare.kind, ErrorKind::PayloadRejected);
		assert_eq!(bare.action, RetryAction::Never);

		let wrapped = classify(
			ErrorCode::Text("server_error".into()),
			Some("Provider returned error: 413 Payload Too Large"),
		);
		assert_eq!(wrapped.kind, ErrorKind::PayloadRejected);
		assert_eq!(wrapped.action, RetryAction::Never);

		let token = classify(ErrorCode::Number(413), Some("maximum context length is 128000 tokens"));
		assert_eq!(token.kind, ErrorKind::ContextOverflow);
		assert_eq!(token.action, RetryAction::Never);
	}

	#[test]
	fn truncated_content_stream_and_resource_finish_are_retryable_failures() {
		let Err(truncated) = decode_fixture(
			"data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"partial\"}}]}\n\n",
		) else {
			panic!("content without a finish reason must be truncated");
		};
		assert_eq!(truncated.kind, ErrorKind::StreamCorruption);
		assert_eq!(truncated.action, RetryAction::SemanticRetry);
		let empty = decode_fixture("").expect("empty close remains an empty completion");
		assert!(empty.iter().any(|event| {
			matches!(event, RawEvent::Completion(completion) if completion.reason == FinishReason::Stop)
		}));

		let events = decode_fixture(
			"data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"partial\"}}]}\n\ndata: \
			 {\"choices\":[{\"index\":0,\"delta\":{},\"finish_reason\":\"\
			 insufficient_system_resource\"}]}\n\ndata: [DONE]\n\n",
		)
		.expect("resource finish decodes to a typed failure");
		let failure = events
			.into_iter()
			.find_map(|event| match event {
				RawEvent::Failure(error) => Some(error),
				_ => None,
			})
			.expect("resource finish emits a failure");
		assert_eq!(failure.kind, ErrorKind::ResourceExhausted);
		assert_eq!(failure.action, RetryAction::SemanticRetry);
	}
	#[test]
	fn done_sentinel_is_authoritative_without_finish_reason() {
		let events = decode_fixture(
			"data: {\"choices\":[{\"index\":0,\"delta\":{\"content\":\"complete\"}}]}\n\ndata: \
			 [DONE]\n\n",
		)
		.expect("DONE authoritatively terminates the visible answer");
		assert!(events.iter().any(|event| {
			matches!(event, RawEvent::Completion(completion) if completion.reason == FinishReason::Stop)
		}));
	}

	#[test]
	fn object_valued_tool_arguments_deep_merge_and_flush_once() {
		let events = decode_fixture(
			"data: {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"\
			 call_1\",\"function\":{\"name\":\"read\",\"arguments\":{\"path\":\"a\",\"nested\":{\"\
			 left\":\"x\"}}}}]}}]}\n\ndata: \
			 {\"choices\":[{\"index\":0,\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"\
			 arguments\":{\"path\":\".rs\",\"nested\":{\"right\":\"y\"}}}}]}}]}\n\ndata: [DONE]\n\n",
		)
		.expect("object arguments decode");
		let arguments = events
			.into_iter()
			.find_map(|event| match event {
				RawEvent::ToolCallComplete { call, .. } => Some(call.arguments),
				_ => None,
			})
			.expect("tool completed");
		let value: serde_json::Value =
			serde_json::from_slice(&arguments).expect("merged arguments are concat-safe JSON");
		assert_eq!(value, serde_json::json!({"path":"a.rs","nested":{"left":"x","right":"y"}}),);
	}

	#[test]
	fn wrong_known_field_type_is_rejected_without_value_fallback() {
		let mut decoder = OpenAiChatDecoder::default();
		let error = decoder
			.push(
				Frame::Sse(SseEvent {
					name: None,
					data: Bytes::from_static(
						br#"{"choices":[{"index":0,"delta":{"content":7},"finish_reason":null}]}"#,
					),
				}),
				&mut |_| {},
			)
			.expect_err("numeric content is not a Chat Completions content shape");
		assert_eq!(error.kind, ErrorKind::Protocol);
		assert!(!error.committed);
	}

	#[test]
	fn terminal_decoder_is_idempotent() {
		let mut decoder = OpenAiChatDecoder::default();
		let mut events = Vec::new();
		decoder
			.finish(&mut |event| events.push(event))
			.expect("first finish");
		let count = events.len();
		decoder
			.finish(&mut |event| events.push(event))
			.expect("second finish");
		assert_eq!(events.len(), count);
	}

	#[test]
	fn opaque_tool_call_ids_round_trip_verbatim_on_unconstrained_routes() {
		// Provider-issued correlation tokens (vLLM/SGLang gateways emit pipe-
		// and plus-laden ids) must replay byte-for-byte on the route that
		// issued them; only a route whose policy declares the OpenAI
		// 40-character projection may rewrite them.
		let opaque = "call_abc||gateway_state||opaque+/=";
		let chunk = serde_json::json!({
			"choices": [{"index": 0, "delta": {"tool_calls": [{
				"index": 0,
				"id": opaque,
				"type": "function",
				"function": {"name": "read", "arguments": "{\"path\":\"README.md\"}"}
			}]}}]
		});
		let fixture = format!(
			"data: {chunk}\n\ndata: \
			 {{\"choices\":[{{\"index\":0,\"delta\":{{}},\"finish_reason\":\"tool_calls\"}}]}}\n\\
			 ndata: [DONE]\n\n"
		);
		let events = decode_fixture(&fixture).expect("tool stream decodes");
		let call = events
			.iter()
			.find_map(|event| match event {
				RawEvent::ToolCallComplete { call, .. } => Some(call),
				_ => None,
			})
			.expect("complete tool call");
		assert_eq!(call.id.as_str(), opaque);

		let replay = request(Arc::from([
			Message {
				role:    Role::User,
				content: Arc::from([ContentPart::Text { text: "Read README".into(), proof: None }]),
				name:    None,
			},
			Message {
				role:    Role::Assistant,
				content: Arc::from([ContentPart::ToolCall {
					call:      call.id.clone(),
					name:      call.name.clone(),
					arguments: OpaqueJson::new(serde_json::json!({"path": "README.md"})),
					proof:     None,
				}]),
				name:    None,
			},
			Message {
				role:    Role::Tool,
				content: Arc::from([ContentPart::ToolResult {
					call:     call.id.clone(),
					name:     Some("read".into()),
					content:  Arc::from([ToolResultContent::Text("done".into())]),
					is_error: false,
				}]),
				name:    None,
			},
		]));
		let body = OpenAiChatCodec::default()
			.encode_chat("gateway-model", &replay)
			.expect("replay encodes");
		let wire: serde_json::Value = serde_json::from_slice(&body).expect("wire body is JSON");
		assert_eq!(wire["messages"][1]["tool_calls"][0]["id"], opaque);
		assert_eq!(wire["messages"][2]["tool_call_id"], opaque);

		// The 40-character projection stays a route-scoped policy, not a
		// blanket rewrite of provider-issued ids.
		let profile =
			OpenAiChatProfile { tool_id: ToolIdWireProfile::OpenAi40, ..OpenAiChatProfile::default() };
		let projected = OpenAiChatCodec::new(profile, None)
			.encode_chat("gpt-4o-mini", &replay)
			.expect("projected replay encodes");
		let wire: serde_json::Value =
			serde_json::from_slice(&projected).expect("projected body is JSON");
		let id = wire["messages"][1]["tool_calls"][0]["id"]
			.as_str()
			.expect("projected id");
		assert!(id.len() <= 40);
		assert!(
			id.chars()
				.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
		);
		assert_eq!(wire["messages"][2]["tool_call_id"].as_str(), Some(id));
	}

	#[test]
	fn assistant_run_with_parallel_calls_collapses_into_one_wire_message() {
		// The durable thread stores one item per message, so one assistant
		// turn arrives as [text, call, call]. kimi-code K3 400s ("tool_call_ids
		// did not have response messages: write:1") when the calls stay in
		// consecutive assistant messages ahead of their tool responses.
		let call_message = |id: &str| Message {
			role:    Role::Assistant,
			content: Arc::from([ContentPart::ToolCall {
				call:      crate::id::ToolCallId::new(id),
				name:      "write".into(),
				arguments: OpaqueJson::new(serde_json::json!({"path": "a"})),
				proof:     None,
			}]),
			name:    None,
		};
		let result_message = |id: &str| Message {
			role:    Role::Tool,
			content: Arc::from([ContentPart::ToolResult {
				call:     crate::id::ToolCallId::new(id),
				name:     Some("write".into()),
				content:  Arc::from([ToolResultContent::Text("ok".into())]),
				is_error: false,
			}]),
			name:    None,
		};
		let replay = request(Arc::from([
			Message {
				role:    Role::Assistant,
				content: Arc::from([ContentPart::Text {
					text:  "writing two files".into(),
					proof: None,
				}]),
				name:    None,
			},
			call_message("call_a"),
			call_message("call_b"),
			result_message("call_a"),
			result_message("call_b"),
		]));
		let body = OpenAiChatCodec::default()
			.encode_chat("gateway-model", &replay)
			.expect("replay encodes");
		let wire: serde_json::Value = serde_json::from_slice(&body).expect("wire body is JSON");
		let messages = wire["messages"].as_array().expect("wire messages");
		assert_eq!(messages.len(), 3, "one assistant turn plus two tool responses: {wire}");
		assert_eq!(messages[0]["role"], "assistant");
		assert_eq!(messages[0]["content"], "writing two files");
		assert_eq!(messages[0]["tool_calls"][0]["id"], "call_a");
		assert_eq!(messages[0]["tool_calls"][1]["id"], "call_b");
		assert_eq!(messages[1]["role"], "tool");
		assert_eq!(messages[1]["tool_call_id"], "call_a");
		assert_eq!(messages[2]["tool_call_id"], "call_b");
	}

	fn thinking_request(effort: ReasoningEffort) -> ChatRequest {
		let mut request = request(Arc::from([text_message("think")]));
		request.reasoning = Setting::Require(ReasoningRequest {
			visibility:          ReasoningVisibility::Visible,
			effort:              Some(effort),
			max_tokens:          None,
			preserve_signatures: false,
		});
		request
	}

	#[test]
	fn text_only_history_replaces_images_while_ocr_preserves_them() {
		let message = Message {
			role:    Role::User,
			content: Arc::from([
				ContentPart::Text { text: "Read this".into(), proof: None },
				ContentPart::Image(MediaInput::Bytes {
					media_type: "image/png".into(),
					data:       Bytes::from_static(b"png"),
				}),
			]),
			name:    None,
		};
		let chat = request(Arc::from([message]));

		let mut text_only_policy = policy::WirePolicy::baseline();
		text_only_policy.image.encoding = Some(policy::ImageEncodingFormat::None);
		let mut text_only_profile = OpenAiChatProfile::default();
		text_only_profile.apply_policy(&text_only_policy);
		let body = OpenAiChatCodec::new(text_only_profile, None)
			.encode_chat("deepseek-v4-flash", &chat)
			.expect("text-only history encodes");
		let wire: serde_json::Value = serde_json::from_slice(&body).expect("wire body is JSON");
		assert_eq!(
			wire["messages"][0]["content"][1]["text"],
			"[image omitted: model does not support vision]",
		);
		assert!(
			wire["messages"][0]["content"]
				.as_array()
				.expect("content parts")
				.iter()
				.all(|part| part["type"] != "image_url"),
		);

		let mut ocr_policy = policy::WirePolicy::baseline();
		ocr_policy.image.encoding = Some(policy::ImageEncodingFormat::OpenAiUrl);
		let mut ocr_profile = OpenAiChatProfile::default();
		ocr_profile.apply_policy(&ocr_policy);
		let body = OpenAiChatCodec::new(ocr_profile, None)
			.encode_chat("deepseek/deepseek-ocr-2", &chat)
			.expect("OCR history encodes");
		let wire: serde_json::Value = serde_json::from_slice(&body).expect("wire body is JSON");
		assert_eq!(wire["messages"][0]["content"][1]["type"], "image_url");
	}

	#[test]
	fn venice_thinking_off_merges_disable_with_configured_parameters() {
		let mut profile = OpenAiChatProfile::default();
		let mut compat = policy::WirePolicy::baseline();
		compat.reasoning.disable_mode = Some(policy::ReasoningDisableMode::VeniceDisableThinking);
		compat.reasoning.extra_body = Some(policy::ReasoningBodyOverride {
			thinking:          None,
			enable_thinking:   None,
			venice_parameters: Some(policy::VeniceParameters {
				disable_thinking:             Some(false),
				include_venice_system_prompt: Some(false),
			}),
		});
		profile.apply_policy(&compat);
		let body = OpenAiChatCodec::new(profile, None)
			.encode_chat("qwen3-235b", &thinking_request(ReasoningEffort::Off))
			.expect("Venice thinking-off request encodes");
		let wire: serde_json::Value = serde_json::from_slice(&body).expect("wire body is JSON");
		assert!(wire.get("reasoning_effort").is_none());
		assert_eq!(wire["venice_parameters"]["disable_thinking"], true);
		assert_eq!(wire["venice_parameters"]["include_venice_system_prompt"], false);
	}

	#[test]
	fn generic_chat_template_policy_emits_enabled_effort_and_explicit_off() {
		let mut profile = OpenAiChatProfile::default();
		let mut policy = policy::WirePolicy::baseline();
		policy.reasoning.thinking_format = Some(policy::ThinkingFormat::ChatTemplate);
		profile.apply_policy(&policy);

		let body = OpenAiChatCodec::new(profile.clone(), None)
			.encode_chat("deepseek-flash-v4", &thinking_request(ReasoningEffort::Medium))
			.expect("enabled request encodes");
		let wire: serde_json::Value = serde_json::from_slice(&body).expect("wire body is JSON");
		assert_eq!(wire["chat_template_kwargs"]["thinking"], true);
		assert_eq!(wire["chat_template_kwargs"]["reasoning_effort"], "medium");
		assert!(wire.get("reasoning_effort").is_none());
		assert!(
			wire["chat_template_kwargs"]
				.as_object()
				.expect("kwargs object")
				.get("enable_thinking")
				.is_none()
		);

		let body = OpenAiChatCodec::new(profile, None)
			.encode_chat("deepseek-flash-v4", &thinking_request(ReasoningEffort::Off))
			.expect("explicit-off request encodes");
		let wire: serde_json::Value = serde_json::from_slice(&body).expect("wire body is JSON");
		assert_eq!(wire["chat_template_kwargs"]["thinking"], false);
		assert!(
			wire["chat_template_kwargs"]
				.as_object()
				.expect("kwargs object")
				.get("reasoning_effort")
				.is_none()
		);
	}

	#[test]
	fn template_effort_rides_top_level_and_kwargs() {
		// Without routing the selected effort onto the Qwen 3.8+ template's
		// `reasoning_effort` kwarg, `enable_thinking` alone leaves
		// the model reasoning at its xhigh default. Twin emission: top-level
		// for newer llama.cpp builds, kwargs for older builds.
		let mut profile =
			OpenAiChatProfile { reasoning: ReasoningWireFormat::Qwen, ..OpenAiChatProfile::default() };
		let mut policy = policy::WirePolicy::overrides();
		policy.reasoning.template_reasoning_effort = Some(true);
		profile.apply_policy(&policy);
		let body = OpenAiChatCodec::new(profile, None)
			.encode_chat("qwen3.8-27b", &thinking_request(ReasoningEffort::Medium))
			.expect("request encodes");
		let wire: serde_json::Value = serde_json::from_slice(&body).expect("wire body is JSON");
		assert_eq!(wire["enable_thinking"], true);
		assert_eq!(wire["reasoning_effort"], "medium");
		assert_eq!(wire["chat_template_kwargs"]["reasoning_effort"], "medium");
		assert!(
			wire["chat_template_kwargs"]
				.as_object()
				.expect("kwargs object")
				.get("enable_thinking")
				.is_none(),
			"the qwen dialect keeps enable_thinking top-level only"
		);
	}

	#[test]
	fn reasoning_conflict_drops_only_redundant_auto_tool_choice() {
		let mut conflict_profile = OpenAiChatProfile::default();
		let mut policy = policy::WirePolicy::baseline();
		policy.tool.disable_reasoning_on_choice = Some(true);
		conflict_profile.apply_policy(&policy);
		let encode = |profile: OpenAiChatProfile, reasoning: bool, choice| {
			let mut request = request(Arc::from([text_message("think")]));
			request.tools = Arc::from([good_tool()]);
			if reasoning {
				request.reasoning = Setting::Require(ReasoningRequest {
					visibility:          ReasoningVisibility::Visible,
					effort:              Some(ReasoningEffort::Medium),
					max_tokens:          None,
					preserve_signatures: false,
				});
			}
			request.tool_choice = Setting::Require(choice);
			let body = OpenAiChatCodec::new(profile, None)
				.encode_chat("deepseek-reasoner", &request)
				.expect("request encodes");
			serde_json::from_slice::<serde_json::Value>(&body).expect("wire body is JSON")
		};

		let dropped = encode(conflict_profile.clone(), true, ToolChoice::Auto);
		assert!(dropped.get("tool_choice").is_none());

		let no_reasoning = encode(conflict_profile.clone(), false, ToolChoice::Auto);
		assert_eq!(no_reasoning["tool_choice"], "auto");

		let no_axis = encode(OpenAiChatProfile::default(), true, ToolChoice::Auto);
		assert_eq!(no_axis["tool_choice"], "auto");

		let forced = encode(conflict_profile.clone(), true, ToolChoice::Required);
		assert_eq!(forced["tool_choice"], "required");

		let named = encode(conflict_profile, true, ToolChoice::Named("read_file".into()));
		assert_eq!(named["tool_choice"]["function"]["name"], "read_file");
	}

	#[test]
	fn qwen_pre_38_templates_keep_the_bare_enable_thinking_toggle() {
		// Older Qwen templates have no `reasoning_effort` kwarg; leaking one
		// would inject an undefined template variable.
		let profile =
			OpenAiChatProfile { reasoning: ReasoningWireFormat::Qwen, ..OpenAiChatProfile::default() };
		let body = OpenAiChatCodec::new(profile, None)
			.encode_chat("qwen3.6-27b", &thinking_request(ReasoningEffort::High))
			.expect("request encodes");
		let wire: serde_json::Value = serde_json::from_slice(&body).expect("wire body is JSON");
		assert_eq!(wire["enable_thinking"], true);
		assert!(wire.get("reasoning_effort").is_none());
		assert!(wire.get("chat_template_kwargs").is_none());
	}

	#[test]
	fn qwen_chat_template_dialect_rides_kwargs_only() {
		// vLLM/NIM-style schemas reject unknown top-level fields; the effort
		// rides `chat_template_kwargs` alone on the kwargs dialect.
		let profile = OpenAiChatProfile {
			reasoning: ReasoningWireFormat::Nvidia,
			template_reasoning_effort: true,
			..OpenAiChatProfile::default()
		};
		let body = OpenAiChatCodec::new(profile, None)
			.encode_chat("qwen3.8-27b", &thinking_request(ReasoningEffort::Xhigh))
			.expect("request encodes");
		let wire: serde_json::Value = serde_json::from_slice(&body).expect("wire body is JSON");
		assert!(wire.get("reasoning_effort").is_none());
		assert!(wire.get("enable_thinking").is_none());
		assert_eq!(wire["chat_template_kwargs"]["enable_thinking"], true);
		assert_eq!(wire["chat_template_kwargs"]["reasoning_effort"], "xhigh");
	}

	#[test]
	fn template_kwarg_effort_rejection_classifies_as_adaptable_same_route_retry() {
		// NInfer-style strict kwargs whitelists reject the kwargs spelling of
		// the effort with a deterministic 400. The classification must carry
		// the canonical adaptation code and a zero-delay same-route retry so
		// the next encode hoists the effort onto the top-level field.
		let classify = |code: Option<&str>, message: Option<&str>, param: Option<&str>| {
			classify_error(
				WireError {
					code:            code.map(|value| ErrorCode::Text(value.into())),
					message:         message.map(Into::into),
					kind:            None,
					param:           param.map(Into::into),
					metadata:        None,
					rate_limit_type: None,
				},
				false,
			)
		};
		// NInfer names the kwarg in the message.
		let named = classify(
			Some("unknown_parameter"),
			Some("chat_template_kwargs.reasoning_effort is not supported"),
			Some("chat_template_kwargs.reasoning_effort"),
		);
		assert_eq!(named.kind, ErrorKind::InvalidRequest);
		assert_eq!(named.action, RetryAction::SameRoute { after: Duration::ZERO });
		assert_eq!(
			named.code.as_ref().map(|value| value.as_str()),
			Some(super::TEMPLATE_EFFORT_REJECTED_CODE),
		);
		assert!(!named.committed);
		// Pydantic-style validators name the field in `param` alone.
		let param_only = classify(
			Some("invalid_request_error"),
			Some("Extra inputs are not permitted"),
			Some("chat_template_kwargs.reasoning_effort"),
		);
		assert_eq!(param_only.action, RetryAction::SameRoute { after: Duration::ZERO });
		assert_eq!(
			param_only.code.as_ref().map(|value| value.as_str()),
			Some(super::TEMPLATE_EFFORT_REJECTED_CODE),
		);
		// Scope guards: an ordinary 400 naming only reasoning_effort, or only
		// chat_template_kwargs, stays a terminal invalid request.
		for message in ["reasoning_effort is not supported", "unknown chat_template_kwargs"] {
			let unrelated = classify(Some("invalid_request_error"), Some(message), None);
			assert_eq!(unrelated.kind, ErrorKind::InvalidRequest, "{message}");
			assert_eq!(unrelated.action, RetryAction::Never, "{message}");
		}
	}

	#[test]
	fn rejected_qwen_dialect_keeps_the_top_level_twin_and_drops_the_kwarg() {
		// After a classified kwargs rejection, the qwen dialect must stop
		// twin-emitting: the effort stays on the top-level field the same
		// servers accept, and the kwargs object disappears entirely when the
		// effort was its only member.
		let profile = OpenAiChatProfile {
			reasoning: ReasoningWireFormat::Qwen,
			template_reasoning_effort: true,
			template_effort_top_level_only: true,
			..OpenAiChatProfile::default()
		};
		let body = OpenAiChatCodec::new(profile, None)
			.encode_chat("qwen3.8-27b", &thinking_request(ReasoningEffort::Medium))
			.expect("request encodes");
		let wire: serde_json::Value = serde_json::from_slice(&body).expect("wire body is JSON");
		assert_eq!(wire["enable_thinking"], true);
		assert_eq!(wire["reasoning_effort"], "medium");
		assert!(wire.get("chat_template_kwargs").is_none());
	}

	#[test]
	fn supports_usage_in_streaming_matches_pi_request_shape() {
		let mut policy = policy::WirePolicy::overrides();
		policy.usage.in_streaming = Some(false);
		let mut profile = OpenAiChatProfile::default();
		profile.apply_policy(&policy);
		let body = OpenAiChatCodec::new(profile, None)
			.encode_chat("model", &request(Arc::from([text_message("hello")])))
			.expect("request encodes");
		let wire: serde_json::Value = serde_json::from_slice(&body).expect("JSON");
		assert!(wire.get("stream_options").is_none());
	}

	#[test]
	fn supports_multiple_system_messages_matches_pi_request_shape() {
		let messages = Arc::from([
			Message {
				role:    Role::System,
				content: Arc::from([ContentPart::Text { text: "one".into(), proof: None }]),
				name:    None,
			},
			Message {
				role:    Role::System,
				content: Arc::from([ContentPart::Text { text: "two".into(), proof: None }]),
				name:    None,
			},
		]);
		let mut policy = policy::WirePolicy::overrides();
		policy.role.multiple_system_messages = Some(false);
		let mut profile = OpenAiChatProfile::default();
		profile.apply_policy(&policy);
		let body = OpenAiChatCodec::new(profile, None)
			.encode_chat("model", &request(messages))
			.expect("request encodes");
		let wire: serde_json::Value = serde_json::from_slice(&body).expect("JSON");
		assert_eq!(wire["messages"].as_array().expect("messages").len(), 1);
		assert_eq!(wire["messages"][0]["content"], "one\n\ntwo");
	}

	fn reasoning_history_request() -> ChatRequest {
		request(Arc::from([Message {
			role:    Role::Assistant,
			content: Arc::from([
				ContentPart::Reasoning { text: "thought".into(), proof: None },
				ContentPart::Text { text: "answer".into(), proof: None },
			]),
			name:    None,
		}]))
	}

	#[test]
	fn replay_reasoning_content_matches_pi_request_shape() {
		let mut policy = policy::WirePolicy::overrides();
		policy.reasoning.replay_content = Some(false);
		let mut profile = OpenAiChatProfile::default();
		profile.apply_policy(&policy);
		let body = OpenAiChatCodec::new(profile, None)
			.encode_chat("model", &reasoning_history_request())
			.expect("request encodes");
		let wire: serde_json::Value = serde_json::from_slice(&body).expect("JSON");
		assert!(wire["messages"][0].get("reasoning_content").is_none());
	}

	#[test]
	fn requires_thinking_as_text_matches_pi_request_shape() {
		let mut policy = policy::WirePolicy::overrides();
		policy.reasoning.requires_thinking_as_text = Some(true);
		let mut profile = OpenAiChatProfile::default();
		profile.apply_policy(&policy);
		let body = OpenAiChatCodec::new(profile, None)
			.encode_chat("model", &reasoning_history_request())
			.expect("request encodes");
		let wire: serde_json::Value = serde_json::from_slice(&body).expect("JSON");
		assert_eq!(wire["messages"][0]["content"], "<think>thought</think> answer");
		assert!(wire["messages"][0].get("reasoning_content").is_none());
	}

	#[test]
	fn qwen_preserve_thinking_matches_pi_request_shape() {
		let mut policy = policy::WirePolicy::overrides();
		policy.reasoning.qwen_preserve_thinking = Some(true);
		let mut profile =
			OpenAiChatProfile { reasoning: ReasoningWireFormat::Qwen, ..Default::default() };
		profile.apply_policy(&policy);
		let body = OpenAiChatCodec::new(profile, None)
			.encode_chat("model", &request(Arc::from([text_message("hello")])))
			.expect("request encodes");
		let wire: serde_json::Value = serde_json::from_slice(&body).expect("JSON");
		assert_eq!(wire["preserve_thinking"], true);
		assert_eq!(wire["chat_template_kwargs"]["preserve_thinking"], true);
	}

	#[test]
	fn thinking_keep_matches_pi_request_shape() {
		let mut policy = policy::WirePolicy::overrides();
		policy.reasoning.keep = Some(true);
		let mut profile =
			OpenAiChatProfile { reasoning: ReasoningWireFormat::Zai, ..Default::default() };
		profile.apply_policy(&policy);
		let body = OpenAiChatCodec::new(profile, None)
			.encode_chat("model", &thinking_request(ReasoningEffort::High))
			.expect("request encodes");
		let wire: serde_json::Value = serde_json::from_slice(&body).expect("JSON");
		assert_eq!(wire["thinking"]["keep"], "all");
	}

	#[test]
	fn supports_penalty_and_stop_params_matches_pi_request_shape() {
		let mut policy = policy::WirePolicy::overrides();
		policy.structured.penalty_and_stop_params = Some(true);
		let mut profile = OpenAiChatProfile::default();
		profile.apply_policy(&policy);
		let mut request = request(Arc::from([text_message("hello")]));
		request.sampling.presence_penalty = Some(0.25);
		request.sampling.stop = Arc::from(["END".into()]);
		let body = OpenAiChatCodec::new(profile, None)
			.encode_chat("model", &request)
			.expect("request encodes");
		let wire: serde_json::Value = serde_json::from_slice(&body).expect("JSON");
		assert_eq!(wire["presence_penalty"], 0.25);
		assert_eq!(wire["stop"][0], "END");
	}

	#[test]
	fn supports_reasoning_params_matches_pi_request_shape() {
		let mut policy = policy::WirePolicy::overrides();
		policy.reasoning.supports_params = Some(false);
		let mut profile = OpenAiChatProfile::default();
		profile.apply_policy(&policy);
		let error = OpenAiChatCodec::new(profile, None)
			.encode_chat("model", &thinking_request(ReasoningEffort::Low))
			.expect_err("unsupported reasoning parameters fail locally");
		assert_eq!(error.kind, ErrorKind::CapabilityMismatch);
	}

	#[test]
	fn strip_image_input_matches_pi_request_shape() {
		let mut policy = policy::WirePolicy::overrides();
		policy.image.strip_input = Some(true);
		let mut profile = OpenAiChatProfile::default();
		profile.apply_policy(&policy);
		let message = Message {
			role:    Role::User,
			content: Arc::from([
				ContentPart::Text { text: "look".into(), proof: None },
				ContentPart::Image(MediaInput::Remote {
					uri:        "https://example.test/image.png".into(),
					media_type: Some("image/png".into()),
					name:       None,
				}),
			]),
			name:    None,
		};
		let body = OpenAiChatCodec::new(profile, None)
			.encode_chat("model", &request(Arc::from([message])))
			.expect("request encodes");
		let wire: serde_json::Value = serde_json::from_slice(&body).expect("JSON");
		assert_eq!(
			wire["messages"][0]["content"][1]["text"],
			"[image omitted: model does not support vision]"
		);
	}

	fn tool_history_request(id: &str) -> ChatRequest {
		request(Arc::from([Message {
			role:    Role::Assistant,
			content: Arc::from([ContentPart::ToolCall {
				call:      crate::id::ToolCallId::new(id),
				name:      "lookup".into(),
				arguments: OpaqueJson::new(serde_json::json!({"q": "x"})),
				proof:     None,
			}]),
			name:    None,
		}]))
	}

	#[test]
	fn uses_openai_tool_call_id_limit_matches_pi_request_shape() {
		let mut policy = policy::WirePolicy::overrides();
		policy.tool.uses_openai_id_limit = Some(true);
		let mut profile = OpenAiChatProfile::default();
		profile.apply_policy(&policy);
		let body = OpenAiChatCodec::new(profile, None)
			.encode_chat(
				"model",
				&tool_history_request("call.with spaces/and punctuation that is much too long"),
			)
			.expect("request encodes");
		let wire: serde_json::Value = serde_json::from_slice(&body).expect("JSON");
		let id = wire["messages"][0]["tool_calls"][0]["id"]
			.as_str()
			.expect("id");
		assert!(id.len() <= 40);
		assert!(
			id.chars()
				.all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '_' | '-'))
		);
	}

	#[test]
	fn requires_mistral_tool_ids_matches_pi_request_shape() {
		let mut policy = policy::WirePolicy::overrides();
		policy.tool.requires_mistral_ids = Some(true);
		let mut profile = OpenAiChatProfile::default();
		profile.apply_policy(&policy);
		let body = OpenAiChatCodec::new(profile, None)
			.encode_chat("model", &tool_history_request("invalid-id"))
			.expect("request encodes");
		let wire: serde_json::Value = serde_json::from_slice(&body).expect("JSON");
		let id = wire["messages"][0]["tool_calls"][0]["id"]
			.as_str()
			.expect("id");
		assert_eq!(id.len(), 9);
		assert!(id.chars().all(|ch| ch.is_ascii_alphanumeric()));
	}

	fn forced_tool_request() -> ChatRequest {
		let mut request = thinking_request(ReasoningEffort::High);
		request.tools = Arc::from([ToolDefinition {
			name:        "lookup".into(),
			description: None,
			input:       ToolInputConstraint::JsonSchema {
				parameters: OpaqueJson::new(serde_json::json!({
					"type": "object",
					"properties": {"q": {"type": "string"}}
				})),
				strict:     true,
			},
		}]);
		request.tool_choice = Setting::Require(ToolChoice::Named("lookup".into()));
		request
	}

	#[test]
	fn supports_strict_mode_matches_pi_request_shape() {
		let mut policy = policy::WirePolicy::overrides();
		policy.tool.supports_strict_mode = Some(false);
		let mut profile = OpenAiChatProfile::default();
		profile.apply_policy(&policy);
		let body = OpenAiChatCodec::new(profile, None)
			.encode_chat("model", &forced_tool_request())
			.expect("request encodes");
		let wire: serde_json::Value = serde_json::from_slice(&body).expect("JSON");
		assert!(wire["tools"][0]["function"].get("strict").is_none());
	}

	#[test]
	fn tool_strict_mode_matches_pi_request_shape() {
		let mut policy = policy::WirePolicy::overrides();
		policy.tool.strict_mode = Some(policy::ToolStrictMode::AllStrict);
		policy.tool.supports_strict_mode = Some(true);
		let mut profile = OpenAiChatProfile::default();
		profile.apply_policy(&policy);
		let body = OpenAiChatCodec::new(profile, None)
			.encode_chat("model", &forced_tool_request())
			.expect("request encodes");
		let wire: serde_json::Value = serde_json::from_slice(&body).expect("JSON");
		assert_eq!(wire["tools"][0]["function"]["strict"], true);
		assert_eq!(wire["tools"][0]["function"]["parameters"]["additionalProperties"], false);
	}

	#[test]
	fn strict_schema_preserves_optional_fields_as_nullable_and_strips_validation_keywords() {
		let mut policy = policy::WirePolicy::baseline();
		policy.tool.supports_strict_mode = Some(true);
		let mut profile = OpenAiChatProfile::default();
		profile.apply_policy(&policy);
		let mut request = forced_tool_request();
		request.tools = Arc::from([ToolDefinition {
			name:        "lookup".into(),
			description: None,
			input:       ToolInputConstraint::JsonSchema {
				parameters: OpaqueJson::new(serde_json::json!({
					"type": "object",
					"properties": {
						"query": {"type": "string", "pattern": "^x+$"},
						"limit": {"type": "integer", "minimum": 1}
					},
					"required": ["query"]
				})),
				strict:     true,
			},
		}]);
		let body = OpenAiChatCodec::new(profile, None)
			.encode_chat("model", &request)
			.expect("request encodes");
		let wire: serde_json::Value = serde_json::from_slice(&body).expect("JSON");
		let schema = &wire["tools"][0]["function"]["parameters"];
		assert_eq!(schema["required"], serde_json::json!(["query", "limit"]));
		assert_eq!(schema["additionalProperties"], false);
		assert!(schema["properties"]["query"].get("pattern").is_none());
		assert!(schema["properties"]["limit"].get("minimum").is_none());
		assert_eq!(schema["properties"]["limit"]["anyOf"][1]["type"], "null");
	}

	#[test]
	fn unknown_strict_capability_fails_open_with_typed_adjustment() {
		let mut profile = OpenAiChatProfile::default();
		profile.apply_policy(&policy::WirePolicy::baseline());
		let (body, adjustments) = OpenAiChatCodec::new(profile, None)
			.encode_chat_adjusted("model", &forced_tool_request())
			.expect("non-strict fallback encodes");
		let wire: serde_json::Value = serde_json::from_slice(&body).expect("JSON");
		assert!(wire["tools"][0]["function"].get("strict").is_none());
		assert!(matches!(
			adjustments.as_slice(),
			[Adjustment::Dropped { feature, reason }]
				if feature.0 == "chat.tool.strict"
					&& reason.0 == "catalog.strict-schema-unsupported"
		));
	}

	#[test]
	fn unrepresentable_strict_schema_retains_open_map_semantics_and_receipts_fallback() {
		let mut policy = policy::WirePolicy::baseline();
		policy.tool.supports_strict_mode = Some(true);
		let mut profile = OpenAiChatProfile::default();
		profile.apply_policy(&policy);
		let mut request = forced_tool_request();
		request.tools = Arc::from([ToolDefinition {
			name:        "lookup".into(),
			description: None,
			input:       ToolInputConstraint::JsonSchema {
				parameters: OpaqueJson::new(serde_json::json!({
					"type": "object",
					"additionalProperties": true
				})),
				strict:     true,
			},
		}]);
		let (body, adjustments) = OpenAiChatCodec::new(profile, None)
			.encode_chat_adjusted("model", &request)
			.expect("fallback encodes");
		let wire: serde_json::Value = serde_json::from_slice(&body).expect("JSON");
		assert_eq!(wire["tools"][0]["function"]["strict"], false);
		assert_eq!(wire["tools"][0]["function"]["parameters"]["additionalProperties"], true);
		assert!(matches!(
			adjustments.as_slice(),
			[Adjustment::Dropped { reason, .. }]
				if reason.0 == "schema.strict-schema-unrepresentable"
		));
	}

	#[test]
	fn supports_named_tool_choice_matches_pi_request_shape() {
		let mut policy = policy::WirePolicy::overrides();
		policy.tool.named_choice = Some(false);
		let mut profile = OpenAiChatProfile::default();
		profile.apply_policy(&policy);
		let body = OpenAiChatCodec::new(profile, None)
			.encode_chat("model", &forced_tool_request())
			.expect("request encodes");
		let wire: serde_json::Value = serde_json::from_slice(&body).expect("JSON");
		assert_eq!(wire["tool_choice"], "required");
	}

	#[test]
	fn disable_reasoning_on_forced_tool_choice_matches_pi_request_shape() {
		let mut policy = policy::WirePolicy::overrides();
		policy.tool.disable_reasoning_on_forced_choice = Some(true);
		let mut profile = OpenAiChatProfile::default();
		profile.apply_policy(&policy);
		let body = OpenAiChatCodec::new(profile, None)
			.encode_chat("model", &forced_tool_request())
			.expect("request encodes");
		let wire: serde_json::Value = serde_json::from_slice(&body).expect("JSON");
		assert!(wire.get("reasoning_effort").is_none());
		assert!(wire.get("reasoning").is_none());
		assert!(wire.get("thinking").is_none());
	}

	fn tool_result_then_user_request() -> ChatRequest {
		request(Arc::from([
			Message {
				role:    Role::Tool,
				content: Arc::from([ContentPart::ToolResult {
					call:     crate::id::ToolCallId::new("call_123"),
					name:     Some("read".into()),
					content:  Arc::from([ToolResultContent::Text("done".into())]),
					is_error: false,
				}]),
				name:    None,
			},
			text_message("continue"),
		]))
	}

	#[test]
	fn requires_tool_result_name_matches_pi_request_shape() {
		let mut policy = policy::WirePolicy::overrides();
		policy.tool.requires_result_name = Some(true);
		let mut profile = OpenAiChatProfile::default();
		profile.apply_policy(&policy);
		let body = OpenAiChatCodec::new(profile, None)
			.encode_chat("model", &tool_result_then_user_request())
			.expect("request encodes");
		let wire: serde_json::Value = serde_json::from_slice(&body).expect("JSON");
		assert_eq!(wire["messages"][0]["name"], "read");
	}

	#[test]
	fn requires_assistant_after_tool_result_matches_pi_request_shape() {
		let mut policy = policy::WirePolicy::overrides();
		policy.tool.requires_assistant_after_result = Some(true);
		let mut profile = OpenAiChatProfile::default();
		profile.apply_policy(&policy);
		let body = OpenAiChatCodec::new(profile, None)
			.encode_chat("model", &tool_result_then_user_request())
			.expect("request encodes");
		let wire: serde_json::Value = serde_json::from_slice(&body).expect("JSON");
		assert_eq!(wire["messages"][1]["role"], "assistant");
		assert_eq!(wire["messages"][1]["content"], "I have processed the tool results.");
		assert_eq!(wire["messages"][2]["role"], "user");
	}

	#[test]
	fn reasoning_deltas_may_be_cumulative_matches_pi_request_shape() {
		let profile = OpenAiChatProfile { reasoning_deltas_cumulative: true, ..Default::default() };
		let mut decoder = OpenAiChatCodec::new(profile, None).chat_decoder();
		let mut events = Vec::new();
		for data in [
			br#"{"choices":[{"index":0,"delta":{"reasoning_content":"abc"}}]}"#.as_slice(),
			br#"{"choices":[{"index":0,"delta":{"reasoning_content":"abcdef"}}]}"#.as_slice(),
		] {
			decoder
				.push(
					Frame::Sse(SseEvent { name: None, data: Bytes::copy_from_slice(data) }),
					&mut |event| events.push(event),
				)
				.expect("chunk decodes");
		}
		let deltas: Vec<_> = events
			.into_iter()
			.filter_map(|event| match event {
				RawEvent::Chat(ChatEvent::ThinkingDelta { text, .. }) => Some(text),
				_ => None,
			})
			.collect();
		assert_eq!(deltas, ["abc", "def"]);
	}

	#[test]
	fn strip_deepseek_special_tokens_matches_pi_request_shape() {
		let profile = OpenAiChatProfile { strip_deepseek_special_tokens: true, ..Default::default() };
		let mut decoder = OpenAiChatCodec::new(profile, None).chat_decoder();
		let mut events = Vec::new();
		decoder
			.push(
				Frame::Sse(SseEvent {
					name: None,
					data: Bytes::copy_from_slice(
						r#"{"choices":[{"index":0,"delta":{"content":"<｜DSML｜>answer"}}]}"#.as_bytes(),
					),
				}),
				&mut |event| events.push(event),
			)
			.expect("chunk decodes");
		assert!(events.iter().any(|event| matches!(
			event,
			RawEvent::Chat(ChatEvent::TextDelta { text, .. }) if text.as_str() == "answer"
		)));
	}

	#[test]
	fn empty_length_finish_is_context_error_matches_pi_request_shape() {
		let profile =
			OpenAiChatProfile { empty_length_finish_is_context_error: true, ..Default::default() };
		let mut decoder = OpenAiChatCodec::new(profile, None).chat_decoder();
		let mut events = Vec::new();
		decoder
			.push(
				Frame::Sse(SseEvent {
					name: None,
					data: Bytes::from_static(
						br#"{"choices":[{"index":0,"delta":{},"finish_reason":"length"}]}"#,
					),
				}),
				&mut |event| events.push(event),
			)
			.expect("chunk decodes");
		let error = decoder
			.finish(&mut |event| events.push(event))
			.expect_err("context error");
		assert_eq!(error.kind, ErrorKind::ContextOverflow);
	}

	#[test]
	fn rejected_kwargs_dialect_hoists_the_effort_onto_the_top_level_field() {
		// The kwargs-only dialect carried no top-level effort; after the
		// rejection the effort selection must survive by hoisting, while
		// `enable_thinking` keeps riding the kwargs the endpoint accepts.
		let profile = OpenAiChatProfile {
			reasoning: ReasoningWireFormat::Nvidia,
			template_reasoning_effort: true,
			template_effort_top_level_only: true,
			..OpenAiChatProfile::default()
		};
		let body = OpenAiChatCodec::new(profile, None)
			.encode_chat("qwen3.8-27b", &thinking_request(ReasoningEffort::Xhigh))
			.expect("request encodes");
		let wire: serde_json::Value = serde_json::from_slice(&body).expect("wire body is JSON");
		assert_eq!(wire["reasoning_effort"], "xhigh");
		assert_eq!(wire["chat_template_kwargs"]["enable_thinking"], true);
		assert!(
			wire["chat_template_kwargs"]
				.as_object()
				.expect("kwargs object")
				.get("reasoning_effort")
				.is_none(),
			"the rejected kwargs spelling must not reappear"
		);
	}

	/// Encodes through [`Codec::encode`] against an embedded Chat Completions
	/// route so the catalog model limits reach the codec the way planning
	/// delivers them.
	fn encode_with_model_limit(
		policy: &policy::WirePolicy,
		maximum_output_tokens: Option<u64>,
		request: ChatRequest,
	) -> serde_json::Value {
		encode_embedded(policy, maximum_output_tokens, request, &CallAffinity::none(), None)
	}

	fn encode_embedded(
		policy: &policy::WirePolicy,
		maximum_output_tokens: Option<u64>,
		request: ChatRequest,
		affinity: &CallAffinity,
		adapter: Option<OpenAiChatAdapterOptions>,
	) -> serde_json::Value {
		let catalog = Catalog::embedded();
		let model = catalog
			.models()
			.iter()
			.find(|model| {
				model.routes.iter().any(|route| {
					catalog
						.route(route)
						.is_some_and(|route| route.codec.as_str() == "openai-chat")
				})
			})
			.expect("embedded Chat Completions model");
		let route = model
			.routes
			.iter()
			.filter_map(|route| catalog.route(route))
			.find(|route| route.codec.as_str() == "openai-chat")
			.expect("embedded Chat Completions route");
		let wire_model = model
			.wire_ids
			.iter()
			.find(|(candidate, _)| candidate == &route.id)
			.expect("embedded Chat Completions wire model")
			.1
			.clone();
		let target = WireTarget {
			route: route.id.clone(),
			codec: route.codec.clone(),
			endpoint: route.endpoint.clone(),
			wire_model,
		};
		let mut policy_model = PolicyModel::from(model);
		policy_model.limits.maximum_output_tokens = maximum_output_tokens;
		let request_id = RequestId::new("chat-output-clamp");
		let context = EncodeContext {
			request_id: &request_id,
			route,
			target: Some(&target),
			policy_model: Some(&policy_model),
			policy,
			affinity,
			..EncodeContext::default()
		};
		let encoded = OpenAiChatCodec::new(OpenAiChatProfile::default(), adapter)
			.encode(&context, &OperationCall::Chat(Arc::new(request)))
			.expect("request encodes");
		let BodySource::Bytes(body) = encoded.body else {
			panic!("Chat Completions body is buffered JSON");
		};
		serde_json::from_slice(&body).expect("wire body is JSON")
	}

	fn limited_request(max_output_tokens: u64) -> ChatRequest {
		let mut request = request(Arc::from([text_message("hello")]));
		request.max_output_tokens = Some(max_output_tokens);
		request
	}

	#[test]
	fn call_cache_affinity_lowers_prompt_cache_key_without_a_bound_conversation() {
		// Headless calls carry no provider conversation; the invocation key
		// still has to reach `prompt_cache_key`.
		let affinity = CallAffinity {
			prompt_cache:     Some(omp_core::sf!("invocation-cache")),
			provider_session: None,
		};
		let wire = encode_embedded(
			&policy::WirePolicy::baseline(),
			None,
			request(Arc::from([text_message("hello")])),
			&affinity,
			Some(OpenAiChatAdapterOptions::OpenAi(OpenAiOptions::default())),
		);
		assert_eq!(wire["prompt_cache_key"], "invocation-cache");

		let wire = encode_embedded(
			&policy::WirePolicy::baseline(),
			None,
			request(Arc::from([text_message("hello")])),
			&CallAffinity::none(),
			Some(OpenAiChatAdapterOptions::OpenAi(OpenAiOptions::default())),
		);
		assert!(wire.get("prompt_cache_key").is_none());
	}

	#[test]
	fn clamp_output_to_model_max_matches_pi_request_shape() {
		let mut policy = policy::WirePolicy::baseline();
		policy.context.clamp_output_to_model_max = Some(true);
		// `min(requested, model maximum)` when output clamping is enabled.
		let wire = encode_with_model_limit(&policy, Some(131_072), limited_request(200_000));
		assert_eq!(wire["max_completion_tokens"], 131_072_u64);
		assert!(wire.get("max_tokens").is_none());
		// A limit under the model maximum is forwarded as requested.
		let wire = encode_with_model_limit(&policy, Some(131_072), limited_request(4_096));
		assert_eq!(wire["max_completion_tokens"], 4_096_u64);
		// An unknown model maximum falls back to `OPENAI_MAX_OUTPUT_TOKENS`.
		let wire = encode_with_model_limit(&policy, None, limited_request(200_000));
		assert_eq!(wire["max_completion_tokens"], super::OPENAI_MAX_OUTPUT_TOKENS);
		// No caller limit: nothing is synthesized, so nothing is clamped.
		let wire = encode_with_model_limit(
			&policy,
			Some(131_072),
			request(Arc::from([text_message("hello")])),
		);
		assert!(wire.get("max_completion_tokens").is_none());
	}

	#[test]
	fn clamp_output_is_inert_without_the_axis() {
		let policy = policy::WirePolicy::baseline();
		let wire = encode_with_model_limit(&policy, Some(131_072), limited_request(200_000));
		assert_eq!(wire["max_completion_tokens"], 200_000_u64);
	}
}
