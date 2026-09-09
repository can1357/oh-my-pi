//! Stable OpenTelemetry attribute-key vocabulary used by omp telemetry.
//!
//! The `gen_ai.*` keys are OpenTelemetry `GenAI` semantic conventions,
//! `openai.*` keys are OpenTelemetry's OpenAI-specific conventions, and
//! `omp.gen_ai.*` / `omp.*` keys are omp extensions. These literal strings
//! are a compatibility contract: changing even one breaks downstream
//! dashboards, collectors, and alerts.

/// OpenTelemetry `GenAI` semantic-convention attribute keys.
pub mod gen_ai {
	/// Provider identifier on `invoke_agent` and `chat` spans.
	pub const PROVIDER_NAME: &str = "gen_ai.provider.name";
	/// Operation vocabulary value on every `invoke_agent`, `chat`,
	/// `execute_tool`, and `handoff` span.
	pub const OPERATION_NAME: &str = "gen_ai.operation.name";
	/// Conversation identifier on every emitted agent, chat, tool, and handoff
	/// span.
	pub const CONVERSATION_ID: &str = "gen_ai.conversation.id";
	/// Requested output modality on `chat` spans.
	pub const OUTPUT_TYPE: &str = "gen_ai.output.type";

	/// Agent identifier on `invoke_agent` and its emitted child spans, including
	/// handoffs.
	pub const AGENT_ID: &str = "gen_ai.agent.id";
	/// Agent display name on `invoke_agent` and its emitted child spans,
	/// including handoffs.
	pub const AGENT_NAME: &str = "gen_ai.agent.name";
	/// Agent description on `invoke_agent` and its emitted child spans,
	/// including handoffs.
	pub const AGENT_DESCRIPTION: &str = "gen_ai.agent.description";

	/// Requested model identifier on `invoke_agent` and `chat` spans.
	pub const REQUEST_MODEL: &str = "gen_ai.request.model";
	/// Requested maximum output-token count on `chat` spans.
	pub const REQUEST_MAX_TOKENS: &str = "gen_ai.request.max_tokens";
	/// Requested sampling temperature on `chat` spans.
	pub const REQUEST_TEMPERATURE: &str = "gen_ai.request.temperature";
	/// Requested nucleus-sampling probability on `chat` spans.
	pub const REQUEST_TOP_P: &str = "gen_ai.request.top_p";
	/// Requested top-k sampling count on `chat` spans.
	pub const REQUEST_TOP_K: &str = "gen_ai.request.top_k";
	/// Requested frequency penalty on `chat` spans.
	pub const REQUEST_FREQUENCY_PENALTY: &str = "gen_ai.request.frequency_penalty";
	/// Requested presence penalty on `chat` spans.
	pub const REQUEST_PRESENCE_PENALTY: &str = "gen_ai.request.presence_penalty";
	/// Requested stop-sequence array on `chat` spans.
	pub const REQUEST_STOP_SEQUENCES: &str = "gen_ai.request.stop_sequences";
	/// Requested random seed on `chat` spans.
	pub const REQUEST_SEED: &str = "gen_ai.request.seed";
	/// Requested response-choice count; reserved for `chat` spans but not set by
	/// the built-in emitter.
	pub const REQUEST_CHOICE_COUNT: &str = "gen_ai.request.choice.count";
	/// Whether response streaming was requested on `chat` spans.
	pub const REQUEST_STREAM: &str = "gen_ai.request.stream";

	/// Actual response model identifier on `chat` spans.
	pub const RESPONSE_MODEL: &str = "gen_ai.response.model";
	/// Provider-issued response identifier on `chat` spans.
	pub const RESPONSE_ID: &str = "gen_ai.response.id";
	/// Array of normalized completion finish reasons on `chat` spans.
	pub const RESPONSE_FINISH_REASONS: &str = "gen_ai.response.finish_reasons";
	/// Seconds from request start to the first response chunk on `chat` spans.
	pub const RESPONSE_TIME_TO_FIRST_CHUNK: &str = "gen_ai.response.time_to_first_chunk";

