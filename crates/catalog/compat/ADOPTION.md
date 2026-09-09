# Codec adoption ledger

Every newly synced wire/thinking compatibility axis is parsed into a typed catalog policy. A `consumed` row names the inference consumer and the test reproducing pi's observable shape. A `stored-only` row is an honest gap: the fact is compiled and typed, but the named boundary cannot consume it yet. Stored-only axes are not silently treated as unsupported.

Primary ledger: **70 axes — 52 consumed, 18 stored-only.**

| axis | set | WirePolicy field | codec file | test name | status |
|---|---|---|---|---|---|
| `allow-anthropic-header-overrides` | wire | `policy.headers.allow_anthropic_overrides` | `crates/inference/src/codec/anthropic.rs` | — | stored-only: codec receives no caller/model header map; OAuth enforced-header merging belongs to auth/header assembly |
| `always-send-max-tokens` | wire | `policy.context.always_send_max_tokens` | `crates/inference/src/codec/openai_responses.rs` | `always_send_max_tokens_matches_pi_request_shape` | consumed |
| `antigravity-claude-tool-mode` | wire | `policy.tool.antigravity_claude_mode` | `crates/inference/src/codec/google_cca.rs` | `antigravity_claude_tool_mode_matches_pi_request_shape` | consumed |
| `antigravity-usage-label` | wire | `policy.usage.antigravity_label` | `crates/inference/src/codec/google_cca.rs` | `antigravity_usage_label_matches_pi_request_shape` | consumed |
| `cache-control-format` | wire | `policy.cache.control_format` | `crates/inference/src/codec/openai_responses.rs` | `cache_control_format_matches_pi_request_shape` | consumed |
| `cca-legacy-parameters-schema` | wire | `policy.tool.cca_legacy_parameters_schema` | `crates/inference/src/codec/gemini.rs` | `cca_legacy_parameters_schema_matches_pi_request_shape` | consumed |
| `clamp-output-to-model-max` | wire | `policy.context.clamp_output_to_model_max` | `crates/inference/src/codec/openai_chat.rs` | `clamp_output_to_model_max_matches_pi_request_shape` | consumed |
| `claude-thinking-beta-header` | wire | `policy.headers.claude_thinking_beta` | `crates/inference/src/codec/google_cca.rs` | `claude_thinking_beta_header_matches_pi_request_shape` | consumed |
| `disable-reasoning-on-forced-tool-choice` | wire | `policy.tool.disable_reasoning_on_forced_choice` | `crates/inference/src/codec/openai_chat.rs` | `disable_reasoning_on_forced_tool_choice_matches_pi_request_shape` | consumed |
| `disable-strict-tools` | wire | `policy.tool.disable_strict_tools` | `crates/inference/src/codec/anthropic.rs` | `disable_strict_tools_matches_pi_request_shape` | consumed |
| `drop-thinking-when-reasoning-effort` | wire | `policy.reasoning.drop_thinking_when_effort` | `crates/inference/src/codec/openai_chat.rs` | — | stored-only: typed extra-body merge is outside the current chat request contract |
| `drop-unsigned-thinking` | wire | `policy.reasoning.drop_unsigned` | `crates/inference/src/codec/gemini.rs` | `drop_unsigned_thinking_matches_pi_request_shape` | consumed |
| `empty-length-finish-is-context-error` | wire | `policy.streaming.empty_length_finish_is_context_error` | `crates/inference/src/codec/openai_chat.rs` | `empty_length_finish_is_context_error_matches_pi_request_shape` | consumed |
| `flash-stream-leak-workaround` | wire | `policy.streaming.flash_leak_workaround` | `crates/inference/src/codec/google_cca.rs` | `flash_stream_leak_workaround_matches_pi_request_shape` | consumed |
| `harmony-leak-mitigation` | wire | `policy.streaming.harmony_leak_mitigation` | `crates/inference/src/recovery/harmony.rs`, `crates/inference/src/layer/recover.rs` | `harmony_audit_is_selected_only_by_compiled_policy`, `harmony_leak_rejection_is_transactional_and_retryable` | consumed |
| `inject-claude-code-instruction` | wire | `policy.role.inject_claude_code_instruction` | `crates/inference/src/codec/anthropic.rs` | `inject_claude_code_instruction_matches_pi_request_shape` | consumed |
| `kimi-api-format` | wire | `policy.dialect.kimi_api_format` | `crates/inference/src/codec/openai_chat.rs` | — | stored-only: codec selection and routing happen before request lowering |
| `model-router` | wire | `policy.dialect.model_router` | `crates/inference/src/codec/devin.rs` | — | stored-only: pi requires AssignModel preflight + assignment JWT before chat; omp provider operation has no typed AssignModel orchestration yet |
| `multimodal-function-response` | wire | `policy.image.multimodal_function_response` | `crates/inference/src/codec/gemini.rs` | `multimodal_function_response_matches_pi_request_shape` | consumed |
| `native-kimi-k3-reasoning` | wire | `policy.reasoning.native_kimi_k3` | `crates/inference/src/codec/openai_chat.rs` | — | stored-only: thinking resolution selects this dialect before codec lowering |
| `prompt-cache-breakpoint-ttl` | wire | `policy.cache.breakpoint_ttl` | `crates/inference/src/codec/openai_responses.rs` | `prompt_cache_breakpoint_ttl_matches_pi_request_shape` | consumed |
| `prompt-cache-maximum-checkpoints` | wire | `policy.cache.maximum_checkpoints` | `crates/inference/src/codec/bedrock.rs` | `prompt_cache_maximum_checkpoints_matches_pi_request_shape` | consumed |
| `prompt-cache-minimum-tokens` | wire | `policy.cache.minimum_tokens` | `crates/inference/src/codec/bedrock.rs` | — | stored-only: pi delegates the minimum-prefix-token check to Bedrock and does not count locally |
| `prompt-cache-mode` | wire | `policy.cache.prompt_cache_mode` | `crates/inference/src/codec/bedrock.rs` | `prompt_cache_mode_matches_pi_request_shape` | consumed |
| `prompt-cache-session-header` | wire | `policy.headers.prompt_cache_session` | `crates/inference/src/codec/openai_responses.rs` | `prompt_cache_session_header_matches_pi_request_shape` | consumed |
| `qwen-preserve-thinking` | wire | `policy.reasoning.qwen_preserve_thinking` | `crates/inference/src/codec/openai_chat.rs` | `qwen_preserve_thinking_matches_pi_request_shape` | consumed |
| `reasoning-deltas-may-be-cumulative` | wire | `policy.streaming.reasoning_deltas_cumulative` | `crates/inference/src/codec/openai_chat.rs` | `reasoning_deltas_may_be_cumulative_matches_pi_request_shape` | consumed |
| `reject-root-object-union` | wire | `policy.tool.reject_root_object_union` | `crates/inference/src/codec/openai_chat.rs` | `reject_root_object_union_matches_pi_request_shape` | consumed |
| `replay-reasoning-content` | wire | `policy.reasoning.replay_content` | `crates/inference/src/codec/openai_chat.rs` | `replay_reasoning_content_matches_pi_request_shape` | consumed |
| `requires-assistant-after-tool-result` | wire | `policy.tool.requires_assistant_after_result` | `crates/inference/src/codec/openai_chat.rs` | `requires_assistant_after_tool_result_matches_pi_request_shape` | consumed |
| `requires-mistral-tool-ids` | wire | `policy.tool.requires_mistral_ids` | `crates/inference/src/codec/openai_chat.rs` | `requires_mistral_tool_ids_matches_pi_request_shape` | consumed |
| `requires-reasoning-off-juice-instruction` | wire | `policy.reasoning.requires_off_juice_instruction` | `crates/inference/src/codec/openai_responses.rs` | `requires_reasoning_off_juice_instruction_matches_pi_request_shape` | consumed |
| `requires-skip-thought-signature` | wire | `policy.tool.requires_skip_thought_signature` | `crates/inference/src/codec/gemini.rs` | `requires_skip_thought_signature_matches_pi_request_shape` | consumed |
| `requires-skip-thought-signature-on-first-function-call` | wire | `policy.tool.requires_skip_thought_signature_on_first_function_call` | `crates/inference/src/codec/gemini.rs`; `crates/inference/src/codec/google_cca.rs` | `first_function_call_sentinel_applies_only_to_first_unsigned_call`; `cca_gemini_three_requires_only_the_first_call_signature_bypass` | consumed |
| `requires-thinking-as-text` | wire | `policy.reasoning.requires_thinking_as_text` | `crates/inference/src/codec/openai_chat.rs` | `requires_thinking_as_text_matches_pi_request_shape` | consumed |
| `requires-tool-result-name` | wire | `policy.tool.requires_result_name` | `crates/inference/src/codec/openai_chat.rs` | `requires_tool_result_name_matches_pi_request_shape` | consumed |
| `retry-without-strict-on-grammar-error` | wire | `policy.tool.retry_without_strict_on_grammar_error` | `crates/inference/src/layer/recover.rs` | — | stored-only: requires attempt-level mutation after a typed prebody provider rejection; stream recovery cannot perform it |
| `stream-first-event-timeout-ms` | wire | `policy.streaming.watchdog.first_event_ms` | `crates/inference/src/transport/http.rs` | `stream_first_event_timeout_ms_matches_pi_behavior` | consumed |
| `stream-markup-healing-pattern` | wire | `policy.streaming.markup_healing_pattern` | `crates/inference/src/recovery/projection.rs`; `crates/inference/src/layer/recover.rs` | `configured_dialect_pipeline_projects_canonical_tool_events`; `live_dialect_projection_suppresses_source_text_blocks_and_avoids_index_collisions` | consumed |
| `strict-responses-pairing` | wire | `policy.tool.strict_responses_pairing` | `crates/inference/src/codec/openai_responses.rs` | `strict_responses_pairing_matches_pi_request_shape` | consumed |
| `strip-deepseek-special-tokens` | wire | `policy.streaming.strip_deepseek_special_tokens` | `crates/inference/src/codec/openai_chat.rs` | `strip_deepseek_special_tokens_matches_pi_request_shape` | consumed |
| `strip-image-input` | wire | `policy.image.strip_input` | `crates/inference/src/codec/openai_chat.rs` | `strip_image_input_matches_pi_request_shape` | consumed |
| `supports-all-turns-reasoning-context` | wire | `policy.reasoning.supports_all_turns_context` | `crates/inference/src/codec/openai_codex.rs` | `supports_all_turns_reasoning_context_matches_pi_request_shape` | consumed |
| `supports-context-management` | wire | `policy.context.supports_management` | `crates/inference/src/codec/anthropic.rs` | `supports_context_management_matches_pi_request_shape` | consumed |
| `supports-function-part-id` | wire | `policy.tool.supports_function_part_id` | `crates/inference/src/codec/gemini.rs` | `supports_function_part_id_matches_pi_request_shape` | consumed |
| `supports-long-prompt-cache-retention` | wire | `policy.cache.supports_long_retention` | `crates/inference/src/codec/bedrock.rs` | `supports_long_prompt_cache_retention_matches_pi_request_shape` | consumed |
| `supports-mid-conversation-tool-changes` | wire | `policy.tool.supports_mid_conversation_changes` | `crates/inference/src/codec/anthropic.rs` | — | stored-only: canonical ChatRequest has no Anthropic tool-change control-transition payload |
| `supports-multiple-system-messages` | wire | `policy.role.multiple_system_messages` | `crates/inference/src/codec/openai_chat.rs` | `supports_multiple_system_messages_matches_pi_request_shape` | consumed |
| `supports-named-tool-choice` | wire | `policy.tool.named_choice` | `crates/inference/src/codec/openai_chat.rs` | `supports_named_tool_choice_matches_pi_request_shape` | consumed |
| `supports-obfuscation-opt-out` | wire | `policy.streaming.supports_obfuscation_opt_out` | `crates/inference/src/codec/openai_responses.rs` | `supports_obfuscation_opt_out_matches_pi_request_shape` | consumed |
| `supports-output-effort` | wire | `policy.reasoning.supports_output_effort` | `crates/inference/src/codec/anthropic.rs` | `supports_output_effort_matches_pi_request_shape` | consumed |
| `supports-parallel-tool-calls` | wire | `policy.tool.supports_parallel_calls` | `crates/inference/src/codec/devin.rs` | `supports_parallel_tool_calls_matches_pi_request_shape` | consumed |
| `supports-penalty-and-stop-params` | wire | `policy.structured.penalty_and_stop_params` | `crates/inference/src/codec/openai_chat.rs` | `supports_penalty_and_stop_params_matches_pi_request_shape` | consumed |
| `supports-per-message-effort` | wire | `policy.reasoning.supports_per_message_effort` | `crates/inference/src/codec/anthropic.rs` | — | stored-only: canonical Message has no per-message output_config effort control |
| `supports-prompt-cache-breakpoints` | wire | `policy.cache.supports_breakpoints` | `crates/inference/src/codec/openai_responses.rs` | `supports_prompt_cache_breakpoints_matches_pi_request_shape` | consumed |
| `supports-prompt-cache-key` | wire | `policy.cache.supports_key` | `crates/inference/src/codec/openai_chat.rs` | — | stored-only: the session-affinity adapter owns the explicit key |
| `supports-reasoning-params` | wire | `policy.reasoning.supports_params` | `crates/inference/src/codec/openai_chat.rs` | `supports_reasoning_params_matches_pi_request_shape` | consumed |
| `supports-strict-mode` | wire | `policy.tool.supports_strict_mode` | `crates/inference/src/codec/openai_chat.rs` | `supports_strict_mode_matches_pi_request_shape` | consumed |
| `supports-thinking-binding-controls` | wire | `policy.reasoning.supports_binding_controls` | `crates/inference/src/codec/anthropic.rs` | — | stored-only: canonical request has no prefix-mismatch behavior control to encode |
| `supports-turn-scoped-system` | wire | `policy.role.supports_turn_scoped_system` | `crates/inference/src/codec/anthropic.rs` | — | stored-only: canonical Message has no clear_at/turn-scoped system control payload |
| `thinking-effort-map` | thinking | `ThinkingPolicy.effort_map → ThinkingSelection.native_effort` | `crates/inference/src/codec/anthropic.rs` | `thinking_effort_map_matches_pi_request_shape` | consumed |
| `thinking-keep` | wire | `policy.reasoning.keep` | `crates/inference/src/codec/openai_chat.rs` | `thinking_keep_matches_pi_request_shape` | consumed |
| `thinking-loop-guard` | wire | `policy.reasoning.loop_guard_profile` | `crates/inference/src/layer/recover.rs` | `thinking_loop_guard_matches_pi_behavior` | consumed |
| `thinking-prefix-binding` | thinking | `ThinkingPolicy.prefix_binding` | `crates/inference/src/codec/anthropic.rs` | — | stored-only: canonical ChatRequest exposes no prefix-mismatch behavior to combine with binding controls |
| `tool-schema-flavor` | wire | `policy.tool.schema_flavor` | `crates/inference/src/codec/openai_chat.rs` | — | stored-only: strict-schema ownership must perform this projection |
| `tool-strict-mode` | wire | `policy.tool.strict_mode` | `crates/inference/src/codec/openai_chat.rs` | `tool_strict_mode_matches_pi_request_shape` | consumed |
| `trust-explicit-thinking-only` | wire | `policy.reasoning.trust_explicit_only` | `crates/inference/src/codec/devin.rs` | — | stored-only: pi consumes during catalog thinking inference, before codec request lowering |
| `uses-openai-tool-call-id-limit` | wire | `policy.tool.uses_openai_id_limit` | `crates/inference/src/codec/openai_chat.rs` | `uses_openai_tool_call_id_limit_matches_pi_request_shape` | consumed |
| `wire-model-id-mode` | wire | `policy.dialect.wire_model_id_mode` | `crates/inference/src/codec/openai_chat.rs` | — | stored-only: the target wire model is resolved before codec lowering |
| `zai-reasoning-effort-dialect` | wire | `policy.dialect.zai_reasoning_effort` | `crates/inference/src/codec/openai_chat.rs` | — | stored-only: thinking resolution selects the wire format |

## Existing axes verified while closing the ledger

| axis | set | WirePolicy field | codec file | test name | status |
|---|---|---|---|---|---|
| `disable-adaptive-thinking` | wire | `policy.reasoning.disable_adaptive` | `crates/inference/src/codec/anthropic.rs` | `disable_adaptive_thinking_matches_pi_request_shape` | consumed |
| `supports-forced-tool-choice` | wire | `policy.tool.forced_choice` | `crates/inference/src/plan.rs`; `crates/inference/src/codec/openai_chat.rs`; `crates/inference/src/codec/openai_responses.rs` | `supports_forced_tool_choice_matches_pi_behavior` | consumed |
| `supports-usage-in-streaming` | wire | `policy.usage.in_streaming` | `crates/inference/src/codec/openai_chat.rs` | `supports_usage_in_streaming_matches_pi_request_shape` | consumed |
