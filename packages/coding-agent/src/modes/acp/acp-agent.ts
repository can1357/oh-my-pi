import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AgentBusyError, type AgentToolResult } from "@oh-my-pi/pi-agent-core";
import type { AssistantMessage, Model } from "@oh-my-pi/pi-ai";
import { getBlobsDir, isEnoent, logger, type postmortem, VERSION } from "@oh-my-pi/pi-utils";
import {
	type Agent,
	type AgentSideConnection,
	type AuthenticateRequest,
	type AuthenticateResponse,
	type AuthMethod,
	type AvailableCommand,
	type ClientCapabilities,
	type CloseSessionRequest,
	type CloseSessionResponse,
	type CreateElicitationResponse,
	type ElicitationContentValue,
	type ElicitationPropertySchema,
	type ForkSessionRequest,
	type ForkSessionResponse,
	type InitializeRequest,
	type InitializeResponse,
	type ListSessionsRequest,
	type ListSessionsResponse,
	type LoadSessionRequest,
	type LoadSessionResponse,
	type McpServer,
	type NewSessionRequest,
	type NewSessionResponse,
	PROTOCOL_VERSION,
	type PromptRequest,
	type PromptResponse,
	RequestError,
	type ResumeSessionRequest,
	type ResumeSessionResponse,
	type SessionConfigOption,
	type SessionInfo,
	type SessionModeState,
	type SessionNotification,
	type SessionUpdate,
	type SetSessionConfigOptionRequest,
	type SetSessionConfigOptionResponse,
	type SetSessionModeRequest,
	type SetSessionModeResponse,
	type ToolCallContent,
	type Usage,
} from "@oh-my-pi/pi-utils/acp";
import { disableProvider, enableProvider, reset as resetCapabilities } from "../../capability";
import { Settings } from "../../config/settings";
import { clearPluginRootsAndCaches, resolveActiveProjectRegistryPath } from "../../discovery/helpers";
import {
	type ExtensionUIContext,
	type ExtensionUIDialogOptions,
	getExtensionUISelectOptionLabel,
} from "../../extensibility/extensions";
import { runExtensionCompact } from "../../extensibility/extensions/compact-handler";
import { getSessionSlashCommands } from "../../extensibility/extensions/get-commands-handler";
import { buildSkillPromptMessage, parseSkillInvocation } from "../../extensibility/skills";
import { loadSlashCommands } from "../../extensibility/slash-commands";
import { resolveLocalUrlToPath } from "../../internal-urls";
import { MCPManager } from "../../mcp/manager";
import type { MCPServerConfig } from "../../mcp/types";
import { loadAllExtensions } from "../../modes/components/extensions/state-manager";
import { theme } from "../../modes/theme/theme";
import { normalizePlanTitle, type PlanApprovalDetails, resolveApprovedPlan } from "../../plan-mode/approved-plan";
import { hydrateReplayableToolExecution } from "../../presentation/hydrate";
import type { ReplayableToolExecution } from "../../presentation/journal";
import {
	type BashLikeResult,
	type EditResult,
	type EvalResult,
	parseLegacyToolResult,
	type ToolSource,
} from "../../presentation/known-tool-result";
import type { AgentSession, AgentSessionEvent } from "../../session/agent-session";
import { BlobStore, resolveImageDataSync } from "../../session/blob-store";
import { isSilentAbort, SKILL_PROMPT_MESSAGE_TYPE, USER_INTERRUPT_LABEL } from "../../session/messages";
import type { UsageStatistics } from "../../session/session-entries";
import type { SessionInfo as StoredSessionInfo } from "../../session/session-listing";
import { SessionManager } from "../../session/session-manager";
import {
	createReplayToolJournalCursor,
	nextReplayableToolExecution,
	ReplayToolCallBookkeeping,
	type ReplayToolJournalCursor,
} from "../../session/tool-journal-correlation";
import { executeAcpBuiltinSlashCommand } from "../../slash-commands/acp-builtins";
import { buildAvailableSlashCommands, toAcpAvailableCommands } from "../../slash-commands/available-commands";
import { DEFAULT_STT_MODEL_KEY, STT_MODEL_OPTIONS } from "../../stt/models";
import { refreshAgentDiscovery } from "../../task";
import { AUTO_THINKING, parseConfiguredThinkingLevel } from "../../thinking";
import { OTHER_OPTION } from "../../tools/ask";
import { formatOutputNotice } from "../../tools/output-meta";
import { normalizeLocalScheme, resolveToCwd } from "../../tools/path-utils";
import { ToolError } from "../../tools/tool-errors";
import {
	DEFAULT_TTS_LOCAL_MODEL_KEY,
	DEFAULT_TTS_VOICE,
	TTS_LOCAL_MODELS,
	TTS_LOCAL_VOICE_OPTIONS,
} from "../../tts/models";
import { canonicalizeMessage } from "../../utils/thinking-display";
import { createAcpClientBridge } from "./acp-client-bridge";
import {
	buildLegacyReplayTodoPlanUpdate,
	buildLegacyReplayToolCallStartUpdate,
	buildToolCallPresentation,
	extractAssistantMessageText,
	extractToolLocations,
	mapAgentSessionEventToAcpSessionUpdates,
	normalizeReplayToolArguments,
} from "./acp-event-mapper";
import { assertAcpUpdateInvariants } from "./acp-update-invariants";
import { formatLegacyOutputNotice } from "./legacy-output-meta";
import { ACP_TERMINAL_AUTH_FLAG } from "./terminal-auth";
import type {
	AcpRenderContext,
	AcpToolFrame,
	AcpToolViewState,
	AcpToolViewStep,
	CheckedToolNotification,
} from "./view";
import {
	AcpOutboundCoordinator,
	checkedNotificationPayload,
	encodeToolFrames,
	INITIAL_ACP_TOOL_VIEW,
	negotiateTerminalMetaCap,
	reduceAcpToolView,
} from "./view";
import { isLegacyBashToolName, LegacyBashPresentation, legacyBashStartedEvent } from "./view/legacy-bash";
import {
	isLegacyEditToolName,
	legacyEditFramesWithLocations,
	legacyEditSettlementEvents,
	legacyEditStartedEvent,
	legacyEditUpdateFrames,
} from "./view/legacy-edit";
import { LegacyEvalPresentation } from "./view/legacy-eval";

const ACP_DEFAULT_MODE_ID = "default";
const ACP_PLAN_MODE_ID = "plan";
const DEFAULT_PLAN_FILE_URL = "local://PLAN.md";
const APPROVE_OPTION = "Approve and execute";
const REFINE_OPTION = "Refine plan";
const MODE_CONFIG_ID = "mode";
const MODEL_CONFIG_ID = "model";
const THINKING_CONFIG_ID = "thinking";
const THINKING_OFF = "off";
const SESSION_PAGE_SIZE = 50;
const SPEECH_MODELS_LIST_METHOD = "speech.models.list";
/**
 * Delay between `session/new` (or `session/load` / `session/resume` /
 * `unstable_session/fork`) returning and the agent firing the first
 * notifications against the new session id. Mitigates Zed's
 * `Received session notification for unknown session` race — see
 * `#scheduleBootstrapUpdates`. Exported so the ACP test harness can
 * wait past this guard without hard-coding the literal.
 */
export const ACP_BOOTSTRAP_RACE_GUARD_MS = 50;
const ACP_CANCEL_CLEANUP_TIMEOUT_MS = 5_000;
const ACP_ASYNC_DELIVERY_DRAIN_TIMEOUT_MS = 250;
const ACP_ASYNC_DELIVERY_DRAIN_MAX_PASSES = 3;
// The final typed settlement must be delivered before a client terminal is
// released, but a peer that never answers terminal/release must not pin the
// shared outbound FIFO (and therefore prompt completion) forever.
const ACP_TERMINAL_RELEASE_GRACE_MS = 1_000;

type AgentImageContent = {
	type: "image";
	data: string;
	mimeType: string;
};

type PromptQueueState = {
	promise: Promise<void>;
	release: (() => void) | undefined;
};
type PromptLifecycleError = Error & { readonly code: "ACP_SESSION_CLOSED" };

type PromptTurnState = {
	cancelRequested: boolean;
	settled: boolean;
	/**
	 * Delivery of streamed assistant `error` chunks this turn (the mapper
	 * surfaces them as `agent_message_chunk`s). Resolves `true` once at least
	 * one error chunk reached the client — the `agent_end` error fallback in
	 * {@link AcpAgent##flushUnreportedTurnError} awaits it and stays silent on
	 * success, so a fallback racing an in-flight delivery can neither duplicate
	 * the error nor drop it when delivery fails.
	 */
	errorTextDelivery: Promise<boolean> | undefined;
	/**
	 * `abort()` is in-flight (or its bounded-timeout race). `undefined` while the turn is
	 * running normally and after cleanup completes. The turn occupies `record.promptTurn`
	 * for as long as either `!settled` or `cleanup` is set — that combined window is the
	 * "turn in flight" predicate (`isPromptTurnInFlight`) every consumer gates on.
	 */
	cleanup: Promise<void> | undefined;
	usageBaseline: UsageStatistics;
	unsubscribe: (() => void) | undefined;
	resolve: (value: PromptResponse) => void;
	reject: (reason?: unknown) => void;
	promise: Promise<PromptResponse>;
};

/**
 * A turn is "in flight" from the moment `prompt()` reserves the slot until `settled` is
 * true AND any cancel cleanup has completed. Fork/queue/event gating all depend on this
 * combined window — a settled-but-still-aborting turn is not safe to fork from, queue
 * onto, or forward late events for.
 */
function isPromptTurnInFlight(turn: PromptTurnState | undefined): turn is PromptTurnState {
	return turn !== undefined && (!turn.settled || turn.cleanup !== undefined);
}

/**
 * Whether an event still needs handling after the client cancelled.
 *
 * Cancellation resolves the ACP response immediately, but a tool call that already
 * announced itself must still be driven to its one `settled` event or its card and
 * its display-only terminal stay "running" forever. Ordinary assistant content is
 * filtered: continuing to stream prose into a cancelled turn is the behaviour the
 * cancel was asking to stop.
 */
function isCleanupRelevantEvent(event: AgentSessionEvent): boolean {
	switch (event.type) {
		case "tool_presentation":
		case "tool_execution_start":
		case "tool_execution_end":
			return true;
		default:
			return false;
	}
}

/**
 * Outbound ordering tag for a legacy-mapper write.
 *
 * The reserved permission slot for tool call T waits for T's **start batch** to
 * reach the writer and lets exactly that batch pass it. That prerequisite has to
 * be declared by every route, not only by the migrated presentation path: an
 * untagged legacy start is held behind the very slot that is waiting for it, so
 * both the dialog and the card it refers to appeared only after the bounded
 * barrier expired.
 *
 * `tool_execution_end` is the call's last write on this path, so it also releases
 * the call's ordering state — in FIFO position, after the end frame lands.
 */
function legacyOutboundTag(event: AgentSessionEvent): {
	readonly toolCallId?: string;
	readonly isStart?: boolean;
	readonly isFinal?: boolean;
} {
	switch (event.type) {
		case "tool_execution_start":
			return { toolCallId: event.toolCallId, isStart: true };
		case "tool_execution_update":
			return { toolCallId: event.toolCallId };
		case "tool_execution_end":
			return { toolCallId: event.toolCallId, isFinal: true };
		default:
			return {};
	}
}

type ManagedSessionRecord = {
	session: AgentSession;
	setToolUIContext: ((uiContext: ExtensionUIContext, hasUI: boolean) => void) | undefined;
	mcpManager: MCPManager | undefined;
	// Ordered queue of MCP tool refreshes for this record. Rebuilt per
	// `#configureMcpServers` call; drained on reconfigure so a stale in-flight
	// refresh can never land after a newer configuration's tools.
	mcpRefreshChain: Promise<void> | undefined;
	promptTurn: PromptTurnState | undefined;
	promptQueue: PromptQueueState;
	liveMessageId: string | undefined;
	liveMessageProgress: { textEmitted: boolean; thoughtEmitted: boolean } | undefined;
	toolArgsById: Map<string, unknown>;
	/**
	 * Per-session outbound coordinator: the FIFO that keeps a multi-frame reducer
	 * transition contiguous, poisons on a failed send, and owns the reserved
	 * permission slot. Shared with the ACP client bridge so a permission request
	 * joins the same ordering domain as the frames.
	 */
	outbound: AcpOutboundCoordinator;
	/** Reducer state per tool call on the `presentation_events` protocol. */
	toolViews: Map<string, AcpToolViewState>;
	/** Stateful typed conversion for built-in EvalTool proxy snapshots. */
	legacyEvalPresentations: Map<string, LegacyEvalPresentation>;
	/** Stateful typed conversion for built-in bash synthetic legacy snapshots. */
	legacyBashPresentations: Map<string, LegacyBashPresentation>;
	extensionsConfigured: boolean;
	// Installed inside `#scheduleBootstrapUpdates` (post-race-guard); released
	// in `#disposeSessionRecord`. Lives independent of any prompt turn.
	lifetimeUnsubscribe: (() => void) | undefined;
	closedError: PromptLifecycleError | undefined;
	promptEventHandlers: Set<Promise<void>>;
	extensionUserMessageTasks: Set<Promise<void>>;
	presentationSettlementDeliveries: Map<string, PromiseWithResolvers<void>>;
	/**
	 * Latched once the record's settlement deliveries were released (poisoned
	 * teardown or disposal). A running agent loop may still invoke a
	 * previously captured barrier callback AFTER the map was resolved and
	 * cleared; once released, {@link AcpAgent.#waitForPresentationSettlementDelivery}
	 * returns an already-resolved promise instead of parking a new waiter
	 * nothing can ever resolve.
	 */
	settlementDeliveriesReleased: boolean;
};

type ReplayableMessage = {
	role: string;
	content?: unknown;
	errorMessage?: string;
	toolCallId?: string;
	toolName?: string;
	details?: unknown;
	isError?: boolean;
};

type ReplayableToolItem = {
	type?: unknown;
	id?: unknown;
	name?: unknown;
	arguments?: unknown;
	input?: unknown;
};

/** Narrows a replayed assistant-message content item to a real tool call, on both the counting pass and the dispatch pass — one predicate so the two can never disagree about which items are tool calls. */
function isReplayableToolItem(item: ReplayableToolItem): item is ReplayableToolItem & { id: string; name: string } {
	return (
		(item.type === "toolCall" || item.type === "tool_use") &&
		typeof item.id === "string" &&
		typeof item.name === "string"
	);
}

/**
 * Count each `toolCallId`'s tool-call occurrences across a replayed
 * transcript, for {@link ReplayToolJournalCursor}'s totality gate. A provider
 * can recycle a `toolCallId` across turns; this and `startsByToolCallId`
 * (branch-side) must agree exactly before any occurrence of that id is safe to
 * hydrate — see that cursor's doc comment for why a short pairing cannot be
 * resolved instead of disqualified.
 */
function countReplayToolCallOccurrences(messages: readonly ReplayableMessage[]): Map<string, number> {
	const counts = new Map<string, number>();
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue;
		for (const item of message.content) {
			if (typeof item !== "object" || item === null || !("type" in item)) continue;
			const toolItem = item as ReplayableToolItem;
			if (!isReplayableToolItem(toolItem)) continue;
			counts.set(toolItem.id, (counts.get(toolItem.id) ?? 0) + 1);
		}
	}
	return counts;
}

/**
 * One notification the chronological replay walk produced, tagged so
 * `#replaySessionHistory` can route a hydrated tool frame through the
 * `CheckedToolNotification` chokepoint (`#sendToolUpdate`) while every other
 * replay notification keeps going through the general `#sendUpdate` path.
 */
type AcpReplayUpdate = SessionNotification | { readonly checked: CheckedToolNotification };

/**
 * Threaded state for one `#replaySessionHistory` walk over
 * `SessionContext.messages`.
 */
interface AcpReplayWalk {
	readonly sessionId: string;
	readonly cwd: string;
	readonly renderContext: AcpRenderContext;
	readonly journal: ReplayToolJournalCursor;
	/**
	 * Pre-v4 legacy lifecycle bookkeeping: ids the walk has already dispatched
	 * at their assistant-turn occurrence (hydrated *or* legacy-announced), ids
	 * actually announced on the *legacy* path (hydrated ids excluded — they
	 * carry their own reducer-owned settlement), and ids that reached a
	 * resolution during replay. See {@link ReplayToolCallBookkeeping}.
	 */
	readonly bookkeeping: ReplayToolCallBookkeeping;
}

type LegacyReplayBodyBlock = {
	type?: unknown;
	text?: unknown;
	data?: unknown;
	mimeType?: unknown;
};

type MCPConfigMap = {
	[name: string]: MCPServerConfig;
};

type MCPSource = {
	provider: string;
	providerName: string;
	path: string;
	level: "project";
};

type MCPSourceMap = {
	[name: string]: MCPSource;
};

type AcpSessionHandle = {
	session: AgentSession;
	setToolUIContext: (uiContext: ExtensionUIContext, hasUI: boolean) => void;
};

type CreateAcpSession = (
	cwd: string,
	options?: { interactivePrompts?: boolean },
) => Promise<AgentSession | AcpSessionHandle>;

function normalizeCreatedAcpSession(created: AgentSession | AcpSessionHandle): {
	session: AgentSession;
	setToolUIContext: AcpSessionHandle["setToolUIContext"] | undefined;
} {
	return "session" in created ? created : { session: created, setToolUIContext: undefined };
}

type AcpSpeechOption = {
	value: string;
	label: string;
	description?: string;
};

type AcpSpeechVoiceOption = {
	value: string;
	label: string;
};

type AcpSpeechTtsModelOption = AcpSpeechOption & {
	voices: AcpSpeechVoiceOption[];
};

function buildAcpSpeechModelsCatalog(): Record<string, unknown> {
	const voices = TTS_LOCAL_VOICE_OPTIONS.map(({ value, label }) => ({ value, label }));
	return {
		settings: {
			speechToTextModel: "stt.modelName",
			textToSpeechModel: "tts.localModel",
			textToSpeechVoice: "tts.localVoice",
			speechVoice: "speech.voice",
		},
		defaults: {
			speechToTextModel: DEFAULT_STT_MODEL_KEY,
			textToSpeechModel: DEFAULT_TTS_LOCAL_MODEL_KEY,
			voice: DEFAULT_TTS_VOICE,
		},
		speechToText: {
			setting: "stt.modelName",
			defaultValue: DEFAULT_STT_MODEL_KEY,
			models: STT_MODEL_OPTIONS.map(({ value, label, description }) => ({ value, label, description })),
		},
		textToSpeech: {
			modelSetting: "tts.localModel",
			voiceSetting: "tts.localVoice",
			speechVoiceSetting: "speech.voice",
			defaultModel: DEFAULT_TTS_LOCAL_MODEL_KEY,
			defaultVoice: DEFAULT_TTS_VOICE,
			models: TTS_LOCAL_MODELS.map(
				({ key, label, description, voices: modelVoices }): AcpSpeechTtsModelOption => ({
					value: key,
					label,
					description,
					voices: modelVoices.map(({ id, label: voiceLabel }) => ({ value: id, label: voiceLabel })),
				}),
			),
			voices,
		},
	};
}