	/// Total input tokens, including cache-read and cache-created input, on
	/// `chat` spans.
	pub const USAGE_INPUT_TOKENS: &str = "gen_ai.usage.input_tokens";
	/// Output-token count on `chat` spans.
	pub const USAGE_OUTPUT_TOKENS: &str = "gen_ai.usage.output_tokens";
	/// Cache-read input-token count on `chat` spans.
	pub const USAGE_CACHE_READ_INPUT_TOKENS: &str = "gen_ai.usage.cache_read.input_tokens";
	/// Cache-creation input-token count on `chat` spans.
	pub const USAGE_CACHE_CREATION_INPUT_TOKENS: &str = "gen_ai.usage.cache_creation.input_tokens";
	/// Reasoning output-token count on `chat` spans.
	pub const USAGE_REASONING_OUTPUT_TOKENS: &str = "gen_ai.usage.reasoning.output_tokens";

	/// Provider tool-call identifier on `execute_tool` spans.
	pub const TOOL_CALL_ID: &str = "gen_ai.tool.call.id";
	/// Tool name on `execute_tool` spans.
	pub const TOOL_NAME: &str = "gen_ai.tool.name";
	/// Tool description on `execute_tool` spans.
	pub const TOOL_DESCRIPTION: &str = "gen_ai.tool.description";
	/// Tool kind, currently `function`, on `execute_tool` spans.
	pub const TOOL_TYPE: &str = "gen_ai.tool.type";
	/// Captured tool-call arguments on `execute_tool` spans when content capture
	/// is enabled.
	pub const TOOL_CALL_ARGUMENTS: &str = "gen_ai.tool.call.arguments";
	/// Captured tool-call result on `execute_tool` spans when content capture is
	/// enabled.
	pub const TOOL_CALL_RESULT: &str = "gen_ai.tool.call.result";
	/// Serialized tool definitions; reserved for `chat` spans but not set by the
	/// built-in emitter.
	pub const TOOL_DEFINITIONS: &str = "gen_ai.tool.definitions";

	/// Full captured input-message payload on `chat` spans when full content
	/// capture is enabled.
	pub const INPUT_MESSAGES: &str = "gen_ai.input.messages";
	/// Full captured output-message payload on `chat` spans when full content
	/// capture is enabled.
	pub const OUTPUT_MESSAGES: &str = "gen_ai.output.messages";
	/// Full captured system instructions on `chat` spans when full content
	/// capture is enabled.
	pub const SYSTEM_INSTRUCTIONS: &str = "gen_ai.system_instructions";

	/// Error classification on failed `invoke_agent`, `chat`, and `execute_tool`
	/// spans.
	pub const ERROR_TYPE: &str = "error.type";
}

/// OpenTelemetry OpenAI-specific semantic-convention attribute keys.
pub mod openai {
	/// Requested `OpenAI` service tier on eligible `chat` spans.
	pub const REQUEST_SERVICE_TIER: &str = "openai.request.service_tier";
	/// Returned `OpenAI` service tier; reserved for `chat` spans but not set by
	/// the built-in emitter.
	pub const RESPONSE_SERVICE_TIER: &str = "openai.response.service_tier";
}

