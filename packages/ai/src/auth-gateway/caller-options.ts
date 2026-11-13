/**
 * How far the auth gateway trusts a caller with each {@link SimpleStreamOptions}
 * key:
 * - `client`: what is being asked of the model. Any caller may set it.
 * - `gateway`: who the request is from, who pays, or how the gateway talks to
 *   the provider. Only the unscoped gateway token may set it; a scoped client's
 *   value is dropped (see `clients.ts`).
 * - `server`: never accepted from the wire.
 */
import type { SimpleStreamOptions } from "../types";
import { captureRequestHeaders } from "./http";

type OptionTier = "client" | "gateway" | "server";

// Exhaustive: a new `SimpleStreamOptions` field is a compile error until classified.
const OPTION_TIERS = {
	temperature: "client",
	topP: "client",
	topK: "client",
	minP: "client",
	presencePenalty: "client",
	frequencyPenalty: "client",
	repetitionPenalty: "client",
	stopSequences: "client",
	maxTokens: "client",
	reasoning: "client",
	disableReasoning: "client",
	forceReasoningOff: "client",
	hideThinkingSummary: "client",
	thinkingBudgets: "client",
	toolChoice: "client",
	taskBudget: "client",
	include: "client",
	// The gateway builds Anthropic's top-level `compaction` parameter from it.
	anthropicCompaction: "client",
	anthropicPrefixMismatchBehavior: "client",
	sessionId: "client",
	promptCacheKey: "client",
	promptCache: "client",
	statefulResponses: "client",
	acceptEmptyResponse: "client",
	loopGuard: "client",

	// Attribution.
	headers: "gateway",
	userProfileId: "gateway",
	initiatorOverride: "gateway",
	metadata: "gateway",
	requestMetadata: "gateway",
	// Billing and data handling.
	serviceTier: "gateway",
	openrouterVariant: "gateway",
	codexAccessPrograms: "gateway",
	cacheRetention: "gateway",
	storeResponses: "gateway",
	cachedContent: "gateway",
	guardrailIdentifier: "gateway",
	guardrailVersion: "gateway",
	guardrailTrace: "gateway",
	// Transport.
	kimiApiFormat: "gateway",
	syntheticApiFormat: "gateway",
	preferWebsockets: "gateway",
	maxHttpAttempts: "gateway",
	maxRetryDelayMs: "gateway",
	streamFirstEventTimeoutMs: "gateway",
	streamIdleTimeoutMs: "gateway",

	signal: "server",
	apiKey: "server",
	credentialId: "server",
	oauthIdentity: "server",
	fetch: "server",
	cwd: "server",
	providerOptions: "server",
	providerSessionState: "server",
	providerRetryWait: "server",
	parentSessionId: "server",
	minimizeEffort: "server",
	liveSteering: "server",
	maxInFlightRequests: "server",
	beforeDispatch: "server",
	waitForTerminalDrain: "server",
	onPayload: "server",
	onResponse: "server",
	onSseEvent: "server",
	execHandlers: "server",
	cursorExecHandlers: "server",
	cursorOnToolResult: "server",
	cursorExternalToolExecutor: "server",
	codexCompaction: "server",
	codexSseMaxAttempts: "server",
	fallbackCreditRedemption: "server",
	anthropicSlowMode: "server",
	antigravityEndpointMode: "server",
	fallbacks: "server",
	disableServerSideFallback: "server",
	textVerbosity: "server",
} as const satisfies Record<keyof SimpleStreamOptions, OptionTier>;

const TIERED_KEYS = Object.entries(OPTION_TIERS) as [keyof SimpleStreamOptions, OptionTier][];

/** Option keys a gateway request may carry; the pi-native parser drops every other key. */
export const WIRE_OPTION_KEYS: ReadonlySet<string> = new Set(
	TIERED_KEYS.filter(([, tier]) => tier !== "server").map(([key]) => key),
);

const GATEWAY_ONLY_KEYS: readonly (keyof SimpleStreamOptions)[] = TIERED_KEYS.filter(
	([, tier]) => tier === "gateway",
).map(([key]) => key);

/**
 * Apply the caller's trust to the options a chat route sends upstream: a scoped
 * client loses every `gateway` option, and the unscoped gateway token gets the
 * allow-listed request headers merged under its own. Call it on the
 * upstream-bound options only; response encoders read the caller's parsed
 * request (the Anthropic encoder answers the caller's `anthropic-beta`).
 */
export function applyCallerTrust(opts: SimpleStreamOptions, req: Request, scoped: boolean): void {
	if (scoped) {
		for (const key of GATEWAY_ONLY_KEYS) delete opts[key];
		return;
	}
	opts.headers = { ...captureRequestHeaders(req.headers), ...opts.headers };
}