/**
 * Bridge an ExtensionUIContext form to ACP `unstable_createElicitation`.
 *
 * `dialogOptions.signal` short-circuits the elicitation if it is already
 * aborted and races the in-flight request against the abort event. The SDK
 * exposes no `cancel_elicitation` surface for form-mode elicitations
 * (`unstable_completeElicitation` is URL-mode only), so the ACP request itself
 * keeps running on the client side until the user dismisses it — but
 * resolving the local promise unblocks the caller (matches the RPC mode
 * pattern in `requestRpcEditor`). The abort listener is removed once the
 * elicitation settles so that callers which reuse the same signal across many
 * elicitations don't accumulate listeners and trip Node's `MaxListeners`
 * warning.
 *
 * `dialogOptions.timeout` mirrors `RpcExtensionUIContext.#createDialogPromise`:
 * when the timer fires before the client responds, `onTimeout` is invoked and
 * the caller's promise resolves to the stub fallback. Late SDK responses that
 * arrive after abort/timeout — both rejections and successful `accept`s —
 * are dropped silently (no `logger.warn`) to keep operator logs clean.
 */
async function elicitFormFromAcpClient(
	connection: AgentSideConnection,
	sessionId: string,
	method: string,
	message: string,
	properties: Record<string, ElicitationPropertySchema>,
	required: string[] | undefined,
	dialogOptions: ExtensionUIDialogOptions | undefined,
): Promise<Record<string, ElicitationContentValue> | undefined> {
	const signal = dialogOptions?.signal;
	if (signal?.aborted) {
		return undefined;
	}
	const { promise, resolve } = Promise.withResolvers<CreateElicitationResponse | undefined>();
	let settled = false;
	let timeoutId: NodeJS.Timeout | undefined;
	const finish = (value: CreateElicitationResponse | undefined) => {
		if (settled) return;
		settled = true;
		clearTimeout(timeoutId);
		signal?.removeEventListener("abort", onAbort);
		resolve(value);
	};
	const onAbort = () => finish(undefined);
	signal?.addEventListener("abort", onAbort, { once: true });
	if (dialogOptions?.timeout !== undefined) {
		timeoutId = setTimeout(() => {
			if (settled) return;
			try {
				dialogOptions.onTimeout?.();
			} catch (error) {
				// A throwing `onTimeout` must not leave the elicitation promise
				// pending — settle it via `finish` below regardless.
				logger.warn("ACP elicitation onTimeout threw", { sessionId, method, error });
			}
			finish(undefined);
		}, dialogOptions.timeout);
		// A long pending timeout alone shouldn't keep the event loop alive when
		// the rest of the agent has shut down — matches `job-manager.ts` /
		// `executor.ts` timer hygiene. Connection + session lifetimes keep the
		// loop alive on the happy path.
		timeoutId.unref();
	}
	connection
		.unstable_createElicitation({
			mode: "form",
			sessionId,
			message,
			requestedSchema: {
				type: "object",
				properties,
				required,
			},
		})
		.then(finish, error => {
			// Caller may already have moved on via abort/timeout; suppress noise.
			if (settled) return;
			logger.warn("ACP elicitation failed", { sessionId, method, error });
			finish(undefined);
		});
	const response = await promise;
	if (!isAcceptedElicitation(response) || !response.content) {
		return undefined;
	}
	return response.content;
}

async function elicitFromAcpClient(
	connection: AgentSideConnection,
	sessionId: string,
	method: "select" | "confirm" | "input" | "editor",
	message: string,
	property: ElicitationPropertySchema,
	dialogOptions: ExtensionUIDialogOptions | undefined,
): Promise<ElicitationContentValue | undefined> {
	const content = await elicitFormFromAcpClient(
		connection,
		sessionId,
		method,
		message,
		{ value: property },
		["value"],
		dialogOptions,
	);
	return content?.value;
}

/** Narrows a `CreateElicitationResponse` to the accepted-with-content branch; the SDK's `action: string` catch-all arm otherwise defeats literal narrowing on `action !== "accept"`. */
function isAcceptedElicitation(
	response: CreateElicitationResponse | undefined,
): response is Extract<CreateElicitationResponse, { action: "accept" }> {
	return response?.action === "accept";
}

/**
 * Build an {@link ExtensionUIContext} that translates skill/extension UI
 * requests into ACP elicitations against `connection` for the session
 * returned by `getSessionId()`. The id is read lazily at each elicitation
 * because `AgentSession.sessionId` is a getter over `sessionManager` state
 * that mutates when an extension command calls `ctx.newSession` /
 * `ctx.switchSession` — snapshotting it once at factory time would route
 * later elicitations to the pre-switch id. Live reads keep the bridge
 * symmetric with every other `sessionUpdate` call in this file
 * (`record.session.sessionId` is always evaluated at emit time).
 *
 * The non-elicitation surface (custom components, theming, terminal
 * input) remains stubbed — ACP clients render those themselves or not
 * at all. Capability gating respects the client's `initialize`
 * advertisement.
 */
export function createAcpExtensionUiContext(
	connection: AgentSideConnection,
	getSessionId: () => string,
	clientCapabilities: ClientCapabilities | undefined,
): ExtensionUIContext {
	const supportsForm = clientCapabilities?.elicitation?.form != null;
	return {
		select: async (title, options, dialogOptions) => {
			if (!supportsForm) return undefined;
			const value = await elicitFromAcpClient(
				connection,
				getSessionId(),
				"select",
				title,
				{ type: "string", enum: options.map(getExtensionUISelectOptionLabel) },
				dialogOptions,
			);
			return typeof value === "string" ? value : undefined;
		},
		confirm: async (title, message, dialogOptions) => {
			if (!supportsForm) return false;
			const value = await elicitFromAcpClient(
				connection,
				getSessionId(),
				"confirm",
				message.trim().length > 0 ? `${title}\n\n${message}` : title,
				{ type: "boolean" },
				dialogOptions,
			);
			return typeof value === "boolean" ? value : false;
		},
		input: async (title, placeholder, dialogOptions) => {
			if (!supportsForm) return undefined;
			const value = await elicitFromAcpClient(
				connection,
				getSessionId(),
				"input",
				title,
				// ACP's `StringPropertySchema` has no `placeholder` field, so we
				// surface the placeholder text as `description` — the closest
				// semantic field a client can render alongside the input.
				// Empty / whitespace-only placeholders are treated as absent.
				{ type: "string", ...(placeholder?.trim() ? { description: placeholder } : {}) },
				dialogOptions,
			);
			return typeof value === "string" ? value : undefined;
		},
		askDialog: async (questions, dialogOptions) => {
			if (!supportsForm) return undefined;
			const properties: Record<string, ElicitationPropertySchema> = {};
			for (const [index, question] of questions.entries()) {
				const key = `q${index}`;
				const entries = question.options.map(option => ({
					const: option.label,
					title: option.label,
					...(option.description?.trim() ? { description: option.description.trim() } : {}),
				}));
				const description = question.header?.trim();
				if (entries.length > 0) {
					if (question.multi === true) {
						properties[key] = {
							type: "array",
							title: question.question,
							...(description ? { description } : {}),
							items: { anyOf: entries },
						};
					} else {
						const recommended = question.recommended;
						properties[key] = {
							type: "string",
							title: question.question,
							...(description ? { description } : {}),
							oneOf: entries,
							...(recommended !== undefined && recommended >= 0 && recommended < question.options.length
								? { default: question.options[recommended].label }
								: {}),
						};
					}
				}
				properties[`${key}__other`] = { type: "string", title: OTHER_OPTION };
			}

			let timedOut = false;
			const content = await elicitFormFromAcpClient(
				connection,
				getSessionId(),
				"askDialog",
				questions.length === 1 ? questions[0].question : `Answer ${questions.length} questions`,
				properties,
				undefined,
				{
					...dialogOptions,
					onTimeout: () => {
						timedOut = true;
						dialogOptions?.onTimeout?.();
					},
				},
			);
			if (timedOut) {
				return {
					kind: "submit",
					results: questions.map(question => {
						const labels = question.options.map(option => option.label);
						const fallbackIndex = Math.min(
							Math.max(question.recommended ?? 0, 0),
							Math.max(labels.length - 1, 0),
						);
						const fallback = labels[fallbackIndex];
						return {
							id: question.id,
							question: question.question,
							options: labels,
							multi: question.multi ?? false,
							selectedOptions: fallback === undefined ? [] : [fallback],
							customInput: undefined,
							timedOut: true,
						};
					}),
				};
			}
			if (!content) return undefined;

			return {
				kind: "submit",
				results: questions.map((question, index) => {
					const key = `q${index}`;
					const otherKey = `${key}__other`;
					const labels = question.options.map(option => option.label);
					const otherValue = content[otherKey];
					const customInput = typeof otherValue === "string" && otherValue.trim() ? otherValue.trim() : undefined;
					const value = content[key];
					const selectedOptions =
						question.multi === true
							? Array.isArray(value)
								? value.filter(candidate => typeof candidate === "string" && labels.includes(candidate))
								: []
							: customInput === undefined && typeof value === "string" && labels.includes(value)
								? [value]
								: [];
					return {
						id: question.id,
						question: question.question,
						options: labels,
						multi: question.multi ?? false,
						selectedOptions,
						customInput,
					};
				}),
			};
		},
		notify: (message, type) => {
			logger.debug("ACP extension notification", { message, type });
		},
		onTerminalInput: () => () => {},
		setStatus: () => {},
		setWorkingMessage: () => {},
		setWidget: () => {},
		setFooter: () => {},
		setHeader: () => {},
		setTitle: () => {},
		custom: async () => undefined as never,
		pasteToEditor: () => {},
		setEditorText: () => {},
		getEditorText: () => "",
		editor: async (title, prefill, dialogOptions) => {
			if (!supportsForm) return undefined;
			const value = await elicitFromAcpClient(
				connection,
				getSessionId(),
				"editor",
				title,
				{ type: "string", ...(prefill ? { default: prefill } : {}) },
				dialogOptions,
			);
			return typeof value === "string" ? value : undefined;
		},
		addAutocompleteProvider: () => {},
		setEditorComponent: () => {},
		get theme() {
			return theme;
		},
		getAllThemes: async () => [],
		getTheme: async () => undefined,
		setTheme: async () => ({ success: false, error: "Theme changes are unavailable in ACP mode" }),
		getToolsExpanded: () => false,
		setToolsExpanded: () => {},
	};
}

export class AcpAgent implements Agent {
	#connection: AgentSideConnection;
	#initialSession: AgentSession | undefined;
	#createSession: CreateAcpSession;
	#sessions = new Map<string, ManagedSessionRecord>();
	#disposePromise: Promise<void> | undefined;
	#cleanupRegistered = false;
	#clientCapabilities: ClientCapabilities | undefined;
	#cancelCleanupTimeoutMs = ACP_CANCEL_CLEANUP_TIMEOUT_MS;
	#blobs = new BlobStore(getBlobsDir());

	constructor(connection: AgentSideConnection, createSession: CreateAcpSession, initialSession?: AgentSession) {
		this.#connection = connection;
		this.#initialSession = initialSession;
		this.#createSession = createSession;
	}

