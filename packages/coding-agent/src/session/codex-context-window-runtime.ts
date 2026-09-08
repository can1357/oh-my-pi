import { type } from "@oh-my-pi/omptype";
import type { AgentTool } from "@oh-my-pi/pi-agent-core";
import { resolveThresholdTokens } from "@oh-my-pi/pi-agent-core/compaction";
import type { Context, Model, ProviderSessionState } from "@oh-my-pi/pi-ai";
import {
	type CodexContextWindowIdentity,
	getOpenAICodexContextWindow,
	resetOpenAICodexHistoryAfterCompaction,
	restoreOpenAICodexContextWindow,
	setOpenAICodexHistoryIngestion,
} from "@oh-my-pi/pi-ai/providers/openai-codex-responses";
import {
	canUseCodexHistoryNotes,
	getCodexContextWindowPolicy,
	codexHistoryNotesAgentPath,
	type HistoryNotesAgentIdentity,
	type CodexHistoryNotesAuth,
	CodexHistoryNotesBackend,
} from "@oh-my-pi/pi-ai/providers/openai-codex/history-notes";
import type { CodexContextWindows } from "@oh-my-pi/pi-catalog/types";
import { logger } from "@oh-my-pi/pi-utils";
import type { Settings } from "../config/settings";
import { createCodexHistoryNotesTools } from "../tools/codex-history-notes";
import { CodexContextWindowProtocol } from "./codex-context-window";
import { sessionEntryIdOf } from "./session-entries";
import type { SessionManager } from "./session-manager";
import { DEFAULT_MAX_BYTES } from "./streaming-output";

const identitySchema = type({
	threadId: "string",
	firstWindowId: "string",
	"previousWindowId?": "string | undefined",
	windowId: "string",
	windowNumber: "number.integer > 0",
	"sessionId?": "string",
	"agentPath?": "string",
});

interface RuntimeHost {
	settings: Settings;
	sessionManager: SessionManager;
	providerSessionState: Map<string, ProviderSessionState>;
	providerSessionId(): string;
	model(): Model | undefined;
	resolveAuth(model: Model): Promise<CodexHistoryNotesAuth>;
	agentIdentity: HistoryNotesAgentIdentity;
}

export class CodexContextWindowRuntime {
	readonly protocol: CodexContextWindowProtocol;
	readonly backend: CodexHistoryNotesBackend;
	readonly #host: RuntimeHost;
	#notesRequested: boolean | undefined;
	#sessionId?: string;
	#available = false;
	#threadHint?: string;
	#policy?: CodexContextWindows;
	#notesTools?: AgentTool[];
	#windowDisabledReason?: string;
	#initialized = false;
	#lastIdentity?: CodexContextWindowIdentity;

	constructor(host: RuntimeHost) {
		this.#host = host;
		const notesMode = host.settings.get("providers.openai-codex.historyNotes");
		this.#notesRequested =
			notesMode === "auto" ? getCodexContextWindowPolicy(host.model())?.useHistoryNotes : notesMode === "on";
		this.protocol = new CodexContextWindowProtocol(codexHistoryNotesAgentPath(host.agentIdentity));
		this.backend = new CodexHistoryNotesBackend(async () => {
			const model = host.model();
			if (!model || model.api !== "openai-codex-responses") throw new Error("Codex model unavailable");
			return host.resolveAuth(model);
		});
	}

