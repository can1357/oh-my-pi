import { buildModel } from "@oh-my-pi/pi-catalog/build";
import {
	FACTORY_DROID_UPSTREAMS,
	factoryDroidOrgIdFromToken,
	resolveFactoryDroidAuth,
} from "@oh-my-pi/pi-catalog/discovery";
import type { Effort } from "@oh-my-pi/pi-catalog/effort";
import * as AIError from "../error";
import type { Context, Model, ModelSpec, ServiceTier, StreamFunction, StreamOptions, ToolChoice } from "../types";
import { AssistantMessageEventStream } from "../utils/event-stream";
import { createProviderErrorMessage } from "./error-message";
import { streamOpenAICompletions } from "./register-builtins";

/**
 * Factory Droid (Droid Core subscription) provider — sidecar-free transport.
 *
 * Talks directly to Factory's subscription LLM proxy at
 * `POST https://api.factory.ai/api/llm/o/v1/chat/completions`, an
 * OpenAI-compatible endpoint the Droid CLI itself uses. No `droid` binary or
 * daemon is required at inference time; authentication reuses the WorkOS
 * session that `droid auth login` stored locally (see factory-droid-auth.ts).
 *
 * Reverse-engineered wire contract (verified live against droid 0.189.0):
 *
 * - Auth: `Authorization: Bearer <workos access token>`. Factory API keys are
 *   control-plane only and get 403 here.
 * - Required headers: a parseable client version (`X-Client-Version`), and
 *   `x-api-provider` selecting the upstream router (`fireworks`/`baseten`,
 *   resolved per model from the catalog registry).
 * - System-prompt gate: the proxy rejects (403) requests whose first system
 *   message does not start with the exact Droid identity sentence
 *   {@link DROID_SYSTEM_PREFIX}. The rest of the system prompt is untouched —
 *   OMP's own prompt follows the marker sentence.
 * - Reasoning: Fireworks takes OpenAI-style `reasoning_effort`
 *   (`"none"` disables); Baseten takes `chat_template_args.enable_thinking`.
 *   Both stream thinking as `reasoning_content` deltas, which the generic
 *   openai-completions transport parses natively.
 */

export const FACTORY_DROID_CLIENT_VERSION = "0.189.0";

/** Exact first sentence of the Droid CLI system prompt; the proxy prefix-gates on it. */
export const DROID_SYSTEM_PREFIX = "You are Droid, an AI software engineering agent built by Factory.";

export interface FactoryDroidOptions extends StreamOptions {
	/** Accepted for interface compatibility; the direct transport does not spawn processes. */
	cwd?: string;
	reasoning?: Effort;
	disableReasoning?: boolean;
	toolChoice?: ToolChoice;
	serviceTier?: ServiceTier;
}

type FactoryDroidUpstream = "fireworks" | "baseten";

/**
 * Upstream comes from the static registry, never from `model.headers`:
 * the shared model cache intentionally strips headers from persisted specs,
 * so header-carried routing would silently vanish on cached loads.
 */
function resolveUpstream(model: Model<"factory-droid-agent">): FactoryDroidUpstream {
	return FACTORY_DROID_UPSTREAMS[model.requestModelId ?? model.id] ?? "fireworks";
}

/**
 * Per-request reasoning off/on body extras for upstreams whose toggle is not
 * the OpenAI `reasoning_effort` field the generic transport already emits
 * when an effort is requested.
 */
function buildReasoningExtraBody(
	upstream: FactoryDroidUpstream,
	options: FactoryDroidOptions | undefined,
): Record<string, unknown> | undefined {
	if (options?.disableReasoning) {
		return upstream === "baseten" ? { chat_template_args: { enable_thinking: false } } : { reasoning_effort: "none" };
	}
	if (options?.reasoning !== undefined && upstream === "baseten") {
		return { chat_template_args: { enable_thinking: true } };
	}
	return undefined;
}