	/**
	 * Whether the connected client advertised the display-only terminal
	 * `_meta` convention (see `wantsMetaTerminal` in acp-event-mapper.ts) at
	 * `initialize`. Shared by every live/replay event-mapping call site so
	 * eval/replayed-command output can render as a rich terminal block
	 * instead of falling back to fenced text.
	 */
	#terminalMetaCapable(): boolean {
		return this.#clientCapabilities?._meta?.terminal_output === true;
	}

	/**
	 * Single emit chokepoint for every outbound `session/update` — checks the
	 * finished frame against `checkAcpUpdateInvariants` (a terminal content item
	 * must be the update's only content item; an `_meta.terminal_*` key requires
	 * the negotiated capability; a completed status must not sit above a nonzero
	 * exit code) before forwarding it unchanged. See
	 * `acp-update-invariants.ts` for why this
	 * needs to run on the assembled frame rather than at each builder: a
	 * violation is often only visible after content arrays from different
	 * builders are merged. Returns the connection's promise directly (not
	 * `async`) so callers that need the delivery promise itself (see the
	 * `agent_message_chunk` streaming path) keep the same timing.
	 */
	#sendUpdate(notification: SessionNotification): Promise<void> {
		assertAcpUpdateInvariants(notification, { terminalMetaCapable: this.#terminalMetaCapable() });
		return this.#connection.sessionUpdate(notification);
	}

	/**
	 * The **tool** notification chokepoint: accepts only a {@link CheckedToolNotification},
	 * which the frame encoder alone can mint. A hand-rolled tool `SessionUpdate`
	 * cannot reach the wire through this path.
	 *
	 * Deliberately separate from {@link AcpAgent.#sendUpdate}: assistant/thought
	 * chunks, plans, configuration, session info and usage are not tool frames and
	 * the tool encoder cannot construct them (see the 2026-08-03 plan amendment).
	 * The runtime invariant check still runs, as the tripwire it now is rather than
	 * the primary defence.
	 */
	#sendToolUpdate(checked: CheckedToolNotification): Promise<void> {
		return this.#sendUpdate(checkedNotificationPayload(checked));
	}

	/**
	 * Build the per-session outbound coordinator.
	 *
	 * A failed send poisons it, and poisoning is terminal for the whole managed
	 * session — see {@link AcpAgent.#terminateSessionOnOutboundFailure}. A
	 * caught-and-logged send failure that lets `agent_end` still report success is
	 * precisely the "errors never surface" class this replaces.
	 */
	#createOutboundCoordinator(session: AgentSession): AcpOutboundCoordinator {
		return new AcpOutboundCoordinator({
			onPoison: error => {
				this.#terminateSessionOnOutboundFailure(session.sessionId, error);
			},
		});
	}

	/**
	 * The single terminal owner of a poisoned outbound queue.
	 *
	 * The coordinator invokes this exactly once (its own `#poisonNotified` latch), and
	 * everything a poisoned session needs happens here rather than being hand-rolled
	 * at the callback: the earlier version rejected the prompt in place, which left
	 * the subscription installed, left the prompt slot occupied, and — worst — left
	 * the record in `#sessions` holding a permanently poisoned coordinator, so the
	 * next `prompt()` on that session subscribed again, received duplicate events,
	 * and had every single frame rejected without a wire attempt.
	 *
	 * Order is deliberate: the record becomes unreachable *synchronously*, before any
	 * await, so a prompt racing this teardown cannot pick up the dead coordinator.
	 */
	#terminateSessionOnOutboundFailure(sessionId: string, error: unknown): void {
		const record = this.#sessions.get(sessionId);
		if (record === undefined) return;
		logger.warn("ACP outbound queue poisoned; closing the session", { sessionId, error });
		record.closedError ??= this.#createPromptLifecycleError("ACP session closed after an outbound write failure");
		this.#sessions.delete(sessionId);

		// One terminal settlement of the prompt. `#finishPrompt` is a no-op once the
		// response has been resolved (a cancel already in flight, say), which is what
		// makes "reject exactly once" hold rather than depending on this callback
		// running once.
		const promptTurn = record.promptTurn;
		this.#finishPrompt(record, undefined, error);
		if (promptTurn !== undefined) {
			// Unconditional, unlike `#finishPrompt`'s cancel-aware branch: cleanup
			// delivery is impossible on a dead connection, so there is nothing left for
			// the subscription to carry. `unsubscribe` is cleared, so this is once.
			promptTurn.unsubscribe?.();
			promptTurn.unsubscribe = undefined;
			promptTurn.cleanup = undefined;
			if (record.promptTurn === promptTurn) record.promptTurn = undefined;
		}

		// No later writes: drop the reducer state (a half-delivered view is not
		// resumable) and release any tool fenced behind an unanswered dialog.
		record.toolViews.clear();
		record.outbound.rejectPendingPermissions(error);
		// The prompt subscription is gone, so nothing can ever deliver a settled
		// frame or resolve a settlement-delivery barrier again. Unhook the
		// barrier and release every waiter BEFORE the abort below settles the
		// running tools: the agent loop awaits this barrier after emitting
		// `settled`, and #disposeSessionRecord — the only other place that
		// clears it — runs after the abort completes, so leaving it installed
		// deadlocks the whole teardown (abort waits on the loop, the loop waits
		// on a barrier nobody can resolve, disposal never runs).
		record.session.setPresentationSettlementDeliveryBarrier?.(undefined);
		record.settlementDeliveriesReleased = true;
		for (const delivery of record.presentationSettlementDeliveries.values()) delivery.resolve();
		record.presentationSettlementDeliveries.clear();
		void this.#tearDownPoisonedSession(record, error);
	}

	async #tearDownPoisonedSession(record: ManagedSessionRecord, error: unknown): Promise<void> {
		try {
			await record.session.abort({ reason: "ACP connection write failed" });
		} catch (abortError) {
			logger.warn("Failed to abort ACP session after an outbound write failure", { error: abortError });
		}
		// The record is already out of `#sessions`, so `AcpAgent#dispose` will never see
		// it again: disposing here is what keeps the eviction from leaking the session's
		// lifetime subscription and MCP connections.
		await this.#disposeSessionRecord(record);
		logger.warn("ACP session torn down after an outbound write failure", {
			sessionId: record.session.sessionId,
			error,
		});
	}

	setCancelCleanupTimeoutForTesting(timeoutMs: number): void {
		this.#cancelCleanupTimeoutMs = Math.max(1, timeoutMs);
	}

	async initialize(params: InitializeRequest): Promise<InitializeResponse> {
		this.#registerConnectionCleanup();
		this.#clientCapabilities = params.clientCapabilities;
		const authMethods: AuthMethod[] = [
			{
				id: "agent",
				name: "Use existing local credentials",
				description: "Authenticate via the provider keys/OAuth state already configured under ~/.omp.",
			},
		];
		if (params.clientCapabilities?.auth?.terminal === true) {
			authMethods.push({
				type: "terminal",
				id: "terminal",
				name: "Set up Oh My Pi in terminal",
				description: "Launch the omp TUI to add provider keys and select models.",
				args: [ACP_TERMINAL_AUTH_FLAG],
			});
		}
		return {
			protocolVersion: PROTOCOL_VERSION,
			agentInfo: {
				name: "oh-my-pi",
				title: "Oh My Pi",
				version: VERSION,
			},
			authMethods,
			agentCapabilities: {
				loadSession: true,
				mcpCapabilities: {
					http: true,
					sse: true,
				},
				promptCapabilities: {
					embeddedContext: true,
					image: true,
				},
				sessionCapabilities: {
					list: {},
					fork: {},
					resume: {},
					close: {},
				},
			},
		};
	}

	async authenticate(params: AuthenticateRequest): Promise<AuthenticateResponse> {
		// ACP spec: `methodId` must be one of the methods advertised by `initialize`.
		// Reject anything else so malformed clients fail fast rather than appearing
		// authenticated and surfacing a downstream model failure later.
		const supportsTerminalAuth = this.#clientCapabilities?.auth?.terminal === true;
		const validMethods = supportsTerminalAuth ? ["agent", "terminal"] : ["agent"];
		if (!validMethods.includes(params.methodId)) {
			throw new Error(`Unknown ACP auth method: ${params.methodId}`);
		}
		return {};
	}

	async newSession(params: NewSessionRequest): Promise<NewSessionResponse> {
		this.#assertAbsoluteCwd(params.cwd);
		const record = await this.#createNewSessionRecord(params.cwd, params.mcpServers);
		const response: NewSessionResponse = {
			sessionId: record.session.sessionId,
			configOptions: this.#buildConfigOptions(record.session),
			modes: this.#buildModeState(record.session),
		};
		this.#scheduleBootstrapUpdates(record.session.sessionId);
		return response;
	}

	async loadSession(params: LoadSessionRequest): Promise<LoadSessionResponse> {
		this.#assertAbsoluteCwd(params.cwd);
		const record = await this.#loadManagedSession(params.sessionId, params.cwd, params.mcpServers);
		await this.#replaySessionHistory(record);
		const response: LoadSessionResponse = {
			configOptions: this.#buildConfigOptions(record.session),
			modes: this.#buildModeState(record.session),
		};
		this.#scheduleBootstrapUpdates(record.session.sessionId);
		return response;
	}

	async listSessions(params: ListSessionsRequest): Promise<ListSessionsResponse> {
		if (params.cwd) {
			this.#assertAbsoluteCwd(params.cwd);
		}
		for (const record of this.#sessions.values()) {
			await record.session.sessionManager.flush();
		}
		const sessions = await this.#listStoredSessions(params.cwd ?? undefined);
		const offset = this.#parseCursor(params.cursor ?? undefined);
		const paged = sessions.slice(offset, offset + SESSION_PAGE_SIZE);
		const nextOffset = offset + paged.length;
		return {
			sessions: paged.map(session => this.#toSessionInfo(session)),
			nextCursor: nextOffset < sessions.length ? String(nextOffset) : undefined,
		};
	}

	async resumeSession(params: ResumeSessionRequest): Promise<ResumeSessionResponse> {
		this.#assertAbsoluteCwd(params.cwd);
		const record = await this.#resumeManagedSession(params.sessionId, params.cwd, params.mcpServers ?? []);
		const response: ResumeSessionResponse = {
			configOptions: this.#buildConfigOptions(record.session),
			modes: this.#buildModeState(record.session),
		};
		this.#scheduleBootstrapUpdates(record.session.sessionId);
		return response;
	}

	async unstable_forkSession(params: ForkSessionRequest): Promise<ForkSessionResponse> {
		this.#assertAbsoluteCwd(params.cwd);
		const record = await this.#forkManagedSession(params);
		const response: ForkSessionResponse = {
			sessionId: record.session.sessionId,
			configOptions: this.#buildConfigOptions(record.session),
			modes: this.#buildModeState(record.session),
		};
		// A fork carries the source session's entire conversation, and the client
		// has never seen any of it under this brand-new id, so it gets the same
		// history replay `loadSession` performs — deferred past the response, for
		// the reasons in `#replayForkedSessionHistory`. Parking the replay on the
		// prompt queue keeps a client that prompts the instant it reads
		// `sessionId` from interleaving a live turn into the replayed transcript.
		record.promptQueue = { promise: this.#replayForkedSessionHistory(record), release: undefined };
		this.#scheduleBootstrapUpdates(record.session.sessionId);
		return response;
	}

	async closeSession(params: CloseSessionRequest): Promise<CloseSessionResponse> {
		const record = this.#sessions.get(params.sessionId);
		if (!record) {
			return {};
		}
		await this.#closeManagedSession(params.sessionId, record);
		return {};
	}

	async setSessionMode(params: SetSessionModeRequest): Promise<SetSessionModeResponse> {
		const record = this.#getSessionRecord(params.sessionId);
		this.#applyModeChange(record.session, params.modeId);
		await this.#sendUpdate({
			sessionId: record.session.sessionId,
			update: this.#buildCurrentModeUpdate(record.session),
		});
		await this.#pushConfigOptionUpdate(record);
		return {};
	}

	async setSessionConfigOption(params: SetSessionConfigOptionRequest): Promise<SetSessionConfigOptionResponse> {
		const record = this.#getSessionRecord(params.sessionId);
		if (typeof params.value === "boolean") {
			throw new Error(`Unsupported boolean ACP config option: ${params.configId}`);
		}

		switch (params.configId) {
			case MODE_CONFIG_ID:
				this.#applyModeChange(record.session, params.value);
				break;
			case MODEL_CONFIG_ID:
				await this.#setModelById(record.session, params.value);
				break;
			case THINKING_CONFIG_ID:
				this.#setThinkingLevelById(record.session, params.value);
				break;
			default:
				throw new Error(`Unknown ACP config option: ${params.configId}`);
		}

		// When mode is changed via the generic config-option API, mirror the
		// `current_mode_update` notification that `setSessionMode` emits so
		// ACP clients tracking session-mode state see a consistent transition.
		if (params.configId === MODE_CONFIG_ID) {
			await this.#sendUpdate({
				sessionId: record.session.sessionId,
				update: this.#buildCurrentModeUpdate(record.session),
			});
		}

		// For `model`/`thinking`, `#setModelById`/`#setThinkingLevelById` change
		// the session model/thinking level through AgentSession, which now emits
		// a lifetime event (`model_changed`/`thinking_level_changed`) that
		// `#handleLifetimeEvent` turns into a push once the subscription is
		// installed. Only push here when that subscription is not yet
		// installed, so pre-bootstrap callers still see the change without a
		// post-bootstrap duplicate.
		const handledBySubscription =
			(params.configId === THINKING_CONFIG_ID || params.configId === MODEL_CONFIG_ID) &&
			record.lifetimeUnsubscribe !== undefined;
		if (!handledBySubscription) {
			await this.#pushConfigOptionUpdate(record);
		}
		return { configOptions: this.#buildConfigOptions(record.session) };
	}

	async prompt(params: PromptRequest): Promise<PromptResponse> {
		const record = this.#getSessionRecord(params.sessionId);
		const activeTurn = record.promptTurn;
		if (activeTurn && !activeTurn.settled && record.session.isStreaming) {
			// New prompt arrived while the previous turn is still in-flight (e.g. the
			// client sent a message immediately after pressing stop, before or without
			// a preceding session/cancel notification). Implicitly cancel the running
			// turn so the new prompt can queue behind the abort cleanup — identical to
			// what cancel() does when called explicitly. #beginCancelCleanup is
			// idempotent, so a concurrent session/cancel notification is harmless.
			// Mirror cancel()'s timeout handling: if abort() hangs past the cleanup
			// timeout, close the managed session instead of leaving it registered
			// with a still-streaming AgentSession. The queued prompt below observes
			// the same cleanup rejection and fails accordingly.
			this.#beginCancelCleanup(record, activeTurn).catch(async (error: unknown) => {
				logger.warn("ACP cancel cleanup timed out; closing session", {
					sessionId: record.session.sessionId,
					error,
				});
				await this.#closeManagedSession(params.sessionId, record);
			});
		}
		return await this.#queuePrompt(record, async () => {
			const previousTurn = record.promptTurn;
			if (previousTurn) {
				// Wait for any prompt that's still settling or whose cancel cleanup is
				// still in flight. We deliberately swallow the prompt rejection (the
				// owning caller already received it) but let cleanup rejections
				// propagate — a timed-out cancel must fail this queued prompt instead
				// of letting it run on a session that is about to be closed.
				await previousTurn.promise.catch(() => undefined);
				await previousTurn.cleanup;
			}
			this.#throwIfRecordClosed(record);

			const converted = this.#convertPromptBlocks(params.prompt);
			const pendingPrompt = Promise.withResolvers<PromptResponse>();
			record.promptTurn = {
				cancelRequested: false,
				settled: false,
				errorTextDelivery: undefined,
				cleanup: undefined,
				usageBaseline: this.#cloneUsageStatistics(record.session.sessionManager.getUsageStatistics()),
				unsubscribe: undefined,
				resolve: pendingPrompt.resolve,
				reject: pendingPrompt.reject,
				promise: pendingPrompt.promise,
			};

			record.promptTurn.unsubscribe = record.session.subscribe(event => {
				this.#trackPromptEvent(record, event);
			});

			// Autonomous turns stream without an owning promptTurn, so the implicit-cancel
			// guard above cannot fire and a client prompt lands on AgentSession's busy
			// guard. Type that failure for the wire instead of letting transport.ts wrap
			// it as a generic -32603 internal error.
			this.#runPromptOrCommand(record, converted.text, converted.images).catch((error: unknown) => {
				this.#finishPrompt(
					record,
					undefined,
					error instanceof AgentBusyError
						? RequestError.sessionBusy(error.message, {
								reason: "session_busy",
								hint: "steer|followUp|wait",
							})
						: error,
				);
			});

			return await pendingPrompt.promise;
		});
	}

	async #queuePrompt(record: ManagedSessionRecord, run: () => Promise<PromptResponse>): Promise<PromptResponse> {
		const nextQueue = Promise.withResolvers<void>();
		const releaseQueue = nextQueue.resolve;
		const previousQueue = record.promptQueue;
		record.promptQueue = {
			promise: nextQueue.promise,
			release: releaseQueue,
		};
		await previousQueue.promise;
		this.#throwIfRecordClosed(record);
		try {
			return await run();
		} finally {
			releaseQueue();
			if (record.promptQueue.release === releaseQueue) {
				record.promptQueue.release = undefined;
			}
		}
	}

	#throwIfRecordClosed(record: ManagedSessionRecord): void {
		if (record.closedError) {
			throw record.closedError;
		}
	}

	#createPromptLifecycleError(message: string): PromptLifecycleError {
		return Object.assign(new Error(message), { code: "ACP_SESSION_CLOSED" as const });
	}

	#trackPromptEvent(record: ManagedSessionRecord, event: AgentSessionEvent): void {
		const handling = this.#handlePromptEvent(record, event).catch((error: unknown) => {
			logger.warn("ACP prompt event handler failed", { error });
		});
		record.promptEventHandlers.add(handling);
		void handling.finally(() => {
			record.promptEventHandlers.delete(handling);
		});
	}

	async #waitForPromptEventHandlers(record: ManagedSessionRecord): Promise<void> {
		while (record.promptEventHandlers.size > 0) {
			await Promise.allSettled(Array.from(record.promptEventHandlers));
		}
	}

	#trackExtensionUserMessage(record: ManagedSessionRecord, task: Promise<void>): void {
		const tracked = task.catch((error: unknown) => {
			logger.warn("ACP extension sendUserMessage failed", { error });
		});
		record.extensionUserMessageTasks.add(tracked);
		void tracked.finally(() => {
			record.extensionUserMessageTasks.delete(tracked);
		});
	}

	async #waitForExtensionUserMessages(
		record: ManagedSessionRecord,
		baseline: ReadonlySet<Promise<void>>,
	): Promise<void> {
		while (true) {
			const pending = Array.from(record.extensionUserMessageTasks).filter(task => !baseline.has(task));
			if (pending.length === 0) {
				return;
			}
			await Promise.allSettled(pending);
		}
	}

	async #runPromptOrCommand(record: ManagedSessionRecord, text: string, images: AgentImageContent[]): Promise<void> {
		const skillResult = await this.#tryRunSkillCommand(record, text);
		if (skillResult) {
			return;
		}

		const builtinResult = await executeAcpBuiltinSlashCommand(text, {
			session: record.session,
			sessionManager: record.session.sessionManager,
			settings: record.session.settings,
			cwd: record.session.sessionManager.getCwd(),
			output: output => this.#emitCommandOutput(record, output),
			refreshCommands: () => this.#emitAvailableCommandsUpdate(record),
			reloadPlugins: () => this.#reloadPluginState(record),
			keepTurnOpenUntilIdle: async () => {
				await record.session.waitForIdle();
				// `AgentSession.#emit()` does not await listeners, so the retried
				// turn's `agent_end` handler — which emits the trailing chunks and
				// end-of-turn updates — can still be in flight once the session is
				// idle. Drain the tracked handlers too, or the prompt response can
				// overtake its own updates. Same pairing as the `!agentInvoked`
				// path below.
				await this.#waitForPromptEventHandlers(record);
			},
			notifyTitleChanged: async () => {
				await this.#sendUpdate({
					sessionId: record.session.sessionId,
					update: {
						sessionUpdate: "session_info_update",
						title: record.session.sessionName,
						updatedAt: new Date().toISOString(),
					},
				});
			},
			notifyConfigChanged: async () => {
				await this.#pushConfigOptionUpdate(record);
			},
		});
		if (builtinResult !== false) {
			if ("prompt" in builtinResult) {
				const residualBaseline = new Set(record.extensionUserMessageTasks);
				const residualAgentInvoked = await record.session.prompt(builtinResult.prompt, { images });
				// A residual prompt can itself resolve locally (extension command,
				// custom-TS command, file prompt template). No agent turn means no
				// `agent_end`, so the prompt turn must be settled here — same pairing
				// as the plain-prompt `!agentInvoked` path below — or the ACP
				// `session/prompt` request never resolves (#9206).
				if (!residualAgentInvoked) {
					await this.#waitForExtensionUserMessages(record, residualBaseline);
					await this.#waitForPromptEventHandlers(record);
					this.#finishPrompt(record, { stopReason: "end_turn" });
				}
				return;
			}
			const promptTurn = record.promptTurn;
			this.#finishPrompt(record, {
				stopReason: "end_turn",
				usage: this.#buildTurnUsage(
					promptTurn?.usageBaseline ??
						this.#cloneUsageStatistics(record.session.sessionManager.getUsageStatistics()),
					record.session.sessionManager.getUsageStatistics(),
				),
			});
			return;
		}

		const extensionPromptBaseline = new Set(record.extensionUserMessageTasks);
		const agentInvoked = await record.session.prompt(text, { images });
		// Extension and custom-TS commands are handled locally inside session.prompt().
		// An ACP extension command can still call pi.sendUserMessage(), which starts
		// an async nested prompt through the extension runtime. Keep the ACP turn
		// subscribed until those scheduled prompts and their event handlers drain;
		// only then is `false` proof that the slash command was purely local.
		if (!agentInvoked) {
			await this.#waitForExtensionUserMessages(record, extensionPromptBaseline);
			await this.#waitForPromptEventHandlers(record);
			this.#finishPrompt(record, { stopReason: "end_turn" });
		}
	}

	async #tryRunSkillCommand(record: ManagedSessionRecord, text: string): Promise<boolean> {
		if (!record.session.skillsSettings?.enableSkillCommands) {
			return false;
		}
		const parsed = parseSkillInvocation(text);
		if (!parsed) {
			return false;
		}
		const skill = record.session.skills.find(candidate => candidate.name === parsed.name);
		if (!skill) {
			return false;
		}
		const built = await buildSkillPromptMessage(skill, parsed.args, "user");
		await record.session.promptCustomMessage(
			{
				customType: SKILL_PROMPT_MESSAGE_TYPE,
				content: built.message,
				display: true,
				details: built.details,
				attribution: "user",
			},
			{ streamingBehavior: "steer" },
		);
		return true;
	}

	async cancel(params: { sessionId: string }): Promise<void> {
		const record = this.#getSessionRecord(params.sessionId);
		const promptTurn = record.promptTurn;
		if (!promptTurn || promptTurn.settled) {
			return;
		}
		const cleanup = this.#beginCancelCleanup(record, promptTurn);
		try {
			await cleanup;
		} catch (error: unknown) {
			logger.warn("ACP cancel cleanup timed out; closing session", { sessionId: record.session.sessionId, error });
			await this.#closeManagedSession(record.session.sessionId, record);
		}
	}

	/**
	 * Transition a still-running turn into cancellation: mark intent, drop the live-event
	 * subscription, start the bounded `abort()` race, and resolve the ACP prompt response
	 * with `stopReason: "cancelled"` so the client sees acceptance immediately. The
	 * returned promise is the cleanup barrier — it resolves when `abort()` completes and
	 * rejects when the timeout fires. Idempotent: a second call returns the same barrier.
	 */
	#beginCancelCleanup(record: ManagedSessionRecord, promptTurn: PromptTurnState): Promise<void> {
		if (promptTurn.cleanup) {
			return promptTurn.cleanup;
		}
		promptTurn.cancelRequested = true;
		// Deliberately NOT unsubscribing here. The subscription becomes cleanup-only
		// (see `isCleanupRelevantEvent`) so in-flight tool calls still reach their
		// `settled` event and drain their terminal-exit/status frames. `#runCancelCleanup`
		// unsubscribes once the queue has drained, or the bounded timeout closes the
		// session.
		const cleanup = this.#runCancelCleanup(record, promptTurn);
		promptTurn.cleanup = cleanup;
		this.#finishPrompt(record, {
			stopReason: "cancelled",
			usage: this.#buildTurnUsage(promptTurn.usageBaseline, record.session.sessionManager.getUsageStatistics()),
		});
		return cleanup;
	}

	async #runCancelCleanup(record: ManagedSessionRecord, promptTurn: PromptTurnState): Promise<void> {
		let timer: NodeJS.Timeout | undefined;
		const timeout = new Promise<never>((_, reject) => {
			timer = setTimeout(() => reject(new Error("ACP cancel cleanup timed out")), this.#cancelCleanupTimeoutMs);
		});
		try {
			await Promise.race([record.session.abort({ reason: USER_INTERRUPT_LABEL }), timeout]);
			// The abort resolved: let the cleanup frames the tool calls produced actually
			// reach the wire before dropping the subscription. A poisoned/closed
			// connection cannot promise wire cleanup, so its rejection is expected here
			// and does not turn a successful cancel into a failure.
			await Promise.race([this.#waitForPromptEventHandlers(record), timeout]);
			await Promise.race([record.outbound.idle(), timeout]);
		} finally {
			if (timer) clearTimeout(timer);
			promptTurn.unsubscribe?.();
			promptTurn.unsubscribe = undefined;
			// An unanswered permission dialog must not fence the tool after the turn is
			// gone; rejecting the reservation is not a poison (the connection is fine).
			record.outbound.rejectPendingPermissions(new Error("ACP prompt cancelled"));
			// Order matters: clear `cleanup` before evicting the slot so the slot-eviction
			// branch matches what `#finishPrompt` saw if it ran first.
			promptTurn.cleanup = undefined;
			if (promptTurn.settled && record.promptTurn === promptTurn) {
				record.promptTurn = undefined;
			}
		}
	}

	async extMethod(method: string, params: { [key: string]: unknown }): Promise<{ [key: string]: unknown }> {
		switch (method) {
			case SPEECH_MODELS_LIST_METHOD:
				return buildAcpSpeechModelsCatalog();
			case "_omp/sessions/listAll": {
				const limit = typeof params.limit === "number" ? Math.max(1, Math.min(5000, params.limit as number)) : 1000;
				const sessions = await SessionManager.listAll();
				const sorted = sessions.sort((l, r) => r.modified.getTime() - l.modified.getTime()).slice(0, limit);
				return {
					sessions: sorted.map(s => this.#toSessionInfo(s)),
					total: sessions.length,
				};
			}
			case "_omp/projects/list": {
				const sessions = await SessionManager.listAll();
				const buckets = new Map<
					string,
					{ cwd: string; sessionCount: number; lastActivityAt: number; lastTitle: string }
				>();
				for (const s of sessions) {
					if (!s.cwd) continue;
					const ts = s.modified.getTime();
					const existing = buckets.get(s.cwd);
					if (existing) {
						existing.sessionCount += 1;
						if (ts > existing.lastActivityAt) {
							existing.lastActivityAt = ts;
							existing.lastTitle = s.title ?? "";
						}
					} else {
						buckets.set(s.cwd, {
							cwd: s.cwd,
							sessionCount: 1,
							lastActivityAt: ts,
							lastTitle: s.title ?? "",
						});
					}
				}
				const projects = Array.from(buckets.values()).sort((a, b) => b.lastActivityAt - a.lastActivityAt);
				return { projects, totalSessions: sessions.length };
			}
			case "_omp/chats/byCwd": {
				const cwd = typeof params.cwd === "string" ? (params.cwd as string) : undefined;
				if (!cwd) throw new Error("cwd required");
				const limit = typeof params.limit === "number" ? Math.max(1, Math.min(500, params.limit as number)) : 100;
				const sessions = await SessionManager.list(cwd);
				const sorted = sessions.sort((l, r) => r.modified.getTime() - l.modified.getTime()).slice(0, limit);
				return { sessions: sorted.map(s => this.#toSessionInfo(s)) };
			}
			case "_omp/usage": {
				const [firstRecord] = this.#sessions.values();
				const target = firstRecord?.session ?? this.#initialSession;
				if (!target) {
					return { reports: [] };
				}
				const reports = await target.fetchUsageReports();
				return { reports: reports ?? [] };
			}
			case "_omp/extensions": {
				const cwd = typeof params.cwd === "string" ? (params.cwd as string) : undefined;
				const sm = await Settings.init();
				const disabledIds = (sm.get("disabledExtensions") as string[] | undefined) ?? [];
				const extensions = await loadAllExtensions(cwd, disabledIds);
				return { extensions: extensions as unknown as Array<{ [key: string]: unknown }> };
			}
			case "_omp/extensions/toggle": {
				const providerId = params.providerId;
				if (typeof providerId !== "string") throw new Error("providerId required");
				if (params.enabled === false) {
					disableProvider(providerId);
					return { enabled: false };
				}
				enableProvider(providerId);
				return { enabled: true };
			}
			default:
				throw new Error(`Unknown ACP ext method: ${method}`);
		}
	}

	async extNotification(_method: string, _params: { [key: string]: unknown }): Promise<void> {}

	get signal(): AbortSignal {
		return this.#connection.signal;
	}

	get closed(): Promise<void> {
		return this.#connection.closed;
	}

	#registerConnectionCleanup(): void {
		if (this.#cleanupRegistered) {
			return;
		}
		this.#cleanupRegistered = true;
		this.#connection.signal.addEventListener(
			"abort",
			() => {
				void this.dispose();
			},
			{ once: true },
		);
	}

	async #createNewSessionRecord(cwd: string, mcpServers: McpServer[]): Promise<ManagedSessionRecord> {
		const { session, setToolUIContext } = normalizeCreatedAcpSession(
			await this.#createSession(path.resolve(cwd), {
				interactivePrompts: this.#clientCapabilities?.elicitation?.form != null,
			}),
		);
		try {
			await session.sessionManager.ensureOnDisk();
		} catch (error) {
			await this.#disposeStandaloneSession(session);
			throw error;
		}
		return await this.#registerPreparedSession(session, mcpServers, setToolUIContext);
	}

	async #loadManagedSession(sessionId: string, cwd: string, mcpServers: McpServer[]): Promise<ManagedSessionRecord> {
		const existing = this.#sessions.get(sessionId);
		if (existing) {
			this.#assertMatchingCwd(existing.session, cwd);
			await this.#configureMcpServers(existing, mcpServers);
			return existing;
		}

		const storedSession = await this.#findStoredSession(sessionId, cwd);
		if (!storedSession) {
			throw new Error(`ACP session not found: ${sessionId}`);
		}
		return await this.#openStoredSession(storedSession.path, cwd, mcpServers, sessionId);
	}

	async #resumeManagedSession(sessionId: string, cwd: string, mcpServers: McpServer[]): Promise<ManagedSessionRecord> {
		const existing = this.#sessions.get(sessionId);
		if (existing) {
			this.#assertMatchingCwd(existing.session, cwd);
			await this.#configureMcpServers(existing, mcpServers);
			return existing;
		}

		const storedSession = await this.#findStoredSession(sessionId, cwd);
		if (!storedSession) {
			throw new Error(`ACP session not found: ${sessionId}`);
		}
		return await this.#openStoredSession(storedSession.path, cwd, mcpServers, sessionId);
	}

	async #forkManagedSession(params: ForkSessionRequest): Promise<ManagedSessionRecord> {
		const sourcePath = await this.#resolveForkSourceSessionPath(params.sessionId);
		const { session, setToolUIContext } = normalizeCreatedAcpSession(
			await this.#createSession(path.resolve(params.cwd), {
				interactivePrompts: this.#clientCapabilities?.elicitation?.form != null,
			}),
		);
		try {
			const success = await session.switchSession(sourcePath);
			if (!success) {
				throw new Error(`ACP session fork was cancelled: ${params.sessionId}`);
			}
			const forked = await session.fork();
			if (!forked) {
				throw new Error(`ACP session fork failed: ${params.sessionId}`);
			}
		} catch (error) {
			await this.#disposeStandaloneSession(session);
			throw error;
		}
		return await this.#registerPreparedSession(session, params.mcpServers ?? [], setToolUIContext);
	}

	async #openStoredSession(
		sessionPath: string,
		cwd: string,
		mcpServers: McpServer[],
		sessionId: string,
	): Promise<ManagedSessionRecord> {
		const { session, setToolUIContext } = normalizeCreatedAcpSession(
			await this.#createSession(path.resolve(cwd), {
				interactivePrompts: this.#clientCapabilities?.elicitation?.form != null,
			}),
		);
		try {
			const success = await session.switchSession(sessionPath);
			if (!success) {
				throw new Error(`ACP session load was cancelled: ${sessionId}`);
			}
		} catch (error) {
			await this.#disposeStandaloneSession(session);
			throw error;
		}
		return await this.#registerPreparedSession(session, mcpServers, setToolUIContext);
	}

	async #registerPreparedSession(
		session: AgentSession,
		mcpServers: McpServer[],
		setToolUIContext: ((uiContext: ExtensionUIContext, hasUI: boolean) => void) | undefined,
	): Promise<ManagedSessionRecord> {
		const record = this.#createManagedSessionRecord(session, setToolUIContext);
		// The bridge shares this record's outbound coordinator so a permission request
		// orders itself after its tool call's `started` frame batch.
		session.setClientBridge(
			createAcpClientBridge(this.#connection, session.sessionId, this.#clientCapabilities, record.outbound),
		);
		session.setPresentationSettlementDeliveryBarrier?.(toolCallId =>
			this.#waitForPresentationSettlementDelivery(record, toolCallId),
		);
		// `record.lifetimeUnsubscribe` is installed in `#scheduleBootstrapUpdates`
		// so it shares the bootstrap race guard — see that comment for why.
		try {
			await this.#configureExtensions(record);
			await this.#configureMcpServers(record, mcpServers);
			this.#sessions.set(session.sessionId, record);
			return record;
		} catch (error) {
			await this.#disposeSessionRecord(record);
			throw error;
		}
	}

	#createManagedSessionRecord(
		session: AgentSession,
		setToolUIContext: ((uiContext: ExtensionUIContext, hasUI: boolean) => void) | undefined = undefined,
	): ManagedSessionRecord {
		return {
			session,
			setToolUIContext,
			mcpManager: undefined,
			mcpRefreshChain: undefined,
			promptTurn: undefined,
			promptQueue: { promise: Promise.resolve(), release: undefined },
			liveMessageId: undefined,
			liveMessageProgress: undefined,
			toolArgsById: new Map(),
			outbound: this.#createOutboundCoordinator(session),
			toolViews: new Map(),
			legacyEvalPresentations: new Map(),
			legacyBashPresentations: new Map(),
			extensionsConfigured: false,
			closedError: undefined,
			promptEventHandlers: new Set(),
			extensionUserMessageTasks: new Set(),
			presentationSettlementDeliveries: new Map(),
			settlementDeliveriesReleased: false,
			lifetimeUnsubscribe: undefined,
		};
	}

	async #handleLifetimeEvent(record: ManagedSessionRecord, event: AgentSessionEvent): Promise<void> {
		if (event.type !== "thinking_level_changed" && event.type !== "model_changed") {
			return;
		}
		try {
			await this.#pushConfigOptionUpdate(record);
		} catch (error) {
			logger.warn("Failed to push config_option_update after a lifetime event", {
				sessionId: record.session.sessionId,
				eventType: event.type,
				error,
			});
		}
	}

	#getSessionRecord(sessionId: string): ManagedSessionRecord {
		const record = this.#sessions.get(sessionId);
		if (!record) {
			throw new Error(`Unsupported ACP session: ${sessionId}`);
		}
		return record;
	}

	#assertMatchingCwd(session: AgentSession, cwd: string): void {
		const expected = path.resolve(cwd);
		const actual = path.resolve(session.sessionManager.getCwd());
		if (actual !== expected) {
			throw new Error(`ACP session ${session.sessionId} is already loaded for ${actual}, not ${expected}`);
		}
	}

	async #resolveForkSourceSessionPath(sessionId: string): Promise<string> {
		const loaded = this.#sessions.get(sessionId);
		if (loaded) {
			if (isPromptTurnInFlight(loaded.promptTurn)) {
				throw new Error(`ACP session fork is unavailable while a prompt is in progress: ${sessionId}`);
			}
			await loaded.session.sessionManager.flush();
			const sessionPath = loaded.session.sessionManager.getSessionFile();
			if (!sessionPath) {
				throw new Error(`ACP session cannot be forked before it is persisted: ${sessionId}`);
			}
			return sessionPath;
		}

		const storedSession = await this.#findStoredSessionById(sessionId);
		if (!storedSession) {
			throw new Error(`ACP session not found: ${sessionId}`);
		}
		return storedSession.path;
	}

	async #handlePromptEvent(record: ManagedSessionRecord, event: AgentSessionEvent): Promise<void> {
		const promptTurn = record.promptTurn;
		if (!promptTurn) return;
		// Cancellation switches to a **cleanup-only** subscription rather than
		// unsubscribing: a started tool call must still be reduced through its one
		// `settled` event so its terminal exit and final status reach the client. Only
		// ordinary assistant content is filtered here. `settled` means the ACP
		// *response* has been resolved, which is not the same thing as cleanup having
		// been delivered.
		const cleanupOnly = promptTurn.cancelRequested;
		if (cleanupOnly && !isCleanupRelevantEvent(event)) return;
		if (!cleanupOnly && promptTurn.settled) return;
		const imageDataCache = new Map<string, string>();
		const resolveImageDataForAcp = (data: string, mimeType: string | undefined): string => {
			const key = `${mimeType ?? ""}\u0000${data}`;
			const cached = imageDataCache.get(key);
			if (cached !== undefined) return cached;
			const resolved = resolveImageDataSync(this.#blobs, data);
			imageDataCache.set(key, resolved);
			return resolved;
		};

		// Presentation-protocol calls are reduced, encoded and queued; the legacy
		// start/update/end mapper path is skipped for them entirely, so no call can
		// deliver its output through both protocols.
		if (event.type === "tool_presentation") {
			this.#handleToolPresentationEvent(record, event);
			return;
		}
		const legacyEditSource =
			(event.type === "tool_execution_start" ||
				event.type === "tool_execution_update" ||
				event.type === "tool_execution_end") &&
			record.session.hasBuiltInToolDispatch(event.toolName) &&
			isLegacyEditToolName(event.toolName)
				? ({ origin: "builtin", name: event.toolName } as const)
				: undefined;
		if (
			(event.type === "tool_execution_start" ||
				event.type === "tool_execution_update" ||
				event.type === "tool_execution_end") &&
			legacyEditSource !== undefined
		) {
			this.#handleLegacyEditEvent(record, event, legacyEditSource, resolveImageDataForAcp);
			return;
		}
		const isToolLifecycleEvent =
			event.type === "tool_execution_start" ||
			event.type === "tool_execution_update" ||
			event.type === "tool_execution_end";
		const legacyBashSource =
			isToolLifecycleEvent &&
			record.session.hasBuiltInToolDispatch(event.toolName) &&
			isLegacyBashToolName(event.toolName)
				? ({ origin: "builtin", name: event.toolName } as const)
				: undefined;
		const recordedLegacyBash =
			isToolLifecycleEvent && legacyBashSource !== undefined && record.legacyBashPresentations.has(event.toolCallId);
		if (
			legacyBashSource !== undefined &&
			// Omission is the AgentSessionEvent contract's legacy_snapshot default.
			// The normal BashTool route explicitly declares presentation_events and
			// must remain entirely outside this compatibility adapter.
			((event.type === "tool_execution_start" && event.progressProtocol !== "presentation_events") ||
				(event.type === "tool_execution_update" && recordedLegacyBash) ||
				(event.type === "tool_execution_end" &&
					event.progressProtocol !== "presentation_events" &&
					recordedLegacyBash))
		) {
			this.#handleLegacyBashEvent(record, event, legacyBashSource);
			return;
		}
		const legacyEvalSource =
			isToolLifecycleEvent && record.session.hasBuiltInToolDispatch(event.toolName) && event.toolName === "eval"
				? ({ origin: "builtin", name: "eval" } as const)
				: undefined;
		const recordedLegacyEval =
			isToolLifecycleEvent && legacyEvalSource !== undefined && record.legacyEvalPresentations.has(event.toolCallId);
		if (
			legacyEvalSource !== undefined &&
			// Omission is the AgentSessionEvent contract's legacy_snapshot default.
			// Only an explicit presentation_events declaration belongs to the local
			// producer route and must bypass this adapter.
			((event.type === "tool_execution_start" && event.progressProtocol !== "presentation_events") ||
				(event.type === "tool_execution_update" && recordedLegacyEval) ||
				(event.type === "tool_execution_end" &&
					event.progressProtocol !== "presentation_events" &&
					recordedLegacyEval))
		) {
			this.#handleLegacyEvalEvent(record, event, legacyEvalSource);
			return;
		}
		if (
			(event.type === "tool_execution_start" || event.type === "tool_execution_end") &&
			event.progressProtocol === "presentation_events"
		) {
			if (event.type === "tool_execution_start") record.toolArgsById.set(event.toolCallId, event.args);
			else record.toolArgsById.delete(event.toolCallId);
			return;
		}
		if (legacyEvalSource !== undefined) {
			// Updates carry no protocol tag and an end without its recorded legacy
			// start cannot be faithfully reduced. Neither may fall through to the
			// generic mapper, whose compatibility updates bypass the checked tool
			// notification sender.
			if (event.type === "tool_execution_update") return;
			if (event.type === "tool_execution_end") {
				const error = new Error(`ACP built-in eval ended without a legacy start: ${event.toolCallId}`);
				logger.error("ACP legacy eval lifecycle rejected", {
					sessionId: record.session.sessionId,
					toolCallId: event.toolCallId,
					eventType: event.type,
					error,
				});
				record.toolArgsById.delete(event.toolCallId);
				record.legacyEvalPresentations.delete(event.toolCallId);
				record.outbound.poison(error);
				this.#resolvePresentationSettlementDelivery(record, event.toolCallId);
				return;
			}
		}
		if (legacyBashSource !== undefined) {
			// A built-in bash alias may not leak into the generic mapper: that path
			// accepts raw details and sends an unchecked compatibility update. An
			// orphan legacy end is terminal because no reducer state can honestly
			// consume its settlement.
			if (event.type === "tool_execution_update") return;
			if (event.type === "tool_execution_end") {
				const error = new Error(`ACP built-in bash ended without a legacy start: ${event.toolCallId}`);
				logger.error("ACP legacy bash lifecycle rejected", {
					sessionId: record.session.sessionId,
					toolCallId: event.toolCallId,
					eventType: event.type,
					error,
				});
				record.toolArgsById.delete(event.toolCallId);
				record.legacyBashPresentations.delete(event.toolCallId);
				record.outbound.poison(error);
				this.#resolvePresentationSettlementDelivery(record, event.toolCallId);
				return;
			}
		}

		if (event.type === "tool_execution_start" || event.type === "tool_execution_update") {
			record.toolArgsById.set(event.toolCallId, event.args);
		}

		this.#prepareLiveAssistantMessage(record, event);
		const streamedAssistantError =
			event.type === "message_update" &&
			event.message.role === "assistant" &&
			event.assistantMessageEvent.type === "error";
		for (const notification of mapAgentSessionEventToAcpSessionUpdates(event, record.session.sessionId, {
			getMessageId: message => this.#getLiveMessageId(record, message),
			getMessageProgress: message => this.#getLiveMessageProgress(record, message),
			getToolArgs: toolCallId => record.toolArgsById.get(toolCallId),
			cwd: record.session.sessionManager.getCwd(),
			resolveImageData: resolveImageDataForAcp,
			terminalMetaCapable: this.#terminalMetaCapable(),
			realTerminalCapable: this.#clientCapabilities?.terminal === true,
		})) {
			// Every send joins the per-session FIFO so a batch cannot interleave with a
			// later event's frames, and so a permission reservation can order itself
			// against the same stream of writes.
			//
			// Tool writes MUST carry their call id and start/final role even on the legacy
			// mapper path. The reserved permission slot keys off delivered starts, so an
			// untagged legacy start cannot pass the slot that is waiting for it: the
			// permission request — and the start frame behind it — stalled until the
			// 10-second barrier expired for every permission-gated legacy route
			// (`edit`, `delete`, `move`, unmigrated bash).
			const delivery = record.outbound.enqueue(() => this.#sendUpdate(notification), legacyOutboundTag(event));
			if (streamedAssistantError) {
				// Resolves true only once the error chunk actually reached the
				// client — a failed delivery keeps the agent_end fallback armed.
				const outcome = delivery.then(
					() => true,
					() => false,
				);
				const prior = promptTurn.errorTextDelivery;
				promptTurn.errorTextDelivery = prior ? Promise.all([prior, outcome]).then(([a, b]) => a || b) : outcome;
			}
			await delivery;
		}
		if (event.type === "tool_execution_end") {
			record.toolArgsById.delete(event.toolCallId);
		}
		this.#clearLiveAssistantMessageAfterEvent(record, event);

		if (event.type === "agent_end") {
			await this.#flushMissedFinalAssistantText(record, event);
			await this.#flushUnreportedTurnError(record, event);
			await this.#emitEndOfTurnUpdates(record);
			await this.#waitForAcpPromptIdle(record);
			record.liveMessageId = undefined;
			record.liveMessageProgress = undefined;
			this.#finishPrompt(record, {
				stopReason: this.#resolveStopReason(event, promptTurn.cancelRequested),
				usage: this.#buildTurnUsage(promptTurn.usageBaseline, record.session.sessionManager.getUsageStatistics()),
			});
		}
	}

	/**
	 * Reduce one presentation event, encode it, and only then commit and queue it.
	 *
	 * **Synchronous through the reduce, encode, and enqueue.** `AgentSession#emit`
	 * does not await async listeners and `#trackPromptEvent` starts handlers
	 * concurrently, so anything after an `await` here could interleave with the next
	 * event. Reducing and registering the batch before yielding is what makes a
	 * multi-frame transition (meta terminal → content) contiguous relative to later
	 * events; the coordinator then owns actual delivery order.
	 *
	 * **Ordering is compute-then-commit, not commit-then-compute.** Encoding runs
	 * *before* `record.toolViews` is mutated. An encoder throw is exactly as fatal
	 * as a reducer throw — a malformed frame is a producer/reducer bug, never
	 * client data — but encoding used to run *after* the state commit (and after
	 * the settled-call deletion), so a throw there left the reducer's own view of
	 * this call advanced with no frame ever reaching the wire for it, while the
	 * exception itself, hoisted into this async method's rejection, reached only
	 * `#trackPromptEvent`'s generic catch-and-log — never `record.outbound.poison`.
	 * The prompt then finished as though delivery had succeeded. Committing state
	 * only after encoding proves out means a rejected commit can never happen.
	 */
	#handleToolPresentationEvent(
		record: ManagedSessionRecord,
		event: Extract<AgentSessionEvent, { type: "tool_presentation" }>,
		transformFrames?: (frames: readonly AcpToolFrame[]) => readonly AcpToolFrame[],
	): void {
		const state = record.toolViews.get(event.toolCallId) ?? INITIAL_ACP_TOOL_VIEW;
		const context = this.#buildRenderContext(record);
		let step: AcpToolViewStep;
		try {
			step = reduceAcpToolView(state, event.event, context);
		} catch (error) {
			// A continuity violation is a producer/reducer bug, never client data. It
			// must not be swallowed into a silently degraded card: poison the queue so
			// the prompt fails deterministically instead of implying the client's view is
			// intact.
			logger.error("ACP presentation reducer rejected an event", {
				sessionId: record.session.sessionId,
				toolCallId: event.toolCallId,
				eventType: event.event.type,
				error,
			});
			record.outbound.poison(error);
			if (event.event.type === "settled") this.#resolvePresentationSettlementDelivery(record, event.toolCallId);
			return;
		}

		let checked: readonly CheckedToolNotification[];
		try {
			checked = encodeToolFrames(record.session.sessionId, transformFrames?.(step.frames) ?? step.frames);
		} catch (error) {
			// Same failure class as a reducer rejection, and must poison for the same
			// reason — but *before* touching `record.toolViews`, so a poisoned prompt
			// never leaves the reducer's state ahead of what actually reached the wire.
			logger.error("ACP tool frame encoder rejected a reduced frame", {
				sessionId: record.session.sessionId,
				toolCallId: event.toolCallId,
				eventType: event.event.type,
				error,
			});
			record.outbound.poison(error);
			if (event.event.type === "settled") this.#resolvePresentationSettlementDelivery(record, event.toolCallId);
			return;
		}

		record.toolViews.set(event.toolCallId, step.state);

		const isStart = event.event.type === "started";
		// The call's ordering state is released by its **delivered** settlement, not by
		// reaching the settled state here: under a slow writer the start batch can still
		// be in flight, and its completion re-adds the id after an eager release.
		const isFinal = step.state.state === "settled";
		if (isFinal) record.toolViews.delete(event.toolCallId);
		if (checked.length > 0 || isFinal) {
			void record.outbound
				.enqueue(
					async () => {
						for (const notification of checked) {
							await this.#sendToolUpdate(notification);
						}
						// A live client terminal is released through the same FIFO only after
						// every final fact/status/terminal_exit frame has reached the writer.
						// Releasing from Bash's execute finally races ahead of the agent loop's
						// freeze + settled emission under a slow client.
						if (isFinal) await this.#releaseClientTerminalAfterSettlement(record, event.toolCallId);
					},
					{ toolCallId: event.toolCallId, isStart, isFinal },
				)
				.then(
					() => {
						if (isFinal) this.#resolvePresentationSettlementDelivery(record, event.toolCallId);
					},
					() => {
						if (isFinal) this.#resolvePresentationSettlementDelivery(record, event.toolCallId);
					},
				);
		}
	}

	#handleLegacyEditEvent(
		record: ManagedSessionRecord,
		event: Extract<
			AgentSessionEvent,
			{ type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end" }
		>,
		source: Extract<ToolSource, { origin: "builtin" }>,
		resolveImageData: (data: string, mimeType: string | undefined) => string,
	): void {
		if (source.name !== event.toolName || !isLegacyEditToolName(source.name)) return;
		try {
			switch (event.type) {
				case "tool_execution_start":
					record.toolArgsById.set(event.toolCallId, event.args);
					this.#handleToolPresentationEvent(record, {
						type: "tool_presentation",
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						event: legacyEditStartedEvent(
							buildToolCallPresentation({
								toolCallId: event.toolCallId,
								toolName: event.toolName,
								args: event.args,
								...(event.intent === undefined ? {} : { intent: event.intent }),
								cwd: record.session.sessionManager.getCwd(),
							}),
						),
					});
					return;
				case "tool_execution_update": {
					const result = this.#parseLegacyEditResult(source, event.partialResult);
					this.#enqueueLegacyEditFrames(
						record,
						event.toolCallId,
						legacyEditUpdateFrames(
							event.toolCallId,
							result,
							extractToolLocations(event.args, record.session.sessionManager.getCwd()).map(location => ({
								path: location.path,
								...(location.line === null ? {} : { line: location.line }),
							})),
							resolveImageData,
						),
					);
					return;
				}
				case "tool_execution_end": {
					const result = this.#parseLegacyEditResult(source, event.result);
					for (const presentationEvent of legacyEditSettlementEvents(
						event.toolCallId,
						result,
						event.isError === true || result.isError,
						formatOutputNotice,
						resolveImageData,
					)) {
						this.#handleToolPresentationEvent(
							record,
							{
								type: "tool_presentation",
								toolCallId: event.toolCallId,
								toolName: event.toolName,
								event: presentationEvent,
							},
							presentationEvent.type === "settled"
								? frames =>
										legacyEditFramesWithLocations(
											event.toolCallId,
											frames,
											result,
											record.session.sessionManager.getCwd(),
											this.#resolveEditLocationPath,
										)
								: undefined,
						);
					}
					record.toolArgsById.delete(event.toolCallId);
					return;
				}
				default: {
					const exhaustive: never = event;
					throw new Error(`Unhandled legacy edit event: ${JSON.stringify(exhaustive)}`);
				}
			}
		} catch (error) {
			logger.error("ACP legacy edit adapter rejected an event", {
				sessionId: record.session.sessionId,
				toolCallId: event.toolCallId,
				eventType: event.type,
				error,
			});
			record.outbound.poison(error);
			if (event.type === "tool_execution_end") this.#resolvePresentationSettlementDelivery(record, event.toolCallId);
		}
	}

	#parseLegacyEditResult(source: Extract<ToolSource, { origin: "builtin" }>, result: unknown): EditResult {
		// Production path: degrade converts an unparseable built-in edit result into
		// a minimal typed result — salvaged content blocks, envelope `isError`, empty
		// details (`editThrownFailureDetailsSchema` is `strictObject({})`, which
		// `editDetailsRows()` renders as no rows) — so it settles as an empty/failed
		// card instead of poisoning the whole prompt via `record.outbound.poison`.
		// Strict parsing remains the dev/test default (§3.4).
		const parsed = parseLegacyToolResult(source, result, { onBuiltinSchemaError: "degrade" });
		if (parsed.tool === "edit") return parsed;
		if (parsed.tool === "unmodelled_builtin") {
			logger.warn("ACP legacy edit result failed its schema; degrading to a minimal typed result", {
				toolName: parsed.toolName,
				isError: parsed.isError,
				degraded: true,
			});
			return {
				tool: "edit",
				toolName: parsed.toolName,
				content: parsed.content,
				isError: parsed.isError,
				details: {},
			};
		}
		throw new Error(`Legacy edit result for ${source.name} parsed as ${parsed.tool}`);
	}

	#handleLegacyBashEvent(
		record: ManagedSessionRecord,
		event: Extract<
			AgentSessionEvent,
			{ type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end" }
		>,
		source: Extract<ToolSource, { origin: "builtin" }>,
	): void {
		if (source.name !== event.toolName || !isLegacyBashToolName(source.name)) return;
		try {
			switch (event.type) {
				case "tool_execution_start": {
					record.toolArgsById.set(event.toolCallId, event.args);
					record.legacyBashPresentations.set(event.toolCallId, new LegacyBashPresentation(event.toolCallId));
					this.#handleToolPresentationEvent(record, {
						type: "tool_presentation",
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						event: legacyBashStartedEvent(
							buildToolCallPresentation({
								toolCallId: event.toolCallId,
								toolName: event.toolName,
								args: event.args,
								...(event.intent === undefined ? {} : { intent: event.intent }),
								cwd: record.session.sessionManager.getCwd(),
							}),
						),
					});
					return;
				}
				case "tool_execution_update": {
					const result = this.#parseLegacyBashResult(source, event.partialResult);
					const presentation = this.#legacyBashPresentation(record, event.toolCallId);
					if (presentation === undefined) return;
					for (const presentationEvent of presentation.update(result)) {
						this.#handleToolPresentationEvent(record, {
							type: "tool_presentation",
							toolCallId: event.toolCallId,
							toolName: event.toolName,
							event: presentationEvent,
						});
					}
					return;
				}
				case "tool_execution_end": {
					const result = this.#parseLegacyBashResult(source, event.result);
					const presentation = this.#legacyBashPresentation(record, event.toolCallId);
					if (presentation === undefined) return;
					for (const presentationEvent of presentation.settle(result, event.isError === true)) {
						this.#handleToolPresentationEvent(record, {
							type: "tool_presentation",
							toolCallId: event.toolCallId,
							toolName: event.toolName,
							event: presentationEvent,
						});
					}
					record.toolArgsById.delete(event.toolCallId);
					record.legacyBashPresentations.delete(event.toolCallId);
					return;
				}
				default: {
					const exhaustive: never = event;
					throw new Error(`Unhandled legacy bash event: ${JSON.stringify(exhaustive)}`);
				}
			}
		} catch (error) {
			logger.error("ACP legacy bash adapter rejected an event", {
				sessionId: record.session.sessionId,
				toolCallId: event.toolCallId,
				eventType: event.type,
				error,
			});
			record.outbound.poison(error);
			if (event.type === "tool_execution_end") {
				record.toolArgsById.delete(event.toolCallId);
				record.legacyBashPresentations.delete(event.toolCallId);
				this.#resolvePresentationSettlementDelivery(record, event.toolCallId);
			}
		}
	}

	#legacyBashPresentation(record: ManagedSessionRecord, toolCallId: string): LegacyBashPresentation | undefined {
		return record.legacyBashPresentations.get(toolCallId);
	}

	#parseLegacyBashResult(source: Extract<ToolSource, { origin: "builtin" }>, result: unknown): BashLikeResult {
		// Production path: degrade converts an unparseable built-in bash result into
		// a minimal typed result — salvaged content blocks, envelope `isError`,
		// empty details (`legacyBashDetailsSchema` admits `{}`) — so it settles as
		// an empty/failed card instead of poisoning the whole prompt via
		// `record.outbound.poison`. Same rationale as `#parseLegacyEditResult`;
		// strict parsing remains the dev/test default (§3.4).
		const parsed = parseLegacyToolResult(source, result, { onBuiltinSchemaError: "degrade" });
		if (parsed.tool === "bash") return parsed;
		if (parsed.tool === "unmodelled_builtin") {
			logger.warn("ACP legacy bash result failed its schema; degrading to a minimal typed result", {
				toolName: parsed.toolName,
				isError: parsed.isError,
				degraded: true,
			});
			return {
				tool: "bash",
				toolName: parsed.toolName,
				content: parsed.content,
				isError: parsed.isError,
				details: {},
			};
		}
		throw new Error(`Legacy bash result for ${source.name} parsed as ${parsed.tool}`);
	}

	#handleLegacyEvalEvent(
		record: ManagedSessionRecord,
		event: Extract<
			AgentSessionEvent,
			{ type: "tool_execution_start" | "tool_execution_update" | "tool_execution_end" }
		>,
		source: Extract<ToolSource, { origin: "builtin" }>,
	): void {
		if (source.name !== event.toolName || source.name !== "eval") return;
		try {
			switch (event.type) {
				case "tool_execution_start": {
					record.toolArgsById.set(event.toolCallId, event.args);
					record.legacyEvalPresentations.set(
						event.toolCallId,
						new LegacyEvalPresentation(event.toolCallId, formatLegacyOutputNotice),
					);
					const call = buildToolCallPresentation({
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						args: event.args,
						...(event.intent === undefined ? {} : { intent: event.intent }),
						cwd: record.session.sessionManager.getCwd(),
					});
					const code = legacyEvalCode(event.args);
					this.#handleToolPresentationEvent(record, {
						type: "tool_presentation",
						toolCallId: event.toolCallId,
						toolName: event.toolName,
						event: {
							type: "started",
							call: { ...call, ...(code === undefined ? {} : { sourceEcho: code }) },
						},
					});
					return;
				}
				case "tool_execution_update": {
					const result = this.#parseLegacyEvalResult(source, event.partialResult);
					const presentation = this.#legacyEvalPresentation(record, event.toolCallId);
					if (presentation === undefined) return;
					for (const presentationEvent of presentation.update(result)) {
						this.#handleToolPresentationEvent(record, {
							type: "tool_presentation",
							toolCallId: event.toolCallId,
							toolName: event.toolName,
							event: presentationEvent,
						});
					}
					return;
				}
				case "tool_execution_end": {
					const result = this.#parseLegacyEvalResult(source, event.result);
					const presentation = this.#legacyEvalPresentation(record, event.toolCallId);
					if (presentation === undefined) return;
					for (const presentationEvent of presentation.settle(result, event.isError === true)) {
						this.#handleToolPresentationEvent(record, {
							type: "tool_presentation",
							toolCallId: event.toolCallId,
							toolName: event.toolName,
							event: presentationEvent,
						});
					}
					record.toolArgsById.delete(event.toolCallId);
					record.legacyEvalPresentations.delete(event.toolCallId);
					return;
				}
				default: {
					const exhaustive: never = event;
					throw new Error(`Unhandled legacy eval event: ${JSON.stringify(exhaustive)}`);
				}
			}
		} catch (error) {
			logger.error("ACP legacy eval adapter rejected an event", {
				sessionId: record.session.sessionId,
				toolCallId: event.toolCallId,
				eventType: event.type,
				error,
			});
			record.outbound.poison(error);
			if (event.type === "tool_execution_end") {
				record.toolArgsById.delete(event.toolCallId);
				record.legacyEvalPresentations.delete(event.toolCallId);
				this.#resolvePresentationSettlementDelivery(record, event.toolCallId);
			}
		}
	}

	#legacyEvalPresentation(record: ManagedSessionRecord, toolCallId: string): LegacyEvalPresentation | undefined {
		return record.legacyEvalPresentations.get(toolCallId);
	}

	#parseLegacyEvalResult(source: Extract<ToolSource, { origin: "builtin" }>, result: unknown): EvalResult {
		// Production path: degrade converts an unparseable built-in eval result into
		// a minimal typed result — salvaged content blocks, envelope `isError`,
		// empty details (`evalDetailsSchema` admits `{}` and LegacyEvalPresentation
		// reads detail fields undefined-tolerantly) — so it settles as an
		// empty/failed card instead of poisoning the whole prompt via
		// `record.outbound.poison`. Same rationale as `#parseLegacyEditResult`;
		// strict parsing remains the dev/test default (§3.4).
		const parsed = parseLegacyToolResult(source, result, { onBuiltinSchemaError: "degrade" });
		if (parsed.tool === "eval") return parsed;
		if (parsed.tool === "unmodelled_builtin") {
			logger.warn("ACP legacy eval result failed its schema; degrading to a minimal typed result", {
				toolName: parsed.toolName,
				isError: parsed.isError,
				degraded: true,
			});
			return {
				tool: "eval",
				toolName: parsed.toolName,
				content: parsed.content,
				isError: parsed.isError,
				details: {},
			};
		}
		throw new Error(`Legacy eval result for ${source.name} parsed as ${parsed.tool}`);
	}

	#resolveEditLocationPath(path: string, cwd: string): string {
		try {
			return resolveToCwd(path, cwd);
		} catch {
			return path;
		}
	}

	#enqueueLegacyEditFrames(record: ManagedSessionRecord, toolCallId: string, frames: readonly AcpToolFrame[]): void {
		let checked: readonly CheckedToolNotification[];
		try {
			checked = encodeToolFrames(record.session.sessionId, frames);
		} catch (error) {
			record.outbound.poison(error);
			return;
		}
		void record.outbound.enqueue(
			async () => {
				for (const notification of checked) await this.#sendToolUpdate(notification);
			},
			{ toolCallId },
		);
	}

	#waitForPresentationSettlementDelivery(record: ManagedSessionRecord, toolCallId: string): Promise<void> {
		// A running agent loop can invoke a barrier callback it captured before
		// the record's deliveries were released (poisoned teardown/disposal);
		// parking a new waiter here would deadlock the abort that release
		// precedes — nothing can resolve it anymore.
		if (record.settlementDeliveriesReleased) return Promise.resolve();
		const existing = record.presentationSettlementDeliveries.get(toolCallId);
		if (existing) return existing.promise;
		const delivery = Promise.withResolvers<void>();
		record.presentationSettlementDeliveries.set(toolCallId, delivery);
		return delivery.promise;
	}

	#resolvePresentationSettlementDelivery(record: ManagedSessionRecord, toolCallId: string): void {
		const delivery = record.presentationSettlementDeliveries.get(toolCallId);
		if (!delivery) return;
		record.presentationSettlementDeliveries.delete(toolCallId);
		delivery.resolve();
	}

	/** Release the ACP bridge's terminal after its call's settlement writer batch. */
	async #releaseClientTerminalAfterSettlement(record: ManagedSessionRecord, toolCallId: string): Promise<void> {
		const released = await Promise.race([
			this.#tryReleaseClientTerminalAfterSettlement(record, toolCallId).then(() => true),
			Bun.sleep(ACP_TERMINAL_RELEASE_GRACE_MS).then(() => false),
		]);
		if (!released) {
			logger.warn("ACP terminal release did not settle after presentation settlement", {
				toolCallId,
				graceMs: ACP_TERMINAL_RELEASE_GRACE_MS,
			});
		}
	}

	async #tryReleaseClientTerminalAfterSettlement(record: ManagedSessionRecord, toolCallId: string): Promise<void> {
		try {
			await record.session.clientBridge?.releaseTerminalAfterPresentationSettlement?.(toolCallId);
		} catch (error) {
			// Terminal release used to be best-effort in Bash's `finally`; preserve that
			// failure policy while moving its *ordering* behind the delivered settlement.
			logger.warn("ACP terminal release failed after presentation settlement", { toolCallId, error });
		}
	}

	/**
	 * The render context for this connection: a phase crossed with the terminal
	 * capability actually negotiated at `initialize`.
	 *
	 * This replaces the scattered `wantsMetaTerminal`/`isPtyRequested`/
	 * `hasTerminalItem` re-derivations whose disagreement was its own bug class —
	 * the reducer selects a channel once, at `started`, from this single value.
	 */
	#buildRenderContext(record: ManagedSessionRecord): AcpRenderContext {
		const metaCap = negotiateTerminalMetaCap(this.#terminalMetaCapable());
		const cwd = record.session.sessionManager.getCwd();
		if (this.#clientCapabilities?.terminal === true) {
			return {
				phase: "live",
				terminal: { kind: "real", metaCap },
				...(cwd === undefined ? {} : { cwd }),
				fence: true,
			};
		}
		return {
			phase: "live",
			terminal: metaCap === undefined ? { kind: "none" } : { kind: "meta_only", cap: metaCap },
			...(cwd === undefined ? {} : { cwd }),
			fence: true,
		};
	}

	/**
	 * Deliver the final visible answer when the assistant `message_end` never
	 * reached this prompt turn's subscription. Session event handlers are
	 * fire-and-forget (`Agent#emit` does not await async listeners), and
	 * `agent_end` is flushed through the session's `#endInFlight` path while the
	 * assistant `message_end` fan-out can still be parked on extension delivery —
	 * so `agent_end` can overtake `message_end`. Once the turn finishes,
	 * `#finishPrompt` unsubscribes and the fallback text emission in
	 * `mapAssistantMessageEnd` is lost for good: a client that only received
	 * `agent_thought_chunk`s stays stuck on the thinking block (#4902). The live
	 * message progress records whether visible text ever reached the client; if
	 * it has not, emit the last assistant message's text before the prompt
	 * resolves. A `message_end` that lands during the end-of-turn waits still
	 * takes the normal mapper path and sees `textEmitted` already set, so the
	 * answer is delivered exactly once.
	 */
	async #flushMissedFinalAssistantText(
		record: ManagedSessionRecord,
		event: Extract<AgentSessionEvent, { type: "agent_end" }>,
	): Promise<void> {
		const progress = record.liveMessageProgress;
		if (!progress || progress.textEmitted) {
			return;
		}
		const lastAssistant = [...event.messages]
			.reverse()
			.find((message): message is AssistantMessage => message.role === "assistant");
		if (!lastAssistant) {
			return;
		}
		const text = extractAssistantMessageText(lastAssistant);
		if (text.length === 0) {
			return;
		}
		progress.textEmitted = true;
		await this.#sendUpdate({
			sessionId: record.session.sessionId,
			update: {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text },
				messageId: record.liveMessageId,
			},
		});
	}

	/**
	 * Surface a turn-fatal provider error that never reached the client. A
	 * request that fails before streaming any assistant events — e.g. GitHub
	 * Copilot's `HTTP 400 model_not_supported` after retries — emits only
	 * `agent_end` with an empty assistant message carrying `errorMessage`
	 * (`Agent#runLoop`'s catch), so no `message_update`/`message_end` ever maps
	 * to a session update and the client sees the turn end silently. Errors
	 * that did stream are tracked via {@link PromptTurnState.errorTextDelivery};
	 * the fallback awaits that delivery and re-sends only when it failed.
	 */
	async #flushUnreportedTurnError(
		record: ManagedSessionRecord,
		event: Extract<AgentSessionEvent, { type: "agent_end" }>,
	): Promise<void> {
		const streamedDelivery = record.promptTurn?.errorTextDelivery;
		if (streamedDelivery && (await streamedDelivery)) {
			return;
		}
		const lastAssistant = [...event.messages]
			.reverse()
			.find((message): message is AssistantMessage => message.role === "assistant");
		if (lastAssistant?.stopReason !== "error") {
			return;
		}
		const errorMessage = lastAssistant.errorMessage;
		if (!errorMessage || isSilentAbort(lastAssistant)) {
			return;
		}
		await this.#sendUpdate({
			sessionId: record.session.sessionId,
			update: {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text: errorMessage },
				messageId: record.liveMessageId ?? crypto.randomUUID(),
			},
		});
	}

	async #waitForAcpPromptIdle(record: ManagedSessionRecord): Promise<void> {
		for (let pass = 0; pass < ACP_ASYNC_DELIVERY_DRAIN_MAX_PASSES; pass++) {
			await record.session.waitForIdle();
			const delivered = await record.session.drainAsyncJobDeliveriesForAcp({
				timeoutMs: ACP_ASYNC_DELIVERY_DRAIN_TIMEOUT_MS,
			});
			if (!delivered) {
				await this.#drainOutbound(record);
				return;
			}
		}

		await record.session.waitForIdle();
		await this.#drainOutbound(record);
	}

	/**
	 * Wait for every queued outbound frame to reach the writer.
	 *
	 * `prompt()` must not resolve while a tool call's settlement/status/terminal-exit
	 * batch is still sitting in the FIFO: the reducer enqueues those batches
	 * fire-and-forget (delivery order is the coordinator's job, not the event
	 * handler's), so without this a slow writer let the ACP response overtake the
	 * frames that describe the turn's own result.
	 *
	 * A poisoned coordinator rejects instead of draining; that is a terminal state
	 * whose owner is `#terminateSessionOnOutboundFailure`, so swallowing it here does
	 * not lose the failure.
	 */
	async #drainOutbound(record: ManagedSessionRecord): Promise<void> {
		try {
			await record.outbound.idle();
		} catch (error) {
			logger.warn("ACP outbound queue did not drain before the prompt finished", {
				sessionId: record.session.sessionId,
				error,
			});
		}
	}

	#prepareLiveAssistantMessage(record: ManagedSessionRecord, event: AgentSessionEvent): void {
		if (
			(event.type === "message_start" || event.type === "message_update" || event.type === "message_end") &&
			event.message.role === "assistant" &&
			(event.type === "message_start" || !record.liveMessageId || !record.liveMessageProgress)
		) {
			record.liveMessageId = crypto.randomUUID();
			record.liveMessageProgress = { textEmitted: false, thoughtEmitted: false };
		}
	}

	/**
	 * Reset live-message tracking once the assistant `message_end` is handled.
	 * The `agent_end` reset happens inside the `agent_end` branch of
	 * `#handlePromptEvent` — after `#flushMissedFinalAssistantText` — so a
	 * `message_end` that arrives during the end-of-turn waits maps against the
	 * real progress instead of resurrecting a fresh one (which would double-emit
	 * the final answer).
	 */
	#clearLiveAssistantMessageAfterEvent(record: ManagedSessionRecord, event: AgentSessionEvent): void {
		if (event.type === "message_end" && event.message.role === "assistant") {
			record.liveMessageId = undefined;
			record.liveMessageProgress = undefined;
		}
	}

	#getLiveMessageId(record: ManagedSessionRecord, message: unknown): string | undefined {
		if (typeof message !== "object" || message === null) {
			return undefined;
		}
		record.liveMessageId ??= crypto.randomUUID();
		return record.liveMessageId;
	}

	#getLiveMessageProgress(
		record: ManagedSessionRecord,
		message: unknown,
	): { textEmitted: boolean; thoughtEmitted: boolean } | undefined {
		if (typeof message !== "object" || message === null) {
			return undefined;
		}
		record.liveMessageProgress ??= { textEmitted: false, thoughtEmitted: false };
		return record.liveMessageProgress;
	}

	#finishPrompt(record: ManagedSessionRecord, response?: PromptResponse, error?: unknown): void {
		const promptTurn = record.promptTurn;
		if (!promptTurn || promptTurn.settled) {
			return;
		}
		promptTurn.settled = true;
		// `settled` means the ACP *response* is resolved. It does not mean cleanup has
		// been delivered, and the two must not share one flag: when a cancel is in
		// flight the subscription has to stay installed so already-started tool calls
		// still reach their `settled` event and drain their terminal-exit frames.
		// `#runCancelCleanup` unsubscribes once the queue is drained (or the bounded
		// timeout closes the session).
		if (!promptTurn.cancelRequested) {
			promptTurn.unsubscribe?.();
			promptTurn.unsubscribe = undefined;
		}
		// Keep the slot occupied until cancel cleanup finishes — `#runCancelCleanup`
		// evicts the slot in its finally block once both flags say it's safe.
		if (!promptTurn.cleanup && record.promptTurn === promptTurn) {
			record.promptTurn = undefined;
		}
		if (error !== undefined) {
			promptTurn.reject(error);
			return;
		}
		promptTurn.resolve(response ?? { stopReason: "end_turn" });
	}

	#resolveStopReason(
		event: Extract<AgentSessionEvent, { type: "agent_end" }>,
		cancelRequested: boolean,
	): PromptResponse["stopReason"] {
		if (cancelRequested) {
			return "cancelled";
		}
		const lastAssistant = [...event.messages]
			.reverse()
			.find((message): message is AssistantMessage => message.role === "assistant");
		const reason = lastAssistant?.stopReason;
		switch (reason) {
			case "aborted":
				return "cancelled";
			case "length":
				return "max_tokens";
			case "error": {
				const errorMessage = lastAssistant?.errorMessage ?? "";
				if (/content[_ ]?filter|refus(al|ed)/i.test(errorMessage)) {
					return "refusal";
				}
				return "end_turn";
			}
			default:
				return "end_turn";
		}
	}

	async #emitCommandOutput(record: ManagedSessionRecord, text: string): Promise<void> {
		if (!text) {
			return;
		}
		await this.#sendUpdate({
			sessionId: record.session.sessionId,
			update: {
				sessionUpdate: "agent_message_chunk",
				content: { type: "text", text },
				messageId: crypto.randomUUID(),
			},
		});
	}

	#assertAbsoluteCwd(cwd: string): void {
		if (!path.isAbsolute(cwd)) {
			throw new Error(`ACP cwd must be absolute: ${cwd}`);
		}
	}

	#convertPromptBlocks(blocks: PromptRequest["prompt"]): { text: string; images: AgentImageContent[] } {
		const textParts: string[] = [];
		const images: AgentImageContent[] = [];
		for (const block of blocks) {
			switch (block.type) {
				case "text":
					textParts.push(block.text);
					break;
				case "image":
					images.push({ type: "image", data: block.data, mimeType: block.mimeType });
					break;
				case "resource":
					if ("text" in block.resource) {
						textParts.push(block.resource.text);
					} else if (typeof block.resource.mimeType === "string" && block.resource.mimeType.startsWith("image/")) {
						// `embeddedContext: true` covers both text and blob resources, but
						// blobs aren't directly consumable by the LLM. Route image blobs
						// to the images array so the user's intent survives; everything
						// else falls back to the URI placeholder below.
						images.push({ type: "image", data: block.resource.blob, mimeType: block.resource.mimeType });
					} else {
						textParts.push(`[embedded resource: ${block.resource.uri}]`);
					}
					break;
				case "resource_link":
					textParts.push(block.title ?? block.name ?? block.uri);
					break;
				case "audio":
					textParts.push("[audio omitted]");
					break;
			}
		}
		return {
			text: textParts.join("\n\n").trim(),
			images,
		};
	}

	async #pushConfigOptionUpdate(record: ManagedSessionRecord): Promise<void> {
		await this.#pushConfigOptionUpdateForSession(record.session);
	}

	async #pushConfigOptionUpdateForSession(session: AgentSession): Promise<void> {
		await this.#sendUpdate({
			sessionId: session.sessionId,
			update: {
				sessionUpdate: "config_option_update",
				configOptions: this.#buildConfigOptions(session),
			},
		});
	}

	#buildConfigOptions(session: AgentSession): SessionConfigOption[] {
		const currentModeId = this.#getCurrentModeId(session);
		const modeOptions = this.#getAvailableModes(session).map(mode => ({
			value: mode.id,
			name: mode.name,
			description: mode.description,
		}));
		const configOptions: SessionConfigOption[] = [
			{
				id: MODE_CONFIG_ID,
				name: "Mode",
				category: "mode",
				type: "select",
				currentValue: currentModeId,
				options: modeOptions,
			},
		];

		const models = session.getAvailableModels();
		const currentModel = session.model;
		if (models.length > 0) {
			configOptions.push({
				id: MODEL_CONFIG_ID,
				name: "Model",
				category: "model",
				type: "select",
				currentValue: currentModel ? this.#toModelId(currentModel) : this.#toModelId(models[0]),
				options: models.map(model => ({
					value: this.#toModelId(model),
					name: model.name,
					description: `${model.provider}/${model.id}`,
				})),
			});
		}

		configOptions.push({
			id: THINKING_CONFIG_ID,
			name: "Thinking",
			category: "thought_level",
			type: "select",
			currentValue: this.#toThinkingConfigValue(
				session.model?.reasoning ? this.#getConfiguredThinkingLevel(session) : undefined,
			),
			options: this.#buildThinkingOptions(session),
		});
		return configOptions;
	}

	#buildThinkingOptions(session: AgentSession): Array<{ value: string; name: string; description?: string }> {
		return [
			{ value: THINKING_OFF, name: "Off" },
			{ value: AUTO_THINKING, name: "Auto", description: "Auto-detect per prompt" },
			...session.getAvailableThinkingLevels().map(level => ({
				value: level,
				name: level,
			})),
		];
	}
	#getConfiguredThinkingLevel(session: AgentSession): string | undefined {
		const configuredThinkingLevel = (session as { configuredThinkingLevel?: () => string | undefined })
			.configuredThinkingLevel;
		return typeof configuredThinkingLevel === "function"
			? configuredThinkingLevel.call(session)
			: session.thinkingLevel;
	}

	#toThinkingConfigValue(value: string | undefined): string {
		return value && value !== "inherit" ? value : THINKING_OFF;
	}

	async #setModelById(session: AgentSession, modelId: string): Promise<void> {
		const model = session.getAvailableModels().find(candidate => this.#toModelId(candidate) === modelId);
		if (!model) {
			throw new Error(`Unknown ACP model: ${modelId}`);
		}
		await session.setModel(model);
	}

	#setThinkingLevelById(session: AgentSession, value: string): void {
		const thinkingLevel = parseConfiguredThinkingLevel(value);
		if (!thinkingLevel) {
			throw new Error(`Unknown ACP thinking level: ${value}`);
		}
		session.setThinkingLevel(thinkingLevel);
	}

	#toModelId(model: Model): string {
		return `${model.provider}/${model.id}`;
	}

	#getAvailableModes(session: AgentSession): Array<{ id: string; name: string; description: string }> {
		const modes = [{ id: ACP_DEFAULT_MODE_ID, name: "Default", description: "Standard ACP headless mode" }];
		if (session.settings.get("plan.enabled")) {
			modes.push({
				id: ACP_PLAN_MODE_ID,
				name: "Plan",
				description: "Read-only planning mode that drafts a plan to a markdown file before any code changes",
			});
		}
		void session;
		return modes;
	}

	#getCurrentModeId(session: AgentSession): string {
		return session.getPlanModeState()?.enabled ? ACP_PLAN_MODE_ID : ACP_DEFAULT_MODE_ID;
	}

	#applyModeChange(session: AgentSession, modeId: string): void {
		const availableModes = this.#getAvailableModes(session);
		if (!availableModes.some(mode => mode.id === modeId)) {
			throw new Error(`Unsupported ACP mode: ${modeId}`);
		}
		if (modeId === ACP_PLAN_MODE_ID) {
			const previous = session.getPlanModeState();
			session.setPlanModeState({
				enabled: true,
				planFilePath: previous?.planFilePath ?? DEFAULT_PLAN_FILE_URL,
				workflow: previous?.workflow ?? "parallel",
				reentry: previous !== undefined,
			});
			// Mirror `InteractiveMode.#enterPlanMode`: register the plan-proposal
			// handler that consumes `xd://propose` writes from plan mode. Without
			// this, proposal dispatch falls through and plan mode has no approval
			// path (issue #1869).
			session.setPlanProposalHandler?.(title => this.#handleAcpPlanProposal(session, title));
		} else {
			session.setPlanProposalHandler?.(null);
			session.setPlanModeState(undefined);
		}
	}

	/**
	 * Plan-proposal handler installed while ACP plan mode is active. The agent
	 * submits the finalized plan by writing its `<slug>`/title to
	 * `xd://propose`; this handler validates the plan file, normalizes the
	 * title, asks the ACP client to confirm (via `unstable_createElicitation`
	 * when supported), and on approval keeps the chosen plan path, exits plan
	 * mode, and notifies the client so the agent regains full tools.
	 *
	 * Mirrors `InteractiveMode.#handlePlanProposal` for the parts the agent sees
	 * (same `PlanApprovalDetails` shape). Clients without form-mode elicitation
	 * get an auto-approve so plan mode is never stranded — the agent always has
	 * a way out.
	 */
	async #handleAcpPlanProposal(session: AgentSession, title: string): Promise<AgentToolResult<unknown>> {
		const state = session.getPlanModeState();
		if (!state?.enabled) {
			throw new ToolError("Plan mode is not active.");
		}
		const {
			planFilePath,
			planContent,
			title: resolvedTitle,
		} = await resolveApprovedPlan({
			suppliedTitle: title,
			statePlanFilePath: state.planFilePath,
			readPlan: url => this.#readAcpPlanFile(session, url),
			listPlanFiles: () => this.#listAcpLocalPlanFiles(session),
		});
		const approved = await this.#requestAcpPlanApprovalChoice(session.sessionId, resolvedTitle, planContent);
		const details: PlanApprovalDetails = {
			planFilePath,
			title: resolvedTitle,
			planExists: true,
		};
		if (!approved) {
			// Rejection keeps plan mode active for another planning turn. Promote the
			// reviewed path into plan-mode state so the next `#buildPlanModeMessage()`
			// targets the plan just reviewed, not the stale state path.
			if (state.planFilePath !== planFilePath) {
				session.setPlanModeState({ ...state, planFilePath });
			}
			const normalizedTitle = normalizePlanTitle(resolvedTitle).title;
			return {
				content: [
					{
						type: "text" as const,
						text: `Plan refinement requested. Update the plan file, then write ${normalizedTitle} to xd://propose again when ready.`,
					},
				],
				details,
			};
		}
		// Approved. Set the plan reference so the next turn injects the plan
		// content as context (the file keeps its agent-chosen name — no rename),
		// then exit plan mode so the agent regains full tools.
		session.setPlanReferencePath(planFilePath);
		session.setPlanProposalHandler?.(null);
		session.setPlanModeState(undefined);
		try {
			await this.#sendUpdate({
				sessionId: session.sessionId,
				update: this.#buildCurrentModeUpdate(session),
			});
			await this.#pushConfigOptionUpdateForSession(session);
		} catch (error) {
			logger.warn("Failed to emit mode updates after plan approval", {
				sessionId: session.sessionId,
				error,
			});
		}
		return {
			content: [
				{
					type: "text" as const,
					text: `Plan approved at ${planFilePath}. Plan mode exited; proceed with the implementation.`,
				},
			],
			details,
		};
	}

	#resolveAcpPlanFilePath(session: AgentSession, planFilePath: string): string {
		if (planFilePath.startsWith("local:")) {
			const normalized = normalizeLocalScheme(planFilePath);
			return resolveLocalUrlToPath(normalized, {
				getArtifactsDir: () => session.sessionManager.getArtifactsDir(),
				getSessionId: () => session.sessionManager.getSessionId(),
			});
		}
		return path.resolve(session.sessionManager.getCwd(), planFilePath);
	}

	async #readAcpPlanFile(session: AgentSession, planFilePath: string): Promise<string | null> {
		const resolvedPath = this.#resolveAcpPlanFilePath(session, planFilePath);
		try {
			return await Bun.file(resolvedPath).text();
		} catch (error) {
			if (isEnoent(error)) {
				return null;
			}
			throw error;
		}
	}

	/** `local://` URLs of plan files in the session-local root, newest first —
	 *  the `resolveApprovedPlan` fallback for a dropped `extra.title`. */
	async #listAcpLocalPlanFiles(session: AgentSession): Promise<string[]> {
		const localRoot = this.#resolveAcpPlanFilePath(session, "local://");
		try {
			const entries = await fs.readdir(localRoot, { withFileTypes: true });
			const plans = await Promise.all(
				entries
					.filter(entry => entry.isFile() && /plan\.md$/i.test(entry.name))
					.map(async entry => {
						const stat = await fs.stat(path.join(localRoot, entry.name)).catch(() => null);
						return { url: `local://${entry.name}`, mtime: stat?.mtimeMs ?? 0 };
					}),
			);
			return plans.sort((a, b) => b.mtime - a.mtime).map(plan => plan.url);
		} catch {
			return [];
		}
	}

	/**
	 * Ask the ACP client to confirm plan approval. Returns `true` only on an
	 * explicit `APPROVE_OPTION` selection. Refine, dismissal (`undefined`), or
	 * any unrecognized value falls through to refine semantics — the caller
	 * keeps plan mode active and surfaces guidance text to the agent. Clients
	 * without `elicitation.form` support auto-approve because there is no
	 * confirmation surface available; without that, plan mode would strand
	 * the agent (the bug this method exists to fix).
	 */
	async #requestAcpPlanApprovalChoice(sessionId: string, title: string, planContent: string): Promise<boolean> {
		const supportsForm = this.#clientCapabilities?.elicitation?.form != null;
		if (!supportsForm) return true;
		// Include a short preview of the plan so the user has context in the
		// dialog. Keep the body bounded — Zed renders elicitation messages
		// inline and a multi-thousand-line plan blows out the dialog.
		const previewLines = planContent.split("\n").slice(0, 12).join("\n");
		const ellipsis = planContent.split("\n").length > 12 ? "\n…" : "";
		const message = `Approve plan "${title}" and start implementation?\n\n${previewLines}${ellipsis}`;
		const value = await elicitFromAcpClient(
			this.#connection,
			sessionId,
			"select",
			message,
			{ type: "string", enum: [APPROVE_OPTION, REFINE_OPTION] },
			undefined,
		);
		// Approve ONLY on the explicit approve selection. Dismissal, cancel,
		// timeout, or any other non-approve response falls through to refine
		// semantics so closing the dialog can never grant write access.
		return value === APPROVE_OPTION;
	}

	#buildModeState(session: AgentSession): SessionModeState {
		return {
			availableModes: this.#getAvailableModes(session),
			currentModeId: this.#getCurrentModeId(session),
		};
	}

	#buildCurrentModeUpdate(session: AgentSession): SessionUpdate {
		return {
			sessionUpdate: "current_mode_update",
			currentModeId: this.#getCurrentModeId(session),
		};
	}

	async #buildAvailableCommands(session: AgentSession): Promise<AvailableCommand[]> {
		return toAcpAvailableCommands(await buildAvailableSlashCommands(session));
	}

	#toSessionInfo(session: StoredSessionInfo): SessionInfo {
		return {
			sessionId: session.id,
			cwd: session.cwd,
			title: session.title,
			updatedAt: session.modified.toISOString(),
			_meta: {
				messageCount: session.messageCount,
				size: session.size,
			},
		};
	}

	#scheduleBootstrapUpdates(sessionId: string): void {
		// Defer first notifications until the response has reached the client.
		// Zed's agent-client-protocol reader dispatches responses and
		// notifications to different async tasks; sending the first
		// `available_commands_update` from `setTimeout(0)` reliably loses the
		// race against the response handler and Zed logs `Received session
		// notification for unknown session` then drops the update — leaving
		// the slash-command palette empty (#1015 follow-up; see
		// zed-industries/zed#55965 for the same race biting other ACP agents).
		// `ACP_BOOTSTRAP_RACE_GUARD_MS` is invisible to the operator and large
		// enough that the response future has scheduled before our timer fires
		// on stdio-only transports.
		//
		// The session-lifetime subscription is installed inside the same timer
		// so it shares this guard — without it, an extension's `session_start`
		// handler (or any async work it schedules) calling `setThinkingLevel`
		// would push a `config_option_update` for a session id the client
		// hasn't been told about yet. The pre-bootstrap thinking level is
		// reported in the response's `configOptions`, so deferring the
		// notification loses no state.
		setTimeout(() => {
			if (this.#connection.signal.aborted) {
				return;
			}
			const record = this.#sessions.get(sessionId);
			if (!record) {
				return;
			}
			if (!record.lifetimeUnsubscribe) {
				record.lifetimeUnsubscribe = record.session.subscribe(event => {
					void this.#handleLifetimeEvent(record, event);
				});
			}
			void this.#emitBootstrapUpdates(sessionId, record);
		}, ACP_BOOTSTRAP_RACE_GUARD_MS);
	}

	/**
	 * Stream a freshly-forked session's copied history to the client, the same
	 * way `loadSession` streams a loaded session's — `#forkManagedSession`
	 * already hydrates the *backend* session onto the fork (`switchSession` +
	 * `session.fork()`); this is the missing wire step that tells the client.
	 *
	 * Unlike `loadSession`, the client cannot possibly know this session id
	 * before the `unstable_forkSession` response reaches it — `session/load`'s
	 * id comes from the client's own request, but a fork mints a brand-new id
	 * server-side. A real client (see Zed's `agent_servers::acp`) only
	 * registers a session id in its dispatch table once it observes that id —
	 * for `session/load` that happens *before* the request is even sent, but
	 * for fork there is no such hook, only the response. Replaying inline here,
	 * mirroring `loadSession`'s exact call site, would therefore emit every
	 * notification for a session id the client has not registered yet and get
	 * every one silently dropped ("Received session notification for unknown
	 * session") — the identical race `#scheduleBootstrapUpdates` exists to
	 * dodge for `available_commands_update`/`session_info_update`. So this
	 * replay is deferred behind the same `ACP_BOOTSTRAP_RACE_GUARD_MS` guard.
	 *
	 * The caller parks this promise on `record.promptQueue` so a prompt issued
	 * the instant the client reads `sessionId` from the response queues behind
	 * the replay instead of interleaving a live turn into the transcript.
	 */
	#replayForkedSessionHistory(record: ManagedSessionRecord): Promise<void> {
		const sessionId = record.session.sessionId;
		const { promise, resolve } = Promise.withResolvers<void>();
		setTimeout(() => {
			void (async () => {
				try {
					if (this.#connection.signal.aborted) return;
					if (this.#sessions.get(sessionId) !== record) return;
					await this.#replaySessionHistory(record);
				} catch (error) {
					logger.error("ACP forked-session history replay failed", { sessionId, error });
					record.outbound.poison(error);
				} finally {
					resolve();
				}
			})();
		}, ACP_BOOTSTRAP_RACE_GUARD_MS);
		return promise;
	}

	async #emitBootstrapUpdates(sessionId: string, record: ManagedSessionRecord): Promise<void> {
		if (this.#sessions.get(sessionId) !== record) {
			return;
		}
		await this.#sendUpdate({
			sessionId,
			update: {
				sessionUpdate: "available_commands_update",
				availableCommands: await this.#buildAvailableCommands(record.session),
			},
		});
		await this.#sendUpdate({
			sessionId,
			update: {
				sessionUpdate: "session_info_update",
				title: record.session.sessionName,
				updatedAt: record.session.sessionManager.getHeader()?.timestamp,
			},
		});
	}

	async #emitAvailableCommandsUpdate(record: ManagedSessionRecord): Promise<void> {
		await this.#sendUpdate({
			sessionId: record.session.sessionId,
			update: {
				sessionUpdate: "available_commands_update",
				availableCommands: await this.#buildAvailableCommands(record.session),
			},
		});
	}

	/**
	 * Reload plugin/registry state for an ACP session. Mirrors the interactive
	 * `/reload-plugins` and `/move` flows: invalidates the plugin-roots cache,
	 * refreshes task agents, resets the capability cache, refreshes the
	 * session's slash-command state, then re-advertises commands so the client
	 * sees newly installed/disabled plugins.
	 */
	async #reloadPluginState(record: ManagedSessionRecord): Promise<void> {
		const cwd = record.session.sessionManager.getCwd();
		const projectPath = await resolveActiveProjectRegistryPath(cwd);
		clearPluginRootsAndCaches(projectPath ? [projectPath] : undefined);
		await refreshAgentDiscovery(cwd, record.session.effectiveExtensionRoots);
		resetCapabilities();
		await record.session.refreshSkills();
		const fileCommands = await loadSlashCommands({
			cwd,
			extensionRoots: record.session.effectiveExtensionRoots,
		});
		record.session.setSlashCommands(fileCommands);
		await this.#emitAvailableCommandsUpdate(record);
	}

	async #emitEndOfTurnUpdates(record: ManagedSessionRecord): Promise<void> {
		const sessionId = record.session.sessionId;

		const contextUsage = record.session.getContextUsage();
		if (contextUsage) {
			const usageStats = record.session.sessionManager.getUsageStatistics();
			await this.#sendUpdate({
				sessionId,
				update: {
					sessionUpdate: "usage_update",
					size: contextUsage.contextWindow,
					used: contextUsage.tokens ?? 0,
					cost: usageStats.cost > 0 ? { amount: usageStats.cost, currency: "USD" } : undefined,
				},
			});
		}

		await this.#sendUpdate({
			sessionId,
			update: {
				sessionUpdate: "session_info_update",
				title: record.session.sessionName,
				updatedAt: new Date().toISOString(),
			},
		});
	}

	#cloneUsageStatistics(usage: UsageStatistics): UsageStatistics {
		return {
			input: usage.input,
			output: usage.output,
			cacheRead: usage.cacheRead,
			cacheWrite: usage.cacheWrite,
			totalTokens: usage.totalTokens,
			orchestrationInput: usage.orchestrationInput,
			orchestrationOutput: usage.orchestrationOutput,
			orchestrationCacheRead: usage.orchestrationCacheRead,
			premiumRequests: usage.premiumRequests,
			cost: usage.cost,
		};
	}

	#buildTurnUsage(previous: UsageStatistics, current: UsageStatistics): Usage | undefined {
		const inputTokens = Math.max(0, current.input - previous.input);
		const outputTokens = Math.max(0, current.output - previous.output);
		const cachedReadTokens = Math.max(0, current.cacheRead - previous.cacheRead);
		const cachedWriteTokens = Math.max(0, current.cacheWrite - previous.cacheWrite);
		const totalTokens = Math.max(0, current.totalTokens - previous.totalTokens);

		if (totalTokens === 0) {
			return undefined;
		}

		const usage: Usage = {
			inputTokens,
			outputTokens,
			totalTokens,
		};
		if (cachedReadTokens > 0) {
			usage.cachedReadTokens = cachedReadTokens;
		}
		if (cachedWriteTokens > 0) {
			usage.cachedWriteTokens = cachedWriteTokens;
		}
		return usage;
	}

	async #listStoredSessions(cwd?: string): Promise<StoredSessionInfo[]> {
		const sessions = cwd ? await SessionManager.list(cwd) : await SessionManager.listAll();
		return sessions.sort((left, right) => right.modified.getTime() - left.modified.getTime());
	}

	async #findStoredSession(sessionId: string, cwd: string): Promise<StoredSessionInfo | undefined> {
		const sessions = await this.#listStoredSessions(cwd);
		const scoped = sessions.find(session => session.id === sessionId);
		if (scoped) {
			return scoped;
		}
		// The cwd-derived directory only covers sessions stored under the current
		// naming scheme. Sessions written under a legacy/hashed project directory
		// (the 17.2.5+ scheme reverted in #7656) live elsewhere, so fall back to a
		// global by-id scan: the session id is globally unique, and
		// #openStoredSession reopens the file with the request cwd. See #7779.
		return this.#findStoredSessionById(sessionId);
	}

	async #findStoredSessionById(sessionId: string): Promise<StoredSessionInfo | undefined> {
		const sessions = await this.#listStoredSessions();
		return sessions.find(session => session.id === sessionId);
	}

	#parseCursor(cursor: string | undefined): number {
		if (!cursor) {
			return 0;
		}
		const parsed = Number.parseInt(cursor, 10);
		if (!Number.isFinite(parsed) || parsed < 0) {
			throw new Error(`Invalid ACP session cursor: ${cursor}`);
		}
		return parsed;
	}

	async #replaySessionHistory(record: ManagedSessionRecord): Promise<void> {
		const cwd = record.session.sessionManager.getCwd();
		// `buildSessionContext()` (the default) builds the *LLM* context: it
		// collapses pre-compaction history behind a summary and silently strips
		// tool calls left dangling by an interrupted/killed process (no
		// persisted result yet) — exactly wrong for reconstructing what a human
		// should see on `session/load`. `buildTranscriptSessionContext` is the
		// dedicated full-fidelity display builder (the same one `--resume`'s
		// initial TUI redraw uses): every entry in chronological order,
		// compactions inline, and `keepDanglingToolCalls` keeps a still-running
		// call visible as pending instead of erasing the box entirely.
		const context = record.session.buildTranscriptSessionContext({ keepDanglingToolCalls: true });
		const messages = context.messages as ReplayableMessage[];
		const walk: AcpReplayWalk = {
			sessionId: record.session.sessionId,
			cwd,
			renderContext: this.#buildReplayRenderContext(record),
			// `transcriptOccurrences` must be counted over this exact `messages`
			// array — the cursor's totality gate compares like with like.
			journal: createReplayToolJournalCursor(
				record.session.sessionManager.getBranch(),
				countReplayToolCallOccurrences(messages),
			),
			bookkeeping: new ReplayToolCallBookkeeping(),
		};
		for (const message of messages) {
			for (const update of this.#messageToReplayNotifications(walk, message)) {
				if ("checked" in update) await this.#sendToolUpdate(update.checked);
				else await this.#sendUpdate(update);
			}
		}
		// `keepDanglingToolCalls` is only correct for a *live* stream, where the
		// still-running call really will resolve later (see `ui-helpers.ts`'s
		// `viewSession.isStreaming` gate for the TUI's equivalent). A loaded,
		// no-longer-running session has no live execution left to finish a
		// dangling call, but the mapper's `tool_execution_start` alone leaves
		// Zed's card in `Pending` — a state Zed only ever clears on cancel or
		// error (`acp_thread.rs`'s `mark_pending_entries_as_canceled`), never at
		// normal turn end, so it would spin forever. ACP v1 has no `canceled`
		// tool-call status, so `failed` is the terminal state available; this
		// keeps the call visible (why `keepDanglingToolCalls` is used at all)
		// without a permanent spinner. Hydrated calls are excluded from the
		// announced bookkeeping (they already carry their own terminal
		// settlement or `interrupted` frame from the reducer), so this loop
		// never double-settles one.
		for (const toolCallId of walk.bookkeeping.danglingAnnouncedIds()) {
			const explanation = "Interrupted: no result recorded before the process ended.";
			await this.#sendUpdate({
				sessionId: record.session.sessionId,
				update: {
					sessionUpdate: "tool_call_update",
					toolCallId,
					status: "failed",
					content: [{ type: "content", content: { type: "text", text: explanation } }],
				},
			});
		}
	}

	/**
	 * The render context for replaying persisted tool journal entries — a
	 * `phase: "replay"` counterpart to `#buildRenderContext`. `session/load` has
	 * no live client-owned terminal to attach (there is no execution in
	 * flight), so even a terminal-capable client renders through the
	 * display-only meta terminal on replay, matching `hydrateReplayableToolExecution`'s
	 * own documented rationale.
	 */
	#buildReplayRenderContext(record: ManagedSessionRecord): AcpRenderContext {
		const metaCap = negotiateTerminalMetaCap(this.#terminalMetaCapable());
		const cwd = record.session.sessionManager.getCwd();
		return {
			phase: "replay",
			terminal: metaCap === undefined ? { kind: "none" } : { kind: "meta_only", cap: metaCap },
			...(cwd === undefined ? {} : { cwd }),
			fence: true,
		};
	}

	#messageToReplayNotifications(walk: AcpReplayWalk, message: ReplayableMessage): AcpReplayUpdate[] {
		if (message.role === "assistant") {
			return this.#replayAssistantMessage(walk, message);
		}
		if (
			message.role === "user" ||
			message.role === "developer" ||
			message.role === "custom" ||
			message.role === "hookMessage"
		) {
			return this.#wrapReplayContent(
				walk.sessionId,
				this.#extractReplayContent(message.content, undefined),
				"user_message_chunk",
				crypto.randomUUID(),
			);
		}
		if (
			message.role === "toolResult" &&
			typeof message.toolCallId === "string" &&
			typeof message.toolName === "string"
		) {
			walk.bookkeeping.markResolved(message.toolCallId);
			const todoPlan = buildLegacyReplayTodoPlanUpdate(message.toolName, message.isError, {
				content: message.content,
				details: message.details,
			});
			// A hydrated call already reached its terminal frame at its assistant-turn
			// occurrence (`#replayHydratedToolExecution`); this settled/toolResult
			// message is the same execution's legacy-shaped mirror, not a second
			// notification to send.
			const knownToolCall = walk.bookkeeping.wasReplayed(message.toolCallId);
			const toolNotifications = this.#replayToolResult(
				walk.sessionId,
				walk.cwd,
				{
					...message,
					toolCallId: message.toolCallId,
					toolName: message.toolName,
				},
				{
					includeStart: !knownToolCall,
					includeSettlement: !knownToolCall || walk.bookkeeping.wasAnnounced(message.toolCallId),
				},
			);
			// Todo has two ACP projections: the tool call still needs its terminal
			// settlement, then the persisted phases refresh the plan. Returning only
			// the latter leaves a replayed pending tool card stuck forever.
			return todoPlan ? [...toolNotifications, { sessionId: walk.sessionId, update: todoPlan }] : toolNotifications;
		}
		if (
			message.role === "bashExecution" ||
			message.role === "pythonExecution" ||
			message.role === "compactionSummary"
		) {
			return this.#wrapReplayContent(
				walk.sessionId,
				this.#extractReplayContent(message.content, undefined),
				"user_message_chunk",
				crypto.randomUUID(),
			);
		}
		return [];
	}

	#replayAssistantMessage(walk: AcpReplayWalk, message: ReplayableMessage): AcpReplayUpdate[] {
		const notifications: AcpReplayUpdate[] = [];
		const messageId = crypto.randomUUID();
		if (Array.isArray(message.content)) {
			for (const item of message.content) {
				if (typeof item !== "object" || item === null || !("type" in item)) {
					continue;
				}
				if (item.type === "text" && "text" in item && typeof item.text === "string" && item.text.length > 0) {
					notifications.push({
						sessionId: walk.sessionId,
						update: {
							sessionUpdate: "agent_message_chunk",
							content: { type: "text", text: item.text },
							messageId,
						},
					});
					continue;
				}
				if (
					item.type === "image" &&
					"data" in item &&
					typeof item.data === "string" &&
					"mimeType" in item &&
					typeof item.mimeType === "string"
				) {
					notifications.push({
						sessionId: walk.sessionId,
						update: {
							sessionUpdate: "agent_message_chunk",
							content: { type: "image", data: item.data, mimeType: item.mimeType },
							messageId,
						},
					});
					continue;
				}
				if (item.type === "thinking" && "thinking" in item && typeof item.thinking === "string") {
					const thinking = canonicalizeMessage(item.thinking);
					if (thinking.length === 0) continue;
					notifications.push({
						sessionId: walk.sessionId,
						update: {
							sessionUpdate: "agent_thought_chunk",
							content: { type: "text", text: thinking },
							messageId,
						},
					});
					continue;
				}
				const toolItem = item as ReplayableToolItem;
				if (isReplayableToolItem(toolItem)) {
					// Route through the versioned hydration adapter whenever the branch's
					// v4 tool journal actually has a record for *this* occurrence of the
					// id; every pre-v4 session and every still-`legacy_snapshot`
					// call falls through to the existing legacy-marker reconstruction below.
					const execution = nextReplayableToolExecution(walk.journal, toolItem.id);
					walk.bookkeeping.markReplayed(toolItem.id);
					if (execution !== undefined) {
						notifications.push(...this.#replayHydratedToolExecution(walk, toolItem.id, execution));
						continue;
					}
					const args = this.#buildReplayAssistantToolArgs(toolItem);
					const start = buildLegacyReplayToolCallStartUpdate({
						toolCallId: toolItem.id,
						toolName: toolItem.name,
						args,
						cwd: walk.cwd,
					});
					if (start) notifications.push({ sessionId: walk.sessionId, update: start });
					// Only mark announced when a `tool_call` notification
					// actually went out — that's the set the dangling-cleanup loop in
					// `#replaySessionHistory` walks, so it never synthesizes a
					// `tool_call_update` for a `toolCallId` the client was never told
					// about.
					if (start) {
						walk.bookkeeping.markAnnounced(toolItem.id);
					}
				}
			}
		}
		if (notifications.length === 0 && message.errorMessage && !isSilentAbort(message)) {
			notifications.push({
				sessionId: walk.sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: message.errorMessage },
					messageId,
				},
			});
		}
		return notifications;
	}

	/**
	 * Feed one correlated {@link ReplayableToolExecution} through the *same*
	 * `hydrateReplayableToolExecution` → `reduceAcpToolView(phase:'replay')` →
	 * `encodeToolFrames` pipeline `#handleToolPresentationEvent` uses live —
	 * the whole point being there is no replay-specific frame
	 * builder to drift from the live one. A settled or interrupted execution
	 * reduces start-to-finish in one call, so this both produces the frames and
	 * marks the call resolved; the dangling-cleanup loop in
	 * `#replaySessionHistory` never sees it as outstanding.
	 */
	#replayHydratedToolExecution(
		walk: AcpReplayWalk,
		toolCallId: string,
		execution: ReplayableToolExecution,
	): AcpReplayUpdate[] {
		// Fresh state, not carried over from a prior occurrence of this id: a
		// `ReplayableToolExecution` is a complete `started` -> settlement sequence
		// on its own, and this call's totality-gated pairing (see
		// `ReplayToolJournalCursor`) means every occurrence of a hydrated id gets
		// its own independent execution, never a continuation of the last one.
		// Reusing the previous occurrence's terminal `settled` state here made
		// `reduceStarted` reject the second occurrence as "started twice",
		// poisoning the whole `session/load` on a fully-valid recycled-id pair.
		let state = INITIAL_ACP_TOOL_VIEW;
		const frames: AcpToolFrame[] = [];
		try {
			for (const event of hydrateReplayableToolExecution(execution)) {
				const step = reduceAcpToolView(state, event, walk.renderContext);
				state = step.state;
				frames.push(...step.frames);
			}
			const checked = encodeToolFrames(walk.sessionId, frames);
			walk.bookkeeping.markResolved(toolCallId);
			return checked.map(notification => ({ checked: notification }));
		} catch (error) {
			// A malformed persisted record or a reducer/encoder rejection here is a
			// producer/journal bug, never client data — the same class
			// `#handleToolPresentationEvent` poisons the live queue for. There is no
			// live prompt to poison during `session/load`, so the only honest move is
			// to fail the load itself rather than silently falling back to the legacy
			// path for a record that is supposed to be authoritative.
			logger.error("ACP replay hydration rejected a persisted tool journal execution", {
				sessionId: walk.sessionId,
				toolCallId,
				error,
			});
			throw error;
		}
	}

	#buildReplayAssistantToolArgs(item: ReplayableToolItem): unknown {
		if ("arguments" in item) {
			return normalizeReplayToolArguments(item.arguments).args;
		}
		if (item.type === "tool_use" && "input" in item) {
			return item.input;
		}
		return {};
	}

	#replayToolResult(
		sessionId: string,
		cwd: string,
		message: Required<Pick<ReplayableMessage, "toolCallId" | "toolName">> & ReplayableMessage,
		options: { includeStart?: boolean; includeSettlement?: boolean } = {},
	): SessionNotification[] {
		if (options.includeSettlement === false) return [];
		const args = this.#buildReplayToolArgs(message.details);
		const start = buildLegacyReplayToolCallStartUpdate({
			toolCallId: message.toolCallId,
			toolName: message.toolName,
			args,
			cwd,
		});
		const settlement: SessionNotification = {
			sessionId,
			update: {
				sessionUpdate: "tool_call_update",
				toolCallId: message.toolCallId,
				status: message.isError === true ? "failed" : "completed",
				content: this.#legacyReplayToolResultContent(message.content, message.errorMessage),
			},
		};
		if (!start) return [];
		return options.includeStart === false ? [settlement] : [{ sessionId, update: start }, settlement];
	}

	/**
	 * Legacy persisted results are snapshots, not a presentation journal. Keep
	 * their display authority to the settled body itself: no terminal details,
	 * notices, diff reconstruction, or stream reconciliation may enter replay.
	 */
	#legacyReplayToolResultContent(content: unknown, errorMessage: string | undefined): ToolCallContent[] {
		const replay: ToolCallContent[] = [];
		if (Array.isArray(content)) {
			for (const block of content) {
				if (typeof block !== "object" || block === null) continue;
				const legacyBlock = block as LegacyReplayBodyBlock;
				if (legacyBlock.type === "text" && typeof legacyBlock.text === "string") {
					replay.push({ type: "content", content: { type: "text", text: legacyBlock.text } });
					continue;
				}
				if (
					legacyBlock.type === "image" &&
					typeof legacyBlock.data === "string" &&
					typeof legacyBlock.mimeType === "string"
				) {
					replay.push({
						type: "content",
						content: {
							type: "image",
							data: resolveImageDataSync(this.#blobs, legacyBlock.data),
							mimeType: legacyBlock.mimeType,
						},
					});
				}
			}
		}
		if (replay.length === 0 && errorMessage) {
			replay.push({ type: "content", content: { type: "text", text: errorMessage } });
		}
		return replay;
	}

	#buildReplayToolArgs(details: unknown): { path?: string } {
		if (typeof details !== "object" || details === null || !("path" in details)) {
			return {};
		}
		const value = (details as { path?: unknown }).path;
		return typeof value === "string" && value.length > 0 ? { path: value } : {};
	}

	#wrapReplayContent(
		sessionId: string,
		content: PromptRequest["prompt"],
		kind: "agent_message_chunk" | "user_message_chunk",
		messageId: string,
	): SessionNotification[] {
		return content.map(block => ({
			sessionId,
			update: {
				sessionUpdate: kind,
				content: block,
				messageId,
			},
		}));
	}

	#extractReplayContent(content: unknown, errorMessage: string | undefined): PromptRequest["prompt"] {
		const replay: PromptRequest["prompt"] = [];
		if (Array.isArray(content)) {
			for (const item of content) {
				if (typeof item !== "object" || item === null || !("type" in item)) {
					continue;
				}
				if (item.type === "text" && "text" in item && typeof item.text === "string" && item.text.length > 0) {
					replay.push({ type: "text", text: item.text });
					continue;
				}
				if (
					item.type === "image" &&
					"data" in item &&
					"mimeType" in item &&
					typeof item.data === "string" &&
					typeof item.mimeType === "string"
				) {
					replay.push({ type: "image", data: item.data, mimeType: item.mimeType });
				}
			}
		}
		if (replay.length === 0 && errorMessage) {
			replay.push({ type: "text", text: errorMessage });
		}
		return replay;
	}

	async #configureExtensions(record: ManagedSessionRecord): Promise<void> {
		if (record.extensionsConfigured) {
			return;
		}

		const uiContext = createAcpExtensionUiContext(
			this.#connection,
			() => record.session.sessionId,
			this.#clientCapabilities,
		);
		if (this.#clientCapabilities?.elicitation?.form != null) {
			record.setToolUIContext?.(uiContext, true);
			record.session.setUsageFallbackConfirmer((confirmation, signal) => {
				const reserve =
					confirmation.remainingPercent === undefined
						? "inside the configured reserve margin"
						: `${confirmation.remainingPercent.toFixed(1)}% remaining`;
				return uiContext.confirm(
					"Coding-plan reserve reached",
					`${confirmation.from} has ${reserve}. Switch to ${confirmation.to}? Choose No to keep using the current plan.`,
					{ signal },
				);
			});
		}

		const extensionRunner = record.session.extensionRunner;
		if (!extensionRunner) {
			record.extensionsConfigured = true;
			return;
		}

		extensionRunner.initialize(
			{
				sendMessage: (message, options) => {
					record.session.sendCustomMessage(message, options).catch((error: unknown) => {
						logger.warn("ACP extension sendMessage failed", { error });
					});
				},
				sendUserMessage: (content, options) => {
					this.#trackExtensionUserMessage(record, record.session.sendUserMessage(content, options));
				},
				appendEntry: (customType, data) => {
					record.session.sessionManager.appendCustomEntry(customType, data);
				},
				setLabel: (targetId, label) => {
					record.session.sessionManager.appendLabelChange(targetId, label);
				},
				getActiveTools: () => record.session.getEnabledToolNames(),
				getAllTools: () => record.session.getAllToolInfos(),
				setActiveTools: toolNames => record.session.setActiveToolsByName(toolNames),
				getCommands: () => getSessionSlashCommands(record.session),
				setModel: async model => {
					const apiKey = await record.session.modelRegistry.getApiKey(model);
					if (!apiKey) {
						return false;
					}
					await record.session.setModel(model);
					return true;
				},
				getThinkingLevel: () => record.session.thinkingLevel,
				setThinkingLevel: level => record.session.setThinkingLevel(level),
				getServiceTiers: () => record.session.serviceTierByFamily,
				setServiceTier: (family, tier) => record.session.setServiceTierFamily(family, tier),
				getSessionName: () => record.session.sessionManager.getSessionName(),
				setSessionName: async name => {
					await record.session.sessionManager.setSessionName(name, "user");
				},
			},
			{
				getModel: () => record.session.model,
				isIdle: () => !record.session.isStreaming,
				abort: () => {
					void record.session.abort({ reason: USER_INTERRUPT_LABEL });
				},
				hasPendingMessages: () => record.session.queuedMessageCount > 0,
				shutdown: () => {},
				getContextUsage: () => record.session.getContextUsage(),
				getSystemPrompt: () => record.session.systemPrompt,
				compact: instructionsOrOptions => runExtensionCompact(record.session, instructionsOrOptions),
			},
			{
				getContextUsage: () => record.session.getContextUsage(),
				waitForIdle: () => record.session.agent.waitForIdle(),
				newSession: async options => {
					const success = await record.session.newSession({ parentSession: options?.parentSession });
					if (success && options?.setup) {
						await options.setup(record.session.sessionManager);
					}
					return { cancelled: !success };
				},
				branch: async entryId => {
					const result = await record.session.branch(entryId);
					return { cancelled: result.cancelled };
				},
				navigateTree: async (targetId, options) => {
					const result = await record.session.navigateTree(targetId, { summarize: options?.summarize });
					return { cancelled: result.cancelled };
				},
				switchSession: async sessionPath => {
					const success = await record.session.switchSession(sessionPath);
					return { cancelled: !success };
				},
				reload: async () => {
					await record.session.reload();
				},
				compact: instructionsOrOptions => runExtensionCompact(record.session, instructionsOrOptions),
			},
			uiContext,
			"rpc",
		);
		await extensionRunner.emit({ type: "session_start" });
		record.extensionsConfigured = true;
	}

	async #configureMcpServers(record: ManagedSessionRecord, servers: McpServer[]): Promise<void> {
		if (record.mcpManager) {
			await record.mcpManager.disconnectAll();
		}
		// Drain any in-flight refresh queued by a previous configuration: a refresh
		// that already passed its manager guard could otherwise finish applying a
		// stale tool set after this reconfiguration installs the new one.
		await record.mcpRefreshChain;
		record.mcpRefreshChain = undefined;
		if (servers.length === 0) {
			record.mcpManager = undefined;
			await record.session.refreshMCPTools([]);
			return;
		}

		const manager = new MCPManager(record.session.sessionManager.getCwd());
		// MCP servers connect and reconnect independently, so `onToolsChanged` can fire
		// several times back to back. Each firing is chained onto `record.mcpRefreshChain`
		// so refreshes apply in order, and each one re-reads `manager.getTools()` at the
		// time it actually runs rather than the snapshot from when it was queued — so a
		// refresh can never apply a stale, smaller tool set after a newer one already landed.
		// The returned promise propagates failures (the initial awaited refresh below must
		// fail session setup, as the pre-queue code did); the stored chain swallows them
		// after logging so background firings only warn and the chain never rejects.
		const enqueueMcpToolsRefresh = (): Promise<void> => {
			const run = (record.mcpRefreshChain ?? Promise.resolve()).then(async () => {
				if (record.mcpManager !== manager) return;
				await record.session.refreshMCPTools(manager.getTools());
			});
			record.mcpRefreshChain = run.catch(error => {
				logger.warn("ACP MCP tool refresh failed", {
					error: error instanceof Error ? error.message : String(error),
				});
			});
			return run;
		};
		manager.setOnToolsChanged(() => {
			// Failures are logged once via the stored chain's catch above.
			enqueueMcpToolsRefresh().catch(() => {});
		});
		const configs: MCPConfigMap = {};
		const sources: MCPSourceMap = {};
		for (const server of servers) {
			configs[server.name] = this.#toMcpConfig(server);
			sources[server.name] = {
				provider: "acp",
				providerName: "ACP Client",
				path: `acp://${server.name}`,
				level: "project",
			};
		}

		const result = await manager.connectServers(configs, sources);
		if (result.errors.size > 0) {
			throw new Error(
				Array.from(result.errors.entries())
					.map(([name, message]) => `${name}: ${message}`)
					.join("; "),
			);
		}

		record.mcpManager = manager;
		await enqueueMcpToolsRefresh();
	}

	#toMcpConfig(server: McpServer): MCPServerConfig {
		if ("command" in server) {
			return {
				type: "stdio",
				command: server.command,
				args: server.args,
				env: this.#toNameValueMap(server.env),
			};
		}
		if (server.type === "http") {
			return {
				type: "http",
				url: server.url,
				headers: this.#toNameValueMap(server.headers),
			};
		}
		if (server.type === "sse") {
			return {
				type: "sse",
				url: server.url,
				headers: this.#toNameValueMap(server.headers),
			};
		}
		// The experimental ACP-channel transport (`type: "acp"`) is not advertised in
		// `mcpCapabilities`, so a spec-compliant client never sends it; reject defensively.
		throw new Error(`Unsupported MCP server transport: ${server.type}`);
	}

	#toNameValueMap(values: Array<{ name: string; value: string }>): { [name: string]: string } {
		const mapped: { [name: string]: string } = {};
		for (const value of values) {
			mapped[value.name] = value.value;
		}
		return mapped;
	}

	async #closeManagedSession(sessionId: string, record: ManagedSessionRecord): Promise<void> {
		record.closedError ??= this.#createPromptLifecycleError("ACP session closed before queued prompt could run");
		this.#sessions.delete(sessionId);
		await this.#cancelPromptForClose(record);
		await this.#disposeSessionRecord(record);
	}

	async #cancelPromptForClose(record: ManagedSessionRecord): Promise<void> {
		const promptTurn = record.promptTurn;
		if (!isPromptTurnInFlight(promptTurn)) {
			return;
		}
		const cleanup = promptTurn.cleanup ?? this.#beginCancelCleanup(record, promptTurn);
		try {
			await cleanup;
		} catch (error) {
			logger.warn("Failed to abort ACP prompt during session close", { error });
		}
	}

	async #disposeSessionRecord(record: ManagedSessionRecord, reason?: postmortem.Reason): Promise<void> {
		record.lifetimeUnsubscribe?.();
		record.session.setPresentationSettlementDeliveryBarrier?.(undefined);
		record.settlementDeliveriesReleased = true;
		for (const delivery of record.presentationSettlementDeliveries.values()) delivery.resolve();
		record.presentationSettlementDeliveries.clear();
		if (record.mcpManager) {
			try {
				await record.mcpManager.disconnectAll();
			} catch (error) {
				logger.warn("Failed to disconnect ACP MCP servers", { error });
			}
			record.mcpManager = undefined;
		}
		try {
			await record.session.dispose({ reason });
		} catch (error) {
			logger.warn("Failed to dispose ACP session", { error });
		}
	}

	async #disposeStandaloneSession(session: AgentSession, reason?: postmortem.Reason): Promise<void> {
		try {
			await session.dispose({ reason });
		} catch (error) {
			logger.warn("Failed to dispose ACP session", { error });
		}
	}

	/** Dispose every session owned by this ACP connection and await persisted teardown. */
	async dispose(reason?: postmortem.Reason): Promise<void> {
		if (this.#disposePromise) {
			await this.#disposePromise;
			return;
		}

		this.#disposePromise = (async () => {
			const records = Array.from(this.#sessions.entries());
			this.#sessions.clear();
			await Promise.all(
				records.map(async ([sessionId, record]) => {
					try {
						record.closedError ??= this.#createPromptLifecycleError(
							"ACP agent disposed before queued prompt could run",
						);
						await this.#cancelPromptForClose(record);
						await this.#disposeSessionRecord(record, reason);
					} catch (error) {
						logger.warn("Failed to clean up ACP session", { sessionId, error });
					}
				}),
			);

			const initialSession = this.#initialSession;
			this.#initialSession = undefined;
			if (initialSession) {
				await this.#disposeStandaloneSession(initialSession, reason);
			}
		})();

		await this.#disposePromise;
	}
}

function legacyEvalCode(args: unknown): string | undefined {
	if (typeof args !== "object" || args === null || Array.isArray(args)) return undefined;
	const code = (args as { readonly code?: unknown }).code;
	return typeof code === "string" ? code : undefined;
}