/// omp extension attribute keys kept outside OpenTelemetry's reserved
/// namespaces.
pub mod omp_gen_ai {
	/// Zero-based agent-loop step number on `chat` spans.
	pub const AGENT_STEP_NUMBER: &str = "omp.gen_ai.agent.step.number";
	/// Final number of agent-loop steps on the outer `invoke_agent` span.
	pub const AGENT_STEP_COUNT: &str = "omp.gen_ai.agent.step.count";
	/// Requested reasoning effort on `chat` spans.
	pub const REQUEST_REASONING_EFFORT: &str = "omp.gen_ai.request.reasoning.effort";
	/// Serialized requested tool-choice policy on `chat` spans.
	pub const REQUEST_TOOL_CHOICE: &str = "omp.gen_ai.request.tool.choice";
	/// Names of tools available to a `chat` request.
	pub const REQUEST_AVAILABLE_TOOLS: &str = "omp.gen_ai.request.available_tools";
	/// Bounded request-message summary on `chat` spans when content capture is
	/// enabled.
	pub const REQUEST_MESSAGES: &str = "omp.gen_ai.request.messages";
	/// Bounded response-text summary on `chat` spans when content capture is
	/// enabled.
	pub const RESPONSE_TEXT: &str = "omp.gen_ai.response.text";
	/// Bounded response tool-call summary on `chat` spans when content capture
	/// is enabled.
	pub const RESPONSE_TOOL_CALLS: &str = "omp.gen_ai.response.tool_calls";
	/// Upstream provider reported by a gateway on `chat` spans.
	pub const RESPONSE_UPSTREAM_PROVIDER: &str = "omp.gen_ai.response.upstream_provider";
	/// Total token count on `chat` spans.
	pub const USAGE_TOTAL_TOKENS: &str = "omp.gen_ai.usage.total_tokens";
	/// Count of server-side tool requests on `chat` spans.
	pub const USAGE_SERVER_SIDE_TOOLS: &str = "omp.gen_ai.usage.server_tool_requests";
	/// Estimated total cost in USD on `chat` spans.
	pub const COST_ESTIMATED_USD: &str = "omp.gen_ai.cost.estimated_usd";
	/// Estimated input-side cost in USD on `chat` spans.
	pub const COST_INPUT_USD: &str = "omp.gen_ai.cost.input_usd";
	/// Estimated output-side cost in USD on `chat` spans.
	pub const COST_OUTPUT_USD: &str = "omp.gen_ai.cost.output_usd";
	/// Reason cost estimation was unavailable on `chat` spans.
	pub const COST_UNAVAILABLE_REASON: &str = "omp.gen_ai.cost.unavailable_reason";
	/// Terminal tool status on `execute_tool` spans.
	pub const TOOL_STATUS: &str = "omp.gen_ai.tool.status";
	/// Tool-call intent; reserved for `execute_tool` spans but not set by omp's
	/// built-in emitter.
	pub const TOOL_CALL_INTENT: &str = "omp.gen_ai.tool.call.intent";
	/// Source agent name on `handoff` spans.
	pub const HANDOFF_FROM_AGENT_NAME: &str = "omp.gen_ai.handoff.from_agent.name";
	/// Source agent identifier on `handoff` spans.
	pub const HANDOFF_FROM_AGENT_ID: &str = "omp.gen_ai.handoff.from_agent.id";
	/// Destination agent name on `handoff` spans.
	pub const HANDOFF_TO_AGENT_NAME: &str = "omp.gen_ai.handoff.to_agent.name";
	/// Destination agent identifier on `handoff` spans.
	pub const HANDOFF_TO_AGENT_ID: &str = "omp.gen_ai.handoff.to_agent.id";
	/// Kind of one-shot completion outside the main agent loop on `chat` spans.
	pub const ONE_SHOT_KIND: &str = "omp.gen_ai.one_shot.kind";
	/// System-instruction content capture mode on `chat` spans.
	pub const CAPTURE_SYSTEM_INSTRUCTIONS: &str = "omp.gen_ai.capture.system_instructions";
	/// Input-messages content capture mode on `chat` spans.
	pub const CAPTURE_INPUT_MESSAGES: &str = "omp.gen_ai.capture.input_messages";
	/// Output-messages content capture mode on `chat` spans.
	pub const CAPTURE_OUTPUT_MESSAGES: &str = "omp.gen_ai.capture.output_messages";
	/// Gateway name on `chat` spans.
	pub const GATEWAY_NAME: &str = "omp.gen_ai.gateway.name";
	/// Gateway target base URL on `chat` spans.
	pub const GATEWAY_ENDPOINT: &str = "omp.gen_ai.gateway.endpoint";
	/// Gateway call identifier on `chat` spans.
	pub const GATEWAY_CALL_ID: &str = "omp.gen_ai.gateway.call_id";
	/// Gateway routed-to destination on `chat` spans.
	pub const GATEWAY_ROUTED_TO: &str = "omp.gen_ai.gateway.routed_to";
	/// Gateway routing strategy on `chat` spans.
	pub const GATEWAY_ROUTING_STRATEGY: &str = "omp.gen_ai.gateway.routing_strategy";
	/// Gateway fallback attempts count on `chat` spans.
	pub const GATEWAY_FALLBACK_ATTEMPTS: &str = "omp.gen_ai.gateway.fallback_attempts";
	/// Gateway response-cache status (hit/miss/bypass) on `chat` spans; this
	/// is not prompt-cache status.
	pub const GATEWAY_RESPONSE_CACHE_STATUS: &str = "omp.gen_ai.gateway.response_cache.status";

