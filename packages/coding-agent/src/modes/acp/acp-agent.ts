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
import type { AgentSession, AgentSessionEvent } from "../../session/agent-session";
import { BlobStore, resolveImageDataSync } from "../../session/blob-store";
import { isSilentAbort, SKILL_PROMPT_MESSAGE_TYPE, USER_INTERRUPT_LABEL } from "../../session/messages";
import type { UsageStatistics } from "../../session/session-entries";
import type { SessionInfo as StoredSessionInfo } from "../../session/session-listing";
import { SessionManager } from "../../session/session-manager";
import { executeAcpBuiltinSlashCommand } from "../../slash-commands/acp-builtins";
import { buildAvailableSlashCommands, toAcpAvailableCommands } from "../../slash-commands/available-commands";
import { DEFAULT_STT_MODEL_KEY, STT_MODEL_OPTIONS } from "../../stt/models";
import { refreshAgentDiscovery } from "../../task";
import { AUTO_THINKING, parseConfiguredThinkingLevel } from "../../thinking";
import { OTHER_OPTION } from "../../tools/ask";
import { normalizeLocalScheme } from "../../tools/path-utils";
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
	extractAssistantMessageText,
	mapAgentSessionEventToAcpSessionUpdates,
	normalizeReplayToolArguments,
} from "./acp-event-mapper";
import { ACP_TERMINAL_AUTH_FLAG } from "./terminal-auth";

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
	extensionsConfigured: boolean;
	// Installed inside `#scheduleBootstrapUpdates` (post-race-guard); released
	// in `#disposeSessionRecord`. Lives independent of any prompt turn.
	lifetimeUnsubscribe: (() => void) | undefined;
	closedError: PromptLifecycleError | undefined;
	promptEventHandlers: Set<Promise<void>>;
	extensionUserMessageTasks: Set<Promise<void>>;
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
		await this.#connection.sessionUpdate({
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
			await this.#connection.sessionUpdate({
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
				await this.#connection.sessionUpdate({
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
		promptTurn.unsubscribe?.();
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
		} finally {
			if (timer) clearTimeout(timer);
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
		session.setClientBridge(createAcpClientBridge(this.#connection, session.sessionId, this.#clientCapabilities));
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
			extensionsConfigured: false,
			closedError: undefined,
			promptEventHandlers: new Set(),
			extensionUserMessageTasks: new Set(),
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
		if (!promptTurn || promptTurn.settled || promptTurn.cancelRequested) {
			return;
		}

		if (event.type === "tool_execution_start" || event.type === "tool_execution_update") {
			record.toolArgsById.set(event.toolCallId, event.args);
		}

		this.#prepareLiveAssistantMessage(record, event);
		const imageDataCache = new Map<string, string>();
		const resolveImageDataForAcp = (data: string, mimeType: string | undefined): string => {
			const key = `${mimeType ?? ""}\u0000${data}`;
			const cached = imageDataCache.get(key);
			if (cached !== undefined) return cached;
			const resolved = resolveImageDataSync(this.#blobs, data);
			imageDataCache.set(key, resolved);
			return resolved;
		};
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
		})) {
			const delivery = this.#connection.sessionUpdate(notification);
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
		await this.#connection.sessionUpdate({
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
		await this.#connection.sessionUpdate({
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
				return;
			}
		}

		await record.session.waitForIdle();
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
		promptTurn.unsubscribe?.();
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
		await this.#connection.sessionUpdate({
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
		await this.#connection.sessionUpdate({
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
			await this.#connection.sessionUpdate({
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

	async #emitBootstrapUpdates(sessionId: string, record: ManagedSessionRecord): Promise<void> {
		if (this.#sessions.get(sessionId) !== record) {
			return;
		}
		await this.#connection.sessionUpdate({
			sessionId,
			update: {
				sessionUpdate: "available_commands_update",
				availableCommands: await this.#buildAvailableCommands(record.session),
			},
		});
		await this.#connection.sessionUpdate({
			sessionId,
			update: {
				sessionUpdate: "session_info_update",
				title: record.session.sessionName,
				updatedAt: record.session.sessionManager.getHeader()?.timestamp,
			},
		});
	}

	async #emitAvailableCommandsUpdate(record: ManagedSessionRecord): Promise<void> {
		await this.#connection.sessionUpdate({
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
			await this.#connection.sessionUpdate({
				sessionId,
				update: {
					sessionUpdate: "usage_update",
					size: contextUsage.contextWindow,
					used: contextUsage.tokens ?? 0,
					cost: usageStats.cost > 0 ? { amount: usageStats.cost, currency: "USD" } : undefined,
				},
			});
		}

		await this.#connection.sessionUpdate({
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
		const replayedToolCallIds = new Set<string>();
		const replayedToolCallArgs = new Map<string, unknown>();
		for (const message of record.session.sessionManager.buildSessionContext().messages as ReplayableMessage[]) {
			for (const notification of this.#messageToReplayNotifications(
				record.session.sessionId,
				message,
				cwd,
				replayedToolCallIds,
				replayedToolCallArgs,
			)) {
				await this.#connection.sessionUpdate(notification);
			}
		}
	}

	#messageToReplayNotifications(
		sessionId: string,
		message: ReplayableMessage,
		cwd: string,
		replayedToolCallIds: Set<string>,
		replayedToolCallArgs: Map<string, unknown>,
	): SessionNotification[] {
		if (message.role === "assistant") {
			return this.#replayAssistantMessage(sessionId, message, cwd, replayedToolCallIds, replayedToolCallArgs);
		}
		if (
			message.role === "user" ||
			message.role === "developer" ||
			message.role === "custom" ||
			message.role === "hookMessage"
		) {
			return this.#wrapReplayContent(
				sessionId,
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
			return this.#replayToolResult(
				sessionId,
				cwd,
				{
					...message,
					toolCallId: message.toolCallId,
					toolName: message.toolName,
				},
				{
					includeStart: !replayedToolCallIds.has(message.toolCallId),
					toolArgs: replayedToolCallArgs.get(message.toolCallId),
				},
			);
		}
		if (
			message.role === "bashExecution" ||
			message.role === "pythonExecution" ||
			message.role === "compactionSummary"
		) {
			return this.#wrapReplayContent(
				sessionId,
				this.#extractReplayContent(message.content, undefined),
				"user_message_chunk",
				crypto.randomUUID(),
			);
		}
		return [];
	}

	#replayAssistantMessage(
		sessionId: string,
		message: ReplayableMessage,
		cwd: string,
		replayedToolCallIds: Set<string>,
		replayedToolCallArgs: Map<string, unknown>,
	): SessionNotification[] {
		const notifications: SessionNotification[] = [];
		const messageId = crypto.randomUUID();
		if (Array.isArray(message.content)) {
			for (const item of message.content) {
				if (typeof item !== "object" || item === null || !("type" in item)) {
					continue;
				}
				if (item.type === "text" && "text" in item && typeof item.text === "string" && item.text.length > 0) {
					notifications.push({
						sessionId,
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
						sessionId,
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
						sessionId,
						update: {
							sessionUpdate: "agent_thought_chunk",
							content: { type: "text", text: thinking },
							messageId,
						},
					});
					continue;
				}
				const toolItem = item as ReplayableToolItem;
				if (
					(toolItem.type === "toolCall" || toolItem.type === "tool_use") &&
					typeof toolItem.id === "string" &&
					typeof toolItem.name === "string"
				) {
					const args = this.#buildReplayAssistantToolArgs(toolItem);
					notifications.push(
						...mapAgentSessionEventToAcpSessionUpdates(
							{
								type: "tool_execution_start",
								toolCallId: toolItem.id,
								toolName: toolItem.name,
								args,
							},
							sessionId,
							{ cwd },
						),
					);
					replayedToolCallIds.add(toolItem.id);
					replayedToolCallArgs.set(toolItem.id, args);
				}
			}
		}
		if (notifications.length === 0 && message.errorMessage && !isSilentAbort(message)) {
			notifications.push({
				sessionId,
				update: {
					sessionUpdate: "agent_message_chunk",
					content: { type: "text", text: message.errorMessage },
					messageId,
				},
			});
		}
		return notifications;
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
		options: { includeStart?: boolean; toolArgs?: unknown } = {},
	): SessionNotification[] {
		const args = this.#buildReplayToolArgs(message.details);
		const startEvent: AgentSessionEvent = {
			type: "tool_execution_start",
			toolCallId: message.toolCallId,
			toolName: message.toolName,
			args,
		};
		const endEvent: AgentSessionEvent = {
			type: "tool_execution_end",
			toolCallId: message.toolCallId,
			toolName: message.toolName,
			isError: message.isError === true,
			result: {
				content: message.content,
				details: message.details,
				errorMessage: message.errorMessage,
			},
		};
		const notifications = mapAgentSessionEventToAcpSessionUpdates(endEvent, sessionId, {
			cwd,
			getToolArgs: toolCallId => (toolCallId === message.toolCallId ? options.toolArgs : undefined),
			resolveImageData: (data, _mimeType) => resolveImageDataSync(this.#blobs, data),
		});
		if (options.includeStart === false) {
			return notifications;
		}
		return [...mapAgentSessionEventToAcpSessionUpdates(startEvent, sessionId, { cwd }), ...notifications];
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