	/** Re-read per access: `compaction.methodOrder` changes at runtime. */
	get #windowRequested(): boolean {
		return this.#host.settings.get("compaction.methodOrder").includes("window");
	}

	get windowActive(): boolean {
		return (
			this.#windowDisabledReason === undefined &&
			this.#host.settings.get("compaction.enabled") &&
			this.#available &&
			this.#windowRequested &&
			this.#policy !== undefined
		);
	}

	/** Turn window mode off for the rest of the session. */
	disableWindowMode(reason: string): void {
		if (this.#windowDisabledReason !== undefined) return;
		this.#windowDisabledReason = reason;
		logger.warn("Codex context-window mode disabled", { reason });
	}
	get notesActive(): boolean {
		return this.#available && this.#notesRequested === true;
	}
	get policy(): CodexContextWindows | undefined {
		return this.windowActive ? this.#policy : undefined;
	}
	get effectiveLimit(): number {
		return resolveThresholdTokens(this.#host.model()?.contextWindow ?? 0, this.#host.settings.getGroup("compaction"));
	}
	invalidateIdentity(): void {
		this.#sessionId = undefined;
		this.#lastIdentity = undefined;
		this.#threadHint = undefined;
		this.#initialized = false;
	}

	get identity(): CodexContextWindowIdentity {
		const sessionId = this.#host.providerSessionId();
		if (this.#sessionId !== sessionId) this.#restoreIdentity(sessionId);
		const identity = getOpenAICodexContextWindow(this.#host.providerSessionId(), this.#host.providerSessionState);
		if (
			this.#lastIdentity &&
			identity.windowId !== this.#lastIdentity.windowId &&
			identity.windowNumber <= this.#lastIdentity.windowNumber
		) {
			restoreOpenAICodexContextWindow(
				this.#host.providerSessionId(),
				this.#host.providerSessionState,
				this.#lastIdentity,
			);
			return this.#lastIdentity;
		}
		return (this.#lastIdentity = identity);
	}

	async refresh(): Promise<void> {
		this.#available = false;
		if (this.#notesRequested) {
			setOpenAICodexHistoryIngestion(this.#host.providerSessionId(), this.#host.providerSessionState, undefined);
		}
		const model = this.#host.model();
		this.#notesRequested ??= getCodexContextWindowPolicy(model)?.useHistoryNotes;
		if ((!this.#windowRequested && !this.#notesRequested) || model?.api !== "openai-codex-responses") return;
		try {
			if (!canUseCodexHistoryNotes(await this.#host.resolveAuth(model))) return;
		} catch {
			return;
		}
		this.#available = true;
		// The catalog's own `enabled: false` disables the whole protocol, tools and meter included.
		const discovered = getCodexContextWindowPolicy(model);
		this.#policy = discovered?.enabled === true ? discovered : undefined;
		const sessionId = this.#host.providerSessionId();
		if (this.notesActive) {
			setOpenAICodexHistoryIngestion(sessionId, this.#host.providerSessionState, this.protocol.agentName);
		}
		if (this.#sessionId !== sessionId) this.#restoreIdentity(sessionId);
		if (this.#initialized) return;
		this.#initialized = true;
		this.refreshThreadHint();
	}

	#restoreIdentity(sessionId: string): void {
		this.#lastIdentity = undefined;
		this.#threadHint = undefined;
		this.#initialized = false;
		this.#sessionId = sessionId;
		const branch = this.#host.sessionManager.getBranch();
		const liveStoreId = getOpenAICodexContextWindow(sessionId, this.#host.providerSessionState).sessionId;
		let restored = false;
		for (let index = branch.length - 1; index >= 0; index--) {
			const entry = branch[index];
			const candidate =
				entry.type === "compaction"
					? entry.preserveData?.codexContextWindow
					: entry.type === "custom" && entry.customType === "codex.context-window"
						? entry.data
						: undefined;
			if (candidate === undefined) continue;
			const identity = identitySchema(candidate);
			if (identity instanceof type.errors) continue;
			if (this.#host.agentIdentity.kind === "sub" && identity.agentPath !== this.protocol.agentName) continue;
			// A clone mints a new backend session, so its copied window has no checkpoints there.
			if (identity.sessionId !== undefined && identity.sessionId !== liveStoreId) continue;
			restoreOpenAICodexContextWindow(sessionId, this.#host.providerSessionState, identity);
			restored = true;
			break;
		}
		if (!restored)
			this.#host.sessionManager.appendCustomEntry("codex.context-window", {
				...this.identity,
				agentPath: this.protocol.agentName,
			});
		this.protocol.reset(this.identity);
	}

	/** Fire-and-forget; a hint for a stale session or window is discarded. */
	refreshThreadHint(): void {
		if (!this.notesActive) {
			this.#threadHint = undefined;
			return;
		}
		const windowId = this.identity.windowId;
		const sessionId = this.#sessionId;
		this.#threadHint = undefined;
		void this.backend.threadHint(this.#backendContext()).then(
			hint => {
				if (this.#sessionId === sessionId && this.#lastIdentity?.windowId === windowId) this.#threadHint = hint;
			},
			error => {
				logger.debug("Codex thread hint unavailable", { error: String(error) });
			},
		);
	}

	#backendContext() {
		// Match codex-rs's session-store identity, not its separate thread identity.
		return {
			sessionId: this.identity.sessionId,
			agentName: this.protocol.agentName,
			truncation: { mode: "bytes" as const, limit: DEFAULT_MAX_BYTES },
		};
	}

	notesTools(): AgentTool[] {
		if (!this.notesActive) return [];
		return (this.#notesTools ??= createCodexHistoryNotesTools(this.backend, () => this.#backendContext()));
	}

	transform(context: Context): Context {
		if (!this.windowActive && !this.notesActive) return context;
		const identity = this.identity;
		setOpenAICodexHistoryIngestion(
			this.#host.providerSessionId(),
			this.#host.providerSessionState,
			this.notesActive ? this.protocol.agentName : undefined,
		);
		return this.protocol.transform(context, {
			identity,
			policy: this.#policy,
			threadHint: this.#threadHint,
			getMessageId: message => (message.role === "assistant" ? undefined : sessionEntryIdOf(message)),
		});
	}

	startNewWindow(): CodexContextWindowIdentity {
		resetOpenAICodexHistoryAfterCompaction({
			sessionId: this.#host.providerSessionId(),
			providerSessionState: this.#host.providerSessionState,
		});
		const identity = this.identity;
		this.protocol.reset(identity);
		return identity;
	}

	restore(identity: CodexContextWindowIdentity): void {
		restoreOpenAICodexContextWindow(this.#host.providerSessionId(), this.#host.providerSessionState, identity);
		this.#lastIdentity = identity;
		this.protocol.reset(identity);
	}
}