	/// Assembler-computed prompt digest on settled chat spans.
	pub const PROMPT_DIGEST: &str = "omp.gen_ai.prompt.digest";
	/// Changed prompt-slot keys on settled chat spans.
	pub const PROMPT_CHANGED_SLOTS: &str = "omp.gen_ai.prompt.changed_slots";
	/// Byte length of the cacheable prefix shared with the prior prompt.
	pub const PROMPT_PREFIX_STABLE_BYTES: &str = "omp.gen_ai.prompt.prefix_stable_bytes";
	/// Provider cache-affinity key on settled chat spans.
	pub const CACHE_KEY: &str = "omp.gen_ai.cache.key";
	/// Cache breakpoint strategy on settled chat spans.
	pub const CACHE_BREAKPOINT: &str = "omp.gen_ai.cache.breakpoint";
}

/// Firehose-only facts that have no OpenTelemetry semantic-convention owner.
pub mod omp_firehose {
	/// Committed tool revision on tool-call events and execute-tool spans.
	pub const TOOL_REV: &str = "omp.tool.rev";
	/// Tool execution placement on tool-call events and execute-tool spans.
	pub const TOOL_PLACE: &str = "omp.tool.place";
	/// Tool target discriminant on tool-call events and execute-tool spans.
	pub const TOOL_TARGET: &str = "omp.tool.target";
	/// Speculative decoding time on tool-call events and execute-tool spans.
	pub const TOOL_SPECULATION_MS: &str = "omp.tool.speculation_ms";
	/// Size of a tool's rendered projection, never its text.
	pub const TOOL_PROMPT_BYTES: &str = "omp.tool.prompt_bytes";
	/// Applied charitable repairs on tool-call events and execute-tool spans.
	pub const TOOL_REPAIRS: &str = "omp.tool.repairs";
	/// Classified tool fault code on tool-call events and execute-tool spans.
	pub const TOOL_FAULT_CODE: &str = "omp.tool.fault_code";
	/// Compaction trigger on compaction events.
	pub const COMPACTION_REASON: &str = "omp.compaction.reason";
	/// Structured outcomes preserved by compaction.
	pub const COMPACTION_OUTCOMES_KEPT: &str = "omp.compaction.outcomes_kept";
	/// Identifier of a spilled artifact.
	pub const ARTIFACT_ID: &str = "omp.artifact.id";
	/// Layer that caused an artifact spill.
	pub const ARTIFACT_REASON: &str = "omp.artifact.reason";
	/// Identifier of a durable `AutoQA` issue.
	pub const ISSUE_ID: &str = "omp.issue.id";
	/// Requested capability constraint intent.
	pub const CONSTRAINT_INTENT: &str = "omp.constraint.intent";
	/// Granted capability-constraint result.
	pub const CONSTRAINT_GRANTED: &str = "omp.constraint.granted";
}

/// omp runtime-duration attributes emitted on metrics and durable receipts.
pub mod omp_runtime {
	/// Configured courtesy-interrupt grace expressed exactly in nanoseconds.
	pub const INTERRUPT_GRACE_NS: &str = "omp.runtime.interrupt_grace.ns";
	/// Unit used to configure the courtesy-interrupt grace.
	pub const INTERRUPT_GRACE_UNIT: &str = "omp.runtime.interrupt_grace.unit";
	/// Configured invocation deadline expressed exactly in nanoseconds.
	pub const DEADLINE_NS: &str = "omp.runtime.deadline.ns";
	/// Unit used to configure the invocation deadline.
	pub const DEADLINE_UNIT: &str = "omp.runtime.deadline.unit";
}

