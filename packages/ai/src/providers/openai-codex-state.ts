import { CODEX_BASE_URL } from "@oh-my-pi/pi-catalog/wire/codex";
import type { CodexCompactionContext, Model, ProviderSessionState } from "../types";
import type {
	CodexProviderSessionState,
	CodexTransport,
	CodexWebSocketSessionState,
	OpenAICodexWebSocketDebugStats,
} from "./openai-codex-responses";
import { isOpenAICodexWebSocketPreferred } from "./openai-codex-transport";
import { releaseOpenAIEffortControlSession } from "./openai-configuration-update";
import { normalizeOpenAIPromptCacheKey } from "./openai-shared";

const CODEX_PROVIDER_SESSION_STATE_KEY = "openai-codex-responses";

/** Live Codex session state to preserve after a successful history rewrite. */
export interface OpenAICodexCompactionResetOptions {
	providerSessionState?: Map<string, ProviderSessionState>;
	sessionId?: string;
	compaction: CodexCompactionContext;
}

/**
 * Invalidate Codex history-dependent transport state after compaction while
 * retaining the session identity and live connection.
 */
export function resetOpenAICodexHistoryAfterCompaction(options: OpenAICodexCompactionResetOptions): void {
	const providerState = options.providerSessionState?.get(CODEX_PROVIDER_SESSION_STATE_KEY);
	if (!isCodexProviderSessionState(providerState)) return;
	for (const websocketState of providerState.webSocketSessions.values()) {
		resetCodexWebSocketAppendState(websocketState);
	}
	const sessionId = normalizeOpenAIPromptCacheKey(options.sessionId);
	if (!sessionId) return;
	const metadataSession = providerState.metadataSessions.get(sessionId);
	if (!metadataSession) return;
	metadataSession.windowId = crypto.randomUUID();
	metadataSession.compactionOperationId = undefined;
	metadataSession.reuseTurnForNextRequest = options.compaction.phase !== "standalone_turn";
}

/** Create isolated Codex transport state for a session or compaction request. */
export function createCodexProviderSessionState(): CodexProviderSessionState {
	const state: CodexProviderSessionState = {
		webSocketSessions: new Map(),
		webSocketPublicToPrivate: new Map(),
		metadataSessions: new Map(),
		effortControls: new Map(),
		releaseSession: sessionId => {
			const normalizedSessionId = normalizeOpenAIPromptCacheKey(sessionId);
			if (!normalizedSessionId) return;
			for (const [key, session] of state.webSocketSessions) {
				if (session.sessionId !== normalizedSessionId) continue;
				session.connection?.close("session_disposed");
				state.webSocketSessions.delete(key);
				for (const [publicKey, privateKey] of state.webSocketPublicToPrivate) {
					if (privateKey === key) state.webSocketPublicToPrivate.delete(publicKey);
				}
			}
			state.metadataSessions.delete(normalizedSessionId);
			releaseOpenAIEffortControlSession(state.effortControls, normalizedSessionId);
		},
		close: () => {
			for (const session of state.webSocketSessions.values()) {
				session.connection?.close("session_disposed");
			}
			state.webSocketSessions.clear();
			state.webSocketPublicToPrivate.clear();
			state.metadataSessions.clear();
			state.effortControls.clear();
		},
	};
	return state;
}

function isCodexProviderSessionState(state: ProviderSessionState | undefined): state is CodexProviderSessionState {
	return (
		state !== undefined &&
		"webSocketSessions" in state &&
		state.webSocketSessions instanceof Map &&
		"webSocketPublicToPrivate" in state &&
		state.webSocketPublicToPrivate instanceof Map &&
		"metadataSessions" in state &&
		state.metadataSessions instanceof Map &&
		"effortControls" in state &&
		state.effortControls instanceof Map
	);
}