export const streamFactoryDroid: StreamFunction<"factory-droid-agent"> = (
	model: Model<"factory-droid-agent">,
	context: Context,
	options?: FactoryDroidOptions,
): AssistantMessageEventStream => {
	const stream = new AssistantMessageEventStream();

	(async () => {
		try {
			// Auth precedence: an OMP-stored WorkOS session from `/login factory-droid`
			// (resolved and refreshed by the harness, passed as apiKey) wins over the
			// local droid-file bridge. The kNoAuth sentinel ("N/A") means no stored
			// credential — fall through to the bridge.
			const harnessToken = options?.apiKey?.trim();
			const auth =
				harnessToken && harnessToken !== "N/A"
					? { accessToken: harnessToken, orgId: undefined }
					: await resolveFactoryDroidAuth();
			if (!auth) {
				throw new AIError.ConfigurationError(
					"No Factory Droid credentials found. Run `/login factory-droid` (browser device code), " +
						"sign in once with `droid auth login`, or set FACTORY_DROID_ACCESS_TOKEN.",
				);
			}

			const upstream = resolveUpstream(model);
			const extraBody = buildReasoningExtraBody(upstream, options);
			const openaiModel = buildModel({
				...model,
				api: "openai-completions",
				compat: {
					// Wire parity with the Droid CLI: the proxy's upstreams speak
					// `max_tokens` (not the OpenAI-era `max_completion_tokens`) and
					// have no `store` field.
					maxTokensField: "max_tokens",
					supportsStore: false,
					...(model.compatConfig ?? {}),
					...(extraBody ? { extraBody } : {}),
				},
			} as ModelSpec<"openai-completions">);

			const proxiedContext: Context = {
				...context,
				systemPrompt: [DROID_SYSTEM_PREFIX, ...(context.systemPrompt ?? [])],
			};

			// Header parity with the Droid CLI (Factory's requested integration
			// posture): factory-cli user agent, client markers, the X-Stainless
			// runtime fingerprint droid's OpenAI SDK emits, and the per-request
			// session/assistant-message ids the proxy uses for attribution. The
			// OMP session id maps to x-session-id.
			const requestId = crypto.randomUUID();
			const orgId = auth.orgId ?? factoryDroidOrgIdFromToken(auth.accessToken);
			const innerStream = streamOpenAICompletions(openaiModel, proxiedContext, {
				apiKey: auth.accessToken,
				temperature: options?.temperature ?? 1,
				topP: options?.topP,
				topK: options?.topK,
				minP: options?.minP,
				presencePenalty: options?.presencePenalty,
				repetitionPenalty: options?.repetitionPenalty,
				maxTokens: options?.maxTokens ?? model.maxTokens ?? undefined,
				signal: options?.signal,
				headers: {
					Accept: "application/json",
					"User-Agent": `factory-cli/${FACTORY_DROID_CLIENT_VERSION}`,
					"X-Client-Version": FACTORY_DROID_CLIENT_VERSION,
					"X-Factory-Client": "cli",
					"X-Stainless-Lang": "js",
					"X-Stainless-Package-Version": "6.25.0",
					"X-Stainless-Runtime": "node",
					"X-Stainless-Runtime-Version": process.version,
					"X-Stainless-Arch": process.arch,
					"X-Stainless-OS":
						process.platform === "darwin" ? "MacOS" : process.platform === "win32" ? "Windows" : "Linux",
					"X-Stainless-Retry-Count": "0",
					"x-api-provider": upstream,
					"x-session-id": options?.sessionId ?? requestId,
					"x-assistant-message-id": requestId,
					...(orgId ? { "X-Factory-Org-Id": orgId } : {}),
					...options?.headers,
				},
				cacheRetention: options?.cacheRetention,
				sessionId: options?.sessionId,
				promptCacheKey: options?.promptCacheKey,
				onPayload: options?.onPayload,
				onResponse: options?.onResponse,
				onSseEvent: options?.onSseEvent,
				fetch: options?.fetch,
				reasoning: options?.reasoning,
				toolChoice: options?.toolChoice,
				disableReasoning: options?.disableReasoning,
				serviceTier: options?.serviceTier,
			});

			for await (const event of innerStream) {
				stream.push(event);
			}
		} catch (error) {
			stream.push({
				type: "error",
				reason: "error",
				error: createProviderErrorMessage(model, error),
			});
		}
	})();

	return stream;
};