/// omp aggregate attribute keys stamped on the outer `invoke_agent` span.
pub mod omp_aggregate {
	/// Number of chat calls in the run, on `invoke_agent` spans.
	pub const CHATS_COUNT: &str = "omp.gen_ai.agent.chats.count";
	/// Sum of chat latency in milliseconds, on `invoke_agent` spans.
	pub const CHATS_TOTAL_LATENCY_MS: &str = "omp.gen_ai.agent.chats.total_latency_ms";
	/// Prefix for dynamic per-stop-reason count keys on `invoke_agent` spans;
	/// never emit this bare prefix.
	pub const CHATS_STOP_REASON_PREFIX: &str = "omp.gen_ai.agent.chats.stop_reason.";
	/// Number of tool invocations in the run, on `invoke_agent` spans.
	pub const TOOLS_COUNT: &str = "omp.gen_ai.agent.tools.count";
	/// Number of successful tool invocations, on `invoke_agent` spans.
	pub const TOOLS_OK_COUNT: &str = "omp.gen_ai.agent.tools.ok.count";
	/// Number of errored tool invocations, on `invoke_agent` spans.
	pub const TOOLS_ERROR_COUNT: &str = "omp.gen_ai.agent.tools.error.count";
	/// Number of skipped tool invocations, on `invoke_agent` spans.
	pub const TOOLS_SKIPPED_COUNT: &str = "omp.gen_ai.agent.tools.skipped.count";
	/// Number of blocked tool invocations, on `invoke_agent` spans.
	pub const TOOLS_BLOCKED_COUNT: &str = "omp.gen_ai.agent.tools.blocked.count";
	/// Number of timed-out tool invocations, on `invoke_agent` spans.
	pub const TOOLS_TIMEOUT_COUNT: &str = "omp.gen_ai.agent.tools.timeout.count";
	/// Number of aborted tool invocations, on `invoke_agent` spans.
	pub const TOOLS_ABORTED_COUNT: &str = "omp.gen_ai.agent.tools.aborted.count";
	/// Sum of tool latency in milliseconds, on `invoke_agent` spans.
	pub const TOOLS_TOTAL_LATENCY_MS: &str = "omp.gen_ai.agent.tools.total_latency_ms";
	/// Distinct invoked tool names, on `invoke_agent` spans.
	pub const TOOLS_INVOKED: &str = "omp.gen_ai.agent.tools.invoked";
	/// Distinct available tool names, on `invoke_agent` spans.
	pub const TOOLS_AVAILABLE: &str = "omp.gen_ai.agent.tools.available";
	/// Distinct available-but-unused tool names, on `invoke_agent` spans.
	pub const TOOLS_UNUSED: &str = "omp.gen_ai.agent.tools.unused";
	/// Aggregate input-token count, on `invoke_agent` spans.
	pub const USAGE_INPUT_TOKENS_TOTAL: &str = "omp.gen_ai.agent.usage.input_tokens.total";
	/// Aggregate output-token count, on `invoke_agent` spans.
	pub const USAGE_OUTPUT_TOKENS_TOTAL: &str = "omp.gen_ai.agent.usage.output_tokens.total";
	/// Aggregate cache-read input-token count, on `invoke_agent` spans.
	pub const USAGE_CACHE_READ_INPUT_TOKENS_TOTAL: &str =
		"omp.gen_ai.agent.usage.cache_read.input_tokens.total";
	/// Aggregate cache-creation input-token count, on `invoke_agent` spans.
	pub const USAGE_CACHE_CREATION_INPUT_TOKENS_TOTAL: &str =
		"omp.gen_ai.agent.usage.cache_creation.input_tokens.total";
	/// Aggregate reasoning output-token count, on `invoke_agent` spans.
	pub const USAGE_REASONING_OUTPUT_TOKENS_TOTAL: &str =
		"omp.gen_ai.agent.usage.reasoning.output_tokens.total";
	/// Aggregate total-token count, on `invoke_agent` spans.
	pub const USAGE_TOTAL_TOKENS_TOTAL: &str = "omp.gen_ai.agent.usage.total_tokens.total";
	/// Aggregate estimated cost in USD, on `invoke_agent` spans.
	pub const COST_ESTIMATED_USD_TOTAL: &str = "omp.gen_ai.agent.cost.estimated_usd.total";
	/// Aggregate error count, on `invoke_agent` spans.
	pub const ERRORS_COUNT: &str = "omp.gen_ai.agent.errors.count";

	/// Builds the dynamic per-stop-reason count key used on `invoke_agent`
	/// spans.
	pub fn chats_stop_reason(reason: &str) -> String {
		let mut key =
			String::with_capacity(CHATS_STOP_REASON_PREFIX.len() + reason.len() + ".count".len());
		key.push_str(CHATS_STOP_REASON_PREFIX);
		key.push_str(reason);
		key.push_str(".count");
		key
	}
}

#[cfg(test)]
mod tests {
	#[test]
	fn builds_complete_stop_reason_key() {
		assert_eq!(
			super::omp_aggregate::chats_stop_reason("toolUse"),
			"omp.gen_ai.agent.chats.stop_reason.toolUse.count",
		);
	}
}