/** Return or initialize the Codex state shared by a session's streaming requests. */
export function getCodexProviderSessionState(
	providerSessionState: Map<string, ProviderSessionState> | undefined,
): CodexProviderSessionState | undefined {
	if (!providerSessionState) return undefined;
	const existing = providerSessionState.get(CODEX_PROVIDER_SESSION_STATE_KEY);
	if (isCodexProviderSessionState(existing)) return existing;
	const created = createCodexProviderSessionState();
	providerSessionState.set(CODEX_PROVIDER_SESSION_STATE_KEY, created);
	return created;
}

/** Forget append baselines after a history rewrite without closing the live connection. */
export function resetCodexWebSocketAppendState(state: CodexWebSocketSessionState): void {
	state.canAppend = false;
	state.lastRequest = undefined;
	state.lastResponseId = undefined;
	state.lastResponseItems = undefined;
}

/** Current Codex transport selection and connection status for host diagnostics. */
export interface OpenAICodexTransportDetails {
	websocketPreferred: boolean;
	lastTransport?: CodexTransport;
	websocketDisabled: boolean;
	websocketConnected: boolean;
	fallbackCount: number;
	canAppend: boolean;
	prewarmed: boolean;
	hasSessionState: boolean;
	hasTurnState: boolean;
	lastFallbackAt?: number;
}

function getCodexWebSocketStateForPublicSession(
	model: Model<"openai-codex-responses">,
	options:
		| {
				sessionId?: string;
				baseUrl?: string;
				providerSessionState?: Map<string, ProviderSessionState>;
		  }
		| undefined,
): CodexWebSocketSessionState | undefined {
	const baseUrl = options?.baseUrl || model.baseUrl || CODEX_BASE_URL;
	const providerSessionState = getCodexProviderSessionState(options?.providerSessionState);
	const normalizedSessionId = normalizeOpenAIPromptCacheKey(options?.sessionId);
	const publicSessionKey = normalizedSessionId ? `${baseUrl}:${model.id}:${normalizedSessionId}` : undefined;
	const privateSessionKey = publicSessionKey
		? providerSessionState?.webSocketPublicToPrivate.get(publicSessionKey)
		: undefined;
	return privateSessionKey ? providerSessionState?.webSocketSessions.get(privateSessionKey) : undefined;
}

export function getOpenAICodexWebSocketDebugStats(
	model: Model<"openai-codex-responses">,
	options?: {
		sessionId?: string;
		baseUrl?: string;
		providerSessionState?: Map<string, ProviderSessionState>;
	},
): OpenAICodexWebSocketDebugStats | undefined {
	const stats = getCodexWebSocketStateForPublicSession(model, options)?.stats;
	return stats ? { ...stats } : undefined;
}

export function getOpenAICodexTransportDetails(
	model: Model<"openai-codex-responses">,
	options?: {
		sessionId?: string;
		baseUrl?: string;
		preferWebsockets?: boolean;
		providerSessionState?: Map<string, ProviderSessionState>;
	},
): OpenAICodexTransportDetails {
	const websocketPreferred = isOpenAICodexWebSocketPreferred(model, {
		preferWebsockets: options?.preferWebsockets,
	});
	const state = getCodexWebSocketStateForPublicSession(model, options);
	const providerSessionState = getCodexProviderSessionState(options?.providerSessionState);
	const sessionId = normalizeOpenAIPromptCacheKey(options?.sessionId);
	let hasTurnState = false;
	if (sessionId) {
		const metadataSession = providerSessionState?.metadataSessions.get(sessionId);
		if (metadataSession) {
			for (const cell of metadataSession.turnStates.values()) {
				if (cell.value === undefined) continue;
				hasTurnState = true;
				break;
			}
		}
	}

	return {
		websocketPreferred,
		lastTransport: state?.lastTransport,
		websocketDisabled: state?.disableWebsocket ?? false,
		websocketConnected: state?.connection?.isOpen() ?? false,
		fallbackCount: state?.fallbackCount ?? 0,
		canAppend: state?.canAppend ?? false,
		prewarmed: state?.prewarmed ?? false,
		hasSessionState: state !== undefined,
		hasTurnState,
		lastFallbackAt: state?.lastFallbackAt,
	};
}
